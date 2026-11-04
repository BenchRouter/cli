import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/benchrouter.mjs", import.meta.url));

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: { ...process.env, BENCHROUTER_SETUP_KEY: "", npm_config_registry: "http://127.0.0.1:9" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// Records each setup request and refuses it, so a pack that passes local checks stops after one request.
async function setupServer(t) {
  const bodies = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    bodies.push(JSON.parse(raw || "{}"));
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "setup_scope_expired", message: "BenchRouter setup access has expired" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, bodies };
}

async function monorepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "br-eval-pack-rules-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "apps/web/eval"), { recursive: true });
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const file of ["apps/web/eval/run.mjs", "apps/web/eval/cases.json", "apps/web/eval/qrels.json"]) {
    await writeFile(path.join(root, file), "{}\n");
  }
  return root;
}

function pack(overrides = {}) {
  const value = {
    mode: "repository_executable",
    id: "web_review_v1",
    config_path: ".benchrouter/benchrouter.yml",
    workflow: ".github/workflows/benchrouter-evals.yml",
    command: "node eval/run.mjs",
    scorer: ".benchrouter/scorer.web.js",
    result_schema: "benchrouter.executable_result.v1",
    case_refs: ["apps/web/eval/cases.json"],
    argv: ["node", "eval/run.mjs"],
    runtime: "node",
    lockfile: "../../pnpm-lock.yaml",
    working_directory: "apps/web",
    isolation: "job",
    input_refs: ["apps/web/eval/run.mjs", "apps/web/eval/cases.json"],
    acceptance_refs: ["apps/web/eval/qrels.json"],
    result_path: ".benchrouter/executable-result.json",
    primary_metric: "pass_rate",
    timeout_minutes: 30,
    secret_env: [],
    ...overrides
  };
  for (const [key, item] of Object.entries(value)) if (item === undefined) delete value[key];
  return value;
}

async function initWith(t, root, evalPack) {
  const server = await setupServer(t);
  await writeFile(path.join(root, "eval-pack.json"), `${JSON.stringify(evalPack)}\n`);
  const result = await runCli(["init", "--setup-key", "br_setup_fixture", "--route-id", "app/web", "--name", "Web",
    "--incumbent-model", "openai/gpt-4o-mini", "--eval-pack", "eval-pack.json", "--api-family", "openai_chat_completions",
    "--repo", "example/app", "--api-url", server.url, "--output-dir", root], root);
  return { result, bodies: server.bodies };
}

test("a monorepo pack with working_directory, a parent lockfile, job isolation and no runtime_version passes", async (t) => {
  const root = await monorepo(t);
  const evalPack = pack();
  const { result, bodies } = await initWith(t, root, evalPack);
  assert.equal(bodies.length, 1, result.stderr);
  assert.deepEqual(bodies[0].route.eval_pack, evalPack);
});

test("eval pack rules that match the server stop before any request", async (t) => {
  const root = await monorepo(t);
  const cases = [
    [{ working_directory: "." }, "working_directory must be a repository-relative directory"],
    [{ working_directory: "apps/./web" }, "working_directory must be a repository-relative directory"],
    [{ working_directory: "~/web" }, "working_directory must be a repository-relative directory"],
    [{ working_directory: "apps/api" }, "working_directory apps/api is not a directory in the repository"],
    [{ lockfile: "../../../pnpm-lock.yaml" }, "lockfile ../../../pnpm-lock.yaml leaves the repository from working_directory apps/web"],
    [{ lockfile: "sub/pnpm-lock.yaml" }, "references missing repository file apps/web/sub/pnpm-lock.yaml"],
    [{ lockfile: "pnpm-lock.yaml" }, "references missing repository file apps/web/pnpm-lock.yaml"],
    [{ lockfile: "./pnpm-lock.yaml" }, "lockfile must be a relative path"],
    [{ lockfile: "/pnpm-lock.yaml" }, "lockfile must be a relative path"],
    [{ working_directory: undefined, lockfile: "../pnpm-lock.yaml" }, "leaves the repository from working_directory (the repository root)"],
    [{ isolation: "container" }, "isolation must be process or job"],
    [{ runtime_version: "lts" }, "runtime_version must be an exact version"],
    [{ primary_metric: "Pass_rate" }, "primary_metric must start with a lowercase letter"],
    [{ primary_metric: "pass-rate" }, "primary_metric must start with a lowercase letter"],
    [{ case_refs: ["apps/web/eval/cases.json", "apps/web/eval/cases.json"] }, "case_refs lists apps/web/eval/cases.json twice"],
    [{ acceptance_refs: ["apps/web/eval/qrels.json", "apps/web/eval/run.mjs"] }, "input_refs and acceptance_refs both list apps/web/eval/run.mjs. A file is either data the evaluator reads (input_refs) or part of what decides quality (acceptance_refs); an evaluator that holds the checks goes in acceptance_refs."]
  ];
  for (const [overrides, message] of cases) {
    const { result, bodies } = await initWith(t, root, pack(overrides));
    assert.equal(result.status, 1, JSON.stringify(overrides));
    assert.ok(result.stderr.includes(message), `${JSON.stringify(overrides)}: ${result.stderr}`);
    assert.equal(bodies.length, 0, JSON.stringify(overrides));
  }
});

test("a lockfile in a child directory of working_directory is accepted", async (t) => {
  const root = await monorepo(t);
  await mkdir(path.join(root, "apps/web/deps"), { recursive: true });
  await writeFile(path.join(root, "apps/web/deps/pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const { result, bodies } = await initWith(t, root, pack({ lockfile: "deps/pnpm-lock.yaml" }));
  assert.equal(bodies.length, 1, result.stderr);
});

test("the overlap error names the file and explains both lists, exactly", async (t) => {
  const root = await monorepo(t);
  const { result, bodies } = await initWith(t, root, pack({ acceptance_refs: ["apps/web/eval/qrels.json", "apps/web/eval/run.mjs"] }));
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "--eval-pack for route app/web: input_refs and acceptance_refs both list apps/web/eval/run.mjs. " +
    "A file is either data the evaluator reads (input_refs) or part of what decides quality (acceptance_refs); " +
    "an evaluator that holds the checks goes in acceptance_refs.\n");
  assert.equal(bodies.length, 0);
});

test("null optional fields mean the repository root and process isolation", async (t) => {
  const root = await monorepo(t);
  const evalPack = pack({ working_directory: null, isolation: null, lockfile: "pnpm-lock.yaml", argv: ["node", "apps/web/eval/run.mjs"] });
  const { result, bodies } = await initWith(t, root, evalPack);
  assert.equal(bodies.length, 1, result.stderr);
});
