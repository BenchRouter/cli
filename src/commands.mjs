import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { normalizeRepoFullName, saveAccountToken, saveAdminToken } from "./config.mjs";
import { adminPaths, adminKeysMintBrowserSessionRequired, customerPaths, publicPaths } from "./control-api.mjs";
import {
  accountRequest,
  adminRequest,
  emit,
  publicRequest,
  requireMutationConfirmation,
  subcommand,
  unknown
} from "./control-helpers.mjs";
import { ApiError } from "./http.mjs";
import * as render from "./render.mjs";
import { resolveControlUsageName } from "./usage-text.mjs";
import { runLogin } from "./login.mjs";

export const CUSTOMER_ROOT_COMMANDS = new Set([
  "login",
  "account",
  "billing",
  "keys",
  "repos",
  "setup",
  "routes",
  "evals",
  "baseline",
  "blocks",
  "public"
]);

export const ADMIN_ROOT_COMMANDS = new Set(["proposals", "admin"]);

export function isControlPlaneCommand(command) {
  return CUSTOMER_ROOT_COMMANDS.has(command) || ADMIN_ROOT_COMMANDS.has(command);
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
    if (command === "login") return await runLogin(ctx);
    if (command === "account") return await runAccount(ctx);
    if (command === "billing") return await runBilling(ctx);
    if (command === "keys") return await runKeys(ctx);
    if (command === "repos") return await runRepos(ctx);
    if (command === "setup") return await runSetup(ctx);
    if (command === "routes") return await runRoutes(ctx);
    if (command === "evals") return await runEvals(ctx);
    if (command === "baseline") return await runBaseline(ctx);
    if (command === "blocks") return await runBlocks(ctx);
    if (command === "public") return await runPublic(ctx);
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
    // MCP-001 / BILL-001: the website's account page, with the credential's role and products from the control read.
    const [self, page] = await Promise.all([
      accountRequest(ctx, customerPaths.accountSelf()),
      accountRequest(ctx, customerPaths.dashboardAccount())
    ]);
    const payload = {
      ok: true,
      account_id: self.account?.id ?? null,
      role: self.membership_role ?? null,
      visible_products: self.visible_products ?? [],
      ...page
    };
    return emit(ctx, payload, () => render.renderAccountShow(payload));
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
  if (!sub) return ctx.usage(1, "billing", "Missing subcommand. Try: billing show | activity | statement | charge | top-up");
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
  if (sub === "activity" || sub === "statement") {
    // BILL-001: the account page's billing history (activity) and period summary (statement).
    const usageName = `billing ${sub}`;
    const from = optionValue(ctx, "from", usageName);
    const to = optionValue(ctx, "to", usageName);
    if (sub === "statement") {
      const body = await accountRequest(ctx, customerPaths.billingActivity({ from, to, summary: true }, usageName));
      return emit(ctx, body, () => render.renderBillingStatement(body));
    }
    const payments = flagOnly(ctx, "payments", usageName);
    const cursor = optionValue(ctx, "cursor", usageName);
    const body = await accountRequest(ctx, customerPaths.billingActivity({ from, to, payments, cursor }, usageName));
    return emit(ctx, body, () => render.renderBillingActivity(body, { payments }));
  }
  if (sub === "charge") {
    // BILL-006: one purchase, one idempotency key. A retry with the same key never charges twice.
    const amountUsd = Number(optionValue(ctx, "amount", "billing charge") ?? ctx.args._[2]);
    if (!Number.isInteger(amountUsd) || amountUsd <= 0) {
      return ctx.usage(1, "billing charge", "Missing or invalid --amount: whole USD.");
    }
    const idempotencyKey = optionValue(ctx, "idempotency-key", "billing charge") ?? `cli-${randomUUID()}`;
    const retry = `benchrouter billing charge --amount ${amountUsd} --idempotency-key ${idempotencyKey}`;
    await requireMutationConfirmation(ctx, render.mutationSummary(
      "Buy credit on the saved card",
      `$${amountUsd} of credit plus the service fee; with no saved card, a Checkout link instead and no charge`
    ));
    let body;
    try {
      body = await accountRequest(ctx, customerPaths.billingCardCharge(amountUsd, idempotencyKey));
    } catch (error) {
      // The charge may have reached Stripe before the error: the same key reads its result.
      process.stderr.write(`To retry without charging twice, repeat with the same key: ${retry}\n`);
      throw error;
    }
    return emit(ctx, { ...body, idempotency_key: idempotencyKey }, () => render.renderCardCharge(body, retry));
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
  if (sub === "auto-reload") {
    const action = ctx.args._[2];
    if (action === "setup") {
      const thresholdUsd = Number(optionValue(ctx, "threshold", "billing auto-reload setup"));
      const reloadAmountUsd = Number(optionValue(ctx, "amount", "billing auto-reload setup"));
      if (!Number.isFinite(thresholdUsd) || thresholdUsd <= 0 || !Number.isFinite(reloadAmountUsd) || reloadAmountUsd <= 0) {
        return ctx.usage(1, "billing auto-reload setup", "--threshold and --amount must be positive USD amounts.");
      }
      await requireMutationConfirmation(
        ctx,
        render.mutationSummary("Set up automatic credit reload", `threshold_usd=${thresholdUsd} reload_amount_usd=${reloadAmountUsd}`)
      );
      const body = await accountRequest(ctx, customerPaths.autoReloadSetup({ thresholdUsd, reloadAmountUsd }));
      return emit(ctx, body, () => render.renderAutoReloadSetup(body));
    }
    if (action === "disable") {
      await requireMutationConfirmation(ctx, render.mutationSummary("Turn off automatic credit reload", "auto_reload=off"));
      const body = await accountRequest(ctx, customerPaths.autoReloadDisable());
      return emit(ctx, body, () => render.renderAutoReloadDisable(body));
    }
    return unknown(ctx, "billing auto-reload", action);
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
  if (sub === "disable" || sub === "enable") {
    const keyId = ctx.stringArg("key-id") ?? ctx.args._[2];
    if (!keyId) return ctx.usage(1, `keys ${sub}`, "Missing key id.");
    const enabled = sub === "enable";
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary(`${enabled ? "Enable" : "Disable"} runtime API key`, `key_id=${keyId}`)
    );
    const body = await accountRequest(ctx, customerPaths.apiKeySetEnabled(keyId, enabled));
    return emit(ctx, body, () => render.renderApiKeyState(body, keyId, enabled));
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
    return ctx.usage(1, "routes", "Missing subcommand. Try: routes list | show | catalog | activity | startup-failures | create | pin | archive | unarchive");
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
  if (sub === "activity") {
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes activity", "Missing route key.");
    const body = await accountRequest(ctx, customerPaths.routeActivity(routeKey));
    return emit(ctx, body, () => render.renderRouteActivity(body));
  }
  if (sub === "startup-failures") {
    // RUN-001 R5: the route page's blocked runner startups, each with GitHub's annotations.
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes startup-failures", "Missing route key.");
    const catalog = await accountRequest(ctx, customerPaths.routeCatalog(routeKey, "routes startup-failures"));
    const failures = [];
    for (const failure of Array.isArray(catalog.startup_failures) ? catalog.startup_failures : []) {
      try {
        failures.push({ ...failure, details: await accountRequest(ctx, customerPaths.routeStartupDetails(routeKey, failure.blocked_event_id)) });
      } catch (error) {
        // A block cleared between the two reads is no longer current; its details are gone.
        if (!(error instanceof ApiError && error.code === "startup_failure_stale")) throw error;
        failures.push({ ...failure, details: null });
      }
    }
    const payload = { ok: true, route_key: catalog.route_key, startup_failures: failures };
    return emit(ctx, payload, () => render.renderStartupFailures(payload));
  }
  if (sub === "create") {
    // SERVE-001: a pinned route (no eval) in a new hosted product or an existing one with no repository.
    const name = optionValue(ctx, "name", "routes create");
    const model = optionValue(ctx, "model", "routes create");
    const productName = optionValue(ctx, "product", "routes create");
    const productId = optionValue(ctx, "product-id", "routes create");
    if (!name || !model || Boolean(productName) === Boolean(productId)) {
      return ctx.usage(1, "routes create", "Pass --name, --model, and one of --product <name> or --product-id <id>.");
    }
    const productSlug = optionValue(ctx, "product-slug", "routes create");
    if (productSlug && !productName) return ctx.usage(1, "routes create", "--product-slug goes with --product.");
    const body = { name, model };
    const routeSlug = optionValue(ctx, "route-slug", "routes create");
    if (routeSlug) body.route_slug = routeSlug;
    if (productId) body.product_id = productId;
    else body.product = productSlug ? { name: productName, slug: productSlug } : { name: productName };
    await requireMutationConfirmation(ctx, render.mutationSummary(
      "Create pinned route",
      `name=${name}; model=${model}; ${productId ? `product_id=${productId}` : `product=${productName}`}`
    ));
    const created = await accountRequest(ctx, customerPaths.routeCreate(body));
    return emit(ctx, created, () => render.renderRouteCreated(created));
  }
  if (sub === "pin") {
    // ROUTE-004: read the pin, then re-pin with its generation id as the fence.
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes pin", "Missing route key.");
    const model = optionValue(ctx, "model", "routes pin");
    const current = await accountRequest(ctx, customerPaths.routePin(routeKey));
    if (!model) return emit(ctx, current, () => render.renderRoutePin(current));
    if (current.repin_blocked_reason) {
      ctx.fail(`${routeKey} cannot be re-pinned (${current.repin_blocked_reason}).`, current.repin_blocked_reason);
    }
    await requireMutationConfirmation(ctx, render.mutationSummary("Re-pin route", `${routeKey}: ${current.model} -> ${model}`));
    const body = await accountRequest(ctx, customerPaths.routeRepin(routeKey, model, current.route_id));
    return emit(ctx, body, () => render.renderRouteRepinned(body));
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

async function runEvals(ctx) {
  const sub = subcommand(ctx);
  if (!sub) {
    return ctx.usage(1, "evals", "Missing subcommand. Try: evals list | status | results | model | case-output | overview | draft | approve | run | refresh-preview");
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
      latest_eval_batch: body.latest_eval_batch ?? null,
      // EVAL-011 / ROUTE-005: each context's search status, by evidence view id.
      search_status: Object.fromEntries(
        (Array.isArray(body.view_evidence) ? body.view_evidence : [])
          .filter((view) => view && view.search_status)
          .map((view) => [view.id, view.search_status])
      )
    };
    return emit(ctx, payload, () => render.renderEvalsList(body));
  }
  if (sub === "status") {
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "evals status", "Missing route key.");
    const prNumber = prOption(ctx, "evals status");
    if (prNumber === null) {
      // ROUTE-005: production reads the hosted-eval status, which adds the route's eval spend and polling.
      const body = await accountRequest(ctx, customerPaths.evalsStatus(routeKey));
      if (!body.search_status) ctx.fail(`The server returned no search status for ${routeKey} (production).`, "search_status_missing");
      const payload = {
        ok: true,
        route_key: body.route_key,
        view_id: "production",
        label: body.label,
        search_status: body.search_status,
        spend_usd: body.spend_usd,
        polling: body.polling
      };
      return emit(ctx, payload, () => render.renderEvalsStatus(payload));
    }
    // A PR preview context is only on the route catalog read.
    const body = await accountRequest(ctx, customerPaths.routeCatalog(routeKey, "evals status"));
    const viewId = `pr-${prNumber}`;
    const view = (Array.isArray(body.view_evidence) ? body.view_evidence : []).find((entry) => entry && entry.id === viewId);
    if (!view) ctx.fail(`No open PR #${prNumber} preview evidence on ${routeKey}.`, "view_not_found");
    if (!view.search_status) ctx.fail(`The server returned no search status for ${routeKey} (${viewId}).`, "search_status_missing");
    const payload = { ok: true, route_key: body.route_key, view_id: view.id, label: view.label, search_status: view.search_status };
    return emit(ctx, payload, () => render.renderEvalsStatus(payload));
  }
  if (sub === "run") {
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "evals run", "Missing route key.");
    if (ctx.args["full-refresh"] !== undefined) {
      if (ctx.args["full-refresh"] !== true || ctx.args.model !== undefined) {
        return ctx.usage(1, "evals run", "--full-refresh takes no value and no --model.");
      }
      await requireMutationConfirmation(
        ctx,
        render.mutationSummary("Run every model of the route again (spends eval credits)", `route_key=${routeKey}`)
      );
      const body = await accountRequest(ctx, customerPaths.routeFullRefresh(routeKey));
      return emit(ctx, body, () => render.renderEvalsFullRefresh(body));
    }
    const model = ctx.stringArg("model") ?? ctx.args._[3];
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
  if (sub === "retry") {
    // RUN-001 R5: Retry reruns failed models or wakes a stuck evaluation. It never clears a block.
    const resultSetId = optionValue(ctx, "result-set", "evals retry");
    const routeKey = optionValue(ctx, "route", "evals retry");
    if (Boolean(resultSetId) === Boolean(routeKey)) {
      return ctx.usage(1, "evals retry", "Pass exactly one of --result-set <id> or --route <route-key>.");
    }
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Retry evaluation", resultSetId ? `result_set_id=${resultSetId}` : `route_key=${routeKey}`)
    );
    const body = await accountRequest(ctx, customerPaths.evalsRetry({ resultSetId, routeKey }));
    return emit(ctx, body, () => render.renderEvalsRetry(body));
  }
  if (sub === "harness-retry") {
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "evals harness-retry", "Missing route key.");
    const catalog = await accountRequest(ctx, customerPaths.routeCatalog(routeKey, "evals harness-retry"));
    const block = catalog.route_harness_block;
    if (!block) ctx.fail(`No evaluator block on ${routeKey}.`, "harness_block_missing");
    const model = optionValue(ctx, "model", "evals harness-retry") ?? catalog.best_model ?? catalog.baseline_model;
    if (!model) return ctx.usage(1, "evals harness-retry", "Missing --model.");
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Retry the evaluator with one model (spends eval credits)", `route_key=${routeKey} model=${model}`)
    );
    const body = await accountRequest(ctx, customerPaths.routeHarnessRetry(routeKey, model, block));
    return emit(ctx, body, () => render.renderEvalsRun(body));
  }
  if (sub === "results") {
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "evals results", "Missing route key.");
    const body = await accountRequest(ctx, customerPaths.evalsResults(routeKey));
    return emit(ctx, body, () => render.renderEvalsResults(body));
  }
  if (sub === "overview") {
    const body = await accountRequest(ctx, customerPaths.evalsOverview());
    return emit(ctx, body, () => render.renderEvalsOverview(body));
  }
  if (sub === "model") {
    const routeKey = ctx.args._[2];
    const modelId = ctx.args._[3];
    if (!routeKey || !modelId) return ctx.usage(1, "evals model", "Missing route key or model id.");
    const prNumber = prOption(ctx, "evals model");
    const body = await accountRequest(ctx, customerPaths.evalsModel(routeKey, modelId, prNumber === null ? null : `pr-${prNumber}`));
    return emit(ctx, body, () => render.renderEvalsModel(body));
  }
  if (sub === "case-output") {
    const routeKey = ctx.args._[2];
    const modelRunId = optionValue(ctx, "run", "evals case-output");
    const caseId = optionValue(ctx, "case", "evals case-output");
    if (!routeKey || !modelRunId || !caseId) {
      return ctx.usage(1, "evals case-output", "Pass the route key, --run <model-run-id> and --case <case-id>.");
    }
    const body = await accountRequest(ctx, customerPaths.evalsCaseOutput(routeKey, modelRunId, caseId));
    return emit(ctx, body, () => render.renderCaseOutput(body));
  }
  if (sub === "draft") {
    // EVAL-016: cases and a built-in scorer go to the server, which returns the card to show before approval.
    const name = optionValue(ctx, "name", "evals draft");
    const casesPath = optionValue(ctx, "cases", "evals draft");
    const scorerPath = optionValue(ctx, "scorer", "evals draft");
    if (!name || !casesPath || !scorerPath) {
      return ctx.usage(1, "evals draft", "Pass --name, --cases <cases.jsonl> and --scorer <scorer.json>.");
    }
    const body = {
      name,
      cases_jsonl: await readOptionFile(ctx, casesPath, "--cases"),
      scorer: parseScorerFile(ctx, scorerPath, await readOptionFile(ctx, scorerPath, "--scorer")),
      judge_model: optionValue(ctx, "judge-model", "evals draft") ?? null
    };
    for (const [flag, field] of [["incumbent", "incumbent"], ["route", "route"], ["parent-version", "parent_version"], ["request-id", "request_id"]]) {
      const value = optionValue(ctx, flag, "evals draft");
      if (value !== undefined) body[field] = value;
    }
    const response = await accountRequest(ctx, customerPaths.evalsDraft(body));
    return emit(ctx, response, () => render.renderEvalsDraft(response));
  }
  if (sub === "approve") {
    const draftId = ctx.args._[2];
    const cardHash = optionValue(ctx, "card", "evals approve");
    if (!draftId || !cardHash) return ctx.usage(1, "evals approve", "Pass the draft id and --card <card hash> from evals draft.");
    // EVAL-016: approval starts a search that spends from the balance, so it asks first.
    await requireMutationConfirmation(ctx, render.mutationSummary(
      "Approve hosted eval",
      `draft=${draftId}; BenchRouter will keep testing new models against this eval and spend from your balance until it runs out`
    ));
    const body = await accountRequest(ctx, customerPaths.evalsApprove(draftId, cardHash));
    return emit(ctx, body, () => render.renderEvalsApprove(body));
  }
  return unknown(ctx, "evals", sub);
}

async function readOptionFile(ctx, filePath, flag) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    return ctx.fail(`Could not read ${flag} file ${filePath}: ${error instanceof Error ? error.message : String(error)}`, "file_unreadable");
  }
}

/** The scorer file is the API's scorer object, `{ "builtin": "<id>@<version>", "params": { ... } }`; the server checks its fields. */
function parseScorerFile(ctx, filePath, text) {
  let scorer;
  try {
    scorer = JSON.parse(text);
  } catch (error) {
    return ctx.fail(`--scorer file ${filePath} is not JSON: ${error instanceof Error ? error.message : String(error)}`, "invalid_scorer");
  }
  if (!scorer || typeof scorer !== "object" || Array.isArray(scorer)) {
    return ctx.fail(`--scorer file ${filePath} must hold a JSON object: { "builtin": "<id>@<version>", "params": { ... } }.`, "invalid_scorer");
  }
  return scorer;
}

/**
 * A string option. `--repo` given without a value (`--repo --all-blocked`,
 * `--repo=`) is a usage error, never a silently absent option.
 */
function optionValue(ctx, name, usageName) {
  const value = ctx.args[name];
  if (value === true || value === "" || (Array.isArray(value) && (value.includes(true) || value.includes("")))) {
    return ctx.usage(1, usageName, `--${name} needs a value.`);
  }
  return ctx.stringArg(name);
}

/** `--pr <number>`: null when absent. A decimal PR number only: `0x4c` or `7.6e1` is not PR 76. */
function prOption(ctx, usageName) {
  const prArg = optionValue(ctx, "pr", usageName);
  if (prArg === undefined) return null;
  const prNumber = Number.parseInt(prArg, 10);
  if (String(prNumber) !== prArg || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    return ctx.usage(1, usageName, "--pr must be a pull request number.");
  }
  return prNumber;
}

function flagOnly(ctx, name, usageName) {
  const value = ctx.args[name];
  if (value !== undefined && value !== true) return ctx.usage(1, usageName, `--${name} takes no value.`);
  return value === true;
}

/** The website's public pages: service status and the public frontier. No credential. */
async function runPublic(ctx) {
  const sub = subcommand(ctx);
  if (sub === "status") {
    const body = await publicRequest(ctx, publicPaths.status());
    return emit(ctx, body, () => render.renderPublicStatus(body));
  }
  if (sub === "frontier") {
    const body = await publicRequest(ctx, publicPaths.frontier());
    return emit(ctx, body, () => render.renderPublicFrontier(body));
  }
  if (!sub) return ctx.usage(1, "public", "Missing subcommand. Try: public status | public frontier");
  return unknown(ctx, "public", sub);
}

/** RUN-001 R5: list blocks, and Unblock. Unblock clears blocks only; it creates no evaluation. */
async function runBlocks(ctx) {
  const sub = subcommand(ctx);
  if (!sub) return ctx.usage(1, "blocks", "Missing subcommand. Try: blocks list | blocks unblock");
  if (sub === "list") {
    const repo = optionValue(ctx, "repo", "blocks list");
    const repos = [];
    let cursor = null;
    do {
      const page = await accountRequest(ctx, customerPaths.blocksList(repo ? normalizeRepoFullName(repo) : null, cursor));
      repos.push(...(Array.isArray(page.repos) ? page.repos : []));
      cursor = typeof page.next_cursor === "string" && page.next_cursor ? page.next_cursor : null;
    } while (cursor);
    return emit(ctx, { ok: true, repos }, () => render.renderBlocksList(repos));
  }
  if (sub === "unblock") {
    const repo = optionValue(ctx, "repo", "blocks unblock");
    const routeKey = optionValue(ctx, "route", "blocks unblock");
    const allBlocked = flagOnly(ctx, "all-blocked", "blocks unblock");
    if (allBlocked === Boolean(repo || routeKey)) {
      return ctx.usage(1, "blocks unblock", "Pass --repo owner/repo (or --route <route-key>), or --all-blocked alone.");
    }
    const repoFullName = repo ? normalizeRepoFullName(repo) : null;
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Unblock evaluations", allBlocked ? "every blocked repository you own" : `repo=${repoFullName ?? "(route's repository)"}${routeKey ? ` route_key=${routeKey}` : ""}`)
    );
    const repos = [];
    let cursor = null;
    do {
      const page = await accountRequest(ctx, customerPaths.blocksUnblock({ repoFullName, routeKey, allBlocked, cursor }));
      repos.push(...(Array.isArray(page.repos) ? page.repos : []));
      cursor = typeof page.next_cursor === "string" && page.next_cursor ? page.next_cursor : null;
    } while (cursor);
    return emit(ctx, { ok: true, repos }, () => render.renderUnblock(repos));
  }
  return unknown(ctx, "blocks", sub);
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
      "Missing subcommand. Try: show | activity | observations | mappings | model-maps | refresh-report | drain-outbox | rebuild"
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
  if (action === "drain-outbox") {
    const limitArg = ctx.stringArg("limit");
    if (ctx.args.limit !== undefined && limitArg === undefined) {
      return ctx.usage(1, "admin catalog drain-outbox", "--limit requires a value from 1 to 25.");
    }
    const limit = limitArg === undefined ? 25 : Number(limitArg);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
      return ctx.usage(1, "admin catalog drain-outbox", "--limit must be an integer from 1 to 25.");
    }
    await requireMutationConfirmation(
      ctx,
      render.mutationSummary("Drain durable catalog work", `limit=${limit}`)
    );
    const body = await adminRequest(ctx, adminPaths.catalogDrainOutbox(limit));
    return emit(ctx, body, () => render.renderAdminCatalogDrainOutbox(body));
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
