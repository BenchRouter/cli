import { normalizeRepoFullName, saveAccountToken, saveAdminToken } from "./config.mjs";
import { adminPaths, adminKeysMintBrowserSessionRequired, customerPaths } from "./control-api.mjs";
import {
  accountRequest,
  adminRequest,
  emit,
  requireMutationConfirmation,
  subcommand,
  unknown
} from "./control-helpers.mjs";
import { ApiError } from "./http.mjs";
import * as render from "./render.mjs";
import { resolveControlUsageName } from "./usage-text.mjs";

export const CUSTOMER_ROOT_COMMANDS = new Set([
  "account",
  "billing",
  "keys",
  "repos",
  "setup",
  "routes",
  "evals",
  "baseline"
]);

export const ADMIN_ROOT_COMMANDS = new Set(["proposals", "admin"]);

export function isCustomerModelsShow(command, positional) {
  return command === "models" && positional[1] === "show";
}

export function isControlPlaneCommand(command, positional) {
  return (
    CUSTOMER_ROOT_COMMANDS.has(command) ||
    ADMIN_ROOT_COMMANDS.has(command) ||
    isCustomerModelsShow(command, positional)
  );
}

/**
 * @param {object} ctx
 * @param {object} ctx.args
 * @param {string} ctx.command
 * @param {(name: string, fallback?: string) => string|undefined} ctx.stringArg
 * @param {(message: string, code?: string) => never} ctx.fail
 * @param {(status: number, commandName?: string, message?: string) => never} ctx.usage
 * @param {(question: string) => Promise<boolean>} ctx.confirmPrompt
 * @param {() => string|undefined} ctx.detectGitHubRepo
 */
export async function runControlCommand(ctx) {
  const { command } = ctx;
  // One help gate for the whole tree: resolve the deepest matching usage entry
  // so every nesting level answers --help without reaching the network.
  if (ctx.args.help) {
    const usageName = resolveControlUsageName(ctx.args._);
    if (usageName) return ctx.usage(0, usageName);
  }
  try {
    if (command === "account") return await runAccount(ctx);
    if (command === "billing") return await runBilling(ctx);
    if (command === "keys") return await runKeys(ctx);
    if (command === "repos") return await runRepos(ctx);
    if (command === "setup") return await runSetup(ctx);
    if (command === "routes") return await runRoutes(ctx);
    if (command === "models") return await runModelsShow(ctx);
    if (command === "evals") return await runEvals(ctx);
    if (command === "baseline") return await runBaseline(ctx);
    if (command === "proposals") return await runProposals(ctx);
    if (command === "admin") return await runAdmin(ctx);
    ctx.usage(1, "all", `Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof ApiError) {
      ctx.fail(error.message, error.code ?? "command_failed");
    }
    ctx.fail(error instanceof Error ? error.message : "BenchRouter command failed.");
  }
}

async function runAccount(ctx) {
  const sub = subcommand(ctx);
  if (!sub) return ctx.usage(1, "account", "Missing subcommand. Try: account show | account token save");
  if (sub === "show") {
    const body = await accountRequest(ctx, customerPaths.accountSelf());
    return emit(ctx, body, () => render.renderAccountShow(body));
  }
  if (sub === "token") {
    if (ctx.args._[2] !== "save") return unknown(ctx, "account token", ctx.args._[2]);
    const token = ctx.stringArg("account-token") ?? process.env.BENCHROUTER_ACCOUNT_TOKEN;
    if (!token) return ctx.usage(1, "account token save", "Pass --account-token or set BENCHROUTER_ACCOUNT_TOKEN.");
    const target = await saveAccountToken(token);
    process.stdout.write(`Saved account token in ${target}.\n`);
    return;
  }
  return unknown(ctx, "account", sub);
}

async function runBilling(ctx) {
  const sub = subcommand(ctx);
  if (!sub) return ctx.usage(1, "billing", "Missing subcommand. Try: billing show | billing top-up");
  if (sub === "show") {
    const summary = await accountRequest(ctx, customerPaths.dashboardSummary("billing show"));
    const payload = {
      ok: true,
      account: summary.account ?? null,
      billing: summary.billing ?? null,
      recent_ledger: summary.recent_ledger ?? [],
      top_up: summary.top_up ?? null
    };
    return emit(ctx, payload, () => render.renderBillingShow(summary));
  }
  if (sub === "top-up") {
    const amountUsd = Number(ctx.stringArg("amount") ?? ctx.args._[2]);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return ctx.usage(1, "billing top-up", "Missing or invalid --amount (USD).");
    }
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Create billing top-up checkout", `amount_usd=${amountUsd}`)
    );
    const body = await accountRequest(ctx, customerPaths.billingTopUpCheckout(amountUsd));
    return emit(ctx, body, () => render.renderBillingTopUp(body));
  }
  return unknown(ctx, "billing", sub);
}

async function runKeys(ctx) {
  const sub = subcommand(ctx);
  if (!sub) return ctx.usage(1, "keys", "Missing subcommand. Try: keys list | create | revoke");
  if (sub === "list") {
    const summary = await accountRequest(ctx, customerPaths.dashboardSummary("keys list"));
    const keys = Array.isArray(summary.api_keys) ? summary.api_keys : [];
    return emit(ctx, { ok: true, api_keys: keys }, () => render.renderApiKeysList(keys));
  }
  if (sub === "create") {
    const name = ctx.stringArg("name", "CLI key");
    const productId = ctx.stringArg("product-id");
    if (!productId) return ctx.usage(1, "keys create", "Missing --product-id.");
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Create runtime API key", `name=${JSON.stringify(name)} product_id=${productId}`)
    );
    const body = await accountRequest(ctx, customerPaths.apiKeyCreate({ name, productId }));
    return emit(ctx, body, () => render.renderApiKeyCreate(body));
  }
  if (sub === "revoke") {
    const keyId = ctx.stringArg("key-id") ?? ctx.args._[2];
    if (!keyId) return ctx.usage(1, "keys revoke", "Missing key id.");
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Revoke runtime API key", `key_id=${keyId}`)
    );
    const body = await accountRequest(ctx, customerPaths.apiKeyRevoke(keyId));
    return emit(ctx, body, () => render.renderApiKeyRevoke(body, keyId));
  }
  return unknown(ctx, "keys", sub);
}

async function runRepos(ctx) {
  const sub = subcommand(ctx);
  if (!sub) return ctx.usage(1, "repos", "Missing subcommand. Try: repos list");
  if (sub !== "list") return unknown(ctx, "repos", sub);
  const body = await accountRequest(ctx, customerPaths.setupRepos());
  return emit(ctx, body, () => render.renderReposList(body));
}

async function runSetup(ctx) {
  const sub = subcommand(ctx);
  if (!sub) {
    return ctx.usage(1, "setup", "Missing subcommand. Try: setup status | create | session show | upgrade-token");
  }
  if (sub === "status") {
    const repoFullName = requireRepoFullName(ctx, "setup status");
    const body = await accountRequest(ctx, customerPaths.setupDiagnostic(repoFullName));
    return emit(ctx, body, () => render.renderSetupStatus(body));
  }
  if (sub === "create") {
    const repoFullName = requireRepoFullName(ctx, "setup create");
    const repositoryId = ctx.stringArg("repository-id");
    const installationIdArg = ctx.stringArg("installation-id");
    const intent = ctx.stringArg("intent", "initial");
    if (!repositoryId) return ctx.usage(1, "setup create", "Missing --repository-id (the GitHub repository ID).");
    if (!installationIdArg) return ctx.usage(1, "setup create", "Missing --installation-id.");
    const installationId = Number(installationIdArg);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return ctx.usage(1, "setup create", "--installation-id must be a positive integer.");
    }
    if (intent !== "initial" && intent !== "new_route") {
      return ctx.usage(1, "setup create", "--intent must be initial or new_route.");
    }
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Create setup session", `repo=${repoFullName} intent=${intent}`)
    );
    const body = await accountRequest(
      ctx,
      customerPaths.setupSessionCreate({ repositoryId, repoFullName, installationId, intent })
    );
    return emit(ctx, body, () => render.renderSetupSessionCreate(body));
  }
  if (sub === "session") {
    if (ctx.args._[2] !== "show") return unknown(ctx, "setup session", ctx.args._[2]);
    const sessionId = ctx.stringArg("session-id") ?? ctx.args._[3];
    if (!sessionId) return ctx.usage(1, "setup session show", "Missing setup session id.");
    const body = await accountRequest(ctx, customerPaths.setupSessionGet(sessionId));
    return emit(ctx, body, () => render.renderSetupSessionShow(body));
  }
  if (sub === "upgrade-token") {
    const repoFullName = requireRepoFullName(ctx, "setup upgrade-token");
    const routeId = ctx.stringArg("route-id") ?? ctx.args._[2];
    if (!routeId) return ctx.usage(1, "setup upgrade-token", "Missing --route-id.");
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Mint single-use setup-kit upgrade token", `repo=${repoFullName} route_id=${routeId}`)
    );
    const body = await accountRequest(ctx, customerPaths.setupKitUpgradeToken(repoFullName, routeId));
    return emit(ctx, body, () => render.renderUpgradeTokenMint(body));
  }
  return unknown(ctx, "setup", sub);
}

function requireRepoFullName(ctx, usageName) {
  const repoCandidate = ctx.stringArg("repo") ?? ctx.detectGitHubRepo();
  if (!repoCandidate) {
    ctx.usage(1, usageName, "Missing --repo and unable to detect one from git remote.");
  }
  try {
    return normalizeRepoFullName(repoCandidate);
  } catch (error) {
    return ctx.fail(
      error instanceof Error ? error.message : "Repository must use the owner/repo form.",
      "invalid_repository"
    );
  }
}

async function runRoutes(ctx) {
  const sub = subcommand(ctx);
  if (!sub) {
    return ctx.usage(1, "routes", "Missing subcommand. Try: routes list | show | catalog | archive | unarchive");
  }
  if (sub === "list") {
    const summary = await accountRequest(ctx, customerPaths.dashboardSummary("routes list"));
    return emit(
      ctx,
      { ok: true, routes: summary.routes ?? [], archived_routes: summary.archived_routes ?? [] },
      () => render.renderRoutesList(summary.routes ?? [], summary.archived_routes ?? [])
    );
  }
  if (sub === "show") {
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes show", "Missing route key.");
    const summary = await accountRequest(ctx, customerPaths.dashboardSummary("routes show"));
    const route = (Array.isArray(summary.routes) ? summary.routes : []).find((entry) => entry.route_key === routeKey);
    if (!route) ctx.fail(`Route not found in account summary: ${routeKey}`, "route_not_found");
    return emit(ctx, { ok: true, route }, () => render.renderRouteShow(route));
  }
  if (sub === "catalog") {
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes catalog", "Missing route key.");
    const body = await accountRequest(ctx, customerPaths.routeCatalog(routeKey));
    return emit(ctx, body, () => render.renderRouteCatalog(body));
  }
  if (sub === "archive") {
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes archive", "Missing route key.");
    await requireMutationConfirmation(ctx, render.mutationSummary("Archive route", `route_key=${routeKey}`));
    const body = await accountRequest(ctx, customerPaths.routeArchive(routeKey));
    return emit(ctx, body, () => render.renderArchive(body));
  }
  if (sub === "unarchive") {
    const routeId = ctx.args._[2];
    if (!routeId) return ctx.usage(1, "routes unarchive", "Missing route id.");
    await requireMutationConfirmation(ctx, render.mutationSummary("Unarchive route", `route_id=${routeId}`));
    const body = await accountRequest(ctx, customerPaths.routeUnarchive(routeId));
    return emit(ctx, body, () => render.renderUnarchive(body));
  }
  return unknown(ctx, "routes", sub);
}

async function runModelsShow(ctx) {
  const routeKey = ctx.args._[2];
  const modelId = ctx.args._[3];
  if (!routeKey || !modelId) return ctx.usage(1, "models show", "Missing route key or model id.");
  const body = await accountRequest(ctx, customerPaths.routeModel(routeKey, modelId));
  return emit(ctx, body, () => render.renderRouteModel(body));
}

async function runEvals(ctx) {
  const sub = subcommand(ctx);
  if (!sub) {
    return ctx.usage(1, "evals", "Missing subcommand. Try: evals list | run | failures | refresh-preview");
  }
  if (sub === "list") {
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "evals list", "Missing route key.");
    const body = await accountRequest(ctx, customerPaths.routeCatalog(routeKey, "evals list"));
    const payload = {
      ok: true,
      route_key: body.route_key,
      eval_history: body.eval_history ?? [],
      evals: body.evals ?? {},
      latest_eval_batch: body.latest_eval_batch ?? null
    };
    return emit(ctx, payload, () => render.renderEvalsList(body));
  }
  if (sub === "run") {
    const routeKey = ctx.args._[2];
    const model = ctx.stringArg("model") ?? ctx.args._[3];
    if (!routeKey) return ctx.usage(1, "evals run", "Missing route key.");
    if (!model) return ctx.usage(1, "evals run", "Missing --model.");
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Create eval result set", `route_key=${routeKey} model=${model}`)
    );
    const body = await accountRequest(ctx, customerPaths.routeResultSetCreate(routeKey, model));
    return emit(ctx, body, () => render.renderEvalsRun(body));
  }
  if (sub === "refresh-preview") {
    const routeKey = ctx.args._[2];
    const resultSetId = ctx.stringArg("result-set") ?? ctx.args._[3];
    const model = ctx.stringArg("model");
    if (!routeKey) return ctx.usage(1, "evals refresh-preview", "Missing route key.");
    if (!resultSetId) return ctx.usage(1, "evals refresh-preview", "Missing result set id.");
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary(
        "Refresh PR preview result set",
        `route_key=${routeKey} result_set_id=${resultSetId}${model ? ` model=${model}` : ""}`
      )
    );
    const body = await accountRequest(
      ctx,
      customerPaths.routeResultSetRefreshPreview(routeKey, resultSetId, model)
    );
    return emit(ctx, body, () => render.renderEvalsRefreshPreview(body));
  }
  if (sub === "failures") {
    const routeKey = ctx.args._[2];
    const modelId = ctx.stringArg("model") ?? ctx.args._[3];
    if (!routeKey) return ctx.usage(1, "evals failures", "Missing route key.");
    if (!modelId) {
      return ctx.usage(
        1,
        "evals failures",
        "Missing model id. Pass the model, or use repo-read `benchrouter failures <route-key> [model]`."
      );
    }
    const body = await accountRequest(ctx, customerPaths.routeModel(routeKey, modelId, "evals failures"));
    const results = Array.isArray(body.latest_eval?.results) ? body.latest_eval.results : [];
    const payload = {
      ok: true,
      route_key: body.route_key,
      model: modelId,
      model_run_id: body.latest_eval?.model_run_id ?? null,
      failures: results.filter((row) => row && row.outcome && row.outcome !== "pass")
    };
    return emit(ctx, payload, () => render.renderEvalsFailures(body, modelId));
  }
  return unknown(ctx, "evals", sub);
}

async function runBaseline(ctx) {
  const sub = subcommand(ctx);
  if (!sub) return ctx.usage(1, "baseline", "Missing subcommand. Try: baseline set");
  if (sub !== "set") return unknown(ctx, "baseline", sub);
  const routeKey = ctx.args._[2];
  const resultSetId = ctx.stringArg("result-set") ?? ctx.stringArg("result-set-id");
  const model = ctx.stringArg("model");
  if (!routeKey) return ctx.usage(1, "baseline set", "Missing route key.");
  if (!resultSetId) return ctx.usage(1, "baseline set", "Missing --result-set.");
  if (!model) return ctx.usage(1, "baseline set", "Missing --model.");
  await requireMutationConfirmation(
    ctx,
    render.mutationSummary(
      "Set route comparison baseline",
      `route_key=${routeKey} result_set_id=${resultSetId} model=${model}`
    )
  );
  const body = await accountRequest(ctx, customerPaths.routeBaselineSet(routeKey, resultSetId, model));
  return emit(ctx, body, () => render.renderBaselineSet(body));
}

async function runProposals(ctx) {
  const sub = subcommand(ctx);
  if (!sub) return ctx.usage(1, "proposals", "Missing subcommand. Try: proposals list | approve | reject");
  if (sub === "list") {
    const body = await adminRequest(ctx, adminPaths.proposalsList());
    return emit(ctx, body, () => render.renderProposalsList(body));
  }
  if (sub === "approve" || sub === "reject") {
    const proposalId = ctx.args._[2];
    if (!proposalId) return ctx.usage(1, `proposals ${sub}`, "Missing proposal id.");
    const verb = sub === "approve" ? "Approve" : "Reject";
    await requireMutationConfirmation(ctx, render.mutationSummary(`${verb} catalog proposal`, proposalId));
    const body = await adminRequest(ctx, planProposalAction(sub, proposalId));
    return emit(ctx, body, () => render.renderProposalDecision(proposalId, body, sub));
  }
  return unknown(ctx, "proposals", sub);
}

async function runAdmin(ctx) {
  const group = subcommand(ctx);
  if (!group) return ctx.usage(1, "admin", "Missing subcommand. Try: admin providers | catalog | keys | token");
  if (group === "token") return runAdminTokenSave(ctx);
  if (group === "providers") return runAdminProviders(ctx);
  if (group === "catalog") return runAdminCatalog(ctx);
  if (group === "keys") return runAdminKeys(ctx);
  return unknown(ctx, "admin", group);
}

async function runAdminTokenSave(ctx) {
  if (ctx.args._[2] !== "save") return unknown(ctx, "admin token", ctx.args._[2]);
  const token = ctx.stringArg("admin-token") ?? process.env.BENCHROUTER_ADMIN_TOKEN;
  if (!token) return ctx.usage(1, "admin token save", "Pass --admin-token or set BENCHROUTER_ADMIN_TOKEN.");
  const target = await saveAdminToken(token);
  process.stdout.write(`Saved admin token in ${target}.\n`);
}

async function runAdminProviders(ctx) {
  const action = ctx.args._[2];
  if (!action) return ctx.usage(1, "admin providers", "Missing subcommand.");
  if (action === "list") {
    const body = await adminRequest(ctx, adminPaths.providersList());
    return emit(ctx, body, () => render.renderProvidersList(body));
  }
  if (action === "key") {
    const keyAction = ctx.args._[3];
    const provider = ctx.args._[4];
    if (keyAction === "set") {
      if (!provider) return ctx.usage(1, "admin providers key set", "Missing provider.");
      const apiKey = ctx.stringArg("api-key");
      if (!apiKey) return ctx.usage(1, "admin providers key set", "Missing --api-key.");
      await requireMutationConfirmation(ctx, render.mutationSummary("Set provider key", provider));
      // The confirmation names the provider only; the secret never enters it.
      const spec = planAdminProviderKeySet(provider, { apiKey, baseUrl: ctx.stringArg("base-url") });
      const result = await adminRequest(ctx, spec);
      return emit(ctx, result, () => render.renderProviderKeySet(result, provider));
    }
    if (keyAction === "delete") {
      if (!provider) return ctx.usage(1, "admin providers key delete", "Missing provider.");
      await requireMutationConfirmation(ctx, render.mutationSummary("Delete provider key", provider));
      const result = await adminRequest(ctx, adminPaths.providerKeyDelete(provider));
      return emit(ctx, result, () => render.renderProviderKeyDelete(result, provider));
    }
    return unknown(ctx, "admin providers key", keyAction);
  }
  if (action === "smoke" || action === "disable" || action === "enable") {
    const provider = ctx.args._[3];
    if (!provider) return ctx.usage(1, `admin providers ${action}`, "Missing provider.");
    const summary = action === "enable"
      ? `Enable provider ${provider} (clear disable override)`
      : `${action[0].toUpperCase()}${action.slice(1)} provider ${provider}`;
    await requireMutationConfirmation(ctx, summary);
    const spec = action === "smoke"
      ? adminPaths.providerSmoke(provider)
      : action === "disable"
        ? adminPaths.providerDisable(provider)
        : adminPaths.providerEnable(provider);
    const body = await adminRequest(ctx, spec);
    return emit(ctx, body, () => {
      if (action === "smoke") return render.renderProviderSmoke(body, provider);
      return render.renderProviderDisableState(body, provider, action);
    });
  }
  return unknown(ctx, "admin providers", action);
}

async function runAdminCatalog(ctx) {
  const action = ctx.args._[2];
  if (!action) {
    return ctx.usage(
      1,
      "admin catalog",
      "Missing subcommand. Try: show | activity | observations | mappings | model-maps | refresh-report | rebuild"
    );
  }
  if (action === "show") {
    const body = await adminRequest(ctx, adminPaths.catalogShow());
    return emit(ctx, body, () => render.renderAdminCatalogShow(body));
  }
  if (action === "activity") {
    const body = await adminRequest(ctx, adminPaths.catalogActivity());
    return emit(ctx, body, () => render.renderAdminCatalogActivity(body));
  }
  if (action === "observations") return runAdminCatalogObservations(ctx);
  if (action === "mappings") return runAdminCatalogMappings(ctx);
  if (action === "model-maps") {
    const body = await adminRequest(ctx, adminPaths.modelIdMaps());
    return emit(ctx, body, () => render.renderAdminModelIdMaps(body));
  }
  if (action === "refresh-report") {
    // Report-only: the server fetches upstream state and writes nothing, so this
    // needs no confirmation even though it is a POST.
    const body = await adminRequest(ctx, adminPaths.catalogRefreshReport());
    return emit(ctx, body, () => render.renderAdminCatalogRefreshReport(body));
  }
  if (action === "rebuild") {
    await requireMutationConfirmation(ctx, "Rebuild catalog snapshot");
    const body = await adminRequest(ctx, adminPaths.catalogRebuild());
    return emit(ctx, body, () => render.renderAdminCatalogRebuild(body));
  }
  return unknown(ctx, "admin catalog", action);
}

async function runAdminCatalogObservations(ctx) {
  if (ctx.args._[3] !== "add") {
    const body = await adminRequest(ctx, adminPaths.catalogObservations(observationQuery(ctx)));
    return emit(ctx, body, () => render.renderAdminObservationsList(body));
  }
  const source = ctx.stringArg("source");
  const subjectKind = ctx.stringArg("subject-kind");
  if (!source || !subjectKind) {
    return ctx.usage(1, "admin catalog observations", "Requires --source and --subject-kind.");
  }
  let payload;
  const payloadJson = ctx.stringArg("payload-json");
  if (payloadJson !== undefined) {
    payload = parseJsonObjectArg(ctx, "--payload-json", payloadJson);
  }
  await requireMutationConfirmation(
    ctx,
    render.mutationSummary("Record catalog observation", `source=${source} subject_kind=${subjectKind}`)
  );
  const body = await adminRequest(
    ctx,
    adminPaths.observationCreate({
      source,
      subjectKind,
      derivedAction: ctx.stringArg("derived-action"),
      matchConfidence: ctx.stringArg("match-confidence"),
      canonicalId: ctx.stringArg("canonical-id"),
      sourceVersion: ctx.stringArg("source-version"),
      rawSourceId: ctx.stringArg("raw-source-id"),
      payload
    })
  );
  return emit(ctx, body, () => render.renderAdminObservationCreate(body));
}

/**
 * Parse a JSON flag with the real JSON parser and require a plain object,
 * which is what the server accepts for an observation payload.
 */
export function parseJsonObjectArg(ctx, flag, value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return ctx.fail(
      `${flag} must be valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
      "invalid_json_argument"
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ctx.fail(`${flag} must be a JSON object.`, "invalid_json_argument");
  }
  return parsed;
}

async function runAdminCatalogMappings(ctx) {
  const mappingAction = ctx.args._[3];
  const source = ctx.stringArg("source");
  const rawSourceId = ctx.stringArg("raw-source-id");
  if (!mappingAction || mappingAction === "list") {
    const body = await adminRequest(ctx, adminPaths.mappingsList());
    return emit(ctx, body, () => render.renderAdminMappingsList(body));
  }
  if (mappingAction === "resolve") {
    const canonicalId = ctx.stringArg("canonical-id");
    if (!source || !rawSourceId || !canonicalId) {
      return ctx.usage(1, "admin catalog mappings", "Requires --source, --raw-source-id, and --canonical-id.");
    }
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Resolve mapping", `${source}:${rawSourceId} -> ${canonicalId}`)
    );
    const body = await adminRequest(ctx, adminPaths.mappingResolve({ source, rawSourceId, canonicalId }));
    return emit(ctx, body, () => render.renderAdminMappingDecision(body, { source, rawSourceId }));
  }
  if (mappingAction === "ignore") {
    if (!source || !rawSourceId) {
      return ctx.usage(1, "admin catalog mappings", "Requires --source and --raw-source-id.");
    }
    await requireMutationConfirmation(ctx, render.mutationSummary("Ignore mapping", `${source}:${rawSourceId}`));
    const body = await adminRequest(ctx, adminPaths.mappingIgnore({ source, rawSourceId }));
    return emit(ctx, body, () => render.renderAdminMappingDecision(body, { source, rawSourceId }));
  }
  return unknown(ctx, "admin catalog mappings", mappingAction);
}

function observationQuery(ctx) {
  const query = new URLSearchParams();
  for (const [flag, key] of [
    ["source", "source"],
    ["canonical-id", "canonical_id"],
    ["subject-kind", "subject_kind"],
    ["proposal-id", "proposal_id"],
    ["raw-source-id", "raw_source_id"],
    ["limit", "limit"]
  ]) {
    const value = ctx.stringArg(flag);
    if (value) query.set(key, value);
  }
  return query.toString();
}

async function runAdminKeys(ctx) {
  const action = ctx.args._[2];
  if (!action) return ctx.usage(1, "admin keys", "Missing subcommand. Try: admin keys list | revoke");
  if (action === "list") {
    const body = await adminRequest(ctx, adminPaths.adminKeysList());
    return emit(ctx, body, () => render.renderAdminKeysList(body));
  }
  if (action === "revoke") {
    const keyId = ctx.stringArg("key-id") ?? ctx.args._[3];
    if (!keyId) return ctx.usage(1, "admin keys", "Missing admin key id.");
    await requireMutationConfirmation(ctx, render.mutationSummary("Revoke admin key", `id=${keyId}`));
    const body = await adminRequest(ctx, adminPaths.adminKeysRevoke(keyId));
    return emit(ctx, body, () => render.renderAdminKeyRevoke(body, keyId));
  }
  if (action === "mint") {
    // The server answers a bradm_ bearer with admin_session_required, so state
    // that instead of sending a request that cannot succeed.
    ctx.fail(adminKeysMintBrowserSessionRequired(), "admin_session_required");
  }
  return unknown(ctx, "admin keys", action);
}

/** Pure request-construction helpers for regression tests. */
export function planAdminProviderKeySet(provider, { apiKey, baseUrl } = {}) {
  if (!provider) throw new Error("provider required");
  if (!apiKey) throw new Error("--api-key required");
  return adminPaths.providerKeySet(provider, { apiKey, baseUrl });
}

export function planProposalAction(action, proposalId) {
  if (action === "approve") return adminPaths.proposalsApprove(proposalId);
  if (action === "reject") return adminPaths.proposalsReject(proposalId);
  throw new Error(`Unknown proposals action: ${action}`);
}
