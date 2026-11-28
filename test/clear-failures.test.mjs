// A cold-read panel (2026-11-27) found inputs where init and doctor crashed or hid the field at
// fault. Each test runs the real CLI process against a temporary repository and a local server
// that answers with the service's response shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
const WORKFLOW = ".github/workflows/benchrouter-evals.yml";
const MANIFEST = ".benchrouter/benchrouter.yml";
const routeId = "app/chat";
// The kit 0.1.0 eval-action stub (see fixtures/signed-kit/README.md).
const stubWorkflow = await readFile(path.join(testDir, "fixtures/signed-kit/workflow.yml"), "utf8");
// The same workflow with its job renamed, as a hand edit leaves it.
const renamedJobWorkflow = (() => {
  const workflow = parseYaml(stubWorkflow);
  workflow.jobs = { evals: workflow.jobs.eval };
  return stringifyYaml(workflow);
})();

function manifest({ product = true, caseRef = ".benchrouter/cases.chat.json" } = {}) {
  return `version: 1
${product ? "product:\n  slug: app\n  repo: example/app\n  default_branch: main\n" : ""}routes:
  - id: chat
    route_id: ${routeId}
    name: Chat
    code_refs:
      - src/llm.js
    call_site:
      base_url_env: OPENAI_BASE_URL
      api_family: openai_chat_completions
    seed:
      incumbent_model: openai/gpt-4o-mini
    eval_pack:
      id: chat_v1
      config_path: ${MANIFEST}
      workflow: ${WORKFLOW}
      result_schema: benchrouter.eval_result.v1
      case_refs:
        - ${caseRef}
`;
}

const initArgs = (url, root) => ["init", "--setup-key", "br_setup_fixture", "--route", routeId, "--name", "Chat",
  "--incumbent-model", "openai/gpt-4o-mini", "--api-url", url, "--output-dir", root, "--dry-run"];
const packet = (files) => ({ repo_full_name: "example/app", setup_packet: { files } });

test("init names a renamed eval job instead of crashing, and --overwrite-user-edits replaces the workflow", { timeout: 4900 }, async (t) => {
  const root = await tempRepo(t, { [WORKFLOW]: renamedJobWorkflow });
  const server = await startServer(t, () => ({ status: 200, body: packet([{ path: WORKFLOW, content: stubWorkflow }]) }));

  const refused = await runCli(initArgs(server.url, root), root);
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(`${WORKFLOW} must contain jobs.eval.steps (it has jobs.evals; BenchRouter's workflow has one job named eval).`), refused.stderr);
  assert.ok(refused.stderr.includes("rerun with --overwrite-user-edits to replace it with BenchRouter's copy"), refused.stderr);
  assert.ok(!refused.stderr.includes("    at "), "no stack trace");

  const replaced = await runCli([...initArgs(server.url, root), "--overwrite-user-edits"], root);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.ok(replaced.stdout.includes(`  update ${WORKFLOW}\n`), replaced.stdout);
  assert.equal(await readFile(path.join(root, WORKFLOW), "utf8"), renamedJobWorkflow, "a dry run writes nothing");
});

test("init --dry-run warns when the benchrouter.yml it keeps is still invalid", { timeout: 4900 }, async (t) => {
  const root = await tempRepo(t, { [MANIFEST]: manifest({ product: false }) });
  const server = await startServer(t, () => ({ status: 200, body: packet([{ path: MANIFEST, content: manifest() }]) }));

  const result = await runCli(initArgs(server.url, root), root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(
    "Warning: init keeps your existing .benchrouter/benchrouter.yml, and after this init it is still invalid:\n" +
    "  - .benchrouter/benchrouter.yml.product must be an object.\n"
  ), result.stdout);
});

test("doctor names the renamed eval job and a missing case file even when the manifest is invalid", { timeout: 4900 }, async (t) => {
  const root = await tempRepo(t, {
    [WORKFLOW]: renamedJobWorkflow,
    [MANIFEST]: manifest({ product: false, caseRef: "eval/missing-cases.json" })
  });
  const result = await runCli(["doctor", "--skip-github-workflow", "--api-url", "http://127.0.0.1:9"], root);
  assert.equal(result.status, 1);
  const lines = result.stderr.split("\n");
  assert.ok(lines.includes(`doctor failed: ${WORKFLOW}: requires the job to be named eval (it has jobs.evals; BenchRouter's workflow has one job named eval)`), result.stderr);
  assert.ok(lines.includes("doctor failed: .benchrouter/benchrouter.yml.product must be an object."), result.stderr);
  assert.ok(lines.includes(`doctor failed: route ${routeId}: missing declared file eval/missing-cases.json (eval_pack.case_refs[0])`), result.stderr);
});

test("doctor prints the field a 422 manifest refusal names", { timeout: 4900 }, async (t) => {
  const root = await tempRepo(t, { [MANIFEST]: manifest() });
  // The service's errorResponse body for manifestDocument's refusal (src/runner/manifest-check.ts).
  const message = ".benchrouter/benchrouter.yml: routes[0].route_id is required without surrounding whitespace";
  const server = await startServer(t, () => ({
    status: 422, body: { error: { message, type: "benchrouter_error", code: "manifest_invalid" } }
  }));
  const result = await runCli(["doctor", "--repo", "example/app", "--skip-github-workflow", "--api-url", server.url], root,
    { BENCHROUTER_ACCOUNT_TOKEN: "br_ctrl_fixture" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.split("\n").includes(`doctor failed: manifest check: HTTP 422 (manifest_invalid): ${message}`), result.stderr);
  assert.equal(server.requests.length, 1);
});

async function tempRepo(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-clear-failures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await writeFile(path.join(root, filePath), content);
  }
  return root;
}

async function startServer(t, answer) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body });
    const { status, body: reply } = answer(request);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function runCli(cliArgs, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      cwd,
      env: {
        ...process.env,
        // A closed port: the newer-version check fails fast and adds no note.
        npm_config_registry: "http://127.0.0.1:9",
        BENCHROUTER_CONFIG_DIR: path.join(cwd, ".test-config"),
        BENCHROUTER_ACCOUNT_TOKEN: "",
        BENCHROUTER_SETUP_KEY: "",
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
