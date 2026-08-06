import { normalizeRepoFullName } from "./config.mjs";
import * as api from "./customer-api.mjs";
import {
  ApiError,
  MissingServerContractError,
  defaultApiUrl,
  requireAccountCredential
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

export function isCustomerModelsShow(command, positional) {
  return command === "models" && positional[1] === "show";
}

/**
 * @param {object} ctx
 * @param {object} ctx.args parsed argv
 * @param {string} ctx.command root command
 * @param {(name: string, fallback?: string) => string|undefined} ctx.stringArg
 * @param {(message: string, code?: string) => never} ctx.fail
 * @param {(status: number, commandName?: string, message?: string) => never} ctx.usage
 * @param {(question: string) => Promise<boolean>} ctx.confirmPrompt
 * @param {() => string|undefined} ctx.detectGitHubRepo
 */
export async function runCustomerCommand(ctx) {
  const { args, command, fail, usage } = ctx;
  const positional = args._ ?? [];
  const sub = positional[1];

  try {
    if (command === "account") return await runAccount(ctx, sub);
    if (command === "billing") return await runBilling(ctx, sub);
    if (command === "keys") return await runKeys(ctx, sub);
    if (command === "repos") return await runRepos(ctx, sub);
    if (command === "setup") return await runSetup(ctx, sub);
    if (command === "routes") return await runRoutes(ctx, sub);
    if (command === "models") return await runModelsShow(ctx);
    if (command === "evals") return await runEvals(ctx, sub);
    if (command === "baseline") return await runBaseline(ctx, sub);
    usage(1, "all", `Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof MissingServerContractError) {
      fail(error.requirement, "missing_server_contract");
    }
    if (error instanceof ApiError) {
      fail(error.message, error.code ?? "command_failed");
    }
    fail(error instanceof Error ? error.message : "BenchRouter command failed.");
  }
}

async function runAccount(ctx, sub) {
  if (ctx.args.help && (!sub || sub === "show")) {
    return ctx.usage(0, sub === "show" ? "account show" : "account");
  }
  if (!sub) return ctx.usage(1, "account", "Missing subcommand. Try: account show");
  if (sub !== "show") return unknownSub(ctx, "account", sub);

  const client = accountClient(ctx);
  const body = await api.getAccountSelf(client);
  if (ctx.args.json) return render.printJson(body);
  render.renderAccountShow(body);
}

async function runBilling(ctx, sub) {
  if (ctx.args.help && !sub) return ctx.usage(0, "billing");
  if (!sub) return ctx.usage(1, "billing", "Missing subcommand. Try: billing show | billing top-up");
  if (sub === "show") {
    if (ctx.args.help) return ctx.usage(0, "billing show");
    const client = accountClient(ctx);
    const body = await api.getBillingSummary(client);
    if (ctx.args.json) return render.printJson(body);
    render.renderBillingShow(body);
    return;
  }
  if (sub === "top-up") {
    if (ctx.args.help) return ctx.usage(0, "billing top-up");
    const amountRaw = ctx.stringArg("amount") ?? ctx.args._[2];
    const amountUsd = Number(amountRaw);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return ctx.usage(1, "billing top-up", "Missing or invalid --amount (USD).");
    }
    await requireMutationConfirmation(ctx, render.mutationSummary(
      "Create billing top-up checkout",
      `amount_usd=${amountUsd}`
    ));
    const client = accountClient(ctx);
    const body = await api.createBillingTopUpCheckout(client, amountUsd);
    if (ctx.args.json) return render.printJson(body);
    render.renderBillingTopUp(body);
    return;
  }
  return unknownSub(ctx, "billing", sub);
}

async function runKeys(ctx, sub) {
  if (ctx.args.help && !sub) return ctx.usage(0, "keys");
  if (!sub) return ctx.usage(1, "keys", "Missing subcommand. Try: keys list | create | revoke");
  if (sub === "list") {
    if (ctx.args.help) return ctx.usage(0, "keys list");
    const client = accountClient(ctx);
    const summary = await api.getDashboardSummary(client);
    const keys = Array.isArray(summary.api_keys) ? summary.api_keys : [];
    if (ctx.args.json) return render.printJson({ ok: true, api_keys: keys });
    render.renderApiKeysList(keys);
    return;
  }
  if (sub === "create") {
    if (ctx.args.help) return ctx.usage(0, "keys create");
    const name = ctx.stringArg("name", "CLI key");
    const productId = ctx.stringArg("product-id");
    if (!productId) return ctx.usage(1, "keys create", "Missing --product-id.");
    await requireMutationConfirmation(ctx, render.mutationSummary(
      "Create runtime API key",
      `name=${JSON.stringify(name)} product_id=${productId}`
    ));
    const client = accountClient(ctx);
    const body = await api.createDashboardApiKey(client, { name, productId });
    if (ctx.args.json) return render.printJson(body);
    render.renderApiKeyCreate(body);
    return;
  }
  if (sub === "revoke") {
    if (ctx.args.help) return ctx.usage(0, "keys revoke");
    const keyId = ctx.stringArg("key-id") ?? ctx.args._[2];
    if (!keyId) return ctx.usage(1, "keys revoke", "Missing key id.");
    // No server revoke path yet — fail before prompting.
    const client = accountClient(ctx);
    await api.revokeDashboardApiKey(client, keyId);
    return;
  }
  return unknownSub(ctx, "keys", sub);
}

async function runRepos(ctx, sub) {
  if (ctx.args.help && (!sub || sub === "list")) {
    return ctx.usage(0, sub === "list" ? "repos list" : "repos");
  }
  if (!sub) return ctx.usage(1, "repos", "Missing subcommand. Try: repos list");
  if (sub !== "list") return unknownSub(ctx, "repos", sub);

  const client = accountClient(ctx);
  const body = await api.listSetupRepos(client);
  if (ctx.args.json) return render.printJson(body);
  render.renderReposList(body);
}

async function runSetup(ctx, sub) {
  if (ctx.args.help && !sub) return ctx.usage(0, "setup");
  if (!sub) return ctx.usage(1, "setup", "Missing subcommand. Try: setup status");
  if (sub !== "status") return unknownSub(ctx, "setup", sub);
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
  const client = accountClient(ctx);
  const body = await api.getSetupDiagnostic(client, repoFullName);
  if (ctx.args.json) return render.printJson(body);
  render.renderSetupStatus(body);
}

async function runRoutes(ctx, sub) {
  if (ctx.args.help && !sub) return ctx.usage(0, "routes");
  if (!sub) return ctx.usage(1, "routes", "Missing subcommand. Try: routes list | show | catalog | archive | unarchive");
  if (sub === "list") {
    if (ctx.args.help) return ctx.usage(0, "routes list");
    const client = accountClient(ctx);
    const summary = await api.getDashboardSummary(client);
    if (ctx.args.json) {
      return render.printJson({
        ok: true,
        routes: summary.routes ?? [],
        archived_routes: summary.archived_routes ?? []
      });
    }
    render.renderRoutesList(summary.routes ?? [], summary.archived_routes ?? []);
    return;
  }
  if (sub === "show") {
    if (ctx.args.help) return ctx.usage(0, "routes show");
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes show", "Missing route key.");
    const client = accountClient(ctx);
    const summary = await api.getDashboardSummary(client);
    const routes = Array.isArray(summary.routes) ? summary.routes : [];
    const route = routes.find((entry) => entry.route_key === routeKey);
    if (!route) {
      ctx.fail(`Route not found in account summary: ${routeKey}`, "route_not_found");
    }
    if (ctx.args.json) return render.printJson({ ok: true, route });
    render.renderRouteShow(route);
    return;
  }
  if (sub === "catalog") {
    if (ctx.args.help) return ctx.usage(0, "routes catalog");
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes catalog", "Missing route key.");
    const client = accountClient(ctx);
    const body = await api.getRouteCatalog(client, routeKey);
    if (ctx.args.json) return render.printJson(body);
    render.renderRouteCatalog(body);
    return;
  }
  if (sub === "archive") {
    if (ctx.args.help) return ctx.usage(0, "routes archive");
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "routes archive", "Missing route key.");
    await requireMutationConfirmation(ctx, render.mutationSummary(
      "Archive route",
      `route_key=${routeKey}`
    ));
    const client = accountClient(ctx);
    const body = await api.archiveRoute(client, routeKey);
    if (ctx.args.json) return render.printJson(body);
    render.renderArchive(body);
    return;
  }
  if (sub === "unarchive") {
    if (ctx.args.help) return ctx.usage(0, "routes unarchive");
    const routeId = ctx.args._[2];
    if (!routeId) return ctx.usage(1, "routes unarchive", "Missing route id.");
    await requireMutationConfirmation(ctx, render.mutationSummary(
      "Unarchive route",
      `route_id=${routeId}`
    ));
    const client = accountClient(ctx);
    const body = await api.unarchiveRoute(client, routeId);
    if (ctx.args.json) return render.printJson(body);
    render.renderUnarchive(body);
    return;
  }
  return unknownSub(ctx, "routes", sub);
}

async function runModelsShow(ctx) {
  if (ctx.args.help) return ctx.usage(0, "models show");
  const routeKey = ctx.args._[2];
  const modelId = ctx.args._[3];
  if (!routeKey || !modelId) {
    return ctx.usage(1, "models show", "Missing route key or model id.");
  }
  const client = accountClient(ctx);
  const body = await api.getRouteModel(client, routeKey, modelId);
  if (ctx.args.json) return render.printJson(body);
  render.renderRouteModel(body);
}

async function runEvals(ctx, sub) {
  if (ctx.args.help && !sub) return ctx.usage(0, "evals");
  if (!sub) return ctx.usage(1, "evals", "Missing subcommand. Try: evals list | run | failures");
  if (sub === "list") {
    if (ctx.args.help) return ctx.usage(0, "evals list");
    const routeKey = ctx.args._[2];
    if (!routeKey) return ctx.usage(1, "evals list", "Missing route key.");
    const client = accountClient(ctx);
    const body = await api.getRouteCatalog(client, routeKey);
    if (ctx.args.json) {
      return render.printJson({
        ok: true,
        route_key: body.route_key,
        eval_history: body.eval_history ?? [],
        evals: body.evals ?? {},
        latest_eval_batch: body.latest_eval_batch ?? null
      });
    }
    render.renderEvalsList(body);
    return;
  }
  if (sub === "run") {
    if (ctx.args.help) return ctx.usage(0, "evals run");
    const routeKey = ctx.args._[2];
    const model = ctx.stringArg("model") ?? ctx.args._[3];
    if (!routeKey) return ctx.usage(1, "evals run", "Missing route key.");
    if (!model) return ctx.usage(1, "evals run", "Missing --model.");
    await requireMutationConfirmation(ctx, render.mutationSummary(
      "Create eval result set",
      `route_key=${routeKey} model=${model}`
    ));
    const client = accountClient(ctx);
    const body = await api.createRouteResultSet(client, routeKey, model);
    if (ctx.args.json) return render.printJson(body);
    render.renderEvalsRun(body);
    return;
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
    const client = accountClient(ctx);
    const body = await api.getRouteModel(client, routeKey, modelId);
    if (ctx.args.json) {
      const results = Array.isArray(body.latest_eval?.results) ? body.latest_eval.results : [];
      return render.printJson({
        ok: true,
        route_key: body.route_key,
        model: modelId,
        model_run_id: body.latest_eval?.model_run_id ?? null,
        failures: results.filter((row) => row && row.outcome && row.outcome !== "pass")
      });
    }
    render.renderEvalsFailures(body, modelId);
    return;
  }
  return unknownSub(ctx, "evals", sub);
}

async function runBaseline(ctx, sub) {
  if (ctx.args.help && !sub) return ctx.usage(0, "baseline");
  if (!sub) return ctx.usage(1, "baseline", "Missing subcommand. Try: baseline set");
  if (sub !== "set") return unknownSub(ctx, "baseline", sub);
  if (ctx.args.help) return ctx.usage(0, "baseline set");

  const routeKey = ctx.args._[2];
  const resultSetId = ctx.stringArg("result-set") ?? ctx.stringArg("result-set-id");
  const model = ctx.stringArg("model");
  if (!routeKey) return ctx.usage(1, "baseline set", "Missing route key.");
  if (!resultSetId) return ctx.usage(1, "baseline set", "Missing --result-set.");
  if (!model) return ctx.usage(1, "baseline set", "Missing --model.");

  await requireMutationConfirmation(ctx, render.mutationSummary(
    "Set route comparison baseline",
    `route_key=${routeKey} result_set_id=${resultSetId} model=${model}`
  ));
  const client = accountClient(ctx);
  const body = await api.setRouteBaseline(client, routeKey, resultSetId, model);
  if (ctx.args.json) return render.printJson(body);
  render.renderBaselineSet(body);
}

function accountClient(ctx) {
  const credential = requireAccountCredential(ctx.stringArg("account-token"));
  return {
    apiUrl: defaultApiUrl(ctx.stringArg("api-url")),
    token: credential.token
  };
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

function unknownSub(ctx, root, sub) {
  ctx.usage(1, root, `Unknown command: ${root} ${sub}`);
}

export function customerUsageText(commandName) {
  const accountFlags = `  --account-token br_ctrl_...  Defaults to BENCHROUTER_ACCOUNT_TOKEN, then owner-only local config.
  --api-url <url>              Defaults to https://api.benchrouter.com.
  --json                       Print machine-readable JSON.
`;

  if (commandName === "account" || commandName === "account show") {
    return `Usage:
  benchrouter account show

Options:
${accountFlags}`;
  }
  if (commandName === "billing") {
    return `Usage:
  benchrouter billing show
  benchrouter billing top-up --amount 25

Options:
${accountFlags}  --yes, -y                    Skip confirmation for top-up.
`;
  }
  if (commandName === "billing show") {
    return `Usage:
  benchrouter billing show

Options:
${accountFlags}`;
  }
  if (commandName === "billing top-up") {
    return `Usage:
  benchrouter billing top-up --amount <usd>

Prints a Stripe checkout URL. Does not open a browser or automate payment.

Options:
  --amount <usd>               Top-up credit amount (server-allowed values).
  --yes, -y                    Required with --json; skips the confirmation prompt.
${accountFlags}`;
  }
  if (commandName === "keys") {
    return `Usage:
  benchrouter keys list
  benchrouter keys create --product-id <id> [--name text]
  benchrouter keys revoke <key-id>

Options:
${accountFlags}  --yes, -y                    Skip confirmation for create/revoke.
`;
  }
  if (commandName === "keys list") {
    return `Usage:
  benchrouter keys list

Lists runtime API key metadata from the dashboard summary.

Options:
${accountFlags}`;
  }
  if (commandName === "keys create") {
    return `Usage:
  benchrouter keys create --product-id <id> [--name text]

Options:
  --product-id <id>            Product that owns the runtime key.
  --name <text>                Defaults to "CLI key".
  --yes, -y                    Required with --json; skips confirmation.
${accountFlags}`;
  }
  if (commandName === "keys revoke") {
    return `Usage:
  benchrouter keys revoke <key-id>

Options:
  --key-id <id>                Alternative to the positional key id.
  --yes, -y                    Required with --json; skips confirmation.
${accountFlags}`;
  }
  if (commandName === "repos" || commandName === "repos list") {
    return `Usage:
  benchrouter repos list

Options:
${accountFlags}`;
  }
  if (commandName === "setup") {
    return `Usage:
  benchrouter setup status [--repo owner/repo]

Local kit checks and kit upgrades remain:
  benchrouter doctor
  benchrouter upgrade --upgrade-token br_upgrade_... --repo owner/repo --route-id product/route

Options:
${accountFlags}`;
  }
  if (commandName === "setup status") {
    return `Usage:
  benchrouter setup status [--repo owner/repo]

Options:
  --repo owner/repo            Defaults to the current git remote.
${accountFlags}`;
  }
  if (commandName === "routes") {
    return `Usage:
  benchrouter routes list
  benchrouter routes show <route-key>
  benchrouter routes catalog <route-key>
  benchrouter routes archive <route-key>
  benchrouter routes unarchive <route-id>

Options:
${accountFlags}  --yes, -y                    Skip confirmation for archive/unarchive.
`;
  }
  if (commandName === "routes list") {
    return `Usage:
  benchrouter routes list

Options:
${accountFlags}`;
  }
  if (commandName === "routes show") {
    return `Usage:
  benchrouter routes show <route-key>

Options:
${accountFlags}`;
  }
  if (commandName === "routes catalog") {
    return `Usage:
  benchrouter routes catalog <route-key>

Options:
${accountFlags}`;
  }
  if (commandName === "routes archive") {
    return `Usage:
  benchrouter routes archive <route-key>

Options:
  --yes, -y                    Required with --json; skips confirmation.
${accountFlags}`;
  }
  if (commandName === "routes unarchive") {
    return `Usage:
  benchrouter routes unarchive <route-id>

Uses the archived route id from \`routes list\`, not the route key.

Options:
  --yes, -y                    Required with --json; skips confirmation.
${accountFlags}`;
  }
  if (commandName === "models show") {
    return `Usage:
  benchrouter models show <route-key> <model-id>

The existing catalog listing remains:
  benchrouter models [--filter text] [--json]

Options:
${accountFlags}`;
  }
  if (commandName === "evals") {
    return `Usage:
  benchrouter evals list <route-key>
  benchrouter evals run <route-key> --model <model-id>
  benchrouter evals failures <route-key> <model-id>

Repo-token failures remain at:
  benchrouter failures <route-key> [model]

Options:
${accountFlags}  --yes, -y                    Skip confirmation for evals run.
`;
  }
  if (commandName === "evals list") {
    return `Usage:
  benchrouter evals list <route-key>

Options:
${accountFlags}`;
  }
  if (commandName === "evals run") {
    return `Usage:
  benchrouter evals run <route-key> --model <model-id>

Options:
  --model <id>                 Model to evaluate.
  --yes, -y                    Required with --json; skips confirmation.
${accountFlags}`;
  }
  if (commandName === "evals failures") {
    return `Usage:
  benchrouter evals failures <route-key> <model-id>

Options:
  --model <id>                 Alternative to the positional model id.
${accountFlags}`;
  }
  if (commandName === "baseline" || commandName === "baseline set") {
    return `Usage:
  benchrouter baseline set <route-key> --result-set <id> --model <model-id>

Server policy decides eligibility. The CLI only submits the request.

Options:
  --result-set <id>            Eval result set id.
  --model <id>                 Model evidence inside that result set.
  --yes, -y                    Required with --json; skips confirmation.
${accountFlags}`;
  }
  return null;
}

export function topLevelCustomerUsageLines() {
  return `  benchrouter account show [--json]
  benchrouter billing show [--json]
  benchrouter billing top-up --amount <usd> [--yes]
  benchrouter keys list|create|revoke [--json]
  benchrouter repos list [--json]
  benchrouter setup status [--repo owner/repo] [--json]
  benchrouter routes list|show|catalog|archive|unarchive [--json]
  benchrouter models show <route-key> <model-id> [--json]
  benchrouter evals list|run|failures [--json]
  benchrouter baseline set <route-key> --result-set <id> --model <id> [--yes]`;
}
