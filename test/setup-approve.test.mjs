import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
const token = ["--account-token", "br_ctrl_recorded_fixture"];
// Shaped like BrowserSetupApprovalResponse in the server's src/shared/dashboard-dto.ts (SETUP-001).
const pending = {
  ok: true,
  approval: {
    status: "pending", context_id: "sac_demo", repo_full_name: "demo/app", route_key: "demo/chat",
    observed_model: "gpt-4o-mini-2024-07-18", provider_id: "openai", provider_ref: "gpt-4o-mini-2024-07-18",
    canonical_original_model: "openai/gpt-4o-mini", recommended_baseline_model: "openai/gpt-5.4-mini",
    selected_baseline_model: null, approval_expires_at: "2026-10-30T12:00:00.000Z",
    alternatives: [
      { canonical_id: "openai/gpt-5.4-mini", relation_type: "successor", reason: "Same family, newer", source_tier: "cheap", tier: "cheap",
        context_window: 400000, capability_overlap_count: 6, price_guardrail_max: 2, price_multiple: 1.25 },
      { canonical_id: "google/gemini-3.8-flash", relation_type: "peer", reason: "Similar price and capabilities", source_tier: "cheap", tier: "balanced",
        context_window: 1000000, capability_overlap_count: 5, price_guardrail_max: 2 }
    ]
  }
};
const approved = { ok: true, approval: { ...pending.approval, status: "approved", selected_baseline_model: "openai/gpt-5.4-mini" } };

test("setup approve shows an approval from its link, and approves a baseline after confirmation (SETUP-001)", async (t) => {
  const replay = await startServer(t, {
    "GET /v1/setup/approvals/sac_demo": pending,
    "POST /v1/setup/approvals/sac_demo/approve": approved
  });
  const show = await runCli(["setup", "approve", "https://benchrouter.com/setup/authorize?approval=sac_demo", "--api-url", replay.url, ...token]);
  assert.equal(show.status, 0, show.stderr);
  assert.equal(show.stdout, [
    "demo/app demo/chat: pending, expires 2026-10-30 12:00Z",
    "Observed model: gpt-4o-mini-2024-07-18; catalog model openai/gpt-4o-mini",
    "Recommended baseline: openai/gpt-5.4-mini",
    "Alternatives:",
    "  openai/gpt-5.4-mini      successor  cheap  1.25x price  Same family, newer",
    "  google/gemini-3.8-flash  peer  balanced  Similar price and capabilities",
    "Approve with: benchrouter setup approve sac_demo --model <model-id>",
    ""
  ].join("\n"));

  const refused = await runCli(["setup", "approve", "sac_demo", "--model", "openai/gpt-5.4-mini", "--json", "--api-url", replay.url, ...token]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires --yes/);

  const approve = await runCli(["setup", "approve", "sac_demo", "--model", "openai/gpt-5.4-mini", "--yes", "--api-url", replay.url, ...token]);
  assert.equal(approve.status, 0, approve.stderr);
  assert.equal(approve.stdout.split("\n")[0], "demo/app demo/chat: approved");
  assert.match(approve.stdout, /Approved baseline: openai\/gpt-5\.4-mini/);
  assert.deepEqual(replay.requests.filter((request) => request.method === "POST"), [
    { method: "POST", url: "/v1/setup/approvals/sac_demo/approve", body: { approved_baseline_model: "openai/gpt-5.4-mini" } }
  ]);
});

async function startServer(t, responses) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: text ? JSON.parse(text) : null });
      const body = responses[`${request.method} ${request.url}`];
      response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(body ?? { error: { message: "no fixture", code: "not_found" } }));
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
