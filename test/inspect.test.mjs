import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectCases, inspectRoutes, inventoryCases } from "../src/inspect.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");

test("inventoryCases groups by method, archetype, and critical", () => {
  const cases = [
    caseRow("email-1", "generate_email_content", "code-consumed", true),
    caseRow("note-1", "generate_internal_note", "human-read", false),
    caseRow("note-2", "generate_internal_note", "human-read", false)
  ];
  const byMethod = inventoryCases(cases, "method");
  assert.equal(byMethod.count, 3);
  assert.deepEqual(
    byMethod.groups.map((group) => [group.key, group.count]),
    [
      ["generate_email_content", 1],
      ["generate_internal_note", 2]
    ]
  );
  const byCritical = inventoryCases(cases, "critical");
  assert.deepEqual(
    byCritical.groups.map((group) => [group.key, group.count]),
    [
      ["critical", 1],
      ["noncritical", 2]
    ]
  );
});

test("routes inspect and evals cases read the local kit without a token", async (t) => {
  const root = await writeMixedRouteRepo(t);

  const inspected = inspectRoutes(root, "app/crm");
  assert.equal(inspected.routes.length, 1);
  assert.equal(inspected.routes[0].cases.count, 3);
  assert.ok(inspected.routes[0].cases.groups.some((group) => group.key === "generate_email_content"));

  const cases = inspectCases(root, "app/crm", "critical");
  assert.equal(cases.routes[0].inventory.group_by, "critical");
  assert.deepEqual(
    cases.routes[0].inventory.groups.map((group) => group.key),
    ["critical", "noncritical"]
  );

  const inspectCli = await runCli(["routes", "inspect", "app/crm", "--output-dir", root, "--json"]);
  assert.equal(inspectCli.status, 0, inspectCli.stderr);
  const inspectBody = JSON.parse(inspectCli.stdout);
  assert.equal(inspectBody.routes[0].route_id, "app/crm");
  assert.equal(inspectBody.routes[0].cases.count, 3);

  const casesCli = await runCli([
    "evals",
    "cases",
    "app/crm",
    "--group",
    "method",
    "--output-dir",
    root
  ]);
  assert.equal(casesCli.status, 0, casesCli.stderr);
  assert.match(casesCli.stdout, /generate_email_content  1  email-1/);
  assert.match(casesCli.stdout, /generate_internal_note  2/);
});

test("routes inspect reports a missing route and unknown group", async (t) => {
  const root = await writeMixedRouteRepo(t);
  const missing = await runCli(["routes", "inspect", "app/missing", "--output-dir", root, "--json"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Route not found/);

  const group = await runCli(["evals", "cases", "--group", "flavor", "--output-dir", root, "--json"]);
  assert.equal(group.status, 1);
  assert.match(group.stderr, /Unknown case group/);
});

test("local inspect help does not require a token", async () => {
  const inspectHelp = await runCli(["routes", "inspect", "--help"]);
  assert.equal(inspectHelp.status, 0, inspectHelp.stderr);
  assert.match(inspectHelp.stdout, /does not use an account token/i);

  const casesHelp = await runCli(["evals", "cases", "--help"]);
  assert.equal(casesHelp.status, 0, casesHelp.stderr);
  assert.match(casesHelp.stdout, /Inventory local declared cases/);
});

function caseRow(id, method, archetype, critical) {
  return {
    id,
    route: "app/crm",
    critical,
    request: { method },
    scorer_metadata: {
      eval_archetype: archetype,
      method,
      expect: { fields: method === "generate_email_content" ? ["subject", "body"] : ["text"] }
    },
    input: { max_tokens: method === "generate_email_content" ? 300 : 150 }
  };
}

async function writeMixedRouteRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await writeFile(
    path.join(root, ".benchrouter/benchrouter.yml"),
    `version: 1

product:
  slug: app
  repo: example/app
  default_branch: main

routes:
  - id: crm
    route_id: app/crm
    name: CRM
    code_refs:
      - src/llm.js
    metadata:
      eval_archetype: human-read
    call_site:
      base_url_env: OPENAI_BASE_URL
    seed:
      incumbent_model: openai/gpt-4o-mini
    eval_pack:
      id: crm_v1
      config_path: .benchrouter/benchrouter.yml
      workflow: .github/workflows/benchrouter-evals.yml
      command: npm run benchrouter:eval
      scorer: .benchrouter/scorer.crm.js
      result_schema: benchrouter.result.v1
      case_refs:
        - .benchrouter/cases.crm.json
`
  );
  await writeFile(path.join(root, ".benchrouter/scorer.crm.js"), "export function score() { return { pass: true }; }\n");
  await writeFile(
    path.join(root, ".benchrouter/cases.crm.json"),
    `${JSON.stringify([
      caseRow("email-1", "generate_email_content", "code-consumed", true),
      caseRow("note-1", "generate_internal_note", "human-read", false),
      caseRow("note-2", "generate_internal_note", "human-read", false)
    ], null, 2)}\n`
  );
  return root;
}

function runCli(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...argv], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
