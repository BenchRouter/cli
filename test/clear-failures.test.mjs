// A cold-read panel (2026-11-27) found inputs where init and doctor crashed or hid the field at
// fault. Each test runs the real CLI process against a temporary repository and a local server
// that answers with the service's response shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("init refuses a recorded route with no base URL env before writing or committing setup", async (t) => {
  const recordedRoute = await readFile(path.join(testDir, "fixtures/setup-packet/route-without-base-url-env.yml"), "utf8");
  const preview = manifest() + recordedRoute;
  const server = await startServer(t, () => ({
    status: 200, body: packet([
      { path: WORKFLOW, content: stubWorkflow },
      { path: MANIFEST, content: preview }
    ])
  }));

  for (const existing of [false, true]) {
    const root = await tempRepo(t, existing ? { [MANIFEST]: manifest() } : {});
    const before = await readdir(root, { recursive: true });
    const args = [
      "init", "--setup-key", "br_setup_fixture", "--route", "app/panel-summarize",
      "--name", "Panel Summarize", "--incumbent-model", "anthropic/claude-haiku-5.5",
      "--api-family", "anthropic_messages", "--code-ref", "src/summarize.ts",
      "--api-url", server.url, "--output-dir", root
    ];
    for (const mode of [["--dry-run"], []]) {
      const result = await runCli([...args, ...mode], root);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /routes\[1\]\.call_site\.base_url_env is required/);
      assert.match(result.stderr, /Pass --base-url-env <name> and update the call site to read its LLM base URL from that environment variable/);
      assert.deepEqual(await readdir(root, { recursive: true }), before);
      if (existing) assert.equal(await readFile(path.join(root, MANIFEST), "utf8"), manifest());
    }
  }
  assert.deepEqual(server.requests.map(({ body }) => JSON.parse(body).dry_run), [true, true, true, true]);
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

// Each file holds a secret where a YAML parser would quote it: a source line, an unresolved
// alias name, and an unsupported version directive.
const secret = "sk-panel-secret-value";
const badYaml = [
  ["a nested mapping", `version: 1\nroutes: [\n  token: ${secret}\n`, /BAD_INDENT at line 4, column 1/],
  ["an unresolved alias", `version: 1\nroutes:\n  - token: *${secret}\n`, /UNRESOLVED_ALIAS at line 3, column 12/],
  ["an unsupported version", `%YAML 9.${secret}\n---\nversion: 1\n`, /BAD_DIRECTIVE at line 1, column 7/]
];

for (const [label, source, problem] of badYaml) {
  test(`doctor and init name ${label} by code and line without printing the file`, { timeout: 4900 }, async (t) => {
    const root = await tempRepo(t, { [MANIFEST]: source });
    // The service's manifest_yaml_invalid body carries the yaml parser's message, which quotes the file.
    const server = await startServer(t, (request) => request.url === "/v1/repo/manifest-check"
      ? { status: 422, body: { error: { message: `not valid YAML:\n\n  ${secret}\n`, type: "benchrouter_error", code: "manifest_yaml_invalid" } } }
      : { status: 200, body: packet([{ path: MANIFEST, content: manifest() }]) });
    const doctor = await runCli(["doctor", "--repo", "example/app", "--skip-github-workflow", "--api-url", server.url], root,
      { BENCHROUTER_ACCOUNT_TOKEN: "br_ctrl_fixture" });
    assert.equal(doctor.status, 1);
    const lines = doctor.stderr.split("\n");
    assert.ok(lines.some((line) => line.startsWith("doctor failed: manifest check: HTTP 422 (manifest_yaml_invalid): .benchrouter/benchrouter.yml is not valid YAML: ") && problem.test(line)), doctor.stderr);
    assert.ok(lines.some((line) => line.startsWith("doctor failed: .benchrouter/benchrouter.yml is not valid YAML: ") && problem.test(line)), doctor.stderr);
    const init = await runCli(initArgs(server.url, root), root);
    assert.equal(init.status, 1);
    assert.match(init.stderr, problem);
    for (const output of [doctor.stdout, doctor.stderr, init.stdout, init.stderr]) assert.ok(!output.includes(secret), output);
  });
}

test("a login-only init on a repository with no group names the setup-key command", { timeout: 4900 }, async (t) => {
  const root = await tempRepo(t, {});
  // The service's refusal for a login on a repository with no group (handleCreateSetupPacketForActor).
  const server = await startServer(t, () => ({ status: 404, body: { error: {
    message: "This repository has no BenchRouter group yet.", type: "benchrouter_error", code: "repo_not_found"
  } } }));
  const args = initArgs(server.url, root).filter((value, index, all) => value !== "--setup-key" && all[index - 1] !== "--setup-key");
  const result = await runCli([...args, "--repo", "example/app"], root, { BENCHROUTER_ACCOUNT_TOKEN: "br_ctrl_fixture" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.startsWith("repo_not_found: example/app has no BenchRouter group yet"), result.stderr);
  assert.ok(result.stderr.includes("  npx --yes benchrouter@latest setup create --repo example/app --yes\n"), result.stderr);
});
