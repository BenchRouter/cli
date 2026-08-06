export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function renderAccountShow(body) {
  const account = body.account ?? {};
  const person = body.person ?? {};
  const identity = body.identity ?? {};
  const products = Array.isArray(body.visible_products) ? body.visible_products : [];
  process.stdout.write(`Account: ${account.displayName ?? account.slug ?? account.id ?? "unknown"}\n`);
  if (account.slug) process.stdout.write(`Slug: ${account.slug}\n`);
  if (account.id) process.stdout.write(`Id: ${account.id}\n`);
  if (body.membership_role) process.stdout.write(`Role: ${body.membership_role}\n`);
  if (identity.providerLogin) process.stdout.write(`GitHub: ${identity.providerLogin}\n`);
  if (person.displayName || person.id) {
    process.stdout.write(`Person: ${person.displayName ?? person.id}\n`);
  }
  if (products.length === 0) {
    process.stdout.write("Visible products: none\n");
    return;
  }
  process.stdout.write("Visible products:\n");
  for (const product of products) {
    process.stdout.write(
      `- ${product.repo_full_name ?? product.product_id}` +
        `${product.access_kind ? ` (${product.access_kind})` : ""}\n`
    );
  }
}

export function renderBillingShow(body) {
  const billing = body.billing ?? body;
  const balance = numberOrNull(billing.balance_usd);
  const available = numberOrNull(billing.available_usd);
  const limit = numberOrNull(billing.credit_limit_usd);
  process.stdout.write(`Account: ${body.account_id ?? "unknown"}\n`);
  if (billing.currency) process.stdout.write(`Currency: ${billing.currency}\n`);
  if (billing.status) process.stdout.write(`Status: ${billing.status}\n`);
  if (balance !== null) process.stdout.write(`Balance: $${formatUsd(balance)}\n`);
  if (available !== null) process.stdout.write(`Available: $${formatUsd(available)}\n`);
  if (limit !== null) process.stdout.write(`Credit limit: $${formatUsd(limit)}\n`);
  const ledger = Array.isArray(body.recent_ledger) ? body.recent_ledger : [];
  if (ledger.length === 0) return;
  process.stdout.write("Recent ledger:\n");
  for (const entry of ledger.slice(0, 10)) {
    const amount = numberOrNull(entry.amount_usd);
    process.stdout.write(
      `- ${entry.created_at ?? "?"}: ${entry.kind ?? "entry"}` +
        `${amount === null ? "" : ` $${formatUsd(amount)}`}` +
        `${entry.description ? ` — ${entry.description}` : ""}\n`
    );
  }
}

export function renderBillingTopUp(body) {
  process.stdout.write(`Checkout total: $${formatUsd(body.checkout_total_usd)} ` +
    `(credit $${formatUsd(body.credit_usd ?? body.amount_usd)}; fee $${formatUsd(body.service_fee_usd)})\n`);
  process.stdout.write(`Checkout URL:\n${body.checkout_url}\n`);
  process.stdout.write("Open that URL in a browser to pay. The CLI does not open a browser or automate payment.\n");
}

export function renderApiKeysList(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    process.stdout.write("No API keys.\n");
    return;
  }
  for (const key of keys) {
    process.stdout.write(
      `- ${key.id}: ${key.name ?? "unnamed"} (${key.prefix ?? "?"})` +
        `${key.last_used_at ? `; last used ${key.last_used_at}` : ""}\n`
    );
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
  process.stdout.write("Store them now. Runtime keys cannot authorize control-plane commands.\n");
}

export function renderReposList(body) {
  const repos = Array.isArray(body.repos) ? body.repos : [];
  if (repos.length === 0) {
    process.stdout.write("No setup repositories.\n");
  } else {
    for (const repo of repos) {
      process.stdout.write(
        `- ${repo.repo_full_name}` +
          `${repo.private ? " (private)" : ""}` +
          `${repo.default_branch ? `; default ${repo.default_branch}` : ""}\n`
      );
    }
  }
  const installations = Array.isArray(body.installations) ? body.installations : [];
  if (installations.length === 0) return;
  process.stdout.write("Installations:\n");
  for (const installation of installations) {
    process.stdout.write(
      `- ${installation.owner_login} (${installation.status ?? "unknown"}; id ${installation.installation_id})\n`
    );
  }
  const warnings = Array.isArray(body.warnings) ? body.warnings : [];
  for (const warning of warnings) {
    process.stdout.write(`warning: ${warning.message ?? warning.code}\n`);
  }
}

export function renderSetupStatus(body) {
  const diagnostic = body.diagnostic ?? body;
  process.stdout.write(`Status: ${diagnostic.status ?? "unknown"}\n`);
  if (diagnostic.packet_created_at) process.stdout.write(`Packet created: ${diagnostic.packet_created_at}\n`);
  if (diagnostic.imported_at) process.stdout.write(`Imported: ${diagnostic.imported_at}\n`);
  if (diagnostic.last_plan_status != null) process.stdout.write(`Last plan status: ${diagnostic.last_plan_status}\n`);
  if (diagnostic.last_plan_attempt_at) process.stdout.write(`Last plan attempt: ${diagnostic.last_plan_attempt_at}\n`);
  if (diagnostic.last_plan_error) process.stdout.write(`Last plan error: ${diagnostic.last_plan_error}\n`);
  const pr = diagnostic.pr_open_no_report;
  if (pr) {
    process.stdout.write(`PR waiting for report: #${pr.pr_number}` +
      `${pr.minutes_waiting != null ? ` (${pr.minutes_waiting}m)` : ""}\n`);
    if (pr.message) process.stdout.write(`${pr.message}\n`);
  }
}

export function renderRoutesList(routes, archived = []) {
  if (!Array.isArray(routes) || routes.length === 0) {
    process.stdout.write("No active routes.\n");
  } else {
    for (const route of routes) {
      process.stdout.write(
        `- ${route.route_key}: best ${route.best_model ?? "unknown"}; ` +
          `baseline ${route.baseline_model ?? "none"}; ` +
          `state ${route.state ?? "unknown"}` +
          `${route.repo_full_name ? `; ${route.repo_full_name}` : ""}\n`
      );
    }
  }
  if (!Array.isArray(archived) || archived.length === 0) return;
  process.stdout.write("Archived:\n");
  for (const route of archived) {
    process.stdout.write(`- ${route.route_key} (${route.id}) archived ${route.archived_at ?? "?"}\n`);
  }
}

export function renderRouteShow(route) {
  process.stdout.write(`${route.route_key}\n`);
  process.stdout.write(`Name: ${route.name ?? "unnamed"}\n`);
  process.stdout.write(`State: ${route.state ?? "unknown"}\n`);
  process.stdout.write(`Best: ${route.best_model ?? "unknown"}\n`);
  process.stdout.write(`Baseline: ${route.baseline_model ?? "none"}\n`);
  process.stdout.write(`Original: ${route.original_model ?? "unknown"}\n`);
  if (route.repo_full_name) process.stdout.write(`Repo: ${route.repo_full_name}\n`);
  if (route.latest_eval) {
    process.stdout.write(
      `Latest eval: ${route.latest_eval.status}` +
        `${route.latest_eval.model ? ` (${route.latest_eval.model})` : ""}\n`
    );
  }
}

export function renderRouteCatalog(body) {
  process.stdout.write(`${body.route_key}\n`);
  process.stdout.write(`Best: ${body.best_model ?? "unknown"}\n`);
  process.stdout.write(`Baseline: ${body.baseline_model ?? "none"}\n`);
  process.stdout.write(`Original: ${body.original_model ?? "unknown"}\n`);
  const catalog = Array.isArray(body.catalog) ? body.catalog : [];
  process.stdout.write(`Catalog models: ${catalog.length}\n`);
  const history = Array.isArray(body.eval_history) ? body.eval_history : [];
  if (history.length > 0) {
    process.stdout.write(`Eval history entries: ${history.length}\n`);
  }
  if (body.latest_eval_batch) {
    process.stdout.write(`Latest batch: ${body.latest_eval_batch.status ?? "unknown"}\n`);
  }
}

export function renderRouteModel(body) {
  process.stdout.write(`${body.route_key} / ${body.model}\n`);
  if (body.role) process.stdout.write(`Role: ${body.role}\n`);
  if (body.result) {
    process.stdout.write(
      `Result: pass_rate ${body.result.pass_rate ?? "n/a"}; ` +
        `cases ${body.result.cases ?? "n/a"}\n`
    );
  }
  if (body.latest_eval) {
    process.stdout.write(
      `Latest eval: ${body.latest_eval.status}` +
        `${body.latest_eval.id ? ` (${body.latest_eval.id})` : ""}\n`
    );
  }
}

export function renderEvalsList(body) {
  process.stdout.write(`${body.route_key}\n`);
  const history = Array.isArray(body.eval_history) ? body.eval_history : [];
  if (history.length === 0) {
    process.stdout.write("No eval history.\n");
    return;
  }
  for (const entry of history) {
    process.stdout.write(
      `- ${entry.id ?? entry.model_run_id ?? "?"}: ${entry.model ?? "unknown"} ` +
        `${entry.status ?? "unknown"}` +
        `${entry.created_at ? `; ${entry.created_at}` : ""}\n`
    );
  }
}

export function renderEvalsRun(body) {
  process.stdout.write(
    `Queued result set ${body.result_set_id} for ${body.route_key}` +
      ` / ${body.model} (${body.status})\n`
  );
  if (body.model_run_id) process.stdout.write(`Model run: ${body.model_run_id}\n`);
}

export function renderEvalsFailures(body, modelId) {
  const latest = body.latest_eval;
  if (!latest) {
    process.stdout.write(`No eval evidence for ${body.route_key} / ${modelId}.\n`);
    return;
  }
  process.stdout.write(`${body.route_key}: ${modelId} (${latest.model_run_id ?? latest.id})\n`);
  const results = Array.isArray(latest.results) ? latest.results : [];
  const failures = results.filter((row) => row && row.outcome && row.outcome !== "pass");
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
      `${body.route_key}: ${body.baseline_model} is already the baseline` +
        ` for result set ${body.result_set_id}.\n`
    );
    return;
  }
  process.stdout.write(
    `${body.route_key}: baseline set to ${body.baseline_model}` +
      ` (was ${body.previous_model ?? "none"}) on ${body.result_set_id}.\n`
  );
}

export function renderArchive(body) {
  process.stdout.write(`Archived ${body.route_key} at ${body.archived_at}.\n`);
}

export function renderUnarchive(body) {
  process.stdout.write(`Unarchived ${body.route_key} (${body.route_id}).\n`);
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "n/a");
  return number.toFixed(2);
}

/** Pure helper for mutation confirmation copy. */
export function mutationSummary(action, details) {
  return `${action}: ${details}`;
}
