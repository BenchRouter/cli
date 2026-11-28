import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
const token = ["--account-token", "br_ctrl_recorded_fixture"];
// Shaped like the server's refreshGitHubAccess result and GET /v1/setup/repos (AUTH-003).
const repos = {
  repos: [{ repo_full_name: "demo/app", private: true, repository_id: 1, installation_id: 2, default_branch: "main" }],
  installations: [{ installation_id: 2, owner_login: "demo", status: "active" }]
};

test("repos refresh re-reads GitHub access, then lists the repositories (AUTH-003)", async (t) => {
  const replay = await startServer(t, { "POST /v1/setup/repos/refresh": [200, { ok: true }], "GET /v1/setup/repos": [200, repos] });
  const human = await runCli(["repos", "refresh", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, [
    "Refreshed GitHub repository access.",
    "- demo/app (private): repository_id 1; installation_id 2; default branch main",
    ""
  ].join("\n"));
  assert.deepEqual(replay.requests, ["POST /v1/setup/repos/refresh", "GET /v1/setup/repos"]);
});

test("repos list shows the GitHub access sync age and stale time, in human and JSON output (AUTH-003)", async (t) => {
  // GET /v1/setup/repos with github_access as BenchRouter server PR #968 returns it: stale_at is synced_at + 24 hours.
  const syncedAt = new Date(Date.now() - (3 * 60 + 5) * 60 * 1000).toISOString();
  const staleAt = new Date(Date.parse(syncedAt) + 24 * 60 * 60 * 1000).toISOString();
  const replay = await startServer(t, { "GET /v1/setup/repos": [200, { ok: true, ...repos, github_access: { synced_at: syncedAt, stale_at: staleAt } }] });
  const human = await runCli(["repos", "list", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.ok(human.stdout.endsWith(`GitHub access: synced 3h 5m ago (${syncedAt}); stale at ${staleAt}\n`), human.stdout);
  const json = await runCli(["repos", "list", "--json", "--api-url", replay.url, ...token]);
  const access = JSON.parse(json.stdout).github_access;
  assert.equal(access.synced_at, syncedAt);
  assert.equal(access.stale_at, staleAt);
  assert.ok(access.age_seconds >= 185 * 60 && access.age_seconds < 186 * 60, String(access.age_seconds));
});

test("repos list says a stale or missing GitHub access sync needs repos refresh", async (t) => {
  const old = "2026-11-01T00:00:00.000Z";
  const stale = await startServer(t, { "GET /v1/setup/repos": [200, { ok: true, ...repos, github_access: { synced_at: old, stale_at: "2026-11-02T00:00:00.000Z" } }] });
  const staleOut = await runCli(["repos", "list", "--api-url", stale.url, ...token]);
  assert.match(staleOut.stdout, /; stale since 2026-11-02T00:00:00\.000Z\. Run `npx --yes benchrouter@latest repos refresh`\.\n$/);
  const never = await startServer(t, { "GET /v1/setup/repos": [200, { ok: true, ...repos, github_access: { synced_at: null, stale_at: null } }] });
  const neverOut = await runCli(["repos", "list", "--json", "--api-url", never.url, ...token]);
  assert.deepEqual(JSON.parse(neverOut.stdout).github_access, { synced_at: null, stale_at: null, age_seconds: null });
});

test("repos refresh stops with the reconnect error when GitHub needs a fresh sign-in", async (t) => {
  const replay = await startServer(t, {
    "POST /v1/setup/repos/refresh": [409, { error: { message: "Reconnect GitHub to refresh repository access", code: "github_reauth_required" } }]
  });
  const json = await runCli(["repos", "refresh", "--api-url", replay.url, ...token, "--json"]);
  assert.notEqual(json.status, 0);
  const error = JSON.parse(json.stderr).error;
  assert.equal(error.code, "github_reauth_required");
  assert.match(error.message, /Reconnect GitHub to refresh repository access/);
  assert.deepEqual(replay.requests, ["POST /v1/setup/repos/refresh"]);
});

async function startServer(t, responses) {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests.push(`${request.method} ${request.url}`);
      const key = `${request.method} ${request.url}`;
      let fixture = responses[key] ?? [404, { error: { message: "no fixture", code: "not_found" } }];
      // An array of fixtures answers one request each; the last one repeats.
      if (Array.isArray(fixture[0])) fixture = fixture.length > 1 ? fixture.shift() : fixture[0];
      const [status, body] = fixture;
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
