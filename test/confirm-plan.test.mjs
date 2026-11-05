import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
const token = ["--account-token", "br_ctrl_recorded_fixture"];
const refreshPath = "/v1/dashboard/routes/app/chat/result-sets/ers_1/refresh-preview";

test("a confirming command in a non-interactive shell prints its plan, changes nothing and names --yes", async (t) => {
  const replay = await startServer(t, {});
  const result = await runCli(["evals", "refresh-preview", "app/chat", "ers_1", "--model", "m/1", "--api-url", replay.url, ...token]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "Plan: Refresh PR preview result set: route_key=app/chat result_set_id=ers_1 model=m/1\n");
  assert.match(result.stderr, /^Nothing was changed: this shell cannot answer a confirmation prompt\. Rerun with --yes to confirm\.\n/);
  assert.equal(replay.requests.length, 0);
});

test("JSON mode puts the plan in the confirmation_required error", async (t) => {
  const replay = await startServer(t, {});
  const result = await runCli(["evals", "run", "app/chat", "--full-refresh", "--json", "--api-url", replay.url, ...token]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    ok: false,
    error: {
      code: "confirmation_required",
      message: "Plan: Run every model of the route again (spends eval credits): route_key=app/chat. Nothing was changed. JSON mode cannot prompt; rerun with --yes to confirm."
    }
  });
  assert.equal(replay.requests.length, 0);
});

test("409 route_context_busy prints the server message and when to rerun", async (t) => {
  const busy = async (name) => ({
    status: 409,
    body: JSON.parse(await readFile(path.join(testDir, "fixtures/route-context-busy", name), "utf8"))
  });
  const known = await startServer(t, { [`POST ${refreshPath}`]: await busy("pr-known-close.json") });
  const withTime = await runCli(["evals", "refresh-preview", "app/chat", "ers_1", "--yes", "--api-url", known.url, ...token]);
  assert.equal(withTime.status, 1);
  assert.match(withTime.stderr, /^BenchRouter evals refresh-preview failed \(409\): Another eval is open on this route\.\n/);
  assert.match(withTime.stderr, /\nAn eval is already running for PR #12 \(ers_open\); it is expected to finish around 2026-11-04T23:30:00\.000Z\. Rerun this command after that\.\n/);

  const unknown = await startServer(t, { [`POST ${refreshPath}`]: await busy("production-unknown-close.json") });
  const noTime = await runCli(["evals", "refresh-preview", "app/chat", "ers_1", "--yes", "--api-url", unknown.url, ...token]);
  assert.equal(noTime.status, 1);
  assert.match(noTime.stderr, /\nAn eval is already running \(ers_open\)\. Rerun this command after that\.\n/);
});

async function startServer(t, responses) {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      const reply = responses[`${request.method} ${request.url}`];
      response.writeHead(reply?.status ?? 404, { "content-type": "application/json" });
      response.end(JSON.stringify(reply?.body ?? { error: { message: "no fixture", code: "not_found" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, requests };
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
