import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
// A real route catalog response's search status (see fixtures/search-status/README.md).
const catalog = JSON.parse(await readFile(path.join(testDir, "fixtures/search-status/catalog-owed.json"), "utf8"));
const token = ["--account-token", "br_ctrl_recorded_fixture"];

test("evals status renders the production context's search status from the route catalog read", async (t) => {
  const replay = await startFixtureServer(t, catalog);
  const human = await runCli(["evals", "status", "validation/request-router", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, [
    "validation/request-router · Production",
    "State: owed. Searching: 0 of 4 eligible, broad search owed, next batch 18:17Z",
    "Result set: rs_val_production_seed; 3 measured, 0 reused",
    "Models:",
    "  deepseek/deepseek-v4-flash    score 1.000  cost $0.0100  p95 350ms  eligible [serving]",
    "  google/gemini-2.5-flash-lite  score 1.000  cost $0.0200  p95 400ms  baseline",
    "  openai/gpt-oss-20b            score 0.200  cost $0.0050  p95 350ms  low_pass_rate",
    "Next:",
    "  2026-10-27 18:17Z  A broad search resumes at the next batch (up to 10 contexts a batch).",
    ""
  ].join("\n"));

  const json = await runCli(["evals", "status", "validation/request-router", "--api-url", replay.url, ...token, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    ok: true,
    route_key: "validation/request-router",
    view_id: "production",
    label: "Production",
    search_status: catalog.view_evidence[0].search_status
  });
  assert.deepEqual(replay.requests, Array(2).fill({
    method: "GET", url: "/v1/dashboard/routes/validation/request-router/catalog", authorization: "Bearer br_ctrl_recorded_fixture"
  }));
});

test("evals status --pr names a missing preview, and evals list leads with each context's summary", async (t) => {
  const replay = await startFixtureServer(t, catalog);
  const missing = await runCli(["evals", "status", "validation/request-router", "--pr", "76", "--api-url", replay.url, ...token]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No open PR #76 preview evidence on validation\/request-router\./);

  for (const bad of ["seven", "0x4c", "7.6e1", "0"]) {
    const badPr = await runCli(["evals", "status", "validation/request-router", "--pr", bad, "--api-url", replay.url, ...token]);
    assert.notEqual(badPr.status, 0, bad);
    assert.match(badPr.stderr, /--pr must be a pull request number/, bad);
  }
  // A bad --pr is refused before any request.
  assert.equal(replay.requests.length, 1);

  const list = await runCli(["evals", "list", "validation/request-router", "--api-url", replay.url, ...token]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.split("\n")[0], "Production: Searching: 0 of 4 eligible, broad search owed, next batch 18:17Z");
  const listJson = await runCli(["evals", "list", "validation/request-router", "--api-url", replay.url, ...token, "--json"]);
  assert.equal(listJson.status, 0, listJson.stderr);
  assert.deepEqual(JSON.parse(listJson.stdout), {
    ok: true,
    route_key: "validation/request-router",
    eval_history: [],
    evals: {},
    latest_eval_batch: null,
    search_status: { production: catalog.view_evidence[0].search_status }
  });
});

async function startFixtureServer(t, responseFixture) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null });
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
    const child = spawn(process.execPath, [cliPath, ...argv], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
