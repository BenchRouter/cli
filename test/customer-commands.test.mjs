import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");

test("account token resolve order rejects runtime keys and reads owner-only config", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-account-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousDir = process.env.BENCHROUTER_CONFIG_DIR;
  const previousAccount = process.env.BENCHROUTER_ACCOUNT_TOKEN;
  process.env.BENCHROUTER_CONFIG_DIR = root;
  delete process.env.BENCHROUTER_ACCOUNT_TOKEN;
  t.after(() => {
    if (previousDir === undefined) delete process.env.BENCHROUTER_CONFIG_DIR;
    else process.env.BENCHROUTER_CONFIG_DIR = previousDir;
    if (previousAccount === undefined) delete process.env.BENCHROUTER_ACCOUNT_TOKEN;
    else process.env.BENCHROUTER_ACCOUNT_TOKEN = previousAccount;
  });

  const { assertAccountToken, resolveAccountToken, saveAccountToken } = await import("../src/config.mjs");

  assert.throws(() => assertAccountToken("br_live_runtime"), /Runtime API keys cannot authorize/);
  assert.throws(() => assertAccountToken("br_setup_repo"), /Repo setup\/read tokens cannot/);
  assert.equal(resolveAccountToken(), null);

  const saved = await saveAccountToken("br_ctrl_owner_only_recorded", { account_id: "acct_recorded" });
  assert.ok(saved.startsWith(root));
  assert.deepEqual(resolveAccountToken(), {
    token: "br_ctrl_owner_only_recorded",
    source: "config",
    path: saved,
    account_id: "acct_recorded",
    account_slug: undefined
  });
  assert.equal(JSON.parse(await readFile(saved, "utf8")).token, "br_ctrl_owner_only_recorded");

  process.env.BENCHROUTER_ACCOUNT_TOKEN = "br_ctrl_environment_recorded";
  assert.deepEqual(resolveAccountToken(), {
    token: "br_ctrl_environment_recorded",
    source: "environment"
  });
  assert.deepEqual(resolveAccountToken("br_ctrl_argument_recorded"), {
    token: "br_ctrl_argument_recorded",
    source: "argument"
  });
});

test("render helpers stay deterministic for account and billing shapes", async () => {
  const render = await import("../src/render.mjs");
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    render.renderAccountShow({
      account: { id: "acct_1", slug: "acme", displayName: "Acme" },
      membership_role: "owner",
      identity: { providerLogin: "acme-owner" },
      person: { displayName: "Ada" },
      visible_products: [{ repo_full_name: "acme/app", access_kind: "owner" }]
    });
    render.renderBillingTopUp({
      checkout_url: "https://checkout.example/session",
      credit_usd: 25,
      service_fee_usd: 1.38,
      checkout_total_usd: 26.38
    });
    render.renderEvalsFailures({
      route_key: "app/chat",
      latest_eval: {
        model_run_id: "emrun_1",
        results: [
          { case_id: "c1", critical: true, outcome: "assertion_failure" },
          { case_id: "c2", critical: false, outcome: "pass" }
        ]
      }
    }, "provider/model");
  } finally {
    process.stdout.write = original;
  }

  const text = chunks.join("");
  assert.match(text, /Account: Acme/);
  assert.match(text, /Checkout URL:\nhttps:\/\/checkout\.example\/session/);
  assert.match(text, /does not open a browser/);
  assert.match(text, /app\/chat: provider\/model \(emrun_1\)/);
  assert.match(text, /- c1: critical; assertion_failure/);
  assert.doesNotMatch(text, /- c2:/);
});

test("unknown commands name the bad command and exit nonzero", async () => {
  const result = await runCli(["definitely-not-a-command"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: definitely-not-a-command/);
});

test("nested help is discoverable for account and billing", async () => {
  const account = await runCli(["account", "--help"]);
  assert.equal(account.status, 0, account.stderr);
  assert.match(account.stdout, /benchrouter account show/);

  const billing = await runCli(["billing", "top-up", "--help"]);
  assert.equal(billing.status, 0, billing.stderr);
  assert.match(billing.stdout, /--amount/);
  assert.match(billing.stdout, /Does not open a browser/);
});

test("keys revoke reports the exact missing server contract without inventing a path", async () => {
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
});

test("mutationSummary is an exact action string", async () => {
  const { mutationSummary } = await import("../src/render.mjs");
  assert.equal(
    mutationSummary("Archive route", "route_key=app/chat"),
    "Archive route: route_key=app/chat"
  );
});

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
