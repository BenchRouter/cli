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

/** MCP-001 / BILL-001: `benchrouter account show`, the account page with the credential's role. */
export function renderAccountShow(body) {
  const account = body.account ?? {};
  const out = [
    `Account: ${account.display_name ?? account.slug ?? "unknown"}${body.account_id ? ` (${body.account_id})` : ""}`,
    ...(body.role ? [`Role: ${body.role}`] : [])
  ];
  // BILL-001: only an owner's read has billing; a member's spend, savings and keys are empty, not the account's.
  if (body.billing) {
    out.push(`Balance: $${formatUsd(body.billing.balance_usd)} (available $${formatUsd(body.billing.available_usd)})`);
    if (body.free_credit?.granted) out.push(`Free credit: $${formatUsd(body.free_credit.amount_usd)}, granted ${utcMinute(body.free_credit.granted_at)}`);
    const spend = body.spend ?? {};
    out.push(
      `Spend: $${formatUsd(spend.total_usd)} ($${formatUsd(spend.production_usd)} production, $${formatUsd(spend.evaluation_usd)} evaluation);` +
      ` $${formatUsd(spend.last_30d_usd)} in the last 30 days`
    );
    out.push(`Savings: $${formatUsd(body.savings?.total_usd)}; $${formatUsd(body.savings?.last_30d_usd)} in the last 30 days`);
    if (body.auto_reload) out.push(autoReloadLine(body.auto_reload));
    const keys = Array.isArray(body.api_keys) ? body.api_keys : [];
    out.push(keys.length > 0 ? "Endpoint keys:" : "Endpoint keys: none");
    for (const key of keys) {
      out.push(
        `  ${key.prefix}…  ${key.name}  ${key.product_label ?? key.product_id ?? "-"}  last used ${utcMinute(key.last_used_at)}` +
        `${key.disabled_at ? `  disabled ${utcMinute(key.disabled_at)}` : ""}`
      );
    }
    const installations = Array.isArray(body.installations) ? body.installations : [];
    if (installations.length > 0) {
      out.push(`GitHub installations: ${installations.map((entry) => `${entry.owner_login} (${entry.repo_count} repo${entry.repo_count === 1 ? "" : "s"})`).join(", ")}`);
    }
  }
  const products = Array.isArray(body.visible_products) ? body.visible_products : [];
  out.push(products.length === 0 ? "Visible products: none" : `Visible products: ${products.map((p) => p.repo_full_name ?? p.product_id).join(", ")}`);
  printLines(out);
}

/** BILL-005: the auto-reload state, with a paused reload's last error. */
function autoReloadLine(reload) {
  if (!reload.enabled) return "Auto-reload: off";
  const card = reload.payment_method ? ` on ${reload.payment_method.brand ?? "card"} ending ${reload.payment_method.last4}` : "";
  const parts = [
    `Auto-reload: ${reload.state}; adds $${formatUsd(reload.reload_amount_usd)} (charge $${formatUsd(reload.charge_total_usd)}${card})` +
    ` when the balance falls below $${formatUsd(reload.threshold_usd)}`
  ];
  if (reload.last_error) parts.push(`last error: ${reload.last_error.message}${reload.consecutive_failures > 0 ? ` (${reload.consecutive_failures} failed)` : ""}`);
  if (reload.retry_after) parts.push(`retries after ${utcMinute(reload.retry_after)}`);
  return parts.join("; ");
}

/**
 * Billing fields come from GET /v1/dashboard/summary.
 * DashboardSummary.account is `Account { slug, display_name }` — it carries no id.
 * LedgerEntry is { created_at, kind, amount_usd, description }.
 */
export function renderBillingShow(summary) {
  const account = summary.account ?? {};
  const billing = summary.billing ?? {};
  printLines([
    `Account: ${account.display_name ?? account.slug ?? "unknown"}`,
    ...(account.slug && account.display_name ? [`Slug: ${account.slug}`] : []),
    `Balance: $${formatUsd(billing.balance_usd)}`,
    `Available: $${formatUsd(billing.available_usd)}`
  ]);
  const ledger = Array.isArray(summary.recent_ledger) ? summary.recent_ledger.slice(0, 5) : [];
  for (const entry of ledger) {
    const amount = entry.amount_usd == null ? "" : ` $${formatUsd(entry.amount_usd)}`;
    const description = entry.description ? `: ${entry.description}` : "";
    process.stdout.write(`- ${entry.created_at ?? "?"}: ${entry.kind ?? "entry"}${amount}${description}\n`);
  }
}

/** BILL-001: `benchrouter billing activity`, the ledger newest first. */
export function renderBillingActivity(body, { payments }) {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const out = [`${payments ? "Payments" : "Billing activity"} ${utcMinute(body.from)} to ${utcMinute(body.to)}:`];
  if (entries.length === 0) out.push("  none");
  for (const entry of entries) {
    out.push(`  ${utcMinute(entry.created_at)}  ${entry.kind.padEnd(8)}  ${formatSignedUsd(entry.amount_usd).padStart(11)}  ${entry.description}${entry.route_key ? `  ${entry.route_key}` : ""}`);
  }
  if (body.next_cursor) {
    out.push(`More: benchrouter billing activity --cursor '${body.next_cursor}' --from ${body.from} --to ${body.to}${payments ? " --payments" : ""}`);
  }
  printLines(out);
}

/** BILL-001: `benchrouter billing statement`, a period's balances and spend by route. */
export function renderBillingStatement(body) {
  const routes = Array.isArray(body.routes) ? body.routes : [];
  printLines([
    `Statement ${utcMinute(body.from)} to ${utcMinute(body.to)}`,
    `Opening balance $${formatUsd(body.opening_balance_usd)}; credits $${formatUsd(body.credits_usd)}; debits $${formatUsd(body.debits_usd)}; closing balance $${formatUsd(body.closing_balance_usd)}`,
    `Balance now: $${formatUsd(body.balance_usd)}`,
    ...(routes.length > 0 ? ["Spend by route:"] : []),
    ...routes.map((route) =>
      `  ${route.route_key ?? route.route_id ?? "-"}${route.archived ? " (archived)" : ""}  $${formatUsd(route.total_usd)} ($${formatUsd(route.runtime_usd)} runtime, $${formatUsd(route.eval_usd)} evals)`)
  ]);
}

/** "-$0.0035", "+$25.00": ledger amounts keep sub-cent precision. */
function formatSignedUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "n/a");
  const digits = Math.abs(number) < 0.01 && number !== 0 ? 4 : 2;
  return `${number < 0 ? "-" : "+"}$${Math.abs(number).toFixed(digits)}`;
}

/** `benchrouter public status`, the website's status page. */
export function renderPublicStatus(body) {
  const components = Array.isArray(body.components) ? body.components : [];
  const incidents = Array.isArray(body.incidents) ? body.incidents : [];
  const width = Math.max(0, ...components.map((component) => component.name.length));
  printLines([
    `${body.overall}: ${body.description} (updated ${utcMinute(body.updated_at)})`,
    ...components.map((component) => `  ${component.name.padEnd(width)}  ${component.status}  uptime ${metric(component.uptime, (v) => `${(v * 100).toFixed(2)}%`)}`),
    incidents.length === 0 ? "No incidents." : `Incidents: ${incidents.length} (--json lists them)`
  ]);
}

/** `benchrouter public frontier`: the Pareto members; --json lists the near-frontier ones too. */
export function renderPublicFrontier(body) {
  const members = Array.isArray(body.members) ? body.members : [];
  const pareto = members.filter((member) => member.candidate_kind === "pareto");
  const width = Math.max(0, ...pareto.map((member) => member.canonical_id.length));
  printLines([
    `Public frontier, generated ${utcMinute(body.generated_at)}: ${pareto.length} Pareto models, ${members.length - pareto.length} near the frontier.`,
    ...pareto.map((member) =>
      `  ${member.canonical_id.padEnd(width)}  ${String(member.tier).padEnd(12)}  score ${metric(member.score_overall, (v) => v.toFixed(1))}` +
      `  cost ${metric(member.benchmark_cost, (v) => `$${v.toFixed(2)}`)}`)
  ]);
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

/** Revoke returns ApiKeySummary + revoked_at. There is no secret in this body. */
export function renderApiKeyRevoke(body, keyId) {
  const key = body.api_key ?? {};
  printLines([
    `Revoked runtime API key ${key.id ?? keyId}${key.name ? ` (${key.name})` : ""}.`,
    `Prefix: ${key.prefix ?? "unknown"}`,
    `Revoked at: ${key.revoked_at ?? "unknown"}`,
    "Any application still using that key now fails authentication."
  ]);
}

/** GET /v1/admin/keys returns { object: "list", data: [...] } — metadata only. */
export function renderAdminKeysList(body) {
  const keys = Array.isArray(body?.data) ? body.data : [];
  if (keys.length === 0) {
    process.stdout.write("No admin keys.\n");
    return;
  }
  for (const key of keys) {
    const state = key.revoked_at ? `revoked ${key.revoked_at}` : "active";
    const lastUsed = key.last_used_at ? `; last used ${key.last_used_at}` : "; never used";
    process.stdout.write(
      `- ${key.id} (${key.prefix ?? "?"}): ${state}; created ${key.created_at ?? "?"}` +
        `${key.created_by_login ? ` by ${key.created_by_login}` : ""}${lastUsed}\n`
    );
  }
}

export function renderAdminKeyRevoke(body, keyId) {
  process.stdout.write(`Revoked admin key ${body.id ?? keyId}.\n`);
}

/**
 * GET /v1/setup/repos returns { ok, repos, installations, warnings? }.
 * Each repo carries repository_id and installation_id, which `setup create` needs.
 */
export function renderReposList(body) {
  const repos = Array.isArray(body.repos) ? body.repos : [];
  if (repos.length === 0) process.stdout.write("No setup repositories.\n");
  for (const repo of repos) {
    process.stdout.write(
      `- ${repo.repo_full_name}${repo.private ? " (private)" : ""}: ` +
        `repository_id ${repo.repository_id}; installation_id ${repo.installation_id}; ` +
        `default branch ${repo.default_branch ?? "unknown"}\n`
    );
  }
  const installations = Array.isArray(body.installations) ? body.installations : [];
  for (const installation of installations) {
    if (installation.status && installation.status !== "active") {
      process.stdout.write(
        `- installation ${installation.installation_id} (${installation.owner_login}) is ${installation.status}` +
          `${installation.status_reason ? `: ${installation.status_reason}` : ""}\n`
      );
    }
  }
  for (const warning of Array.isArray(body.warnings) ? body.warnings : []) {
    process.stdout.write(`- warning ${warning.code}: ${warning.message}\n`);
  }
}

/**
 * GET /v1/setup/diagnostic returns the latest setup session and four separate
 * readiness facts. Do not collapse these facts into one "ready" result:
 * evaluation completion is not a production-eligibility gate, and observed
 * serving is historical evidence rather than a current health check.
 */
export function renderSetupStatus(body) {
  const diagnostic = body.diagnostic ?? body;
  const readiness = diagnostic.readiness;
  printLines([
    `Status: ${diagnostic.status ?? "unknown"}`,
    ...(diagnostic.route_id ? [`Route: ${diagnostic.route_id}`] : []),
    ...(diagnostic.packet_created_at ? [`Packet created: ${diagnostic.packet_created_at}`] : []),
    ...(diagnostic.imported_at ? [`Imported: ${diagnostic.imported_at}`] : []),
    ...(diagnostic.last_plan_status != null ? [`Last plan status: ${diagnostic.last_plan_status}`] : []),
    ...(diagnostic.last_plan_attempt_at ? [`Last plan attempt: ${diagnostic.last_plan_attempt_at}`] : []),
    ...(diagnostic.last_plan_error ? [`Last plan error: ${diagnostic.last_plan_error}`] : []),
    ...(diagnostic.pr_open_no_report ? ["Open PR has not reported eval results yet."] : []),
    "Readiness:",
    ...(readiness && typeof readiness === "object"
      ? [
          `- Registered: ${formatReportedBoolean(readiness.registered)}`,
          `- Evaluation: ${readiness.evaluation_status ?? "none recorded"}`,
          `- Production eligible: ${formatReportedBoolean(readiness.production_eligible)}`,
          `- Observed serving: ${formatReportedBoolean(readiness.observed_serving)}`
        ]
      : ["- Not reported by the server."]),
    "Evaluation completion is not required for production eligibility.",
    "Observed serving is historical evidence of a successful runtime delivery, not a current health check."
  ]);
}

function formatReportedBoolean(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

/**
 * POST /v1/setup/sessions returns { ok, setup_session, setup_code, command, prompt }.
 * setup_code is a one-time secret: printed once here and never written to disk.
 */
export function renderSetupSessionCreate(body) {
  const session = body.setup_session ?? {};
  printLines([
    `Setup session ${session.id ?? "unknown"} for ${session.repo_full_name ?? "unknown repo"}`,
    `Status: ${session.status ?? "unknown"}`,
    ...(session.installation_id != null ? [`Installation: ${session.installation_id}`] : []),
    ...(session.setup_expires_at ? [`Setup code expires: ${session.setup_expires_at}`] : []),
    ...(session.read_expires_at ? [`Read access expires: ${session.read_expires_at}`] : [])
  ]);
  if (body.setup_code) {
    process.stdout.write("\nBenchRouter issued a setup code. It is shown once:\n");
    process.stdout.write(`- Setup code: ${body.setup_code}\n`);
    process.stdout.write("The CLI does not save it. If it is lost, create another setup session.\n");
  }
  if (body.command) {
    process.stdout.write("\nServer-authored command:\n");
    process.stdout.write(`${body.command}\n`);
  }
  if (body.prompt) {
    process.stdout.write("\nThe server also returned an agent prompt. Use --json to read it.\n");
  }
}

/** GET /v1/setup/sessions/:id returns { ok, setup_session: row }. */
export function renderSetupSessionShow(body) {
  const session = body.setup_session ?? {};
  printLines([
    `Setup session ${session.id ?? "unknown"}`,
    `Status: ${session.status ?? "unknown"}`,
    ...(session.repo_full_name ? [`Repository: ${session.repo_full_name}`] : []),
    ...(session.route_id ? [`Route: ${session.route_id}${session.route_name ? ` (${session.route_name})` : ""}`] : []),
    ...(session.original_model ? [`Incumbent model: ${session.original_model}`] : []),
    ...(session.installation_id != null ? [`Installation: ${session.installation_id}`] : []),
    ...(session.created_at ? [`Created: ${session.created_at}`] : []),
    ...(session.expires_at ? [`Expires: ${session.expires_at}`] : []),
    ...(session.used_at ? [`Used: ${session.used_at}`] : []),
    ...(session.packet_created_at ? [`Packet created: ${session.packet_created_at}`] : []),
    ...(session.imported_at ? [`Imported: ${session.imported_at}`] : [])
  ]);
}

/**
 * POST /v1/dashboard/setup-kit/upgrade-token returns
 * { ok, token, repo_full_name, route_id, expires_at }. The token is single-use.
 */
export function renderUpgradeTokenMint(body) {
  printLines([
    `Upgrade token for ${body.repo_full_name ?? "unknown repo"} / ${body.route_id ?? "unknown route"}`,
    ...(body.expires_at ? [`Expires: ${body.expires_at}`] : [])
  ]);
  process.stdout.write("\nBenchRouter issued a single-use upgrade token. It is shown once:\n");
  process.stdout.write(`- Upgrade token: ${body.token}\n`);
  process.stdout.write("The CLI does not save it. Pass it to `benchrouter upgrade --upgrade-token`.\n");
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

/** Route DTO: route_key, name, state, best_model, original_model, baseline_model, repo_full_name. */
export function renderRouteShow(route) {
  printLines([
    `${route.route_key}${route.name ? ` (${route.name})` : ""}`,
    `State: ${route.state ?? "unknown"}`,
    `Best: ${route.best_model ?? "unknown"}${route.best_model_evidenced === false ? " (seeded incumbent; no eval evidence)" : ""}`,
    `Incumbent: ${route.original_model ?? "unknown"}`,
    `Baseline: ${route.baseline_model ?? "none"}`,
    ...(route.repo_full_name ? [`Repository: ${route.repo_full_name}`] : []),
    ...(route.latest_eval ? [`Latest eval: ${route.latest_eval.model ?? "unknown"} ${route.latest_eval.status ?? "unknown"}`] : [])
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

export function renderEvalsList(body) {
  const history = Array.isArray(body.eval_history) ? body.eval_history : [];
  // EVAL-011 / ROUTE-005: one search-status line per context.
  for (const view of Array.isArray(body.view_evidence) ? body.view_evidence : []) {
    if (view && view.search_status) process.stdout.write(`${view.label}: ${view.search_status.summary}\n`);
  }
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

/** "2026-10-27 18:17Z". */
function utcMinute(iso) {
  return typeof iso === "string" && iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z` : "-";
}

function metric(value, format) {
  return typeof value === "number" && Number.isFinite(value) ? format(value) : "-";
}

/** ROUTE-005: the server's summary and next-step text, printed as they are, with spend and polling when the read has them. */
function searchLines(payload) {
  const status = payload.search_status;
  if (!status) return ["Search: none (archived route)"];
  const out = [`Search: ${status.summary}${payload.polling ? "; still running" : ""}`];
  if (payload.spend_usd !== undefined) out.push(`Eval spend: $${formatUsd(payload.spend_usd)}`);
  const next = Array.isArray(status.next) ? status.next : [];
  if (next.length > 0) {
    out.push("Next:");
    for (const step of next) out.push(`  ${step.at ? utcMinute(step.at) : "-"}  ${step.text}`);
  }
  return out;
}

/** EVAL-011 / ROUTE-005: `benchrouter evals status`. */
export function renderEvalsStatus(payload) {
  const status = payload.search_status;
  const out = [`${payload.route_key} · ${payload.label}`, ...searchLines(payload)];
  if (status.waiting) {
    out.push(`Waiting: ${status.waiting.reason}${status.waiting.until ? ` until ${utcMinute(status.waiting.until)}` : ""}`);
  }
  const set = status.result_set ?? {};
  const decided = set.decided_result_set_id && set.decided_result_set_id !== set.id ? `; latest decided ${set.decided_result_set_id}` : "";
  const stop = set.stop_reason ? `; search stopped: ${set.stop_reason}${set.held_models > 0 ? ` (${set.held_models} held)` : ""}` : "";
  out.push(`Result set: ${set.id ?? "none"}${decided}${stop}; ${set.measured_models ?? 0} measured, ${set.reused_models ?? 0} reused`);
  const models = Array.isArray(status.models) ? status.models : [];
  if (models.length > 0) {
    out.push("Models:");
    const width = Math.max(...models.map((model) => model.model.length));
    for (const model of models) {
      const shown = model.roles.filter((role) => role !== model.verdict);
      const roles = shown.length > 0 ? ` [${shown.join(", ")}]` : "";
      const verdict = model.verdict === "failed" && model.reason ? `failed: ${model.reason}` : model.verdict;
      const notes = [
        model.reused ? "reused" : null,
        model.breaker_open_until ? `breaker open until ${utcMinute(model.breaker_open_until)}` : null
      ].filter(Boolean);
      out.push(
        `  ${model.model.padEnd(width)}  score ${metric(model.score, (v) => v.toFixed(3))}  cost ${metric(model.cost_usd, (v) => `$${v.toFixed(4)}`)}` +
        `  p95 ${metric(model.p95_ms, (v) => `${Math.round(v)}ms`)}  ${verdict}${roles}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`
      );
    }
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

/** EVAL-016: `benchrouter evals results`. Lists the measured models; the JSON output has every model. */
export function renderEvalsResults(body) {
  const out = [`${body.route_key} · ${body.label}`, ...searchLines(body)];
  if (body.current_version && body.version !== body.current_version) {
    out.push(`These results measured ${body.version ?? "no version"}; version ${body.current_version} is being measured.`);
  }
  out.push(`Serving: ${body.serving_model ?? "none"}; incumbent ${body.incumbent ?? "none"}`);
  out.push(`Best available: ${body.best_available ?? "none yet"}`);
  const chain = Array.isArray(body.chain) ? body.chain : [];
  if (chain.length > 0) out.push(`Chain: ${chain.join(" > ")}`);
  const models = Array.isArray(body.models) ? body.models : [];
  const measured = models.filter((model) => model.pass_rate !== null);
  if (measured.length > 0) {
    out.push("Models:");
    const width = Math.max(...measured.map((model) => model.model.length));
    for (const model of measured) {
      const notes = [
        model.role !== model.outcome ? model.role : null,
        model.measured_version && model.measured_version !== body.version ? `measured ${model.measured_version}` : null
      ].filter(Boolean);
      out.push(
        `  ${model.model.padEnd(width)}  pass ${model.pass_count ?? "-"}/${model.cases ?? "-"} (${metric(model.pass_rate, (v) => v.toFixed(3))})` +
        `  cost ${metric(model.run_cost_usd, (v) => `$${v.toFixed(4)}`)}  p95 ${metric(model.p95_latency_ms, (v) => `${Math.round(v)}ms`)}` +
        `  ${model.outcome ?? "-"}${model.eligible_rank ? ` #${model.eligible_rank}` : ""}${notes.length > 0 ? ` [${notes.join(", ")}]` : ""}`
      );
    }
  }
  if (models.length > measured.length) out.push(`${models.length - measured.length} model(s) not measured.`);
  const untested = Array.isArray(body.not_tested_yet) ? body.not_tested_yet : [];
  if (untested.length > 0) {
    out.push("Not tested yet:");
    for (const entry of untested) out.push(`  ${entry.model}: ${entry.reason}`);
  }
  printLines(out);
}

/** MCP-001: `benchrouter evals model`, the route model page: result, latest run and its failing cases. */
export function renderEvalsModel(body) {
  const detail = body.detail ?? {};
  const result = detail.result;
  const out = [
    `${body.route_key} / ${body.model} · ${body.label}`,
    `Context: ${detail.evidence_view?.label ?? "Production"}; role ${detail.role ?? "none"}`,
    result
      ? `Result: pass ${result.pass_count ?? "-"}/${result.cases ?? "-"} (${metric(result.pass_rate, (v) => v.toFixed(3))})` +
        `  cost ${metric(result.actual_cost_usd, (v) => `$${v.toFixed(4)}`)}  p95 ${metric(result.p95_latency_ms, (v) => `${Math.round(v)}ms`)}`
      : "Result: not measured"
  ];
  const latest = detail.latest_eval;
  if (!latest) {
    out.push("No eval run of this model in this context.");
    printLines(out);
    return;
  }
  const cases = Array.isArray(latest.results) ? latest.results : [];
  out.push(`Latest run: ${latest.model_run_id ?? latest.id} ${latest.status ?? "unknown"}, ${utcMinute(latest.decided_at ?? latest.created_at)}; ${cases.length} case(s)`);
  if (latest.failure) out.push(`Run failure: ${latest.failure.message ?? latest.failure.code ?? JSON.stringify(latest.failure)}`);
  const failing = cases.filter((row) => row.outcome !== "pass");
  if (failing.length > 0) {
    out.push(`Failing cases: ${failing.length}`);
    const width = Math.max(...failing.map((row) => row.case_id.length));
    for (const row of failing) {
      const notes = [row.output_archived ? "output archived" : null, row.output_cut_off ? "output cut off" : null].filter(Boolean);
      out.push(
        `  ${row.case_id.padEnd(width)}  ${(row.critical ? "critical" : "").padEnd(8)}  ${row.outcome}${row.result?.error ? `: ${row.result.error}` : ""}` +
        `${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`
      );
    }
  }
  const earlier = (Array.isArray(detail.eval_history) ? detail.eval_history.length : 0) - 1;
  if (earlier > 0) out.push(`Earlier runs: ${earlier} (--json lists them)`);
  if (cases.length > 0) {
    out.push(`Full output of a case: benchrouter evals case-output ${body.route_key} --run ${latest.model_run_id} --case <case-id>`);
  }
  printLines(out);
}

/** MCP-001: `benchrouter evals case-output` prints the model's output as it is. */
export function renderCaseOutput(body) {
  const text = String(body.raw_output ?? "");
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** MCP-001: `benchrouter evals overview`, every route of the account and the open drafts. */
export function renderEvalsOverview(body) {
  const out = [`Account: ${body.account?.name ?? "?"} (${body.account?.id ?? "?"})${body.account?.guest ? ", guest" : ""}`];
  const routes = Array.isArray(body.routes) ? body.routes : [];
  out.push(routes.length > 0 ? "Routes:" : "No routes.");
  const width = Math.max(0, ...routes.map((route) => route.route_key.length));
  for (const route of routes) {
    out.push(
      `  ${route.route_key.padEnd(width)}  eval ${route.eval_state}  serving ${route.serving_model}${route.serving_model_evidenced === false ? " (no eval evidence)" : ""}` +
      `  saved $${formatUsd(route.saved_usd)}  (${route.source?.label ?? route.source?.kind ?? "?"})`
    );
  }
  const drafts = Array.isArray(body.open_drafts) ? body.open_drafts : [];
  if (drafts.length > 0) {
    out.push("Open drafts:");
    for (const draft of drafts) {
      out.push(`  ${draft.draft_id}  ${draft.name}  ${draft.route_key ?? "new route"}  created ${utcMinute(draft.created_at)}  card ${draft.card_hash}`);
    }
  }
  const merge = body.chatgpt_merge;
  if (merge) {
    out.push(`ChatGPT routes: ${merge.pending} still being added${merge.failed.length > 0 ? `; could not add ${merge.failed.map((row) => `${row.name} (${row.reason})`).join(", ")}` : ""}`);
  }
  printLines(out);
}

/** EVAL-016: the card the person approves, as the server wrote it. */
export function renderEvalsDraft(body) {
  printLines([
    body.card_text,
    ...(body.replayed ? ["This request id already made this draft."] : []),
    `Approve with: benchrouter evals approve ${body.draft_id} --card ${body.card_hash}`
  ]);
}

export function renderEvalsApprove(body) {
  printLines([
    `Approved version ${body.version_id} for ${body.route_key}; first search result set ${body.result_set_id}.${body.replayed ? " (already approved)" : ""}`,
    `Follow it with: benchrouter evals status ${body.route_key}`
  ]);
}

export function renderEvalsRun(body) {
  process.stdout.write(
    `Queued result set ${body.result_set_id} for ${body.route_key} / ${body.model} (${body.status})\n`
  );
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

/** ROUTE-004: the model a route serves and its generations. */
export function renderRoutePin(body) {
  const history = Array.isArray(body.history) ? body.history : [];
  printLines([
    `${body.route_key} serves ${body.model}${body.model_available === false ? " (unavailable: re-pin it)" : ""} (${body.route_id})`,
    `Re-pin: ${body.repin_blocked_reason ? `blocked (${body.repin_blocked_reason})` : "allowed"}`,
    ...(history.length > 0 ? ["History:"] : []),
    ...history.map((entry) => `  ${utcMinute(entry.pinned_at)} to ${entry.ended_at ? utcMinute(entry.ended_at) : "now"}  ${entry.model}`)
  ]);
}

export function renderRouteCreated(body) {
  printLines([
    `Created ${body.route_key} serving ${body.model} (${body.route_id})${body.product_created ? "; created its product" : ""}.`,
    `Point the app at it with a key: benchrouter keys create --product-id ${body.product?.productId ?? "<product-id>"}`
  ]);
}

export function renderRouteRepinned(body) {
  printLines([`${body.route_key} now serves ${body.model} (was ${body.previous_model}); generation ${body.route_id}.`]);
}

/** ROUTE-006: `benchrouter routes activity`, the route's background eval activity. */
export function renderRouteActivity(body) {
  const a = body.eval_activity;
  if (!a) {
    printLines([`${body.route_key}: no eval activity.`]);
    return;
  }
  const out = [
    `${body.route_key}: ${a.state} (${a.trigger ?? "no trigger"}); coverage ${a.coverage_status ?? "-"}`,
    `Models: ${a.total_models} total; ${a.terminal_models} done (${a.uploaded_models} measured, ${a.reused_models} reused), ` +
      `${a.failed_models} failed, ${a.running_models} running, ${a.queued_models} queued, ${a.pending_models} pending, ${a.skipped_models} skipped`,
    `Result set: ${a.result_set_id ?? "none"}; requested ${utcMinute(a.requested_at)}, started ${utcMinute(a.started_at)}, completed ${utcMinute(a.completed_at)}`
  ];
  if (a.github_run_url) out.push(`GitHub run: ${a.github_run_url}`);
  if (a.failure_display) {
    out.push(`${a.failure_display.title}${a.failure_display.runs ? ` (${a.failure_display.runs})` : ""}: ${a.failure_display.summary}`);
  }
  const recovery = a.failure_summary?.recovery;
  if (recovery && recovery.state !== "none") {
    out.push(`Recovery: ${recovery.state}, attempt ${recovery.attempt}${recovery.next_at ? `, next ${utcMinute(recovery.next_at)}` : ""}`);
  }
  printLines(out);
}

/** RUN-001 R5: `benchrouter routes startup-failures`. */
export function renderStartupFailures(body) {
  const failures = Array.isArray(body.startup_failures) ? body.startup_failures : [];
  if (failures.length === 0) {
    printLines([`${body.route_key}: no blocked runner startup.`]);
    return;
  }
  const out = [];
  for (const failure of failures) {
    out.push(
      `${failure.context_key} (${failure.purpose}${failure.pr_number ? `, PR #${failure.pr_number}` : ""}): blocked ${utcMinute(failure.blocked_at)}; ` +
      `automatic retry ${utcMinute(failure.retry_at)}${failure.can_unblock ? "; benchrouter blocks unblock --route " + body.route_key + " clears it" : ""}`
    );
    out.push(`  ${failure.message}`);
    const details = failure.details;
    if (!details) {
      out.push("  No longer current: read the route again.");
      continue;
    }
    if (details.github_run_url) out.push(`  GitHub run: ${details.github_run_url}`);
    if (details.unavailable) out.push("  GitHub's annotations are not readable now.");
    for (const line of details.annotations ?? []) out.push(`  | ${line}`);
    if (details.truncated) out.push("  (annotations cut off)");
  }
  printLines(out);
}

/** SETUP-001: a setup agent's replacement model and the baselines the person may approve. */
export function renderSetupApproval(body) {
  const a = body.approval ?? {};
  const alternatives = Array.isArray(a.alternatives) ? a.alternatives : [];
  const width = Math.max(0, ...alternatives.map((alt) => alt.canonical_id.length));
  printLines([
    `${a.repo_full_name} ${a.route_key}: ${a.status}${a.status === "pending" ? `, expires ${utcMinute(a.approval_expires_at)}` : ""}`,
    `Observed model: ${a.observed_model}${a.provider_ref && a.provider_ref !== a.observed_model ? ` (${a.provider_ref})` : ""}; catalog model ${a.canonical_original_model}`,
    `Recommended baseline: ${a.recommended_baseline_model}`,
    ...(a.selected_baseline_model ? [`Approved baseline: ${a.selected_baseline_model}`] : []),
    ...(alternatives.length > 0 ? ["Alternatives:"] : []),
    ...alternatives.map((alt) =>
      `  ${alt.canonical_id.padEnd(width)}  ${alt.relation_type}  ${alt.tier}` +
      `${typeof alt.price_multiple === "number" ? `  ${alt.price_multiple.toFixed(2)}x price` : ""}  ${alt.reason}`),
    ...(a.status === "pending" ? [`Approve with: benchrouter setup approve ${a.context_id} --model <model-id>`] : [])
  ]);
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

/** GET /v1/admin/providers returns { object: "list", data: [...] }. Never secrets. */
export function renderProvidersList(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  if (data.length === 0) {
    process.stdout.write("No providers.\n");
    return;
  }
  for (const provider of data) {
    const disabled = provider.disabled_at ? `; disabled ${provider.disabled_at}` : "";
    process.stdout.write(
      `- ${provider.id}: key ${provider.key_set ? "yes" : "no"}; routable ${provider.routable ? "yes" : "no"}; ` +
        `smoke ${provider.smoke_status ?? "unverified"}${disabled}\n`
    );
  }
}

export function renderProposalDecision(proposalId, body, action) {
  process.stdout.write(
    `Proposal ${proposalId}: ${body.resolution ?? action}${body.already_resolved ? " (already resolved)" : ""}\n`
  );
}

/**
 * PUT .../key returns
 * { provider, action, fingerprint, smoke_status, disabled_at, routable, effective_base_url }.
 * The fingerprint is derived from the secret, so it stays out of human output.
 */
export function renderProviderKeySet(body, provider) {
  printLines([
    `Stored provider key for ${body.provider ?? provider} (${body.action ?? "saved"}).`,
    `Smoke status: ${body.smoke_status ?? "unverified"}; routable ${body.routable ? "yes" : "no"}`,
    ...(body.effective_base_url ? [`Effective base URL: ${body.effective_base_url}`] : []),
    "Run `admin providers smoke` to make it routable."
  ]);
}

/** DELETE .../key returns { provider, deleted }. */
export function renderProviderKeyDelete(body, provider) {
  process.stdout.write(`Deleted provider key for ${body.provider ?? provider}.\n`);
}

/** POST|DELETE .../disable returns { provider, disabled_at, routable? }. */
export function renderProviderDisableState(body, provider, action) {
  if (action === "enable") {
    process.stdout.write(`Cleared the disable override for ${body.provider ?? provider}.\n`);
    return;
  }
  process.stdout.write(
    `Disabled ${body.provider ?? provider} at ${body.disabled_at ?? "now"}; routable ${body.routable ? "yes" : "no"}.\n`
  );
}

/** POST .../smoke returns { status, latency_ms, reason?, http_status? }. */
export function renderProviderSmoke(body, provider) {
  const latency = body.latency_ms == null ? "" : `; ${body.latency_ms}ms`;
  const reason = body.reason ? `; ${body.reason}` : "";
  const httpStatus = body.http_status == null ? "" : `; HTTP ${body.http_status}`;
  process.stdout.write(`Smoke ${body.status ?? "unknown"} for ${provider}${latency}${reason}${httpStatus}\n`);
}

/** GET /v1/admin/catalog returns { object: "list", data: AdminCatalogModelView[] }. */
export function renderAdminCatalogShow(body) {
  const models = Array.isArray(body?.data) ? body.data : [];
  process.stdout.write(`Catalog models: ${models.length}\n`);
  for (const model of models) {
    const targets = Array.isArray(model.targets) ? model.targets : [];
    process.stdout.write(
      `- ${model.canonical_id}: ${model.status ?? "unknown"}; candidate ${model.candidate_standing ?? "?"}; ` +
        `serving ${model.serving_standing ?? "?"}; targets ${targets.length}\n`
    );
  }
}

/** GET /v1/admin/catalog/activity returns { ok: true, activity: [...] }. */
export function renderAdminCatalogActivity(body) {
  const rows = Array.isArray(body?.activity) ? body.activity : [];
  if (rows.length === 0) {
    process.stdout.write("No catalog activity.\n");
    return;
  }
  process.stdout.write(`Catalog activity entries: ${rows.length}\n`);
  for (const row of rows) {
    const publication = row.publication_status ? `; publication ${row.publication_status}` : "";
    process.stdout.write(
      `- ${row.occurred_at}: ${row.action} ${row.subject_type}/${row.subject_key}` +
        ` (${row.canonical_id ?? "-"}); source ${row.source ?? "-"}${publication}\n`
    );
  }
}

/** GET /v1/admin/catalog/observations returns { object: "list", data: [...] }. */
export function renderAdminObservationsList(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  if (rows.length === 0) {
    process.stdout.write("No catalog observations.\n");
    return;
  }
  process.stdout.write(`Observations: ${rows.length}\n`);
  for (const row of rows) {
    process.stdout.write(
      `- ${row.id} ${row.observed_at}: ${row.source}${row.source_version ? `@${row.source_version}` : ""}` +
        ` ${row.subject_kind}; canonical ${row.canonical_id ?? "-"}; action ${row.derived_action ?? "none"}` +
        `${row.match_confidence ? `; match ${row.match_confidence}` : ""}\n`
    );
  }
}

/** POST /v1/admin/catalog/observations returns { ok: true, observation }. */
export function renderAdminObservationCreate(body) {
  const observation = body.observation ?? {};
  printLines([
    `Recorded observation ${observation.id ?? "unknown"}.`,
    `Source: ${observation.source ?? "unknown"}${observation.source_version ? `@${observation.source_version}` : ""}`,
    `Subject: ${observation.subject_kind ?? "unknown"}; canonical ${observation.canonical_id ?? "none"}`,
    `Derived action: ${observation.derived_action ?? "none"}`,
    ...(observation.proposal_id ? [`Proposal: ${observation.proposal_id}`] : [])
  ]);
}

/** GET /v1/admin/catalog/mappings returns { ok: true, mappings: [...] }. */
export function renderAdminMappingsList(body) {
  const mappings = Array.isArray(body?.mappings) ? body.mappings : [];
  if (mappings.length === 0) {
    process.stdout.write("No mapping work waiting for a decision.\n");
    return;
  }
  process.stdout.write(`Mappings awaiting a decision: ${mappings.length}\n`);
  for (const mapping of mappings) {
    const candidates = Array.isArray(mapping.candidate_ids) ? mapping.candidate_ids : [];
    process.stdout.write(
      `- ${mapping.source}:${mapping.raw_source_id} (${mapping.observed_at})` +
        `${mapping.match_confidence ? `; match ${mapping.match_confidence}` : ""}` +
        `${candidates.length > 0 ? `; candidates ${candidates.join(", ")}` : ""}` +
        `${mapping.reason ? `; ${mapping.reason}` : ""}\n`
    );
  }
}

/** POST resolve/ignore returns { ok, source, raw_source_id, decision, canonical_id }. */
export function renderAdminMappingDecision(body, { source, rawSourceId }) {
  const canonical = body.canonical_id ? ` -> ${body.canonical_id}` : "";
  process.stdout.write(
    `Mapping ${body.source ?? source}:${body.raw_source_id ?? rawSourceId} ${body.decision ?? "decided"}${canonical}.\n`
  );
}

/** GET /v1/admin/model-id-maps returns { object: "list", data: [{ provider, pairs }] }. */
export function renderAdminModelIdMaps(body) {
  const maps = Array.isArray(body?.data) ? body.data : [];
  if (maps.length === 0) {
    process.stdout.write("No provider model-id maps.\n");
    return;
  }
  for (const entry of maps) {
    const pairs = Array.isArray(entry.pairs) ? entry.pairs : [];
    process.stdout.write(`${entry.provider}: ${pairs.length} pair${pairs.length === 1 ? "" : "s"}\n`);
    for (const pair of pairs) {
      process.stdout.write(`  ${pair.canonical_id} -> ${pair.provider_model_id}\n`);
    }
  }
}

/** POST /v1/admin/catalog/rebuild-snapshot. */
export function renderAdminCatalogRebuild(body) {
  process.stdout.write(
    `Catalog snapshot rebuilt: models=${body.models ?? "?"} targets=${body.targets ?? "?"} version=${body.version ?? "?"}\n`
  );
}

/**
 * POST /v1/admin/catalog/refresh-report returns a CatalogRefreshReport.
 * execution is "report_only" and writes_performed is false.
 */
export function renderAdminCatalogRefreshReport(body) {
  const health = body.source_health ?? {};
  const current = body.current ?? {};
  const discovery = body.discovery ?? {};
  const proposed = body.proposed ?? {};
  printLines([
    `Catalog refresh report ${body.run_id ?? "unknown"} (${body.generated_at ?? "unknown time"})`,
    `Execution: ${body.execution ?? "unknown"}; writes performed: ${body.writes_performed === false ? "no" : "yes"}`,
    `Automation mode: ${body.automation_mode ?? "unknown"}`,
    `OpenRouter: ${health.openrouter?.status ?? "unknown"} (${health.openrouter?.count ?? "?"})`,
    `Artificial Analysis: ${health.artificial_analysis?.status ?? "unknown"} (${health.artificial_analysis?.count ?? "?"})`,
    `Current: ${current.registry_models ?? "?"} models; ${current.routing_targets ?? "?"} targets; ` +
      `${current.pending_proposals ?? "?"} pending proposals`,
    `Discovery: ${discovery.desired_models ?? "?"} desired models`,
    `Expected eval requests: ${body.expected_eval_requests?.count ?? "?"}`
  ]);
  for (const [key, rows] of Object.entries(proposed)) {
    if (Array.isArray(rows) && rows.length > 0) {
      process.stdout.write(`- proposed ${key}: ${rows.length}\n`);
    }
  }
}

/**
 * POST /v1/admin/catalog/drain-outbox returns one bounded drain result. Counts
 * describe completed work and the durable backlog that remains for later runs.
 */
export function renderAdminCatalogDrainOutbox(body) {
  printLines([
    `Catalog work selected: ${body.selected ?? "?"} across ${body.batches ?? "?"} batch(es)`,
    `Published: ${body.published ?? "?"}; scheduled: ${body.scheduled ?? "?"}; no-op: ${body.noop ?? "?"}`,
    `Deferred: ${body.deferred ?? "?"}; failed: ${body.failed ?? "?"}`,
    `Budget exhausted: ${body.budget_exhausted === true ? "yes" : "no"}`,
    `Remaining backlog: ${body.remaining_outbox ?? "?"} outbox event(s); ` +
      `${body.remaining_eval_requests ?? "?"} eval request(s)`
  ]);
}

/**
 * POST .../refresh-preview returns
 * { ok, outcome: { outcome, reason?, route_key, result_set_id }, plan: { result_set_id, models } }.
 */
export function renderEvalsRefreshPreview(body) {
  const outcome = body.outcome ?? {};
  const models = Array.isArray(body.plan?.models) ? body.plan.models : [];
  printLines([
    `${outcome.route_key ?? "unknown route"}: preview ${outcome.outcome ?? "unknown"}` +
      `${outcome.reason ? ` (${outcome.reason})` : ""}`,
    `Result set: ${outcome.result_set_id ?? body.plan?.result_set_id ?? "unknown"}`,
    `Model runs planned: ${models.length}`
  ]);
}

// RUN-001 R5: one line per block, then one line per repository for Unblock.
function blockScope(block) {
  return block?.route_key ? `route ${block.route_key}` : block?.context_key ? `context ${block.context_key}` : "repository";
}

export function renderBlocksList(repos) {
  if (!Array.isArray(repos) || repos.length === 0) {
    process.stdout.write("No repositories.\n");
    return;
  }
  for (const repo of repos) {
    const blocks = Array.isArray(repo.blocks) ? repo.blocks : [];
    if (blocks.length === 0) {
      process.stdout.write(`${repo.repo_full_name}: nothing blocked\n`);
      continue;
    }
    for (const block of blocks) {
      const when = block.until ? `until ${block.until}` : block.since ? `since ${block.since}` : "";
      const mode = block.clearable ? "unblock clears it" : block.recheckable ? "unblock re-checks it" : "external";
      const fields = [repo.repo_full_name, block.kind, blockScope(block), when, `(${mode})`, block.reason ?? "", `How to clear: ${block.how_to_clear ?? ""}`];
      process.stdout.write(`${fields.filter((field) => field.length > 0).join("  ")}\n`);
    }
  }
}

export function renderUnblock(repos) {
  if (!Array.isArray(repos) || repos.length === 0) {
    process.stdout.write("No repository you own matched.\n");
    return;
  }
  for (const repo of repos) {
    const cleared = Array.isArray(repo.cleared) ? repo.cleared : [];
    const still = Array.isArray(repo.still_blocked) ? repo.still_blocked : [];
    const woke = Array.isArray(repo.woke) ? repo.woke : [];
    const refresh = Array.isArray(repo.refresh_contexts) ? repo.refresh_contexts : [];
    const failed = Array.isArray(repo.failed_while_blocked) ? repo.failed_while_blocked : [];
    if (repo.nothing_blocked && cleared.length === 0) {
      process.stdout.write(still.length === 0
        ? `${repo.repo_full_name}: nothing blocked\n`
        : `${repo.repo_full_name}: nothing to clear; still blocked: ${still.map((block) => `${block.kind} (${blockScope(block)})`).join(", ")}\n`);
      continue;
    }
    const parts = [
      cleared.length === 0 ? "cleared nothing" : `cleared ${cleared.map((block) => `${block.kind} (${blockScope(block)}${block.via === "recheck" ? ", GitHub re-check" : ""})`).join(", ")}`,
      woke.length === 0 ? "woke no queued evaluation" : `woke ${woke.map((set) => set.result_set_id).join(", ")}`
    ];
    if (refresh.length > 0) parts.push(`snapshot refresh restarted for ${refresh.join(", ")}`);
    if (still.length > 0) parts.push(`still blocked: ${still.map((block) => `${block.kind} (${blockScope(block)}): ${block.how_to_clear}`).join("; ")}`);
    if (failed.length > 0) parts.push(`failed while blocked: ${failed.map((set) => `${set.result_set_id} (benchrouter evals retry --result-set ${set.result_set_id})`).join(", ")}`);
    process.stdout.write(`${repo.repo_full_name}: ${parts.join("; ")}\n`);
  }
}

export function renderEvalsRetry(body) {
  const source = body.source_result_set_id ? ` (from ${body.source_result_set_id})` : "";
  const lines = {
    created: `${body.route_key}: created ${body.result_set_id} rerunning ${(body.models ?? []).join(", ")}${source}`,
    woken: `${body.route_key}: woke ${body.result_set_id} for the dispatcher`,
    finalizing: `${body.route_key}: ${body.source_result_set_id} is finishing; nothing to retry`,
    nothing_to_retry: `${body.route_key}: nothing to retry${source}`
  };
  process.stdout.write(`${lines[body.outcome] ?? `${body.route_key}: unexpected retry answer`}\n`);
}

export function renderEvalsFullRefresh(body) {
  process.stdout.write(`Queued full refresh ${body.result_set_id} for ${body.route_key} (${body.status}).\n`);
}

export function renderApiKeyState(body, keyId, enabled) {
  const key = body.api_key ?? {};
  process.stdout.write(`${enabled ? "Enabled" : "Disabled"} runtime API key ${key.id ?? keyId}${key.name ? ` (${key.name})` : ""}.\n`);
}

export function renderAutoReloadSetup(body) {
  printLines([
    `Checkout URL:\n${body.checkout_url}`,
    "Open that URL in a browser to save the card. Automatic reload turns on after Stripe confirms it."
  ]);
}

export function renderAutoReloadDisable(body) {
  process.stdout.write(`Automatic reload is ${body.auto_reload?.enabled ? "still on" : "off"} (${body.auto_reload?.state ?? "unknown"}).\n`);
}
