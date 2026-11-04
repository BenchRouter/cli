import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/benchrouter.mjs", import.meta.url));

// GET /v1/setup/repos in the shape the server returns (src/installations.ts): active
// installations first, repository_id a string, installation_id a number.
const reposBody = {
  ok: true,
  repos: [
    { repository_id: "901", repo_full_name: "Example/App", name: "App", owner_login: "Example", installation_id: 77, private: true, default_branch: "main", html_url: "https://github.com/Example/App" },
    { repository_id: "901", repo_full_name: "Example/App", name: "App", owner_login: "Example", installation_id: 12, private: true, default_branch: "main", html_url: null }
  ],
  installations: [
    { installation_id: 77, owner_login: "Example", owner_type: "Organization", status: "active", status_reason: null, install_url: "https://github.com/apps/benchrouter/installations/77" },
    { installation_id: 12, owner_login: "Example", owner_type: "Organization", status: "suspended", status_reason: "suspended", install_url: "https://github.com/apps/benchrouter/installations/12" }
  ]
};

async function server(t) {
  const requests = [];
  const listener = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : null });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/setup/repos") response.end(JSON.stringify(reposBody));
    else response.end(JSON.stringify({ ok: true, session: { id: "setup_1" }, setup_code: "br_setup_x", init_command: "npx --yes benchrouter@latest init" }));
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  return { url: `http://127.0.0.1:${listener.address().port}`, requests };
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, npm_config_registry: "http://127.0.0.1:9" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("setup create looks up both ids from --repo, ignoring case and taking the first (active) row", { timeout: 4900 }, async (t) => {
  const api = await server(t);
  const result = await runCli(["setup", "create", "--repo", "example/app", "--intent", "new_route", "--yes", "--json",
    "--api-url", api.url, "--account-token", "br_ctrl_recorded_fixture"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(api.requests.map((request) => `${request.method} ${request.url}`), ["GET /v1/setup/repos", "POST /v1/setup/sessions"]);
  assert.deepEqual(api.requests[1].body, { repository_id: "901", repo_full_name: "example/app", installation_id: 77, intent: "new_route" });
});

test("setup create explains a repository missing from synced GitHub access", { timeout: 4900 }, async (t) => {
  const api = await server(t);
  const result = await runCli(["setup", "create", "--repo", "example/other", "--yes",
    "--api-url", api.url, "--account-token", "br_ctrl_recorded_fixture"]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("does not list example/other"), result.stderr);
  assert.ok(result.stderr.includes("benchrouter repos refresh"), result.stderr);
  assert.ok(result.stderr.includes("https://github.com/apps/benchrouter/installations/77"), result.stderr);
  assert.deepEqual(api.requests.map((request) => request.url), ["/v1/setup/repos"]);
});

test("setup create with both ids skips the lookup", { timeout: 4900 }, async (t) => {
  const api = await server(t);
  const result = await runCli(["setup", "create", "--repo", "example/app", "--repository-id", "5", "--installation-id", "6", "--yes", "--json",
    "--api-url", api.url, "--account-token", "br_ctrl_recorded_fixture"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(api.requests.map((request) => request.url), ["/v1/setup/sessions"]);
  assert.deepEqual(api.requests[0].body, { repository_id: "5", repo_full_name: "example/app", installation_id: 6, intent: "initial" });
});
