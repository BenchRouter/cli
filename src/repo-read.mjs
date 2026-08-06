export async function runRepoRead(options) {
  const { kind, routeKey, modelId, route, apiUrl, repoFullName, token, json } = options;
  if (kind === "status") {
    const body = await fetchRepoJson(apiUrl, "/v1/repo/status", token, kind);
    printStatus(body, json);
    return;
  }

  if (kind === "explain") {
    const resolvedRoute = route || await onlyRoute(apiUrl, token);
    const body = await fetchFrontier(apiUrl, resolvedRoute, token);
    printExplanation(body, modelId, json);
    return;
  }

  if (kind === "frontier") {
    const body = await fetchFrontier(apiUrl, routeKey, token);
    printFrontier(body, json);
    return;
  }

  const query = modelId ? `?model=${encodeURIComponent(modelId)}` : "";
  const body = await fetchRepoJson(
    apiUrl,
    `/v1/repo/${encodeURIComponent(routeKey)}/failures${query}`,
    token,
    kind
  );
  printFailures(body, json);
}

async function onlyRoute(apiUrl, token) {
  const status = await fetchRepoJson(apiUrl, "/v1/repo/status", token, "status");
  const routes = Array.isArray(status.routes) ? status.routes : [];
  if (routes.length !== 1) {
    throw new CliUsageError("Pass --route when this repository has zero or multiple routes.");
  }
  return routes[0].route_key;
}

function fetchFrontier(apiUrl, routeKey, token) {
  return fetchRepoJson(apiUrl, `/v1/repo/${encodeURIComponent(routeKey)}/frontier`, token, "frontier");
}

async function fetchRepoJson(apiUrl, pathname, token, label) {
  let response;
  try {
    response = await fetch(`${apiUrl}${pathname}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw new Error(`BenchRouter ${label} request failed: ${networkMessage(error)}`);
  }
  const text = await response.text();
  const body = parseJson(text);
  if (!response.ok) {
    if (["read_scope_expired", "read_token_invalid", "read_token_missing"].includes(body?.error)) {
      const url = typeof body.authorize_url === "string" ? body.authorize_url : "https://benchrouter.com/setup";
      throw new Error(`BenchRouter repo access expired or is invalid. Open ${url} to create a new repo token.`);
    }
    const message = typeof body?.message === "string" ? body.message : text.slice(0, 800);
    throw new Error(`BenchRouter ${label} failed (${response.status}): ${message}`);
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
    const evidence = route.production_result_set_id
      ? `; production evidence ${route.production_result_set_id}`
      : "";
    const best = route.gated ? "awaiting evidence" : `best ${route.best_model ?? "not selected"}`;
    process.stdout.write(
      `- ${route.route_key}: ${best}; incumbent ${route.original_model ?? "unknown"}${wiring}${run}${evidence}\n`
    );
  }
}

function printFrontier(body, json) {
  if (json) return printJson(body);
  process.stdout.write(`${body.route_key}\n`);
  process.stdout.write(`Incumbent: ${body.incumbent?.model ?? "unknown"}\n`);
  process.stdout.write(`Best: ${body.best_pick ?? "not selected"}\n`);
  const alternatives = Array.isArray(body.ranked_alternatives) ? body.ranked_alternatives : [];
  if (alternatives.length === 0) {
    process.stdout.write("Alternatives: none\n");
    return;
  }
  process.stdout.write("Alternatives:\n");
  for (const alternative of alternatives) {
    const cost = Number.isFinite(alternative.cost_per_1k) ? `; $${alternative.cost_per_1k}/1K` : "";
    process.stdout.write(`  ${alternative.rank}. ${alternative.model}${cost}\n`);
  }
}

function printFailures(body, json) {
  if (json) return printJson(body);
  process.stdout.write(`${body.route_key}: ${body.model} (${body.model_run_id})\n`);
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

function printExplanation(body, modelId, json) {
  const incumbent = body.incumbent?.model;
  const alternatives = Array.isArray(body.ranked_alternatives) ? body.ranked_alternatives : [];
  let explanation;
  if (modelId === incumbent) {
    explanation = { model: modelId, route_key: body.route_key, standing: "incumbent", detail: "This is the route incumbent." };
  } else if (modelId === body.best_pick) {
    explanation = { model: modelId, route_key: body.route_key, standing: "best", detail: "This is the current best pick on the Personal Pareto Frontier." };
  } else {
    const alternative = alternatives.find((entry) => entry.model === modelId);
    explanation = alternative
      ? { model: modelId, route_key: body.route_key, standing: "eligible", rank: alternative.rank, detail: `This is eligible alternative ${alternative.rank}.` }
      : { model: modelId, route_key: body.route_key, standing: "not_eligible", detail: "This model is not on the eligible frontier for this route." };
  }
  if (json) return printJson({ ok: true, ...explanation });
  process.stdout.write(`${explanation.model}: ${explanation.detail}\n`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function networkMessage(error) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "request timed out";
  }
  return error instanceof Error ? error.message : "request failed";
}

export class CliUsageError extends Error {}
