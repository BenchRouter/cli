import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  planAdminProviderKeySet,
  planProposalAction
} from "../src/commands.mjs";
import {
  adminKeysMintBrowserSessionRequired,
  adminPaths,
  customerPaths
} from "../src/control-api.mjs";
import { mutationSummary } from "../src/render.mjs";
import { resolveControlUsageName } from "../src/usage-text.mjs";

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

test("admin keys mint stays browser-session only; list and revoke are wired", async () => {
  const mint = await runCli(["admin", "keys", "mint", "--admin-token", "bradm_recorded"]);
  assert.equal(mint.status, 1);
  assert.match(mint.stderr, /browser GitHub admin session/);
  assert.match(mint.stderr, /POST \/v1\/admin\/keys/);
  assert.match(adminKeysMintBrowserSessionRequired(), /cannot mint admin keys/);

  // list/revoke must no longer short-circuit; they now build real bradm_ requests.
  assert.deepEqual(adminPaths.adminKeysList(), {
    method: "GET",
    path: "/v1/admin/keys",
    label: "admin keys list"
  });
  assert.deepEqual(adminPaths.adminKeysRevoke("adm key/1"), {
    method: "DELETE",
    path: `/v1/admin/keys/${encodeURIComponent("adm key/1")}`,
    label: "admin keys revoke"
  });

  // admin keys revoke is a mutation, so JSON mode must still refuse without --yes.
  const revoke = await runCli(["admin", "keys", "revoke", "adm_1", "--admin-token", "bradm_recorded", "--json"]);
  assert.equal(revoke.status, 1);
  assert.match(revoke.stderr, /JSON mode requires --yes/);
});

test("customer request construction uses exact service methods, paths, and bodies", () => {
  assert.deepEqual(customerPaths.accountSelf(), {
    method: "GET",
    path: "/v1/account/control/me",
    label: "account show"
  });
  assert.deepEqual(customerPaths.apiKeyRevoke("key/1"), {
    method: "POST",
    path: `/v1/dashboard/api-keys/${encodeURIComponent("key/1")}/revoke`,
    label: "keys revoke"
  });
  assert.equal(customerPaths.apiKeyRevoke("key_1").body, undefined);
  assert.deepEqual(customerPaths.apiKeyCreate({ name: "CLI key", productId: "prod_1" }).body, {
    product_id: "prod_1",
    name: "CLI key"
  });
  assert.deepEqual(customerPaths.billingTopUpCheckout(25).body, { amount_usd: 25 });
  assert.equal(customerPaths.dashboardSummary("keys list").path, "/v1/dashboard/summary");
  assert.equal(
    customerPaths.setupDiagnostic("example/app").path,
    `/v1/setup/diagnostic?repo=${encodeURIComponent("example/app")}`
  );
  // Dashboard route keys stay slash-separated: the service matches
  // /v1/dashboard/routes/([^/]+/[^/]+)/models/(.+), so percent-encoding the key breaks it.
  assert.equal(
    customerPaths.routeModel("app/chat", "minimax/minimax-m2.7").path,
    `/v1/dashboard/routes/app/chat/models/${encodeURIComponent("minimax/minimax-m2.7")}`
  );
  assert.equal(customerPaths.routeCatalog("app/chat").path, "/v1/dashboard/routes/app/chat/catalog");
  assert.equal(customerPaths.routeArchive("app/chat").path, "/v1/dashboard/routes/app/chat/archive");
  assert.equal(customerPaths.routeUnarchive("rt_1").path, "/v1/dashboard/archived-routes/rt_1/unarchive");
  assert.deepEqual(customerPaths.routeResultSetCreate("app/chat", "m/1"), {
    method: "POST",
    path: "/v1/dashboard/routes/app/chat/result-sets",
    label: "evals run",
    body: { model: "m/1" }
  });
  assert.deepEqual(customerPaths.routeBaselineSet("app/chat", "ers_1", "m/1"), {
    method: "POST",
    path: "/v1/dashboard/routes/app/chat/result-sets/ers_1/set-baseline",
    label: "baseline set",
    body: { model: "m/1" }
  });
});

test("newly wired customer routes build the exact documented request", () => {
  assert.deepEqual(
    customerPaths.setupSessionCreate({
      repositoryId: "123456",
      repoFullName: "example/app",
      installationId: 42,
      intent: "new_route"
    }),
    {
      method: "POST",
      path: "/v1/setup/sessions",
      label: "setup create",
      body: {
        repository_id: "123456",
        repo_full_name: "example/app",
        installation_id: 42,
        intent: "new_route"
      }
    }
  );
  assert.deepEqual(customerPaths.setupSessionGet("setup_1"), {
    method: "GET",
    path: "/v1/setup/sessions/setup_1",
    label: "setup session show"
  });
  assert.deepEqual(customerPaths.setupKitUpgradeToken("example/app", "app/chat"), {
    method: "POST",
    path: "/v1/dashboard/setup-kit/upgrade-token",
    label: "setup upgrade-token",
    body: { repo_full_name: "example/app", route_id: "app/chat" }
  });
  // The route key stays slash-separated; the result set id is one encoded segment.
  assert.equal(
    customerPaths.routeResultSetRefreshPreview("app/chat", "ers 1").path,
    `/v1/dashboard/routes/app/chat/result-sets/${encodeURIComponent("ers 1")}/refresh-preview`
  );
  assert.deepEqual(customerPaths.routeResultSetRefreshPreview("app/chat", "ers_1").body, {});
  assert.deepEqual(customerPaths.routeResultSetRefreshPreview("app/chat", "ers_1", "m/1").body, {
    model: "m/1"
  });
});

test("newly wired admin routes build the exact documented request", () => {
  assert.deepEqual(adminPaths.mappingsList(), {
    method: "GET",
    path: "/v1/admin/catalog/mappings",
    label: "admin catalog mappings list"
  });
  // Report-only, but the service only accepts POST here.
  assert.equal(adminPaths.catalogRefreshReport().method, "POST");
  assert.equal(adminPaths.catalogRefreshReport().path, "/v1/admin/catalog/refresh-report");
  assert.deepEqual(adminPaths.catalogDrainOutbox(), {
    method: "POST",
    path: "/v1/admin/catalog/drain-outbox",
    label: "admin catalog drain-outbox",
    body: {}
  });
  assert.deepEqual(adminPaths.catalogDrainOutbox(12).body, { limit: 12 });
  assert.deepEqual(adminPaths.modelIdMaps(), {
    method: "GET",
    path: "/v1/admin/model-id-maps",
    label: "admin catalog model-maps"
  });

  const minimal = adminPaths.observationCreate({ source: "lab_notice", subjectKind: "model" });
  assert.equal(minimal.method, "POST");
  assert.equal(minimal.path, "/v1/admin/catalog/observations");
  // Only the two required fields travel when nothing else is passed.
  assert.deepEqual(minimal.body, { source: "lab_notice", subject_kind: "model" });
  assert.deepEqual(
    adminPaths.observationCreate({
      source: "manual_admin",
      subjectKind: "target",
      derivedAction: "target_availability",
      matchConfidence: "high",
      canonicalId: "openai/gpt-4o-mini",
      sourceVersion: "2026-08-06",
      rawSourceId: "raw_1",
      payload: { note: "vendor status page" }
    }).body,
    {
      source: "manual_admin",
      subject_kind: "target",
      derived_action: "target_availability",
      match_confidence: "high",
      canonical_id: "openai/gpt-4o-mini",
      source_version: "2026-08-06",
      raw_source_id: "raw_1",
      payload: { note: "vendor status page" }
    }
  );
});

test("--payload-json is parsed, not pattern-matched, and must be a JSON object", async () => {
  const base = ["admin", "catalog", "observations", "add", "--source", "lab_notice", "--subject-kind", "model"];
  const admin = ["--admin-token", "bradm_recorded", "--yes"];

  const broken = await runCli([...base, "--payload-json", "{not json", ...admin]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /--payload-json must be valid JSON/);

  const array = await runCli([...base, "--payload-json", "[1,2]", ...admin]);
  assert.equal(array.status, 1);
  assert.match(array.stderr, /--payload-json must be a JSON object/);

  const scalar = await runCli([...base, "--payload-json", "42", ...admin]);
  assert.equal(scalar.status, 1);
  assert.match(scalar.stderr, /--payload-json must be a JSON object/);

  const missing = await runCli(["admin", "catalog", "observations", "add", ...admin]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Requires --source and --subject-kind/);
});

test("setup create validates its identifiers before authenticating", async () => {
  const account = ["--account-token", "br_ctrl_recorded_fixture", "--repo", "example/app", "--yes"];

  const noRepositoryId = await runCli(["setup", "create", "--installation-id", "42", ...account]);
  assert.equal(noRepositoryId.status, 1);
  assert.match(noRepositoryId.stderr, /Missing --repository-id/);

  const noInstallation = await runCli(["setup", "create", "--repository-id", "123", ...account]);
  assert.equal(noInstallation.status, 1);
  assert.match(noInstallation.stderr, /Missing --installation-id/);

  const badInstallation = await runCli([
    "setup", "create", "--repository-id", "123", "--installation-id", "not-a-number", ...account
  ]);
  assert.equal(badInstallation.status, 1);
  assert.match(badInstallation.stderr, /--installation-id must be a positive integer/);

  const badIntent = await runCli([
    "setup", "create", "--repository-id", "123", "--installation-id", "42", "--intent", "sideways", ...account
  ]);
  assert.equal(badIntent.status, 1);
  assert.match(badIntent.stderr, /--intent must be initial or new_route/);

  const noRouteId = await runCli(["setup", "upgrade-token", ...account]);
  assert.equal(noRouteId.status, 1);
  assert.match(noRouteId.stderr, /Missing --route-id/);

  const noSession = await runCli(["setup", "session", "show", ...account]);
  assert.equal(noSession.status, 1);
  assert.match(noSession.stderr, /Missing setup session id/);
});

test("admin request construction uses exact service paths", () => {
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
  assert.throws(() => planAdminProviderKeySet("openrouter", {}), /--api-key required/);
  assert.equal(adminPaths.providerEnable("vertex").method, "DELETE");
  assert.equal(adminPaths.providerEnable("vertex").path, "/v1/admin/providers/vertex/disable");
  assert.equal(adminPaths.catalogRebuild().path, "/v1/admin/catalog/rebuild-snapshot");
  assert.deepEqual(adminPaths.mappingResolve({ source: "or", rawSourceId: "r1", canonicalId: "c1" }).body, {
    source: "or",
    raw_source_id: "r1",
    canonical_id: "c1"
  });
  assert.deepEqual(adminPaths.mappingIgnore({ source: "or", rawSourceId: "r1" }).body, {
    source: "or",
    raw_source_id: "r1"
  });
  assert.equal(mutationSummary("Archive route", "route_key=app/chat"), "Archive route: route_key=app/chat");
});

test("mutating commands refuse JSON mode without --yes before building a request", async () => {
  const mutations = [
    ["keys", "revoke", "key_1"],
    ["keys", "create", "--product-id", "prod_1"],
    ["routes", "archive", "app/chat"],
    ["routes", "unarchive", "rt_1"],
    ["evals", "run", "app/chat", "--model", "m/1"],
    ["evals", "refresh-preview", "app/chat", "ers_1"],
    ["baseline", "set", "app/chat", "--result-set", "ers_1", "--model", "m/1"],
    ["setup", "create", "--repo", "example/app", "--repository-id", "123", "--installation-id", "42"],
    ["setup", "upgrade-token", "--repo", "example/app", "--route-id", "app/chat"]
  ];
  for (const argv of mutations) {
    const result = await runCli([...argv, "--account-token", "br_ctrl_recorded_fixture", "--json"]);
    assert.equal(result.status, 1, argv.join(" "));
    assert.match(result.stderr, /JSON mode requires --yes/, argv.join(" "));
  }
});

test("catalog outbox drain validates its bounded limit before authentication", async () => {
  const missingValue = await runCli([
    "admin", "catalog", "drain-outbox", "--limit", "--admin-token", "bradm_recorded", "--yes"
  ]);
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /--limit requires a value from 1 to 25/);

  for (const limit of ["0", "26", "1.5", "not-a-number"]) {
    const result = await runCli([
      "admin", "catalog", "drain-outbox", "--limit", limit,
      "--admin-token", "bradm_recorded", "--yes"
    ]);
    assert.equal(result.status, 1, limit);
    assert.match(result.stderr, /--limit must be an integer from 1 to 25/, limit);
  }

  const confirmation = await runCli([
    "admin", "catalog", "drain-outbox", "--admin-token", "bradm_recorded", "--json"
  ]);
  assert.equal(confirmation.status, 1);
  assert.match(confirmation.stderr, /JSON mode requires --yes/);
});

test("token namespaces stay strict across every control command group", async () => {
  const admin = await runCli(["account", "show", "--account-token", "bradm_wrong_scope"]);
  assert.equal(admin.status, 1);
  assert.match(admin.stderr, /Admin tokens cannot authorize account commands/);

  const account = await runCli(["proposals", "list", "--admin-token", "br_ctrl_wrong_scope"]);
  assert.equal(account.status, 1);
  assert.match(account.stderr, /Account control tokens cannot authorize admin commands/);

  const runtime = await runCli(["keys", "list", "--account-token", "br_live_runtime"]);
  assert.equal(runtime.status, 1);
  assert.match(runtime.stderr, /Runtime API keys cannot authorize control-plane commands/);

  const setup = await runCli(["admin", "keys", "list", "--admin-token", "br_setup_repo"]);
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /Repo setup\/read tokens cannot authorize admin commands/);
});

test("--help resolves to the deepest matching command and never sends a request", () => {
  assert.equal(resolveControlUsageName(["keys", "revoke", "key_1"]), "keys revoke");
  assert.equal(resolveControlUsageName(["admin", "providers", "key", "set", "openrouter"]), "admin providers");
  assert.equal(resolveControlUsageName(["admin", "catalog", "mappings", "resolve"]), "admin catalog mappings");
  assert.equal(resolveControlUsageName(["admin", "catalog", "observations", "add"]), "admin catalog observations");
  assert.equal(resolveControlUsageName(["admin", "catalog", "refresh-report"]), "admin catalog");
  assert.equal(resolveControlUsageName(["admin", "catalog", "drain-outbox"]), "admin catalog drain-outbox");
  assert.equal(resolveControlUsageName(["admin", "keys", "list"]), "admin keys");
  assert.equal(resolveControlUsageName(["setup", "create"]), "setup create");
  assert.equal(resolveControlUsageName(["setup", "session", "show", "s_1"]), "setup session show");
  assert.equal(resolveControlUsageName(["setup", "upgrade-token"]), "setup upgrade-token");
  assert.equal(resolveControlUsageName(["evals", "refresh-preview", "app/chat"]), "evals refresh-preview");
  assert.equal(resolveControlUsageName(["models", "show", "app/chat", "m/1"]), "models show");
  assert.equal(resolveControlUsageName(["account", "token", "save"]), "account token save");
  assert.equal(resolveControlUsageName(["doctor"]), null);
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

test("provider and token secrets never reach confirmations or errors", async () => {
  const secret = "sk_provider_secret_value";

  // Refused before the prompt: the confirmation gate must not echo --api-key.
  const jsonGate = await runCli([
    "admin", "providers", "key", "set", "openrouter",
    "--api-key", secret, "--admin-token", "bradm_recorded", "--json"
  ]);
  assert.equal(jsonGate.status, 1);
  assert.doesNotMatch(jsonGate.stdout, new RegExp(secret));
  assert.doesNotMatch(jsonGate.stderr, new RegExp(secret));

  // Rejected credential: the scope error must not echo the provider secret either.
  const wrongScope = await runCli([
    "admin", "providers", "key", "set", "openrouter",
    "--api-key", secret, "--admin-token", "br_ctrl_wrong_scope", "--yes"
  ]);
  assert.equal(wrongScope.status, 1);
  assert.doesNotMatch(wrongScope.stdout, new RegExp(secret));
  assert.doesNotMatch(wrongScope.stderr, new RegExp(secret));

  // A rejected account token must not be echoed back by any customer command.
  const badAccount = await runCli(["setup", "upgrade-token", "--repo", "example/app",
    "--route-id", "app/chat", "--account-token", "br_live_secret_runtime_key", "--yes"]);
  assert.equal(badAccount.status, 1);
  assert.doesNotMatch(badAccount.stderr, /br_live_secret_runtime_key/);
});

test("one-time setup and upgrade secrets are never written to the config dir", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-onetime-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Both commands fail at the network boundary here; what matters is that
  // neither has a save path that could persist the returned secret.
  const commandsSource = await readFile(path.resolve(testDir, "../src/commands.mjs"), "utf8");
  const setupSection = commandsSource.slice(
    commandsSource.indexOf("async function runSetup"),
    commandsSource.indexOf("function requireRepoFullName")
  );
  assert.ok(setupSection.length > 0);
  assert.doesNotMatch(setupSection, /saveAccountToken|saveAdminToken|saveRepoToken|writeFile/);

  const before = await readdir(root).catch(() => []);
  assert.deepEqual(before, []);
});

test("nested help answers every level without a token or a request", async () => {
  const account = await runCli(["account", "--help"]);
  assert.equal(account.status, 0, account.stderr);
  assert.match(account.stdout, /account show/);

  const billing = await runCli(["billing", "top-up", "--help"]);
  assert.equal(billing.status, 0, billing.stderr);
  assert.match(billing.stdout, /Does not open a browser/);

  const admin = await runCli(["admin", "--help"]);
  assert.equal(admin.status, 0, admin.stderr);
  assert.match(admin.stdout, /browser GitHub admin session/);

  // These levels previously fell through the help gate and tried to authenticate.
  const keysRevoke = await runCli(["keys", "revoke", "--help"]);
  assert.equal(keysRevoke.status, 0, keysRevoke.stderr);
  assert.match(keysRevoke.stdout, /POST \/v1\/dashboard\/api-keys\/:keyId\/revoke/);

  const adminKeys = await runCli(["admin", "keys", "--help"]);
  assert.equal(adminKeys.status, 0, adminKeys.stderr);
  assert.match(adminKeys.stdout, /GET \/v1\/admin\/keys/);
  assert.match(adminKeys.stdout, /DELETE \/v1\/admin\/keys\/:id/);
  assert.doesNotMatch(adminKeys.stdout, /benchrouter admin keys mint/);

  const providersList = await runCli(["admin", "providers", "list", "--help"]);
  assert.equal(providersList.status, 0, providersList.stderr);
  assert.match(providersList.stdout, /admin providers list/);

  const modelsShow = await runCli(["models", "show", "--help"]);
  assert.equal(modelsShow.status, 0, modelsShow.stderr);
  assert.match(modelsShow.stdout, /models show <route-key> <model-id>/);
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
