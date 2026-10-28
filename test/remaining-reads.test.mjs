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
const fixture = async (name) => JSON.parse(await readFile(path.join(testDir, "fixtures/reads", name), "utf8"));
// Real responses (see fixtures/reads/README.md).
const activity = await fixture("route-activity.json");
const status = await fixture("public-status.json");
const frontier = await fixture("public-frontier.json");

test("routes activity and routes startup-failures print the route page's activity and blocked startups (ROUTE-006, RUN-001)", async (t) => {
  const failure = (id) => ({
    blocked_event_id: id, context_key: "production", purpose: "work", pr_number: null, blocked_at: "2026-10-28T10:00:00.000Z",
    message: "GitHub did not start the BenchRouter worker job.", can_unblock: true, retry_at: "2026-10-28T11:00:00.000Z"
  });
  const replay = await startServer(t, {
    "GET /v1/dashboard/routes/timeywimey/voice-places/activity": [200, activity],
    "GET /v1/dashboard/routes/demo/app/catalog": [200, { route_key: "demo/app", startup_failures: [failure("evt_1"), failure("evt_2")] }],
    "GET /v1/dashboard/routes/demo/app/startup-details?blocked_event_id=evt_1": [200, {
      blocked_event_id: "evt_1", failed_at: "2026-10-28T10:00:00.000Z", github_run_url: "https://github.com/demo/app/actions/runs/1",
      github_actions_url: "https://github.com/demo/app/actions", annotations: ["Process completed with exit code 1."], truncated: false, unavailable: false
    }],
    "GET /v1/dashboard/routes/demo/app/startup-details?blocked_event_id=evt_2": [409, {
      error: { message: "This startup failure is no longer current. Check again.", code: "startup_failure_stale" }
    }]
  });
  const human = await runCli(["routes", "activity", "timeywimey/voice-places", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, [
    "timeywimey/voice-places: up_to_date (background_coverage); coverage complete",
    "Models: 59 total; 59 done (1 measured, 58 reused), 0 failed, 0 running, 0 queued, 0 pending, 0 skipped",
    "Result set: erset_2b2861d6bf7d48ada4480e199eaad99e; requested 2026-10-28 12:24Z, started 2026-10-28 12:24Z, completed 2026-10-28 12:24Z",
    "GitHub run: https://github.com/patelnav/timeywimey/actions/runs/40687469899",
    ""
  ].join("\n"));

  const startups = await runCli(["routes", "startup-failures", "demo/app", "--api-url", replay.url, ...token]);
  assert.equal(startups.status, 0, startups.stderr);
  const blocked = "production (work): blocked 2026-10-28 10:00Z; automatic retry 2026-10-28 11:00Z; benchrouter blocks unblock --route demo/app clears it";
  assert.equal(startups.stdout, [
    blocked,
    "  GitHub did not start the BenchRouter worker job.",
    "  GitHub run: https://github.com/demo/app/actions/runs/1",
    "  | Process completed with exit code 1.",
    blocked,
    "  GitHub did not start the BenchRouter worker job.",
    "  No longer current: read the route again.",
    ""
  ].join("\n"));
});

test("billing activity pages with the server's cursor, and billing statement prints the period (BILL-001)", async (t) => {
  const cursor = '{"at":"2026-10-20T00:00:00.000Z","id":"bill_2"}';
  const page = {
    ok: true, from: "2026-10-01T00:00:00.000Z", to: "2026-10-28T00:00:00.000Z", next_cursor: cursor,
    entries: [
      { id: "bill_1", kind: "credit", amount_usd: 25, description: "Stripe auto reload", created_at: "2026-10-27T20:42:00.000Z", route_key: null },
      { id: "bill_2", kind: "eval", amount_usd: -0.0035, description: "Eval model call", created_at: "2026-10-20T00:00:00.000Z", route_key: "demo/app" }
    ]
  };
  const statement = {
    ok: true, from: page.from, to: page.to, balance_usd: 26.09, opening_balance_usd: 15.91, closing_balance_usd: 26.09,
    credits_usd: 275, debits_usd: 264.82, net_change_usd: 10.18,
    routes: [{ route_id: "route_1", route_key: "demo/app", archived: false, runtime_usd: 28.7, eval_usd: 32.83, total_usd: 61.53 }]
  };
  const range = `from=${encodeURIComponent(page.from)}&to=${encodeURIComponent(page.to)}`;
  const replay = await startServer(t, {
    [`GET /v1/billing/activity?${range}`]: [200, page],
    [`GET /v1/billing/activity?${range}&cursor=${encodeURIComponent(cursor)}`]: [200, { ...page, entries: [], next_cursor: null }],
    [`GET /v1/billing/activity?${range}&section=summary`]: [200, statement]
  });
  const args = ["--from", page.from, "--to", page.to, "--api-url", replay.url, ...token];
  const first = await runCli(["billing", "activity", ...args]);
  assert.equal(first.status, 0, first.stderr);
  const lines = first.stdout.trim().split("\n");
  assert.deepEqual(lines.slice(0, 3), [
    "Billing activity 2026-10-01 00:00Z to 2026-10-28 00:00Z:",
    "  2026-10-27 20:42Z  credit        +$25.00  Stripe auto reload",
    "  2026-10-20 00:00Z  eval         -$0.0035  Eval model call  demo/app"
  ]);
  // The printed next-page command reads the next page.
  const next = lines[3].replace(/^More: benchrouter /, "");
  assert.equal(next, `billing activity --cursor '${cursor}' --from ${page.from} --to ${page.to}`);
  const second = await runCli(["billing", "activity", "--cursor", cursor, ...args]);
  assert.equal(second.stdout, "Billing activity 2026-10-01 00:00Z to 2026-10-28 00:00Z:\n  none\n");

  const summary = await runCli(["billing", "statement", ...args]);
  assert.equal(summary.stdout, [
    "Statement 2026-10-01 00:00Z to 2026-10-28 00:00Z",
    "Opening balance $15.91; credits $275.00; debits $264.82; closing balance $26.09",
    "Balance now: $26.09",
    "Spend by route:",
    "  demo/app  $61.53 ($28.70 runtime, $32.83 evals)",
    ""
  ].join("\n"));
  assert.equal(replay.requests.length, 3);
});

test("public status and public frontier read without a credential", async (t) => {
  const replay = await startServer(t, { "GET /v1/status": [200, status], "GET /v1/frontier": [200, frontier] });
  const env = { BENCHROUTER_CONFIG_DIR: path.join(testDir, "no-such-config"), BENCHROUTER_ACCOUNT_TOKEN: "" };
  const statusOut = await runCli(["public", "status", "--api-url", replay.url], env);
  assert.equal(statusOut.status, 0, statusOut.stderr);
  assert.equal(statusOut.stdout, [
    "operational: All systems operational (updated 2026-10-28 20:46Z)",
    "  BenchRouter API   operational  uptime 99.99%",
    "  Chat Completions  operational  uptime 100.00%",
    "  Messages          operational  uptime 99.98%",
    "  Responses         operational  uptime 99.98%",
    "No incidents.",
    ""
  ].join("\n"));
  const frontierOut = await runCli(["public", "frontier", "--api-url", replay.url], env);
  assert.equal(frontierOut.stdout, [
    "Public frontier, generated 2026-10-28 00:17Z: 3 Pareto models, 2 near the frontier.",
    "  anthropic/claude-haiku-5.5  value         score 43.4  cost $0.20",
    "  anthropic/claude-opus-5     quality       score 50.8  cost $10.00",
    "  anthropic/claude-opus-5.5   balanced      score 57.6  cost $8.00",
    ""
  ].join("\n"));
  assert.ok(replay.requests.every((request) => request.authorization === null));
});

async function startServer(t, responses) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null });
    const [status, body] = responses[`${request.method} ${request.url}`] ?? [404, { error: { message: `no fixture for ${request.method} ${request.url}`, code: "not_found" } }];
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function runCli(argv, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
