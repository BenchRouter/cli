import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
const token = ["--account-token", "br_ctrl_recorded_fixture"];
// GET /v1/dashboard/summary fields these commands read, with the keys of the service's
// ApiKeySummary, Route and ArchivedRouteSummary (src/shared/dashboard-dto.ts) and invented values.
const key = (id, productId) => ({
  id, name: "Production", prefix: `br_live_${id}`, product_id: productId, product_label: productId,
  created_at: "2026-10-01T00:00:00.000Z", last_used_at: null, disabled_at: null
});
const route = (routeKey, repo) => ({ product_id: "prod_demo", route_key: routeKey, best_model: "openai/gpt-4o-mini", baseline_model: "openai/gpt-4o-mini", repo_full_name: repo });
const summary = {
  api_keys: [key("key_a", "prod_demo_app"), key("key_b", "prod_demo_app"), key("key_c", "prod_other")],
  routes: [route("app/chat", "demo/app"), route("other/chat", "demo/other"), route("hosted/triage", null)],
  archived_routes: [{ id: "rt_old", route_key: "app/old", repo_full_name: "demo/app", archived_at: "2026-10-02T00:00:00.000Z" }]
};

test("keys list --product-id lists only that group's keys", async (t) => {
  const replay = await startServer(t);
  const json = await runCli(["keys", "list", "--product-id", "prod_demo_app", "--json", "--api-url", replay.url, ...token]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).api_keys.map((entry) => entry.id), ["key_a", "key_b"]);
  const all = await runCli(["keys", "list", "--json", "--api-url", replay.url, ...token]);
  assert.equal(JSON.parse(all.stdout).api_keys.length, 3);
});

test("routes list --repo lists only that repository's routes", async (t) => {
  const replay = await startServer(t);
  const human = await runCli(["routes", "list", "--repo", "Demo/App", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, "- app/chat: best openai/gpt-4o-mini; baseline openai/gpt-4o-mini\n- archived app/old (rt_old)\n");
  const json = await runCli(["routes", "list", "--repo", "demo/other", "--json", "--api-url", replay.url, ...token]);
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, routes: [summary.routes[1]], archived_routes: [] });
});

async function startServer(t) {
  const server = createServer((request, response) => {
    const found = request.url === "/v1/dashboard/summary";
    response.writeHead(found ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(found ? summary : { error: { code: "not_found", message: "not found" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}` };
}

function runCli(cliArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      env: { ...process.env, npm_config_registry: "http://127.0.0.1:9", BENCHROUTER_ACCOUNT_TOKEN: "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
