import { apiRequest, ApiError } from "./http.mjs";
import { ACCOUNT_CONTROL_TOKEN_PREFIX, LOGIN_COMMAND } from "./config.mjs";

/**
 * Exact repo-read path construction for regression tests / request planning. A setup key names
 * its repository itself; the CLI login (br_ctrl_) serves many, so its reads name the repository
 * in `repo_full_name`.
 */
export function repoReadPath(kind, { routeKey, modelId, repoFullName } = {}) {
  const query = new URLSearchParams();
  if (kind === "failures" && modelId) query.set("model", modelId);
  if (repoFullName) query.set("repo_full_name", repoFullName);
  const suffix = query.toString() ? `?${query}` : "";
  if (kind === "status") return `/v1/repo/status${suffix}`;
  if (kind === "frontier") return `/v1/repo/${encodeURIComponent(routeKey)}/frontier${suffix}`;
  if (kind === "failures") return `/v1/repo/${encodeURIComponent(routeKey)}/failures${suffix}`;
  if (kind === "explain") {
    return `/v1/repo/${encodeURIComponent(routeKey)}/models/${encodeURIComponent(modelId)}${suffix}`;
  }
  throw new Error(`Unknown repo-read kind: ${kind}`);
}

export async function runRepoRead(options) {
  const { kind, routeKey, modelId, route, apiUrl, token, json } = options;
  // Only the login needs the repository named; a setup key's request stays as it was.
  const repoFullName = options.credentialKind === "account" ? options.repoFullName : undefined;
  if (kind === "status") {
    const body = await fetchRepoJson(apiUrl, repoReadPath("status", { repoFullName }), token, kind);
    printStatus(body, json);
    return;
  }

  if (kind === "explain") {
    const resolvedRoute = route || await onlyRoute(apiUrl, token, repoFullName);
    const body = await fetchRepoJson(
      apiUrl,
      repoReadPath("explain", { routeKey: resolvedRoute, modelId, repoFullName }),
      token,
      kind
    );
    printExplanation(body, json);
    return;
  }

  if (kind === "frontier") {
    const body = await fetchRepoJson(
      apiUrl,
      repoReadPath("frontier", { routeKey, repoFullName }),
      token,
      kind
    );
    printFrontier(body, json);
    return;
  }

  const body = await fetchRepoJson(
    apiUrl,
    repoReadPath("failures", { routeKey, modelId, repoFullName }),
    token,
    kind
  );
  printFailures(body, json);
}

async function onlyRoute(apiUrl, token, repoFullName) {
  const status = await fetchRepoJson(apiUrl, repoReadPath("status", { repoFullName }), token, "status");
  const routes = Array.isArray(status.routes) ? status.routes : [];
  if (routes.length !== 1) {
    throw new CliUsageError("Pass --route when this repository has zero or multiple routes.");
  }
  return routes[0].route_key;
}

/** Repo reads go through the shared client, so a 503 with a short Retry-After is retried once like every other read. */
async function fetchRepoJson(apiUrl, pathname, token, label) {
  let body;
  try {
    body = await apiRequest({ apiUrl, token, path: pathname, label, requireBody: true });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const failed = error.body;
    if (["read_scope_expired", "read_token_invalid", "read_token_missing"].includes(failed?.error)) {
      const url = typeof failed.authorize_url === "string" ? failed.authorize_url : "https://benchrouter.com/cli";
      throw new Error(`BenchRouter repo access expired or is invalid. Open ${url} to create a new repo token.`);
    }
    if (token.startsWith(ACCOUNT_CONTROL_TOKEN_PREFIX) && error.status === 401) {
      throw new Error(`BenchRouter did not accept your login. Run \`${LOGIN_COMMAND}\`, then rerun this command.`);
    }
    const message = typeof failed?.message === "string" ? failed.message : error.text.slice(0, 800);
    throw new Error(`BenchRouter ${label} failed (${error.status}): ${message}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`BenchRouter ${label} returned invalid JSON.`);
  }
  return body;
}

function printStatus(body, json) {
  if (json) return printJson(body);
  process.stdout.write(`${body.repo_full_name ?? "Repository"}\n`);
  const routes = Array.isArray(body.routes) ? body.routes : [];
  if (routes.length === 0) {
    process.stdout.write("No active routes.\n");
    return;
  }
  for (const route of routes) {
    const run = route.latest_run?.status ? `; latest eval ${route.latest_run.status}` : "";
    const wiring = route.wired ? "; wired in production" : "; not wired in production";
    const firstCall = route.production_wiring?.first_runtime_call_id
      ? `; first runtime call ${route.production_wiring.first_runtime_call_id}`
      : "";
    const evidence = route.production_result_set_id
      ? `; production evidence ${route.production_result_set_id}`
      : "";
    const decision = route.production_decision?.selected_model
      ? `; production decision ${route.production_decision.selected_model}`
      : "";
    const best = route.gated ? "awaiting evidence" : `best ${route.best_model ?? "not selected"}`;
    process.stdout.write(
      `- ${route.route_key}: ${best}; incumbent ${route.original_model ?? "unknown"}${wiring}${firstCall}${run}${evidence}${decision}\n`
    );
  }
}

function printFrontier(body, json) {
  if (json) return printJson(body);
  process.stdout.write(`${body.route_key}\n`);
  process.stdout.write(`Incumbent: ${body.incumbent?.model ?? body.original_model ?? "unknown"}\n`);
  process.stdout.write(`Best: ${body.best_pick ?? body.best_model ?? "not selected"}\n`);
  if (body.serving_model) process.stdout.write(`Serving: ${body.serving_model}\n`);
  if (typeof body.wired === "boolean") {
    process.stdout.write(`Wired: ${body.wired ? "yes" : "no"}\n`);
  }
  if (body.production_wiring?.first_runtime_call_id) {
    process.stdout.write(`First runtime call: ${body.production_wiring.first_runtime_call_id}\n`);
  }
  const alternatives = Array.isArray(body.ranked_alternatives) ? body.ranked_alternatives : [];
  if (alternatives.length === 0) {
    process.stdout.write("Alternatives: none\n");
    return;
  }
  process.stdout.write("Alternatives:\n");
  for (const alternative of alternatives) {
    const costValue = alternative.estimated_cost_per_1k_representative_calls_usd ?? alternative.cost_per_1k;
    const cost = Number.isFinite(costValue) ? `; $${costValue}/1K` : "";
    const pass = Number.isFinite(alternative.pass_rate) ? `; pass ${alternative.pass_rate}` : "";
    process.stdout.write(`  ${alternative.rank}. ${alternative.model}${cost}${pass}\n`);
  }
}

function printFailures(body, json) {
  if (json) return printJson(body);
  const selection = body.model_selection ? `; selection ${body.model_selection}` : "";
  process.stdout.write(`${body.route_key}: ${body.model} (${body.model_run_id})${selection}\n`);
  const failures = Array.isArray(body.failures) ? body.failures : [];
  if (failures.length === 0) {
    process.stdout.write("No failed cases in the latest model run.\n");
    return;
  }
  for (const failure of failures) {
    const critical = failure.critical ? "critical; " : "";
    const error = failure.error ? `: ${failure.error}` : "";
    process.stdout.write(`- ${failure.case_id}: ${critical}${failure.outcome}${error}\n`);
  }
}

/**
 * Render server model-explanation. Preserve published human spellings
 * (incumbent / best / eligible / not on eligible frontier) while surfacing
 * enriched state/evidence fields.
 */
function printExplanation(body, json) {
  if (json) return printJson(body);
  const detail = explanationDetail(body);
  process.stdout.write(`${body.model}: ${detail}\n`);
  if (body.state) process.stdout.write(`State: ${body.state}\n`);
  const flags = [
    body.is_original ? "original" : null,
    body.is_baseline ? "baseline" : null,
    body.is_best ? "best" : null,
    body.is_serving ? "serving" : null,
    body.in_registry === false ? "not in registry" : null
  ].filter(Boolean);
  if (flags.length > 0) process.stdout.write(`Roles: ${flags.join(", ")}\n`);
  if (body.evidence) {
    const parts = [];
    if (body.evidence.pass_rate != null) parts.push(`pass_rate ${body.evidence.pass_rate}`);
    if (body.evidence.measured_billed_eval_cost_usd != null) {
      parts.push(`eval_cost $${body.evidence.measured_billed_eval_cost_usd}`);
    }
    if (body.evidence.eligible_rank != null) parts.push(`rank ${body.evidence.eligible_rank}`);
    if (body.evidence.outcome_code) parts.push(body.evidence.outcome_code);
    if (parts.length > 0) process.stdout.write(`Evidence: ${parts.join("; ")}\n`);
  }
}

export function explanationDetail(body) {
  switch (body.state) {
    case "original":
      return "This is the route incumbent.";
    case "best":
      return "This is the current best pick on the Personal Pareto Frontier.";
    case "baseline":
      return "This is the route baseline.";
    case "eligible": {
      const rank = body.evidence?.eligible_rank;
      return Number.isFinite(rank)
        ? `This is eligible alternative ${rank}.`
        : "This is an eligible alternative.";
    }
    case "evaluated_ineligible":
      return "This model was evaluated and is not on the eligible frontier for this route.";
    case "known_not_evaluated":
      return "This model is known in the registry but has not been evaluated on this route.";
    case "unknown_registry_identity":
      return "This model is not a known registry identity for this route.";
    default:
      return "This model is not on the eligible frontier for this route.";
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export class CliUsageError extends Error {}
