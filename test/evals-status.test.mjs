import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
// Real server responses (see fixtures/search-status/README.md).
const catalog = JSON.parse(await readFile(path.join(testDir, "fixtures/search-status/catalog-owed.json"), "utf8"));
const hostedStatus = JSON.parse(await readFile(path.join(testDir, "fixtures/search-status/hosted-status-no-eval.json"), "utf8"));
const token = ["--account-token", "br_ctrl_recorded_fixture"];

test("evals status prints the hosted-eval status read's summary, next steps and spend for production (ROUTE-005)", async (t) => {
  const replay = await startFixtureServer(t, hostedStatus);
  const human = await runCli(["evals", "status", "pinned-smoke/br-b4-smoke", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, [
    "pinned-smoke/br-b4-smoke · no eval yet",
    "Search: No eval yet: the route serves its current model",
    "Eval spend: $0.00",
    "Next:",
    "  -  The search starts when the route has an eval: a merged repository eval or an approved hosted eval.",
    "Waiting: no_eval",
    "Result set: none; 0 measured, 0 reused",
    "Models:",
    "  google/gemini-2.5-flash-lite  score -  cost -  p95 -  not_comparable [baseline, serving]",
    ""
  ].join("\n"));

  const json = await runCli(["evals", "status", "pinned-smoke/br-b4-smoke", "--api-url", replay.url, ...token, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    ok: true,
    route_key: "pinned-smoke/br-b4-smoke",
    view_id: "production",
    label: "no eval yet",
    search_status: hostedStatus.search_status,
    spend_usd: 0,
    polling: false
  });
  assert.deepEqual(replay.requests, Array(2).fill({
    method: "GET", url: "/v1/hosted-evals/pinned-smoke%2Fbr-b4-smoke/status", authorization: "Bearer br_ctrl_recorded_fixture"
  }));
});

test("evals status says the search is still running while the server polls", async (t) => {
  // The live fixture with the fields of a running search (the server sets polling while the state is searching).
  const running = {
    ...hostedStatus,
    search_status: { ...hostedStatus.search_status, state: "searching", waiting: null, summary: "Searching: 0 of 4 eligible" },
    spend_usd: 0.4213,
    polling: true
  };
  const replay = await startFixtureServer(t, running);
  const human = await runCli(["evals", "status", "pinned-smoke/br-b4-smoke", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.deepEqual(human.stdout.split("\n").slice(1, 3), ["Search: Searching: 0 of 4 eligible; still running", "Eval spend: $0.42"]);
});

test("evals status --pr reads the preview context from the route catalog", async (t) => {
  const preview = { ...catalog, view_evidence: [{ ...catalog.view_evidence[0], id: "pr-76", label: "PR #76 preview" }] };
  const replay = await startFixtureServer(t, preview);
  const human = await runCli(["evals", "status", "validation/request-router", "--pr", "76", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.deepEqual(human.stdout.split("\n").slice(0, 4), [
    "validation/request-router · PR #76 preview",
    "Search: Searching: 0 of 4 eligible, broad search owed, next batch 18:17Z",
    "Next:",
    "  2026-10-27 18:17Z  A broad search resumes at the next batch (up to 10 contexts a batch)."
  ]);
  assert.deepEqual(replay.requests.map((request) => request.url), ["/v1/dashboard/routes/validation/request-router/catalog"]);
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
