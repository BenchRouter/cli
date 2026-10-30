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
// A real pin read (see fixtures/routes/README.md); the pinned route below is that body for a hosted product.
const repoRoutePin = JSON.parse(await readFile(path.join(testDir, "fixtures/routes/pin-repo-route.json"), "utf8"));
const groupRequired = JSON.parse(await readFile(path.join(testDir, "fixtures/routes/group-required.json"), "utf8"));
const pinnedRoute = {
  ...repoRoutePin,
  route_key: "support/triage",
  product: { productId: "prod_support", source: "hosted", displayName: "Support", repo: null },
  model: "openai/gpt-5.4-mini",
  route_id: "route_support_triage_g2",
  repin_blocked_reason: null,
  history: [
    { model: "openai/gpt-5.4-mini", pinned_at: "2026-10-20T10:00:00.000Z", ended_at: null },
    { model: "google/gemini-2.5-flash-lite", pinned_at: "2026-10-01T09:30:00.000Z", ended_at: "2026-10-20T10:00:00.000Z" }
  ]
};

test("routes pin shows the pin, and a re-pin sends the read generation as expected_route_id (ROUTE-004)", async (t) => {
  const repinned = { ...pinnedRoute, model: "deepseek/deepseek-v4-flash", route_id: "route_support_triage_g3", previous_model: "openai/gpt-5.4-mini" };
  const replay = await startServer(t, {
    "GET /v1/control/routes/support%2Ftriage/pin": pinnedRoute,
    "POST /v1/control/routes/support%2Ftriage/pin": repinned,
    "GET /v1/control/routes/timeywimey%2Fvoice-places/pin": repoRoutePin
  });
  const show = await runCli(["routes", "pin", "support/triage", "--api-url", replay.url, ...token]);
  assert.equal(show.status, 0, show.stderr);
  assert.equal(show.stdout, [
    "support/triage serves openai/gpt-5.4-mini (route_support_triage_g2)",
    "Re-pin: allowed",
    "History:",
    "  2026-10-20 10:00Z to now  openai/gpt-5.4-mini",
    "  2026-10-01 09:30Z to 2026-10-20 10:00Z  google/gemini-2.5-flash-lite",
    ""
  ].join("\n"));

  const refused = await runCli(["routes", "pin", "support/triage", "--model", "deepseek/deepseek-v4-flash", "--api-url", replay.url, ...token, "--json"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires --yes/);

  const pin = await runCli(["routes", "pin", "support/triage", "--model", "deepseek/deepseek-v4-flash", "--yes", "--api-url", replay.url, ...token]);
  assert.equal(pin.status, 0, pin.stderr);
  assert.equal(pin.stdout, "support/triage now serves deepseek/deepseek-v4-flash (was openai/gpt-5.4-mini); generation route_support_triage_g3.\n");

  const repo = await runCli(["routes", "pin", "timeywimey/voice-places", "--model", "openai/gpt-6-luna", "--yes", "--api-url", replay.url, ...token]);
  assert.notEqual(repo.status, 0);
  assert.match(repo.stderr, /timeywimey\/voice-places cannot be re-pinned \(repo_route\)\./);

  // Only the confirmed re-pin of support/triage wrote.
  assert.deepEqual(replay.requests.filter((request) => request.method === "POST"), [{
    method: "POST", url: "/v1/control/routes/support%2Ftriage/pin", body: { model: "deepseek/deepseek-v4-flash", expected_route_id: "route_support_triage_g2" }
  }]);
});

test("routes create sends a new group, optional slugs, or a group id (SERVE-001)", { timeout: 4900 }, async (t) => {
  const created = { ...pinnedRoute, route_id: "route_support_triage_g1", history: pinnedRoute.history.slice(0, 1), group_created: true };
  const replay = await startServer(t, { "POST /v1/control/routes": created });
  const base = ["routes", "create", "--name", "Triage", "--model", "openai/gpt-5.4-mini", "--yes", "--api-url", replay.url, ...token];

  const human = await runCli([...base, "--group", "Support", "--route-slug", "triage"]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, [
    "Created support/triage serving openai/gpt-5.4-mini (route_support_triage_g1); created its group.",
    "Point the app at it with a key: benchrouter keys create --product-id prod_support",
    ""
  ].join("\n"));
  const slug = await runCli([...base, "--group", "Support", "--group-slug", "support", "--route-slug", "triage", "--json"]);
  assert.equal(slug.status, 0, slug.stderr);
  assert.deepEqual(JSON.parse(slug.stdout), created);
  // Existing groups do not print the group-created message; product remains the response's internal name.
  replay.responses["POST /v1/control/routes"] = { ...created, group_created: false };
  const existing = await runCli([...base, "--group-id", "prod_support"]);
  assert.equal(existing.status, 0, existing.stderr);
  assert.doesNotMatch(existing.stdout, /created its group/);
  assert.match(existing.stdout, /keys create --product-id prod_support/);
  assert.deepEqual(replay.requests, [
    { method: "POST", url: "/v1/control/routes", body: { name: "Triage", model: "openai/gpt-5.4-mini", route_slug: "triage", group: { name: "Support" } } },
    { method: "POST", url: "/v1/control/routes", body: { name: "Triage", model: "openai/gpt-5.4-mini", route_slug: "triage", group: { name: "Support", slug: "support" } } },
    { method: "POST", url: "/v1/control/routes", body: { name: "Triage", model: "openai/gpt-5.4-mini", group_id: "prod_support" } }
  ]);
});

test("routes create requires exactly one group choice and rejects removed product flags before HTTP", { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, {});
  const base = ["routes", "create", "--name", "Triage", "--model", "openai/gpt-5.4-mini", "--yes", "--api-url", replay.url, ...token];
  for (const [extra, message] of [
    [[], /exactly one of --group <name> or --group-id <id>/],
    [["--group", "Support", "--group-id", "prod_support"], /exactly one of --group <name> or --group-id <id>/],
    [["--group-id", "prod_support", "--group-slug", "support"], /--group-slug goes with --group/],
    [["--group"], /--group needs a value/],
    [["--group-id="], /--group-id needs a value/],
    [["--group", "Support", "--group-slug"], /--group-slug needs a value/],
    ...["product", "product-slug", "product-id"].flatMap((flag) => [
      [[`--${flag}`, "old"], new RegExp(`Unknown option --${flag}`)],
      [["--group", "Support", `--${flag}`, "old"], new RegExp(`Unknown option --${flag}`)]
    ])
  ]) {
    const bad = await runCli([...base, ...extra]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, message);
  }
  assert.deepEqual(replay.requests, []);
});

for (const json of [false, true]) test(`routes create renders the recorded H8 group_required refusal (${json ? "JSON" : "text"})`, { timeout: 4900 }, async (t) => {
  const replay = await startServer(t, { "POST /v1/control/routes": groupRequired }, 400);
  const result = await runCli(["routes", "create", "--name", "br-h8-new", "--model", "anthropic/claude-haiku-4.5", "--group", "br-h8", "--yes", "--api-url", replay.url, ...token, ...(json ? ["--json"] : [])]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const message = `BenchRouter routes create failed (400): ${groupRequired.error.message}`;
  if (json) assert.deepEqual(JSON.parse(result.stderr), { ok: false, error: { code: "group_required", message } });
  else assert.ok(result.stderr.includes(message), result.stderr);
  assert.deepEqual(replay.requests, [{ method: "POST", url: "/v1/control/routes", body: { name: "br-h8-new", model: "anthropic/claude-haiku-4.5", group: { name: "br-h8" } } }]);
});

test("route create help uses group flags and has no product aliases", { timeout: 4900 }, async () => {
  for (const args of [["routes", "--help"], ["routes", "create", "--help"]]) {
    const result = await runCli(args);
    assert.equal(result.status, 0, result.stderr);
    for (const flag of ["--group", "--group-slug", "--group-id"]) assert.ok(result.stdout.includes(flag));
    assert.doesNotMatch(result.stdout, /--product/);
  }
});

async function startServer(t, responses, status = 200) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: text ? JSON.parse(text) : null });
      const body = responses[`${request.method} ${request.url}`];
      response.writeHead(body ? status : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(body ?? { error: { message: `no fixture for ${request.method} ${request.url}`, code: "not_found" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, requests, responses };
}

function runCli(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI exceeded 4 s")); }, 4000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (status) => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
  });
}
