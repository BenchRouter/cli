import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apiRequest } from "../src/http.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
// A real public status read (see fixtures/reads/README.md).
const status = JSON.parse(await readFile(path.join(testDir, "fixtures/reads/public-status.json"), "utf8"));
const token = ["--account-token", "br_ctrl_recorded_fixture"];
const unavailable = { error: { message: "BenchRouter could not serve this request. Retry shortly.", code: "temporarily_unavailable" } };

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

test("a write that gets 503 with Retry-After is never sent again", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, [{ status: 503, headers: { "retry-after": "0" }, body: unavailable }, { status: 200, body: {} }]);
  const result = await runCli(["routes", "create", "--name", "Triage", "--model", "openai/gpt-5.4-mini", "--group", "Support", "--yes", "--api-url", replay.url, ...token]);
  assert.equal(result.status, 1);
  assert.deepEqual(replay.requests, ["POST /v1/control/routes"]);
});

/** Answers each request with the next scripted reply; records "METHOD path" for each. */
async function startServer(t, replies) {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      const reply = replies[requests.length - 1] ?? { status: 500, body: { error: { message: "unscripted request" } } };
      response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
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
