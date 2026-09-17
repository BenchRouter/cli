import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  aggregateStress,
  buildRunnerEnv,
  classifyCase,
  isDecided,
  runStress,
  wilsonInterval
} from "../src/stress.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");

test("wilson interval and case classes match the proposal's reference numbers", () => {
  const allPass = wilsonInterval(20, 20);
  assert.equal(allPass.mean, 1);
  assert.ok(Math.abs(allPass.lower - 0.8389) < 0.001, `lower ${allPass.lower}`);
  assert.equal(allPass.upper, 1);
  const allFail = wilsonInterval(0, 20);
  assert.equal(allFail.lower, 0);
  assert.ok(Math.abs(allFail.upper - 0.1611) < 0.001, `upper ${allFail.upper}`);
  assert.equal(wilsonInterval(17, 20).mean, 0.85);
  assert.deepEqual(wilsonInterval(0, 0), { mean: null, lower: null, upper: null });

  assert.equal(classifyCase(5, 5), "stable_pass");
  assert.equal(classifyCase(0, 5), "stable_fail");
  assert.equal(classifyCase(3, 5), "flaky");
});

test("early-stop decisions: any failure decides against threshold 1; all-pass runs to the cap unless a baseline mean is set", () => {
  assert.equal(isDecided({ passes: 4, trials: 5, threshold: 1 }), true);
  assert.equal(isDecided({ passes: 5, trials: 5, threshold: 1 }), false);
  assert.equal(isDecided({ passes: 5, trials: 5, threshold: 0.5 }), true);
  assert.equal(isDecided({ passes: 0, trials: 0, threshold: 1 }), false);
});

test("aggregateStress labels discrimination across models and reports served histograms in live mode", () => {
  const rows = (model, flakyPass) => [
    { case_id: "ceiling", critical: false, pass: true, cost_usd: 0.01, latency_ms: 100, selected_model: model },
    { case_id: "flaky", critical: true, pass: flakyPass, cost_usd: 0.01, latency_ms: 200, selected_model: model }
  ];
  const report = aggregateStress([
    { model: "a/one", trial: 0, rows: rows("a/one", true) },
    { model: "a/one", trial: 1, rows: rows("a/one", false) },
    { model: "b/two", trial: 0, rows: rows("b/two", true) },
    { model: "b/two", trial: 1, rows: rows("b/two", true) }
  ]);
  assert.equal(report.total_calls, 8);
  const [one, two] = report.models;
  assert.equal(one.flaky_case_count, 1);
  assert.equal(one.flaky_critical_case_count, 1);
  assert.equal(two.flaky_case_count, 0);
  assert.deepEqual(
    report.cases.map((entry) => [entry.case_id, entry.discrimination]),
    [["ceiling", "ceiling"], ["flaky", "discriminating"]]
  );

  const live = aggregateStress([
    { model: null, trial: 0, rows: rows("x/served", true) },
    { model: null, trial: 1, rows: [...rows("x/served", true), { case_id: "err", pass: false, error: "boom", technical_failure: { code: "x" } }] }
  ], { live: true });
  assert.equal(live.models[0].served[0].model, "x/served");
  assert.equal(live.models[0].served[0].count, 4);
  assert.equal(live.models[0].error_calls, 1);
  assert.equal(live.cases.find((entry) => entry.case_id === "err").discrimination, null);
});

test("buildRunnerEnv passes only stress controls and strips official eval context", () => {
  const env = buildRunnerEnv({
    baseEnv: { PATH: "/bin", BENCHROUTER_API_KEY: "k", BENCHROUTER_UPLOAD_RESULTS: "1", BENCHROUTER_MODEL_RUN_ID: "mr", BENCHROUTER_FORCE_MODEL: "x" },
    apiUrl: "http://api",
    apiKey: "k",
    routeId: "elo/ladder",
    casesPath: "/tmp/cases.json",
    resultsSuffix: "stress.m.0",
    model: "openai/gpt-5",
    concurrency: 2
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.BENCHROUTER_STRESS_MODEL, "openai/gpt-5");
  assert.equal(env.BENCHROUTER_ROUTE_ID, "elo/ladder");
  assert.equal(env.BENCHROUTER_CASES_PATH, "/tmp/cases.json");
  assert.equal(env.BENCHROUTER_EVAL_CONCURRENCY, "2");
  assert.equal(env.BENCHROUTER_UPLOAD_RESULTS, undefined);
  assert.equal(env.BENCHROUTER_MODEL_RUN_ID, undefined);
  assert.equal(env.BENCHROUTER_FORCE_MODEL, undefined);
});

test("runStress drives the generated runner per trial, early-stops decided cases, and honors the budget", async (t) => {
  const root = await writeStressRepo(t);
  const report = await runStress({
    root,
    routeKey: "elo/ladder",
    models: ["openai/gpt-5"],
    live: false,
    trials: 7,
    caseIds: [],
    concurrency: 1,
    maxCostUsd: null,
    earlyStop: true,
    apiUrl: "http://127.0.0.1:9",
    apiKey: "br_live_test",
    baseEnv: { ...process.env }
  });
  const model = report.models[0];
  assert.equal(model.model, "openai/gpt-5");
  const flaky = model.cases.find((entry) => entry.case_id === "flaky");
  const stable = model.cases.find((entry) => entry.case_id === "stable");
  // flaky fails on odd trials, is decided after the first block of 5, and is dropped from trials 6-7.
  assert.equal(flaky.trials, 5);
  assert.equal(flaky.classification, "flaky");
  assert.equal(stable.trials, 7);
  assert.equal(stable.classification, "stable_pass");
  assert.equal(report.total_calls, 12);
  assert.equal(report.budget_stopped, false);

  const budgeted = await runStress({
    root,
    routeKey: "elo/ladder",
    models: ["openai/gpt-5"],
    live: false,
    trials: 20,
    caseIds: ["stable"],
    concurrency: 1,
    maxCostUsd: 0.025,
    earlyStop: false,
    apiUrl: "http://127.0.0.1:9",
    apiKey: "br_live_test",
    baseEnv: { ...process.env }
  });
  assert.equal(budgeted.budget_stopped, true);
  assert.equal(budgeted.total_calls, 3);
  assert.deepEqual(budgeted.models[0].cases.map((entry) => entry.case_id), ["stable"]);

  await assert.rejects(
    runStress({ root, routeKey: "elo/ladder", models: ["openai/gpt-5"], live: false, trials: 300, caseIds: [], apiUrl: "x", apiKey: "k" }),
    /exceed 200; pass --max-cost-usd/
  );
  await assert.rejects(
    runStress({ root, routeKey: "elo/ladder", models: ["openai/gpt-5"], live: false, trials: 2, caseIds: ["nope"], apiUrl: "x", apiKey: "k" }),
    /Unknown case id/
  );
});

test("stress refuses --model against a runner without stress support and requires a runtime key", async (t) => {
  const root = await writeStressRepo(t, { legacyRunner: true });
  const result = await runCli(["stress", "elo/ladder", "--model", "openai/gpt-5", "--trials", "2", "--output-dir", root], root, { BENCHROUTER_API_KEY: "k" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /predates model-level stress/);

  const noKey = await runCli(["stress", "elo/ladder", "--live", "--output-dir", root, "--json"], root, { BENCHROUTER_API_KEY: "" });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /Missing runtime key/);
});

test("stress CLI renders a report and JSON from the runner rows", async (t) => {
  const root = await writeStressRepo(t);
  const text = await runCli(["stress", "elo/ladder", "--model", "openai/gpt-5", "--trials", "4", "--output-dir", root], root, { BENCHROUTER_API_KEY: "k" });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Stress elo\/ladder \(1 model, 4 trials requested\)/);
  assert.match(text.stdout, /openai\/gpt-5: 75% \[/);
  assert.match(text.stdout, /flaky\*\s+2\/4\s+50%/);
  assert.match(text.stdout, /writes nothing to BenchRouter/);

  const json = await runCli(["stress", "elo/ladder", "--live", "--trials", "2", "--output-dir", root, "--json"], root, { BENCHROUTER_API_KEY: "k" });
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.mode, "live");
  assert.equal(body.models[0].served[0].model, "served/model");
});

const FAKE_RUNNER = `// fake generated runner for tests: reads env like the real one (BENCHROUTER_STRESS_MODEL)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const casesPath = process.env.BENCHROUTER_CASES_PATH || ".benchrouter/cases.elo__ladder.json";
const suffix = process.env.BENCHROUTER_RESULTS_SUFFIX || "model";
const trial = Number(suffix.split(".").pop());
const model = process.env.BENCHROUTER_STRESS_MODEL || "served/model";
const cases = JSON.parse(readFileSync(casesPath, "utf8")).filter((c) => !c.route || c.route === process.env.BENCHROUTER_ROUTE_ID);
const rows = cases.map((c) => ({
  run_id: "local", route_id: process.env.BENCHROUTER_ROUTE_ID, case_id: c.id, critical: c.critical === true, mode: "isolated",
  model, selected_model: model, model_call_ids: ["call_" + c.id + trial],
  pass: c.id === "flaky" ? trial % 2 === 0 : true, score: 1, checks: [], reasons: [], raw_output: "ok", reference_output: null,
  cost_usd: 0.01, judge_cost_usd: null, latency_ms: 100 + trial, error: null, outcome_code: null, technical_failure: null
}));
mkdirSync(".benchrouter", { recursive: true });
writeFileSync(".benchrouter/results." + suffix + ".jsonl", rows.map((r) => JSON.stringify(r)).join("\\n") + "\\n");
`;

async function writeStressRepo(t, { legacyRunner = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-stress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { "benchrouter:eval": "node .benchrouter/benchrouter-eval.mjs" } }));
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), `version: 1
product:
  slug: elo
  repo: example/elo
  default_branch: main
routes:
  - id: ladder
    route_id: elo/ladder
    name: Elo Ladder
    code_refs: [src/ladder.ts]
    call_site:
      base_url_env: OPENAI_BASE_URL
    seed:
      incumbent_model: xai/grok-4.6
    eval_pack:
      workflow: .github/workflows/benchrouter-evals.yml
      scorer: .benchrouter/scorer.elo__ladder.js
      result_schema: benchrouter.result.v1
      case_refs: [.benchrouter/cases.elo__ladder.json]
`);
  await writeFile(path.join(root, ".benchrouter/cases.elo__ladder.json"), JSON.stringify([
    { id: "stable", route: "elo/ladder", input: { messages: [{ role: "user", content: "a" }] } },
    { id: "flaky", route: "elo/ladder", critical: true, input: { messages: [{ role: "user", content: "b" }] } }
  ]));
  await writeFile(path.join(root, ".benchrouter/scorer.elo__ladder.js"), "module.exports.score = () => ({ pass: true });\n");
  await writeFile(
    path.join(root, ".benchrouter/benchrouter-eval.mjs"),
    legacyRunner ? FAKE_RUNNER.replaceAll("BENCHROUTER_STRESS_MODEL", "BENCHROUTER_LEGACY") : FAKE_RUNNER
  );
  return root;
}

function runCli(cliArgs, cwd, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...envOverrides };
    if (envOverrides.BENCHROUTER_API_KEY === "") delete env.BENCHROUTER_API_KEY;
    const child = spawn(process.execPath, [cliPath, ...cliArgs], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
