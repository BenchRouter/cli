import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
const pendingFixture = JSON.parse(
  await readFile(path.join(testDir, "fixtures/setup-diagnostic/imported-eval-pending.json"), "utf8")
);
const productionFixture = JSON.parse(
  await readFile(path.join(testDir, "fixtures/setup-diagnostic/production-decided.json"), "utf8")
);

test("setup status replays separate server readiness facts end to end", async (t) => {
  const replay = await startFixtureServer(t, pendingFixture);

  const text = await runCli([
    "setup", "status", "--repo", "example/app", "--api-url", replay.url,
    "--account-token", "br_ctrl_recorded_fixture"
  ]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Readiness:/);
  assert.match(text.stdout, /Registered: yes/);
  assert.match(text.stdout, /Evaluation: queued/);
  assert.match(text.stdout, /Production eligible: yes/);
  assert.match(text.stdout, /Observed serving: no/);
  assert.match(text.stdout, /Evaluation completion is not required for production eligibility/);
  assert.match(text.stdout, /historical evidence.*not a current health check/);
  assert.doesNotMatch(text.stdout, /production ready|quality certified/i);

  const json = await runCli([
    "setup", "status", "--repo", "example/app", "--api-url", replay.url,
    "--account-token", "br_ctrl_recorded_fixture", "--json"
  ]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), pendingFixture);
  assert.deepEqual(replay.requests, [
    {
      method: "GET",
      url: `/v1/setup/diagnostic?repo=${encodeURIComponent("example/app")}`,
      authorization: "Bearer br_ctrl_recorded_fixture"
    },
    {
      method: "GET",
      url: `/v1/setup/diagnostic?repo=${encodeURIComponent("example/app")}`,
      authorization: "Bearer br_ctrl_recorded_fixture"
    }
  ]);
});

test("setup status renders the recorded deployed diagnostic contract", async (t) => {
  const replay = await startFixtureServer(t, productionFixture);
  const result = await runCli([
    "setup", "status", "--repo", "BenchRouter/benchrouter", "--api-url", replay.url,
    "--account-token", "br_ctrl_recorded_fixture"
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Route: benchrouter\/catalog-identity-review/);
  assert.match(result.stdout, /Evaluation: decided/);
  assert.match(result.stdout, /Production eligible: yes/);
  assert.match(result.stdout, /Observed serving: no/);
  assert.equal(replay.requests.length, 1);
});

async function startFixtureServer(t, responseFixture) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseFixture));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function runCli(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...argv], {
      env: process.env,
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
