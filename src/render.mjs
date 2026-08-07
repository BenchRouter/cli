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
 * GET /v1/setup/diagnostic returns { ok, diagnostic: setup_sessions row }.
 * Selected columns: route_id, status, packet_created_at, imported_at,
 * last_plan_error, last_plan_attempt_at, last_plan_status, plus pr_open_no_report.
 */
export function renderSetupStatus(body) {
  const diagnostic = body.diagnostic ?? body;
  printLines([
    `Status: ${diagnostic.status ?? "unknown"}`,
    ...(diagnostic.route_id ? [`Route: ${diagnostic.route_id}`] : []),
    ...(diagnostic.packet_created_at ? [`Packet created: ${diagnostic.packet_created_at}`] : []),
    ...(diagnostic.imported_at ? [`Imported: ${diagnostic.imported_at}`] : []),
    ...(diagnostic.last_plan_status != null ? [`Last plan status: ${diagnostic.last_plan_status}`] : []),
    ...(diagnostic.last_plan_attempt_at ? [`Last plan attempt: ${diagnostic.last_plan_attempt_at}`] : []),
    ...(diagnostic.last_plan_error ? [`Last plan error: ${diagnostic.last_plan_error}`] : []),
    ...(diagnostic.pr_open_no_report ? ["Open PR has not reported eval results yet."] : [])
  ]);
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
