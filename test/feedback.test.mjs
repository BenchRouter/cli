import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLI_VERSION } from "../src/version.mjs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const cli = fileURLToPath(new URL("../bin/benchrouter.mjs", import.meta.url));
const sent = { object: "customer_feedback", id: "fb_test", kind: "other", created_at: "2026-11-04T12:00:00Z" };
const hint = "If BenchRouter's docs don't explain this, report it:";
const account = "br_ctrl_feedback_test";
const setup = "br_setup_feedback_test";

test("feedback prefers the account login and adds git and workflow context", { timeout: 4900 }, async (t) => {
  const root = await target(t);
  for (const args of [["init", "--quiet"], ["remote", "add", "origin", "https://github.com/example/app.git"]]) {
    assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
  }
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  const workflow = parseYaml(await readFile(new URL("fixtures/signed-kit/workflow.yml", import.meta.url), "utf8"));
  workflow.jobs.eval.steps.find((step) => step.id === "benchrouter_runtime").env.BENCHROUTER_KIT_VERSION = "0.2.4";
  await writeFile(path.join(root, ".github/workflows/benchrouter-evals.yml"), stringifyYaml(workflow));
  const server = await replay(t);
  const result = await run(root, ["feedback", "--kind", "doc_gap", "--route", "app/chat", "--command", "benchrouter evals status app/chat --pr 7", "--error-code", "request_timeout", "What does this error mean?", "--setup-key", setup, "--api-url", server.url], { BENCHROUTER_ACCOUNT_TOKEN: account });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Feedback sent: fb_test\n");
  assert.equal(result.stderr, "");
  assert.equal(server.requests.length, 1);
  const request = server.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/feedback");
  assert.ok(request.authorization === `Bearer ${account}`, "account credential takes precedence");
  assert.deepEqual(request.body, {
    message: "What does this error mean?", kind: "doc_gap",
    context: { repo_full_name: "example/app", route: "app/chat", cli_version: CLI_VERSION, kit_version: "0.2.4", command: "benchrouter evals status app/chat --pr 7", error_code: "request_timeout" }
  });
});

for (const source of ["argument", "environment", "saved"]) test(`feedback accepts a ${source} setup key and JSON output`, { timeout: 4900 }, async (t) => {
  const root = await target(t);
  const server = await replay(t);
  if (source === "saved") {
    const dir = path.join(root, "config/repositories");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${Buffer.from("example/app").toString("base64url")}.json`), JSON.stringify({ repo_full_name: "example/app", token: setup }), { mode: 0o600 });
  }
  const result = await run(root, ["feedback", "A question", "--repo", "example/app", "--json", "--api-url", server.url, ...(source === "argument" ? ["--setup-key", setup] : [])], source === "environment" ? { BENCHROUTER_SETUP_KEY: setup } : {});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), sent);
  assert.ok(server.requests[0].authorization === `Bearer ${setup}`, "setup credential sent");
  assert.deepEqual(server.requests[0].body, { message: "A question", kind: "other", context: { repo_full_name: "example/app", cli_version: CLI_VERSION } });
});

test("feedback uses a saved account login without a repository or workflow", { timeout: 4900 }, async (t) => {
  const root = await target(t);
  const server = await replay(t);
  const saved = await run(root, ["account", "token", "save", "--account-token", account]);
  assert.equal(saved.status, 0, saved.stderr);
  const result = await run(root, ["feedback", "A question", "--api-url", server.url]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(server.requests[0].authorization === `Bearer ${account}`, "saved account credential sent");
  assert.deepEqual(server.requests[0].body.context, { cli_version: CLI_VERSION });
});

test("feedback validates message, kind, command, repo and flags before a request", { timeout: 4900 }, async (t) => {
  const root = await target(t);
  const server = await replay(t);
  for (const args of [[], [""], ["   "], ["x".repeat(8001)], ["one", "two"], ["message", "--kind"], ["message", "--kind", "gap"], ["message", "--command", "x".repeat(501)], ["message", "--repo", "bad/repo/extra"], ["message", "--typo", "value"], ["message", "--error-code", "x".repeat(65536)]]) {
    const result = await run(root, ["feedback", ...args, "--account-token", account, "--api-url", server.url]);
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes(hint), "usage errors have no feedback hint");
  }
  assert.equal(server.requests.length, 0);
});

for (const flag of ["--account-token", "--setup-key"]) test(`feedback refuses wrong credential scopes via ${flag}`, { timeout: 4900 }, async (t) => {
  const root = await target(t);
  const server = await replay(t);
  for (const token of ["br_live_wrong_scope", "br_test_wrong_scope", "bradm_wrong_scope", "br_mcp_wrong_scope"]) {
    const result = await run(root, ["feedback", "A question", flag, token, "--api-url", server.url]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("benchrouter login"));
    assert.ok(!result.stderr.includes(token));
    assert.ok(!result.stderr.includes(hint));
  }
  assert.equal(server.requests.length, 0);
});

const errors = [
  [400, { error: { code: "invalid_feedback", field: "context.command", message: "REMOTE_SECRET" } }, "Invalid feedback field: context.command"],
  [400, { error: { code: "invalid_feedback", field: "REMOTE_SECRET" } }, "Invalid feedback. Check"],
  ...["auth_required", "control_token_invalid", "control_token_expired"].map((code) => [401, { error: { code, message: "REMOTE_SECRET" } }, "Run benchrouter login"]),
  ...["read_token_invalid", "read_scope_expired"].map((code) => [401, { error: code }, "setup key is invalid or expired"]),
  [403, { error: { code: "access_changed", message: "REMOTE_SECRET" } }, "access changed"],
  [413, { error: { code: "payload_too_large", message: "REMOTE_SECRET" } }, "exceeds 64 KiB"],
  [429, { error: { code: "feedback_limit_reached", message: "REMOTE_SECRET" } }, "20 per person per 24 hours", { "retry-after": "60" }],
  [503, { error: { code: "temporarily_unavailable", message: "REMOTE_SECRET" } }, "temporarily unavailable", { "retry-after": "0" }],
  [500, { message: "REMOTE_SECRET" }, "could not accept feedback"]
];
for (const [status, body, expected, headers] of errors) test(`feedback safely explains ${status} ${body.error?.code ?? body.error ?? "unknown"}`, { timeout: 4900 }, async (t) => {
  const root = await target(t);
  const server = await replay(t, { status, body, headers });
  for (const json of [false, true]) {
    const result = await run(root, ["feedback", "A question", "--setup-key", setup, "--api-url", server.url, ...(json ? ["--json"] : [])]);
    assert.equal(result.status, 1);
    const message = json ? JSON.parse(result.stderr).error.message : result.stderr;
    assert.ok(message.includes(expected), message);
    assert.ok(!result.stderr.includes("REMOTE_SECRET"));
    assert.ok(!result.stderr.includes(hint));
    if (status === 429) {
      const date = message.slice(message.indexOf("Retry after ") + 12).trim().slice(0, -1);
      assert.ok(Date.parse(date) >= Date.now() + 55000, "Retry-After reported as a future time");
    }
  }
  assert.equal(server.requests.length, status === 503 ? 4 : 2);
});

test("feedback retries a 503 once, then succeeds", { timeout: 4900 }, async (t) => {
  const root = await target(t);
  const server = await replay(t, (index) => index === 0
    ? { status: 503, body: { error: { code: "temporarily_unavailable" } }, headers: { "retry-after": "0" } }
    : { status: 201, body: sent });
  const result = await run(root, ["feedback", "A question", "--setup-key", setup, "--api-url", server.url]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(server.requests.length, 2);
});

test("feedback without a receipt is not reported as sent", { timeout: 4900 }, async (t) => {
  const root = await target(t);
  for (const reply of [{ status: 200, body: {} }, { status: 201, body: { object: "customer_feedback", id: "nope" } }]) {
    const server = await replay(t, reply);
    const result = await run(root, ["feedback", "A question", "--setup-key", setup, "--api-url", server.url]);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(!result.stdout.includes("Feedback sent"), result.stdout);
    assert.ok(result.stderr.includes("BenchRouter did not return a feedback receipt."), result.stderr);
  }
});

test("the generic error hint appears only in human fail output", { timeout: 4900 }, async (t) => {
  const root = await target(t);
  const human = await run(root, ["routes", "list"]);
  assert.equal(human.status, 1);
  assert.ok(human.stderr.includes(`${hint} benchrouter feedback --kind doc_gap '<what happened>'`));
  const json = await run(root, ["routes", "list", "--json"]);
  assert.equal(json.status, 1);
  assert.ok(!JSON.parse(json.stderr).error.message.includes(hint));
  const usage = await run(root, ["feedback", "--kind", "bad", "message"]);
  assert.equal(usage.status, 1);
  assert.ok(!usage.stderr.includes(hint));
});

async function target(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "feedback-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function replay(t, reply = { status: 201, body: sent }) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
    const next = typeof reply === "function" ? reply(requests.length - 1) : reply;
    response.writeHead(next.status, { "content-type": "application/json", ...next.headers });
    response.end(JSON.stringify(next.body));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function run(root, args, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root, timeout: 4000,
      env: { ...process.env, BENCHROUTER_CONFIG_DIR: path.join(root, "config"), BENCHROUTER_ACCOUNT_TOKEN: "", BENCHROUTER_SETUP_KEY: "", npm_config_registry: "http://127.0.0.1:9", ...overrides }
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      assert.ok(!`${stdout}${stderr}`.includes(account) && !`${stdout}${stderr}`.includes(setup), "credentials are not printed");
      resolve({ status, stdout, stderr });
    });
  });
}
