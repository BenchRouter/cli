export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLines(lines) {
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}

export function mutationSummary(action, details) {
  return `${action}: ${details}`;
}

export function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "n/a");
  return number.toFixed(2);
}

export function renderAccountShow(body) {
  const account = body.account ?? {};
  const products = Array.isArray(body.visible_products) ? body.visible_products : [];
  printLines([
    `Account: ${account.displayName ?? account.slug ?? account.id ?? "unknown"}`,
    ...(account.slug ? [`Slug: ${account.slug}`] : []),
    ...(body.membership_role ? [`Role: ${body.membership_role}`] : []),
    products.length === 0
      ? "Visible products: none"
      : `Visible products: ${products.map((p) => p.repo_full_name ?? p.product_id).join(", ")}`
  ]);
}

/** Billing fields come from GET /v1/dashboard/summary. */
export function renderBillingShow(summary) {
  const billing = summary.billing ?? {};
  printLines([
    `Account: ${summary.account?.id ?? summary.account_id ?? "unknown"}`,
    `Balance: $${formatUsd(billing.balance_usd)}`,
    `Available: $${formatUsd(billing.available_usd)}`
  ]);
  const ledger = Array.isArray(summary.recent_ledger) ? summary.recent_ledger.slice(0, 5) : [];
  for (const entry of ledger) {
    process.stdout.write(
      `- ${entry.created_at ?? "?"}: ${entry.kind ?? "entry"}` +
        `${entry.amount_usd == null ? "" : ` $${formatUsd(entry.amount_usd)}`}\n`
    );
  }
}

export function renderBillingTopUp(body) {
  printLines([
    `Checkout total: $${formatUsd(body.checkout_total_usd)} (credit $${formatUsd(body.credit_usd ?? body.amount_usd)}; fee $${formatUsd(body.service_fee_usd)})`,
    `Checkout URL:\n${body.checkout_url}`,
    "Open that URL in a browser to pay. The CLI does not open a browser or automate payment."
  ]);
}

export function renderApiKeysList(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    process.stdout.write("No API keys.\n");
    return;
  }
  for (const key of keys) {
    process.stdout.write(`- ${key.id}: ${key.name ?? "unnamed"} (${key.prefix ?? "?"})\n`);
  }
}

export function renderApiKeyCreate(body) {
  const created = Array.isArray(body.api_keys) && body.api_keys.length > 0
    ? body.api_keys
    : body.api_key
      ? [body.api_key]
      : [];
  process.stdout.write("Created API key(s). Secrets are shown once:\n");
  for (const key of created) {
    process.stdout.write(`- ${key.name ?? "unnamed"} (${key.prefix ?? "?"}): ${key.key}\n`);
  }
}

export function renderReposList(body) {
  const repos = Array.isArray(body.repos) ? body.repos : [];
  if (repos.length === 0) process.stdout.write("No setup repositories.\n");
  for (const repo of repos) {
    process.stdout.write(`- ${repo.repo_full_name}${repo.private ? " (private)" : ""}\n`);
  }
}

export function renderSetupStatus(body) {
  const diagnostic = body.diagnostic ?? body;
  printLines([
    `Status: ${diagnostic.status ?? "unknown"}`,
    ...(diagnostic.packet_created_at ? [`Packet created: ${diagnostic.packet_created_at}`] : []),
    ...(diagnostic.last_plan_status != null ? [`Last plan status: ${diagnostic.last_plan_status}`] : [])
  ]);
}

export function renderRoutesList(routes, archived = []) {
  if (!Array.isArray(routes) || routes.length === 0) process.stdout.write("No active routes.\n");
  for (const route of routes ?? []) {
    process.stdout.write(
      `- ${route.route_key}: best ${route.best_model ?? "unknown"}; baseline ${route.baseline_model ?? "none"}\n`
    );
  }
  for (const route of archived ?? []) {
    process.stdout.write(`- archived ${route.route_key} (${route.id})\n`);
  }
}

export function renderRouteShow(route) {
  printLines([
    `${route.route_key}`,
    `Best: ${route.best_model ?? "unknown"}`,
    `Baseline: ${route.baseline_model ?? "none"}`,
    `State: ${route.state ?? "unknown"}`
  ]);
}

export function renderRouteCatalog(body) {
  const catalog = Array.isArray(body.catalog) ? body.catalog : [];
  printLines([
    `${body.route_key}`,
    `Best: ${body.best_model ?? "unknown"}; baseline ${body.baseline_model ?? "none"}`,
    `Catalog models: ${catalog.length}`
  ]);
}

export function renderRouteModel(body) {
  printLines([
    `${body.route_key} / ${body.model}`,
    ...(body.role ? [`Role: ${body.role}`] : []),
    ...(body.result
      ? [`Result: pass_rate ${body.result.pass_rate ?? "n/a"}; cases ${body.result.cases ?? "n/a"}`]
      : [])
  ]);
}

export function renderEvalsList(body) {
  const history = Array.isArray(body.eval_history) ? body.eval_history : [];
  if (history.length === 0) {
    process.stdout.write(`${body.route_key}: no eval history.\n`);
    return;
  }
  for (const entry of history) {
    process.stdout.write(
      `- ${entry.id ?? entry.model_run_id ?? "?"}: ${entry.model ?? "unknown"} ${entry.status ?? "unknown"}\n`
    );
  }
}

export function renderEvalsRun(body) {
  process.stdout.write(
    `Queued result set ${body.result_set_id} for ${body.route_key} / ${body.model} (${body.status})\n`
  );
}

export function renderEvalsFailures(body, modelId) {
  const latest = body.latest_eval;
  if (!latest) {
    process.stdout.write(`No eval evidence for ${body.route_key} / ${modelId}.\n`);
    return;
  }
  const results = Array.isArray(latest.results) ? latest.results : [];
  const failures = results.filter((row) => row && row.outcome && row.outcome !== "pass");
  process.stdout.write(`${body.route_key}: ${modelId} (${latest.model_run_id ?? latest.id})\n`);
  if (failures.length === 0) {
    process.stdout.write("No failed cases in the latest model evidence.\n");
    return;
  }
  for (const failure of failures) {
    process.stdout.write(
      `- ${failure.case_id}: ${failure.critical ? "critical; " : ""}${failure.outcome}\n`
    );
  }
}

export function renderBaselineSet(body) {
  if (body.already_baseline) {
    process.stdout.write(
      `${body.route_key}: ${body.baseline_model} is already the baseline for result set ${body.result_set_id}.\n`
    );
    return;
  }
  process.stdout.write(
    `${body.route_key}: baseline set to ${body.baseline_model} (was ${body.previous_model ?? "none"}) on ${body.result_set_id}.\n`
  );
}

export function renderArchive(body) {
  process.stdout.write(`Archived ${body.route_key} at ${body.archived_at}.\n`);
}

export function renderUnarchive(body) {
  process.stdout.write(`Unarchived ${body.route_key} (${body.route_id}).\n`);
}

export function renderProposalsList(body) {
  const proposals = Array.isArray(body?.proposals) ? body.proposals : [];
  if (proposals.length === 0) {
    process.stdout.write("No catalog proposals.\n");
    return;
  }
  for (const proposal of proposals) {
    process.stdout.write(
      `- ${proposal.id}: ${proposal.kind ?? "-"} ${proposal.resolution ?? "-"}${proposal.canonical_id ? ` ${proposal.canonical_id}` : ""}\n`
    );
  }
}

export function renderProvidersList(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  if (data.length === 0) {
    process.stdout.write("No providers.\n");
    return;
  }
  for (const provider of data) {
    process.stdout.write(
      `- ${provider.id}: key ${provider.key_set ? "yes" : "no"}; routable ${provider.routable ? "yes" : "no"}; smoke ${provider.smoke_status ?? "unverified"}\n`
    );
  }
}
