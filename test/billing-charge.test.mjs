import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
const token = ["--account-token", "br_ctrl_recorded_fixture"];
// Outcomes shaped like `CardChargeOutcome` in the server's src/card-charge.ts (BILL-006). No live
// charge was made: this command spends money.
const amounts = { credit_usd: 25, service_fee_usd: 1.38, charge_total_usd: 26.38 };
const outcomes = {
  charged: { ok: true, outcome: "charged", charge_id: "cardcharge_1", replayed: false, balance_usd: 53.17, ...amounts },
  processing: { ok: true, outcome: "processing", charge_id: "cardcharge_1", message: "The charge is still in progress. Repeat the same call to read its result; it never charges twice.", ...amounts },
  checkout: {
    ok: true, outcome: "checkout", reason: "card_failed", charge_id: "cardcharge_1",
    error: { code: "card_declined", message: "Your card was declined." },
    checkout: {
      ok: true, provider: "stripe", session_id: "cs_1", checkout_url: "https://checkout.stripe.com/c/pay/cs_1",
      amount_usd: 25, credit_usd: 25, service_fee_usd: 1.38, checkout_total_usd: 26.38, currency: "USD"
    }
  }
};

test("billing charge sends one key per run and prints each outcome (BILL-006)", async (t) => {
  let next = "charged";
  const replay = await startServer(t, () => [200, outcomes[next]]);
  const run = (extra) => runCli(["billing", "charge", "--amount", "25", "--api-url", replay.url, ...token, ...extra]);

  const refused = await run(["--json"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires --yes/);
  assert.equal(replay.requests.length, 0);

  const charged = await run(["--yes"]);
  assert.equal(charged.status, 0, charged.stderr);
  assert.equal(charged.stdout, "Charged $26.38 ($25.00 credit + $1.38 fee) on the saved card. Balance: $53.17.\n");

  next = "processing";
  const processing = await run(["--yes"]);
  const key = replay.requests[1].body.idempotency_key;
  assert.equal(processing.stdout, `${outcomes.processing.message}\nRead its result with: benchrouter billing charge --amount 25 --idempotency-key ${key}\n`);

  next = "checkout";
  const checkout = await run(["--yes", "--idempotency-key", "retry-key-0001", "--json"]);
  assert.deepEqual(JSON.parse(checkout.stdout), { ...outcomes.checkout, idempotency_key: "retry-key-0001" });
  const checkoutHuman = await run(["--yes"]);
  assert.equal(checkoutHuman.stdout, [
    "Nothing was charged; the saved card failed: Your card was declined.",
    "Pay $26.38 in a browser (credit $25.00; fee $1.38):",
    "https://checkout.stripe.com/c/pay/cs_1",
    ""
  ].join("\n"));

  const keys = replay.requests.map((request) => request.body.idempotency_key);
  assert.equal(keys[2], "retry-key-0001");
  // Each run without --idempotency-key is a new purchase with its own key.
  assert.equal(new Set([keys[0], keys[1], keys[3]]).size, 3);
  assert.ok(replay.requests.every((request) => request.body.amount_usd === 25 && request.url === "/v1/billing/card-charge"));
});

test("billing charge prints the retry command when the request fails, and refuses a fractional amount", async (t) => {
  const replay = await startServer(t, () => [503, { error: { message: "Stripe is unavailable", code: "stripe_unavailable" } }]);
  const failed = await runCli(["billing", "charge", "--amount", "100", "--yes", "--idempotency-key", "retry-key-0002", "--api-url", replay.url, ...token]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /repeat with the same key: benchrouter billing charge --amount 100 --idempotency-key retry-key-0002/);

  const fractional = await runCli(["billing", "charge", "--amount", "25.5", "--yes", "--api-url", replay.url, ...token]);
  assert.notEqual(fractional.status, 0);
  assert.match(fractional.stderr, /whole USD/);
  assert.equal(replay.requests.length, 1);
});

async function startServer(t, respond) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: text ? JSON.parse(text) : null });
      const [status, body] = respond();
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
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
