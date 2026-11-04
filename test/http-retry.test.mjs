import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apiRequest } from "../src/http.mjs";
import { customerPaths } from "../src/control-api.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
// A real public status read (see fixtures/reads/README.md).
const status = JSON.parse(await readFile(path.join(testDir, "fixtures/reads/public-status.json"), "utf8"));
// A recorded repo status read (see fixtures/repo-read/).
const repoStatus = JSON.parse(await readFile(path.join(testDir, "fixtures/repo-read/status.json"), "utf8"));
const catalog = JSON.parse(await readFile(path.join(testDir, "fixtures/search-status/catalog-owed.json"), "utf8"));
const token = ["--account-token", "br_ctrl_recorded_fixture"];
const unavailable = { error: { message: "BenchRouter could not serve this request. Retry shortly.", code: "temporarily_unavailable" } };
const feedbackHint = "If BenchRouter's docs don't explain this, report it: benchrouter feedback --kind doc_gap '<what happened>'\n";

test("a read that gets 503 with a short Retry-After is sent once more, then succeeds", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [
    { status: 503, headers: { "retry-after": "1" }, body: unavailable },
    { status: 200, body: status }
  ]);
  const started = Date.now();
  const result = await runCli(["public", "status", "--json", "--api-url", replay.url]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), status);
  assert.deepEqual(replay.requests, ["GET /v1/status", "GET /v1/status"]);
  assert.ok(Date.now() - started >= 1000, "waited for Retry-After");
});

test("a read is not repeated when Retry-After is missing or longer than 10 seconds, or after a second 503", { timeout: 4900 }, async (t) => {
  const malformed = ["soon", "+0", "0x0", "1e-6", "01", "-1", "2020-01-01"].map((value) => ({ "retry-after": value }));
  for (const headers of [{}, { "retry-after": "120" }, ...malformed]) {
    const replay = await startServer(t, [{ status: 503, headers, body: unavailable }, { status: 200, body: status }]);
    const result = await runCli(["public", "status", "--api-url", replay.url]);
    assert.equal(result.status, 1, JSON.stringify(headers));
    assert.match(result.stderr, /failed \(503\): BenchRouter could not serve this request\. Retry shortly\./);
    assert.deepEqual(replay.requests, ["GET /v1/status"], JSON.stringify(headers));
  }
  const twice = await startServer(t, [
    { status: 503, headers: { "retry-after": "0" }, body: unavailable },
    { status: 503, headers: { "retry-after": "0" }, body: unavailable },
    { status: 200, body: status }
  ]);
  const result = await runCli(["public", "status", "--api-url", twice.url]);
  assert.equal(result.status, 1);
  assert.deepEqual(twice.requests, ["GET /v1/status", "GET /v1/status"]);
});

test("a Retry-After given as an HTTP date within 10 seconds is honoured", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [
    { status: 503, headers: { "retry-after": new Date(Date.now() + 1000).toUTCString() }, body: unavailable },
    { status: 200, body: status }
  ]);
  const result = await runCli(["public", "status", "--json", "--api-url", replay.url]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(replay.requests, ["GET /v1/status", "GET /v1/status"]);
});

test("the caller's signal ends the Retry-After wait at once", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [{ status: 503, headers: { "retry-after": "10" }, body: unavailable }, { status: 200, body: status }]);
  const controller = new AbortController();
  const started = Date.now();
  const pending = apiRequest({ apiUrl: replay.url, path: "/v1/status", label: "public status", signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(pending, /BenchRouter public status request failed/);
  assert.ok(Date.now() - started < 2000, `ended after ${Date.now() - started} ms`);
  assert.deepEqual(replay.requests, ["GET /v1/status"]);
});

test("a repo read (status) retries a 503 with a short Retry-After the same way", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [
    { status: 503, headers: { "retry-after": "0" }, body: unavailable },
    { status: 200, body: repoStatus }
  ]);
  const result = await runCli(["status", "--repo", "example/app", "--setup-key", "br_setup_recorded_fixture", "--json", "--api-url", replay.url]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), repoStatus);
  assert.deepEqual(replay.requests, ["GET /v1/repo/status", "GET /v1/repo/status"]);

  const once = await startServer(t, [{ status: 503, body: { message: "Try again later." } }]);
  const failed = await runCli(["status", "--repo", "example/app", "--setup-key", "br_setup_recorded_fixture", "--api-url", once.url]);
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, "BenchRouter status failed (503): Try again later.\n" + feedbackHint);
  assert.deepEqual(once.requests, ["GET /v1/repo/status"]);
});

test("a repo read still refuses an empty successful body", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [{ status: 200, raw: "" }]);
  const result = await runCli(["status", "--repo", "example/app", "--setup-key", "br_setup_recorded_fixture", "--api-url", replay.url]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "BenchRouter status returned invalid JSON.\n" + feedbackHint);
});

test("a write that gets 503 with Retry-After is never sent again", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [{ status: 503, headers: { "retry-after": "0" }, body: unavailable }, { status: 200, body: {} }]);
  const result = await runCli(["routes", "create", "--name", "Triage", "--model", "openai/gpt-5.4-mini", "--group", "Support", "--yes", "--api-url", replay.url, ...token]);
  assert.equal(result.status, 1);
  assert.deepEqual(replay.requests, ["POST /v1/control/routes"]);
});

test("an evals status catalog GET retries its first timeout, then returns the response", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [{ stall: true }, { status: 200, body: catalog }]);
  const spec = customerPaths.routeCatalog("pinned-smoke/br-b4-smoke", "evals status");
  const result = await apiRequest({ apiUrl: replay.url, ...spec, timeoutMs: 300 });
  assert.deepEqual(result, catalog);
  assert.deepEqual(replay.requests, [`GET ${spec.path}`, `GET ${spec.path}`]);
});

test("a GET that times out twice names the request and suggests a later retry", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [{ stall: true }, { stall: true }]);
  await assert.rejects(apiRequest({ apiUrl: replay.url, path: "/v1/status", label: "public status", timeoutMs: 300 }), (error) => {
    assert.equal(error.message, "BenchRouter public status request (GET /v1/status) timed out. Retry in a minute.");
    return true;
  });
  assert.deepEqual(replay.requests, ["GET /v1/status", "GET /v1/status"]);
});

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) test(`a timed out ${method} is never repeated`, { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [{ stall: true }, { status: 200, body: {} }]);
  await assert.rejects(apiRequest({ apiUrl: replay.url, path: "/v1/feedback", method, label: "write", timeoutMs: 300 }), (error) => error.timedOut === true);
  assert.deepEqual(replay.requests, [`${method} /v1/feedback`]);
});

test("a caller cancellation is not retried as a GET timeout", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [{ stall: true }]);
  const controller = new AbortController();
  const pending = apiRequest({ apiUrl: replay.url, path: "/v1/status", label: "public status", timeoutMs: 1000, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 300);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, (error) => error.timedOut === false);
  assert.deepEqual(replay.requests, ["GET /v1/status"]);
});

test("GET timeout and 503 retries each keep their own single retry", { timeout: 4900 }, async (t) => {
  for (const replies of [
    [{ stall: true }, { status: 503, headers: { "retry-after": "0" }, body: unavailable }, { status: 200, body: status }],
    [{ status: 503, headers: { "retry-after": "0" }, body: unavailable }, { stall: true }, { status: 200, body: status }]
  ]) {
    const replay = await startServer(t, replies);
    assert.deepEqual(await apiRequest({ apiUrl: replay.url, path: "/v1/status", label: "public status", timeoutMs: 300 }), status);
    assert.equal(replay.requests.length, 3);
  }
});

/** Answers each request with the next scripted reply; records "METHOD path" for each. */
async function startServer(t, replies) {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      const reply = replies[requests.length - 1] ?? { status: 500, body: { error: { message: "unscripted request" } } };
      if (reply.stall) return;
      response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      response.end(reply.raw ?? JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function runCli(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
