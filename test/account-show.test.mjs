import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
const token = ["--account-token", "br_ctrl_recorded_fixture"];
// The keys and shapes of live GET /v1/account/control/me and GET /v1/dashboard/account
// responses (api.benchrouter.com, 2026-10-28), with invented values: the live ones are an
// account's billing.
const product = { product_id: "prod_acct_demo_app", repo_full_name: "demo/app", access_kind: "owner" };
const self = (role) => ({
  ok: true,
  person: { id: "person_demo", displayName: "Demo" },
  account: { id: "acct_demo", slug: "demo", displayName: "Demo" },
  membership_role: role,
  visible_products: [product]
});
const ownerPage = {
  account: { slug: "demo", display_name: "Demo" },
  setup: null,
  spend: { total_usd: 12.5, production_usd: 10, evaluation_usd: 2.5, last_30d_usd: 4.25 },
  savings: { total_usd: 3.1, last_30d_usd: 1.2, sparkline: [0.1, 0.2] },
  billing: { balance_usd: 7.456, available_usd: 7.456 },
  auto_reload: {
    enabled: true, state: "paused", threshold_usd: 10, reload_amount_usd: 25, service_fee_usd: 1.38, charge_total_usd: 26.38,
    payment_method: { brand: "visa", last4: "4242" }, consecutive_failures: 2, retry_after: null,
    last_error: { code: "card_declined", message: "Your card was declined." }, setup_enabled: true
  },
  installations: [{ owner_login: "demo", owner_type: "User", installation_id: 1, repo_count: 2 }],
  recent_ledger: [{ created_at: "2026-10-28T17:39:57.353Z", kind: "debit", amount_usd: -0.004, description: "Runtime model call" }],
  top_up: { provider: "stripe", checkout_enabled: true, min_amount_usd: 25, max_amount_usd: 25000, suggested_amounts_usd: [25, 50, 100] },
  api_keys: [{
    id: "key_demo", name: "Production", prefix: "br_live_AbCdEfGh", product_id: "prod_acct_demo_app", product_label: "demo/app",
    created_at: "2026-10-01T00:00:00.000Z", last_used_at: "2026-10-28T16:22:47.442Z", disabled_at: null
  }],
  products: [],
  free_credit: { amount_usd: 5, granted: true, granted_at: "2026-06-19T19:22:59.762Z" }
};
// A member's read: the server leaves out billing and keys (BILL-001).
const memberPage = {
  ...ownerPage,
  spend: { total_usd: 0, production_usd: 0, evaluation_usd: 0, last_30d_usd: 0 },
  billing: null, auto_reload: null, installations: [], recent_ledger: [], api_keys: [], free_credit: { amount_usd: 0, granted: false, granted_at: null }
};

test("account show prints the owner's account page with the role, and a paused reload's error (MCP-001, BILL-001)", async (t) => {
  const replay = await startServer(t, { "/v1/account/control/me": self("owner"), "/v1/dashboard/account": ownerPage });
  const human = await runCli(["account", "show", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, [
    "Account: Demo (acct_demo)",
    "Role: owner",
    "Balance: $7.46 (available $7.46)",
    "Free credit: $5.00, granted 2026-06-19 19:22Z",
    "Spend: $12.50 ($10.00 production, $2.50 evaluation); $4.25 in the last 30 days",
    "Savings: $3.10; $1.20 in the last 30 days",
    "Auto-reload: paused; adds $25.00 (charge $26.38 on visa ending 4242) when the balance falls below $10.00; last error: Your card was declined. (2 failed)",
    "Endpoint keys:",
    "  br_live_AbCdEfGh…  Production  demo/app  last used 2026-10-28 16:22Z",
    "GitHub installations: demo (2 repos)",
    "Visible products: demo/app",
    ""
  ].join("\n"));
  const json = await runCli(["account", "show", "--api-url", replay.url, ...token, "--json"]);
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, account_id: "acct_demo", role: "owner", visible_products: [product], ...ownerPage });
  assert.ok(replay.requests.every((request) => request.authorization === "Bearer br_ctrl_recorded_fixture"));
});

test("account show gives a member the name, role and products, and no empty spend lines", async (t) => {
  const replay = await startServer(t, { "/v1/account/control/me": self("member"), "/v1/dashboard/account": memberPage });
  const human = await runCli(["account", "show", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, "Account: Demo (acct_demo)\nRole: member\nVisible products: demo/app\n");
});

async function startServer(t, responses) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null });
    const body = request.method === "GET" ? responses[request.url] : undefined;
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { error: { message: `no fixture for ${request.method} ${request.url}`, code: "not_found" } }));
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
