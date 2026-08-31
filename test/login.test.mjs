import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");

test("browser login exchanges once, proves the account, and saves owner-only credentials", async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "benchrouter-login-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));

  const observed = {
    createAuthorization: null,
    createAuthorizationBody: null,
    statusAuthorization: null,
    exchangeAuthorization: null,
    selfAuthorization: null,
    exchangeCount: 0,
    exchangeBody: null
  };
  const controlToken = "br_ctrl_live_login_contract";
  const transactionId = "cliauth_contract_1";
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    if (request.method === "POST" && request.url === "/v1/cli/authorizations") {
      observed.createAuthorization = request.headers.authorization ?? null;
      observed.createAuthorizationBody = body;
      assert.equal(typeof body.nonce, "string");
      assert.equal(typeof body.code_challenge, "string");
      assert.equal(body.client_name, "BenchRouter CLI");
      json(response, 200, {
        transaction_id: transactionId,
        authorize_url: `${apiUrl(server)}/cli/authorize?transaction=${transactionId}`,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        poll_after_ms: 500
      });
      return;
    }
    if (request.method === "POST" && request.url === `/v1/cli/authorizations/${transactionId}/status`) {
      observed.statusAuthorization = request.headers.authorization ?? null;
      json(response, 200, {
        status: "approved",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        poll_after_ms: 500
      });
      return;
    }
    if (request.method === "POST" && request.url === `/v1/cli/authorizations/${transactionId}/exchange`) {
      observed.exchangeAuthorization = request.headers.authorization ?? null;
      observed.exchangeCount += 1;
      observed.exchangeBody = body;
      const expectedChallenge = createHash("sha256")
        .update(body.code_verifier, "utf8")
        .digest("base64url");
      assert.equal(expectedChallenge, observed.createAuthorizationBody.code_challenge);
      json(response, 200, {
        ok: true,
        account: {
          id: "acct_contract",
          slug: "contract",
          display_name: "Contract Account"
        },
        control_token: {
          id: "act_contract",
          token: controlToken,
          prefix: "br_ctrl_live",
          expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
        }
      });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/account/control/me") {
      observed.selfAuthorization = request.headers.authorization ?? null;
      json(response, 200, {
        ok: true,
        account: {
          id: "acct_contract",
          slug: "contract",
          display_name: "Contract Account"
        }
      });
      return;
    }
    json(response, 404, { error: "not_found" });
  });
  await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await runCli([
    "login",
    "--no-open",
    "--json",
    "--api-url",
    apiUrl(server),
    "--timeout-seconds",
    "5"
  ], { BENCHROUTER_CONFIG_DIR: configDir });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(observed.createAuthorization, null);
  assert.equal(observed.statusAuthorization, null);
  assert.equal(observed.exchangeAuthorization, null);
  assert.equal(observed.exchangeCount, 1);
  assert.equal(observed.selfAuthorization, `Bearer ${controlToken}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(controlToken));
  assert.doesNotMatch(result.stderr, /code_verifier|code_challenge|nonce/);
  assert.match(result.stderr, new RegExp(`/cli/authorize\\?transaction=${transactionId}`));

  const savedPath = path.join(configDir, "account.json");
  const saved = JSON.parse(await readFile(savedPath, "utf8"));
  assert.equal(saved.token, controlToken);
  assert.equal(saved.account_id, "acct_contract");
  assert.equal(saved.account_slug, "contract");
  assert.equal((await stat(configDir)).mode & 0o777, 0o700);
  assert.equal((await stat(savedPath)).mode & 0o777, 0o600);
});

function apiUrl(server) {
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function runCli(argv, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...argv], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
