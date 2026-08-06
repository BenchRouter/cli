import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  planAdminProviderKeySet,
  planProposalAction
} from "../src/commands.mjs";
import { adminKeysBrowserSessionRequired, adminPaths } from "../src/control-api.mjs";
import { mutationSummary } from "../src/render.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");

test("account and admin token resolve order reject wrong scopes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-tokens-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = {
    dir: process.env.BENCHROUTER_CONFIG_DIR,
    account: process.env.BENCHROUTER_ACCOUNT_TOKEN,
    admin: process.env.BENCHROUTER_ADMIN_TOKEN
  };
  process.env.BENCHROUTER_CONFIG_DIR = root;
  delete process.env.BENCHROUTER_ACCOUNT_TOKEN;
  delete process.env.BENCHROUTER_ADMIN_TOKEN;
  t.after(() => {
    restoreEnv("BENCHROUTER_CONFIG_DIR", previous.dir);
    restoreEnv("BENCHROUTER_ACCOUNT_TOKEN", previous.account);
    restoreEnv("BENCHROUTER_ADMIN_TOKEN", previous.admin);
  });

  const {
    assertAccountToken,
    assertAdminToken,
    resolveAccountToken,
    resolveAdminToken,
    saveAccountToken,
    saveAdminToken
  } = await import("../src/config.mjs");

  assert.throws(() => assertAccountToken("br_live_runtime"), /Runtime API keys/);
  assert.throws(() => assertAccountToken("br_setup_repo"), /Repo setup\/read/);
  assert.throws(() => assertAccountToken("bradm_admin"), /Admin tokens cannot authorize account/);
  assert.throws(() => assertAdminToken("br_ctrl_account"), /Account control tokens cannot authorize admin/);
  assert.throws(() => assertAdminToken("br_setup_repo"), /Repo setup\/read/);
  assert.throws(() => assertAdminToken("br_live_runtime"), /Runtime API keys/);

  assert.equal(resolveAccountToken(), null);
  assert.equal(resolveAdminToken(), null);

  const accountPath = await saveAccountToken("br_ctrl_owner_only");
  const adminPath = await saveAdminToken("bradm_owner_only");
  assert.equal(resolveAccountToken().source, "config");
  assert.equal(resolveAdminToken().source, "config");
  assert.equal((await stat(accountPath)).mode & 0o777, 0o600);
  assert.equal((await stat(adminPath)).mode & 0o777, 0o600);

  process.env.BENCHROUTER_ACCOUNT_TOKEN = "br_ctrl_environment";
  process.env.BENCHROUTER_ADMIN_TOKEN = "bradm_environment";
  assert.equal(resolveAccountToken().source, "environment");
  assert.equal(resolveAdminToken("bradm_argument").source, "argument");
});

test("owner-only config rewrite forces mode 0600 over a permissive file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.BENCHROUTER_CONFIG_DIR = root;
  t.after(() => delete process.env.BENCHROUTER_CONFIG_DIR);

  const { saveAccountToken, assertOwnerFileMode } = await import("../src/config.mjs");
  const target = await saveAccountToken("br_ctrl_first");
  chmodSync(target, 0o644);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
  await saveAccountToken("br_ctrl_second");
  assert.equal(assertOwnerFileMode(target), 0o600);
  assert.equal(JSON.parse(await readFile(target, "utf8")).token, "br_ctrl_second");
});

test("unknown nested and top-level commands name the bad command", async () => {
  const top = await runCli(["definitely-not-a-command"]);
  assert.equal(top.status, 1);
  assert.match(top.stderr, /Unknown command: definitely-not-a-command/);

  const nested = await runCli(["admin", "nope"]);
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /Unknown command: admin nope/);

  const proposals = await runCli(["proposals", "explode"]);
  assert.equal(proposals.status, 1);
  assert.match(proposals.stderr, /Unknown command: proposals explode/);
});

test("JSON mutations require --yes and never prompt", async () => {
  const result = await runCli([
    "billing",
    "top-up",
    "--amount",
    "25",
    "--account-token",
    "br_ctrl_recorded_fixture",
    "--json"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JSON mode requires --yes/);

  const admin = await runCli([
    "proposals",
    "approve",
    "prop_1",
    "--admin-token",
    "bradm_recorded_fixture",
    "--json"
  ]);
  assert.equal(admin.status, 1);
  assert.match(admin.stderr, /JSON mode requires --yes/);
});

test("keys revoke reports the missing server contract without inventing a path", async () => {
  const result = await runCli([
    "keys",
    "revoke",
    "key_recorded",
    "--account-token",
    "br_ctrl_recorded_fixture",
    "--yes"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing server contract: authenticated API key revoke/);
  assert.match(result.stderr, /POST \/v1\/dashboard\/api-keys\/:id\/revoke/);
});

test("admin keys list/mint/revoke state browser-session requirement accurately", async () => {
  for (const action of ["list", "mint", "revoke"]) {
    const args = action === "revoke"
      ? ["admin", "keys", "revoke", "adm_1", "--admin-token", "bradm_recorded"]
      : ["admin", "keys", action, "--admin-token", "bradm_recorded"];
    const result = await runCli(args);
    assert.equal(result.status, 1, action);
    assert.match(result.stderr, /browser GitHub admin session/);
    assert.match(result.stderr, /cannot list, mint, or revoke/);
  }
  assert.match(adminKeysBrowserSessionRequired("list"), /GET \/v1\/admin\/keys/);
});

test("request construction uses exact service paths", () => {
  assert.deepEqual(adminPaths.proposalsList(), {
    method: "GET",
    path: "/v1/dashboard/catalog/proposals",
    label: "proposals list"
  });
  assert.equal(
    planProposalAction("approve", "prop/with space").path,
    `/v1/dashboard/catalog/proposals/${encodeURIComponent("prop/with space")}/approve`
  );
  assert.deepEqual(planAdminProviderKeySet("openrouter", { apiKey: "sk", baseUrl: "https://x" }), {
    method: "PUT",
    path: "/v1/admin/providers/openrouter/key",
    label: "admin providers key set",
    body: { api_key: "sk", base_url: "https://x" }
  });
  assert.equal(adminPaths.providerEnable("vertex").method, "DELETE");
  assert.equal(adminPaths.providerEnable("vertex").path, "/v1/admin/providers/vertex/disable");
  assert.equal(adminPaths.catalogRebuild().path, "/v1/admin/catalog/rebuild-snapshot");
  assert.equal(mutationSummary("Archive route", "route_key=app/chat"), "Archive route: route_key=app/chat");
});

test("token save commands never print the secret", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-save-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const account = await runCli(
    ["account", "token", "save", "--account-token", "br_ctrl_save_me"],
    { BENCHROUTER_CONFIG_DIR: root }
  );
  assert.equal(account.status, 0, account.stderr);
  assert.match(account.stdout, /Saved account token/);
  assert.doesNotMatch(account.stdout, /br_ctrl_save_me/);
  assert.doesNotMatch(account.stderr, /br_ctrl_save_me/);

  const admin = await runCli(
    ["admin", "token", "save", "--admin-token", "bradm_save_me"],
    { BENCHROUTER_CONFIG_DIR: root }
  );
  assert.equal(admin.status, 0, admin.stderr);
  assert.match(admin.stdout, /Saved admin token/);
  assert.doesNotMatch(admin.stdout, /bradm_save_me/);
});

test("nested help covers account, billing, and admin", async () => {
  const account = await runCli(["account", "--help"]);
  assert.equal(account.status, 0, account.stderr);
  assert.match(account.stdout, /account show/);

  const billing = await runCli(["billing", "top-up", "--help"]);
  assert.equal(billing.status, 0, billing.stderr);
  assert.match(billing.stdout, /Does not open a browser/);

  const admin = await runCli(["admin", "--help"]);
  assert.equal(admin.status, 0, admin.stderr);
  assert.match(admin.stdout, /browser GitHub admin session/);
});

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
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
