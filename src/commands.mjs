import { normalizeRepoFullName, saveAccountToken, saveAdminToken } from "./config.mjs";
import * as api from "./control-api.mjs";
import {
  ApiError,
  MissingServerContractError,
  defaultApiUrl,
  requireAccountCredential,
  requireAdminCredential,
  apiRequest
} from "./http.mjs";
import * as render from "./render.mjs";

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
    if (error instanceof MissingServerContractError) {
      ctx.fail(error.requirement, "missing_server_contract");
    }
    if (error instanceof ApiError) {
      ctx.fail(error.message, error.code ?? "command_failed");
    }
    ctx.fail(error instanceof Error ? error.message : "BenchRouter command failed.");
  }
}

async function runAccount(ctx) {
  const sub = subcommand(ctx);
  if (ctx.args.help && (!sub || sub === "show" || sub === "token")) {
    return ctx.usage(0, sub ? `account ${sub}` : "account");
  }
  if (!sub) return ctx.usage(1, "account", "Missing subcommand. Try: account show | account token save");
  if (sub === "show") {
    const body = await api.getAccountSelf(accountClient(ctx));
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
  if (ctx.args.help && !sub) return ctx.usage(0, "billing");
  if (!sub) return ctx.usage(1, "billing", "Missing subcommand. Try: billing show | billing top-up");
  if (sub === "show") {
    if (ctx.args.help) return ctx.usage(0, "billing show");
    const summary = await api.getDashboardSummary(accountClient(ctx));
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
    if (ctx.args.help) return ctx.usage(0, "billing top-up");
    const amountUsd = Number(ctx.stringArg("amount") ?? ctx.args._[2]);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return ctx.usage(1, "billing top-up", "Missing or invalid --amount (USD).");
    }
    await requireMutationConfirmation(ctx, render.mutationSummary("Create billing top-up checkout", `amount_usd=${amountUsd}`));
    const body = await api.createBillingTopUpCheckout(accountClient(ctx), amountUsd);
    return emit(ctx, body, () => render.renderBillingTopUp(body));
  }
  return unknown(ctx, "billing", sub);
}

async function runKeys(ctx) {
  const sub = subcommand(ctx);
  if (ctx.args.help && !sub) return ctx.usage(0, "keys");
  if (!sub) return ctx.usage(1, "keys", "Missing subcommand. Try: keys list | create | revoke");
  if (sub === "list") {
    if (ctx.args.help) return ctx.usage(0, "keys list");
    const summary = await api.getDashboardSummary(accountClient(ctx));
    const keys = Array.isArray(summary.api_keys) ? summary.api_keys : [];
    return emit(ctx, { ok: true, api_keys: keys }, () => render.renderApiKeysList(keys));
  }
  if (sub === "create") {
    if (ctx.args.help) return ctx.usage(0, "keys create");
    const name = ctx.stringArg("name", "CLI key");
    const productId = ctx.stringArg("product-id");
    if (!productId) return ctx.usage(1, "keys create", "Missing --product-id.");
    await requireMutationConfirmation(ctx, render.mutationSummary("Create runtime API key", `name=${JSON.stringify(name)} product_id=${productId}`));
    const body = await api.createDashboardApiKey(accountClient(ctx), { name, productId });
    return emit(ctx, body, () => render.renderApiKeyCreate(body));
  }
  if (sub === "revoke") {
    if (ctx.args.help) return ctx.usage(0, "keys revoke");
    const keyId = ctx.stringArg("key-id") ?? ctx.args._[2];
    if (!keyId) return ctx.usage(1, "keys revoke", "Missing key id.");
    await api.revokeDashboardApiKey(accountClient(ctx), keyId);
    return;
  }
  return unknown(ctx, "keys", sub);
}

async function runRepos(ctx) {
  const sub = subcommand(ctx);
  if (ctx.args.help && (!sub || sub === "list")) return ctx.usage(0, sub === "list" ? "repos list" : "repos");
  if (!sub) return ctx.usage(1, "repos", "Missing subcommand. Try: repos list");
  if (sub !== "list") return unknown(ctx, "repos", sub);
  const body = await api.listSetupRepos(accountClient(ctx));
  return emit(ctx, body, () => render.renderReposList(body));
}

async function runSetup(ctx) {
  const sub = subcommand(ctx);
  if (ctx.args.help && !sub) return ctx.usage(0, "setup");
  if (!sub) return ctx.usage(1, "setup", "Missing subcommand. Try: setup status");
  if (sub !== "status") return unknown(ctx, "setup", sub);
  if (ctx.args.help) return ctx.usage(0, "setup status");
  const repoCandidate = ctx.stringArg("repo") ?? ctx.detectGitHubRepo();
  if (!repoCandidate) {
    return ctx.usage(1, "setup status", "Missing --repo and unable to detect one from git remote.");
  }
  let repoFullName;
  try {
    repoFullName = normalizeRepoFullName(repoCandidate);
  } catch (error) {
    ctx.fail(error instanceof Error ? error.message : "Repository must use the owner/repo form.", "invalid_repository");
  }
  const body = await api.getSetupDiagnostic(accountClient(ctx), repoFullName);
  return emit(ctx, body, () => render.renderSetupStatus(body));
}

async function runRoutes(ctx) {
  const sub = subcommand(ctx);
  if (ctx.args.help && !sub) return ctx.usage(0, "routes");
  if (!sub) return ctx.usage(1, "routes", "Missing subcommand. Try: routes list | show | catalog | archive | unarchive");
  if (sub === "list") {
    if (ctx.args.help) return ctx.usage(0, "routes list");
    const summary = await api.getDashboardSummary(accountClient(ctx));
    return emit(
      ctx,
      { ok: true, routes: summary.routes ?? [], archived_routes: summary.archived_routes ?? [] },
      () => render.renderRoutesList(summary.routes ?? [], summary.archived_routes ?? [])
    );
  }
  if (sub === "show") {
    if (ctx.args.help) return ctx.usage(0, "routes show");
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes show", "Missing route key.");
    const summary = await api.getDashboardSummary(accountClient(ctx));
    const route = (Array.isArray(summary.routes) ? summary.routes : []).find((entry) => entry.route_key === routeKey);
    if (!route) ctx.fail(`Route not found in account summary: ${routeKey}`, "route_not_found");
    return emit(ctx, { ok: true, route }, () => render.renderRouteShow(route));
  }
  if (sub === "catalog") {
    if (ctx.args.help) return ctx.usage(0, "routes catalog");
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes catalog", "Missing route key.");
    const body = await api.getRouteCatalog(accountClient(ctx), routeKey);
    return emit(ctx, body, () => render.renderRouteCatalog(body));
  }
  if (sub === "archive") {
    if (ctx.args.help) return ctx.usage(0, "routes archive");
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes archive", "Missing route key.");
    await requireMutationConfirmation(ctx, render.mutationSummary("Archive route", `route_key=${routeKey}`));
    const body = await api.archiveRoute(accountClient(ctx), routeKey);
    return emit(ctx, body, () => render.renderArchive(body));
  }
  if (sub === "unarchive") {
    if (ctx.args.help) return ctx.usage(0, "routes unarchive");
    const routeId = ctx.args._[2];
    if (!routeId) return ctx.usage(1, "routes unarchive", "Missing route id.");
    await requireMutationConfirmation(ctx, render.mutationSummary("Unarchive route", `route_id=${routeId}`));
    const body = await api.unarchiveRoute(accountClient(ctx), routeId);
    return emit(ctx, body, () => render.renderUnarchive(body));
  }
  return unknown(ctx, "routes", sub);
}

async function runModelsShow(ctx) {
  if (ctx.args.help) return ctx.usage(0, "models show");
  const routeKey = ctx.args._[2];
  const modelId = ctx.args._[3];
  if (!routeKey || !modelId) return ctx.usage(1, "models show", "Missing route key or model id.");
  const body = await api.getRouteModel(accountClient(ctx), routeKey, modelId);
  return emit(ctx, body, () => render.renderRouteModel(body));
}

async function runEvals(ctx) {
  const sub = subcommand(ctx);
  if (ctx.args.help && !sub) return ctx.usage(0, "evals");
  if (!sub) return ctx.usage(1, "evals", "Missing subcommand. Try: evals list | run | failures");
  if (sub === "list") {
    if (ctx.args.help) return ctx.usage(0, "evals list");
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "evals list", "Missing route key.");
    const body = await api.getRouteCatalog(accountClient(ctx), routeKey);
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
    if (ctx.args.help) return ctx.usage(0, "evals run");
    const routeKey = ctx.args._[2];
    const model = ctx.stringArg("model") ?? ctx.args._[3];
    if (!routeKey) return ctx.usage(1, "evals run", "Missing route key.");
    if (!model) return ctx.usage(1, "evals run", "Missing --model.");
    await requireMutationConfirmation(ctx, render.mutationSummary("Create eval result set", `route_key=${routeKey} model=${model}`));
    const body = await api.createRouteResultSet(accountClient(ctx), routeKey, model);
    return emit(ctx, body, () => render.renderEvalsRun(body));
  }
  if (sub === "failures") {
    if (ctx.args.help) return ctx.usage(0, "evals failures");
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
    const body = await api.getRouteModel(accountClient(ctx), routeKey, modelId);
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
  if (ctx.args.help && !sub) return ctx.usage(0, "baseline");
  if (!sub) return ctx.usage(1, "baseline", "Missing subcommand. Try: baseline set");
  if (sub !== "set") return unknown(ctx, "baseline", sub);
  if (ctx.args.help) return ctx.usage(0, "baseline set");
  const routeKey = ctx.args._[2];
  const resultSetId = ctx.stringArg("result-set") ?? ctx.stringArg("result-set-id");
  const model = ctx.stringArg("model");
  if (!routeKey) return ctx.usage(1, "baseline set", "Missing route key.");
  if (!resultSetId) return ctx.usage(1, "baseline set", "Missing --result-set.");
  if (!model) return ctx.usage(1, "baseline set", "Missing --model.");
  await requireMutationConfirmation(
    ctx,
    render.mutationSummary("Set route comparison baseline", `route_key=${routeKey} result_set_id=${resultSetId} model=${model}`)
  );
  const body = await api.setRouteBaseline(accountClient(ctx), routeKey, resultSetId, model);
  return emit(ctx, body, () => render.renderBaselineSet(body));
}

async function runProposals(ctx) {
  const sub = subcommand(ctx);
  if (ctx.args.help && !sub) return ctx.usage(0, "proposals");
  if (!sub) return ctx.usage(1, "proposals", "Missing subcommand. Try: proposals list | approve | reject");
  if (sub === "list") {
    if (ctx.args.help) return ctx.usage(0, "proposals list");
    const spec = api.adminPaths.proposalsList();
    const body = await adminRequest(ctx, spec);
    return emit(ctx, body, () => render.renderProposalsList(body));
  }
  if (sub === "approve" || sub === "reject") {
    if (ctx.args.help) return ctx.usage(0, `proposals ${sub}`);
    const proposalId = ctx.args._[2];
    if (!proposalId) return ctx.usage(1, `proposals ${sub}`, "Missing proposal id.");
    const verb = sub === "approve" ? "Approve" : "Reject";
    await requireMutationConfirmation(ctx, render.mutationSummary(`${verb} catalog proposal`, proposalId));
    const spec = sub === "approve"
      ? api.adminPaths.proposalsApprove(proposalId)
      : api.adminPaths.proposalsReject(proposalId);
    const body = await adminRequest(ctx, spec);
    return emit(ctx, body, () => {
      process.stdout.write(
        `Proposal ${proposalId}: ${body.resolution ?? sub}${body.already_resolved ? " (already resolved)" : ""}\n`
      );
    });
  }
  return unknown(ctx, "proposals", sub);
}

async function runAdmin(ctx) {
  const group = subcommand(ctx);
  if (ctx.args.help && !group) return ctx.usage(0, "admin");
  if (!group) return ctx.usage(1, "admin", "Missing subcommand. Try: admin providers | catalog | keys | token");
  if (group === "token") return runAdminTokenSave(ctx);
  if (group === "providers") return runAdminProviders(ctx);
  if (group === "catalog") return runAdminCatalog(ctx);
  if (group === "keys") return runAdminKeys(ctx);
  return unknown(ctx, "admin", group);
}

async function runAdminTokenSave(ctx) {
  if (ctx.args._[2] !== "save") return unknown(ctx, "admin token", ctx.args._[2]);
  if (ctx.args.help) return ctx.usage(0, "admin token save");
  const token = ctx.stringArg("admin-token") ?? process.env.BENCHROUTER_ADMIN_TOKEN;
  if (!token) return ctx.usage(1, "admin token save", "Pass --admin-token or set BENCHROUTER_ADMIN_TOKEN.");
  const target = await saveAdminToken(token);
  process.stdout.write(`Saved admin token in ${target}.\n`);
}

async function runAdminProviders(ctx) {
  const action = ctx.args._[2];
  if (ctx.args.help && !action) return ctx.usage(0, "admin providers");
  if (!action) return ctx.usage(1, "admin providers", "Missing subcommand.");
  if (action === "list") {
    const body = await adminRequest(ctx, api.adminPaths.providersList());
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
      const body = { api_key: apiKey };
      const baseUrl = ctx.stringArg("base-url");
      if (baseUrl) body.base_url = baseUrl;
      const result = await adminRequest(ctx, { ...api.adminPaths.providerKeySet(provider), body });
      return emit(ctx, result, () => {
        process.stdout.write(`Stored provider key for ${result.provider ?? provider}.\n`);
      });
    }
    if (keyAction === "delete") {
      if (!provider) return ctx.usage(1, "admin providers key delete", "Missing provider.");
      await requireMutationConfirmation(ctx, render.mutationSummary("Delete provider key", provider));
      const result = await adminRequest(ctx, api.adminPaths.providerKeyDelete(provider));
      return emit(ctx, result, () => {
        process.stdout.write(`Deleted provider key for ${result.provider ?? provider}.\n`);
      });
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
      ? api.adminPaths.providerSmoke(provider)
      : action === "disable"
        ? api.adminPaths.providerDisable(provider)
        : api.adminPaths.providerEnable(provider);
    const body = await adminRequest(ctx, spec);
    return emit(ctx, body, () => {
      if (action === "smoke") {
        process.stdout.write(`Smoke ${body.status ?? "unknown"} for ${provider}.\n`);
        return;
      }
      process.stdout.write(`${summary}.\n`);
    });
  }
  return unknown(ctx, "admin providers", action);
}

async function runAdminCatalog(ctx) {
  const action = ctx.args._[2];
  if (ctx.args.help && !action) return ctx.usage(0, "admin catalog");
  if (!action) return ctx.usage(1, "admin catalog", "Missing subcommand.");
  if (action === "show") {
    const body = await adminRequest(ctx, api.adminPaths.catalogShow());
    return emit(ctx, body, () => {
      const models = Array.isArray(body?.models) ? body.models.length : body?.models ?? "?";
      process.stdout.write(`Catalog models: ${models}\n`);
    });
  }
  if (action === "activity") {
    const body = await adminRequest(ctx, api.adminPaths.catalogActivity());
    return emit(ctx, body, () => {
      const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
      process.stdout.write(`Catalog activity entries: ${rows.length}\n`);
    });
  }
  if (action === "observations") {
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
    const body = await adminRequest(ctx, api.adminPaths.catalogObservations(query.toString()));
    return emit(ctx, body, () => {
      const rows = Array.isArray(body?.data) ? body.data : [];
      process.stdout.write(`Observations: ${rows.length}\n`);
    });
  }
  if (action === "mappings") {
    const mappingAction = ctx.args._[3];
    if (mappingAction === "resolve") {
      const source = ctx.stringArg("source");
      const rawSourceId = ctx.stringArg("raw-source-id");
      const canonicalId = ctx.stringArg("canonical-id");
      if (!source || !rawSourceId || !canonicalId) {
        return ctx.usage(1, "admin catalog mappings resolve", "Requires --source, --raw-source-id, and --canonical-id.");
      }
      await requireMutationConfirmation(
        ctx,
        render.mutationSummary("Resolve mapping", `${source}:${rawSourceId} → ${canonicalId}`)
      );
      const body = await adminRequest(ctx, {
        ...api.adminPaths.mappingResolve(),
        body: { source, raw_source_id: rawSourceId, canonical_id: canonicalId }
      });
      return emit(ctx, body, () => {
        process.stdout.write(`Mapping ${source}:${rawSourceId} → ${body.decision ?? "resolve"} (${canonicalId}).\n`);
      });
    }
    if (mappingAction === "ignore") {
      const source = ctx.stringArg("source");
      const rawSourceId = ctx.stringArg("raw-source-id");
      if (!source || !rawSourceId) {
        return ctx.usage(1, "admin catalog mappings ignore", "Requires --source and --raw-source-id.");
      }
      await requireMutationConfirmation(ctx, render.mutationSummary("Ignore mapping", `${source}:${rawSourceId}`));
      const body = await adminRequest(ctx, {
        ...api.adminPaths.mappingIgnore(),
        body: { source, raw_source_id: rawSourceId }
      });
      return emit(ctx, body, () => {
        process.stdout.write(`Mapping ${source}:${rawSourceId} ignored.\n`);
      });
    }
    return unknown(ctx, "admin catalog mappings", mappingAction);
  }
  if (action === "rebuild") {
    await requireMutationConfirmation(ctx, "Rebuild catalog snapshot");
    const body = await adminRequest(ctx, api.adminPaths.catalogRebuild());
    return emit(ctx, body, () => {
      process.stdout.write(
        `Catalog snapshot rebuilt: models=${body.models ?? "?"} targets=${body.targets ?? "?"} version=${body.version ?? "?"}\n`
      );
    });
  }
  return unknown(ctx, "admin catalog", action);
}

async function runAdminKeys(ctx) {
  const action = ctx.args._[2];
  if (ctx.args.help && !action) return ctx.usage(0, "admin keys");
  if (!action) return ctx.usage(1, "admin keys", "Missing subcommand. Try: admin keys list | mint | revoke");
  if (!["list", "mint", "revoke"].includes(action)) return unknown(ctx, "admin keys", action);
  // Server requires a GitHub-session admin; bearer keys receive admin_session_required.
  ctx.fail(api.adminKeysBrowserSessionRequired(action), "admin_session_required");
}

function accountClient(ctx) {
  const credential = requireAccountCredential(ctx.stringArg("account-token"));
  return { apiUrl: defaultApiUrl(ctx.stringArg("api-url")), token: credential.token };
}

function adminClient(ctx) {
  const credential = requireAdminCredential(ctx.stringArg("admin-token"));
  return { apiUrl: defaultApiUrl(ctx.stringArg("api-url")), token: credential.token };
}

function adminRequest(ctx, spec) {
  const client = adminClient(ctx);
  return apiRequest({
    ...client,
    method: spec.method,
    path: spec.path,
    body: spec.body,
    label: spec.label
  });
}

async function requireMutationConfirmation(ctx, summary) {
  const json = Boolean(ctx.args.json);
  const yes = Boolean(ctx.args.yes);
  if (json && !yes) {
    ctx.fail("JSON mode requires --yes for mutations (no interactive prompts).", "confirmation_required");
  }
  if (yes) return;
  const confirmed = await ctx.confirmPrompt(`${summary}. Continue? [y/N] `);
  if (!confirmed) {
    process.stdout.write("Declined. No changes made.\n");
    process.exit(0);
  }
}

function emit(ctx, body, human) {
  if (ctx.args.json) return render.printJson(body);
  return human();
}

function subcommand(ctx) {
  return ctx.args._[1];
}

function unknown(ctx, root, sub) {
  ctx.usage(1, root, `Unknown command: ${root}${sub ? ` ${sub}` : ""}`.trimEnd());
}

export function controlUsageText(commandName) {
  const accountFlags = `  --account-token br_ctrl_...  Defaults to BENCHROUTER_ACCOUNT_TOKEN, then owner-only local config.
  --api-url <url>              Defaults to https://api.benchrouter.com.
  --json                       Print machine-readable JSON.
`;
  const adminFlags = `  --admin-token bradm_...      Defaults to BENCHROUTER_ADMIN_TOKEN, then owner-only local config.
  --api-url <url>              Defaults to https://api.benchrouter.com.
  --json                       Print machine-readable JSON.
`;

  const texts = {
    account: `Usage:
  benchrouter account show
  benchrouter account token save --account-token br_ctrl_...

Options:
${accountFlags}`,
    "account show": `Usage:
  benchrouter account show

Options:
${accountFlags}`,
    "account token": `Usage:
  benchrouter account token save --account-token br_ctrl_...

Saves an already-minted account token. Never prints the secret.
Minting still requires a browser session (POST /v1/dashboard/control-tokens).

Options:
${accountFlags}`,
    "account token save": `Usage:
  benchrouter account token save --account-token br_ctrl_...

Options:
${accountFlags}`,
    billing: `Usage:
  benchrouter billing show
  benchrouter billing top-up --amount 25

billing show reads billing fields from GET /v1/dashboard/summary.

Options:
${accountFlags}  --yes, -y                    Skip confirmation for top-up.
`,
    "billing show": `Usage:
  benchrouter billing show

Reads billing from GET /v1/dashboard/summary (not /v1/billing/summary).

Options:
${accountFlags}`,
    "billing top-up": `Usage:
  benchrouter billing top-up --amount <usd>

Prints a Stripe checkout URL. Does not open a browser or automate payment.

Options:
  --amount <usd>               Top-up credit amount (server-allowed values).
  --yes, -y                    Required with --json; skips the confirmation prompt.
${accountFlags}`,
    keys: `Usage:
  benchrouter keys list
  benchrouter keys create --product-id <id> [--name text]
  benchrouter keys revoke <key-id>

Options:
${accountFlags}  --yes, -y                    Skip confirmation for create/revoke.
`,
    "keys list": `Usage:
  benchrouter keys list

Options:
${accountFlags}`,
    "keys create": `Usage:
  benchrouter keys create --product-id <id> [--name text]

Options:
  --product-id <id>
  --name <text>
  --yes, -y
${accountFlags}`,
    "keys revoke": `Usage:
  benchrouter keys revoke <key-id>

Options:
  --key-id <id>
  --yes, -y
${accountFlags}`,
    repos: `Usage:
  benchrouter repos list

Options:
${accountFlags}`,
    "repos list": `Usage:
  benchrouter repos list

Options:
${accountFlags}`,
    setup: `Usage:
  benchrouter setup status [--repo owner/repo]

Options:
${accountFlags}`,
    "setup status": `Usage:
  benchrouter setup status [--repo owner/repo]

Options:
  --repo owner/repo
${accountFlags}`,
    routes: `Usage:
  benchrouter routes list
  benchrouter routes show <route-key>
  benchrouter routes catalog <route-key>
  benchrouter routes archive <route-key>
  benchrouter routes unarchive <route-id>

Options:
${accountFlags}  --yes, -y
`,
    "routes list": `Usage:
  benchrouter routes list

Options:
${accountFlags}`,
    "routes show": `Usage:
  benchrouter routes show <route-key>

Options:
${accountFlags}`,
    "routes catalog": `Usage:
  benchrouter routes catalog <route-key>

Options:
${accountFlags}`,
    "routes archive": `Usage:
  benchrouter routes archive <route-key>

Options:
  --yes, -y
${accountFlags}`,
    "routes unarchive": `Usage:
  benchrouter routes unarchive <route-id>

Options:
  --yes, -y
${accountFlags}`,
    "models show": `Usage:
  benchrouter models show <route-key> <model-id>

Options:
${accountFlags}`,
    evals: `Usage:
  benchrouter evals list <route-key>
  benchrouter evals run <route-key> --model <model-id>
  benchrouter evals failures <route-key> <model-id>

Options:
${accountFlags}  --yes, -y
`,
    "evals list": `Usage:
  benchrouter evals list <route-key>

Options:
${accountFlags}`,
    "evals run": `Usage:
  benchrouter evals run <route-key> --model <model-id>

Options:
  --model <id>
  --yes, -y
${accountFlags}`,
    "evals failures": `Usage:
  benchrouter evals failures <route-key> <model-id>

Options:
  --model <id>
${accountFlags}`,
    baseline: `Usage:
  benchrouter baseline set <route-key> --result-set <id> --model <model-id>

Options:
  --result-set <id>
  --model <id>
  --yes, -y
${accountFlags}`,
    "baseline set": `Usage:
  benchrouter baseline set <route-key> --result-set <id> --model <model-id>

Options:
  --result-set <id>
  --model <id>
  --yes, -y
${accountFlags}`,
    proposals: `Usage:
  benchrouter proposals list
  benchrouter proposals approve <proposal-id> [--yes]
  benchrouter proposals reject <proposal-id> [--yes]

Requires bradm_ admin bearer.

Options:
${adminFlags}  --yes, -y
`,
    "proposals list": `Usage:
  benchrouter proposals list

Options:
${adminFlags}`,
    "proposals approve": `Usage:
  benchrouter proposals approve <proposal-id> [--yes]

Options:
  --yes, -y
${adminFlags}`,
    "proposals reject": `Usage:
  benchrouter proposals reject <proposal-id> [--yes]

Options:
  --yes, -y
${adminFlags}`,
    admin: `Usage:
  benchrouter admin providers list|key set|key delete|smoke|disable|enable
  benchrouter admin catalog show|activity|observations|mappings resolve|mappings ignore|rebuild
  benchrouter admin keys list|mint|revoke
  benchrouter admin token save --admin-token bradm_...

admin keys list/mint/revoke require a browser GitHub admin session; a bradm_ bearer cannot call them.
Provider enable maps to DELETE /v1/admin/providers/:provider/disable.

Options:
${adminFlags}  --yes, -y
`,
    "admin providers": `Usage:
  benchrouter admin providers list
  benchrouter admin providers key set <provider> --api-key <secret> [--base-url <url>] [--yes]
  benchrouter admin providers key delete <provider> [--yes]
  benchrouter admin providers smoke|disable|enable <provider> [--yes]

Options:
${adminFlags}  --yes, -y
`,
    "admin catalog": `Usage:
  benchrouter admin catalog show|activity|observations|rebuild
  benchrouter admin catalog mappings resolve --source <s> --raw-source-id <id> --canonical-id <id>
  benchrouter admin catalog mappings ignore --source <s> --raw-source-id <id>

Options:
${adminFlags}  --yes, -y
`,
    "admin keys": `Usage:
  benchrouter admin keys list|mint|revoke

These require a browser GitHub admin session. A bradm_ bearer cannot list, mint, or revoke admin keys.

Options:
${adminFlags}`,
    "admin token": `Usage:
  benchrouter admin token save --admin-token bradm_...

Saves an already-minted admin token. Never prints the secret.

Options:
${adminFlags}`,
    "admin token save": `Usage:
  benchrouter admin token save --admin-token bradm_...

Options:
${adminFlags}`
  };
  return texts[commandName] ?? null;
}

export function topLevelControlUsageLines() {
  return `  benchrouter account show|token save [--json]
  benchrouter billing show [--json]
  benchrouter billing top-up --amount <usd> [--yes]
  benchrouter keys list|create|revoke [--json]
  benchrouter repos list [--json]
  benchrouter setup status [--repo owner/repo] [--json]
  benchrouter routes list|show|catalog|archive|unarchive [--json]
  benchrouter models show <route-key> <model-id> [--json]
  benchrouter evals list|run|failures [--json]
  benchrouter baseline set <route-key> --result-set <id> --model <id> [--yes]
  benchrouter proposals list|approve|reject [--json]
  benchrouter admin providers|catalog|keys|token [--json]`;
}

/** Pure request-construction helpers for regression tests. */
export function planAdminProviderKeySet(provider, { apiKey, baseUrl } = {}) {
  if (!provider) throw new Error("provider required");
  if (!apiKey) throw new Error("--api-key required");
  const body = { api_key: apiKey };
  if (baseUrl) body.base_url = baseUrl;
  return { ...api.adminPaths.providerKeySet(provider), body };
}

export function planProposalAction(action, proposalId) {
  if (action === "approve") return api.adminPaths.proposalsApprove(proposalId);
  if (action === "reject") return api.adminPaths.proposalsReject(proposalId);
  throw new Error(`Unknown proposals action: ${action}`);
}
