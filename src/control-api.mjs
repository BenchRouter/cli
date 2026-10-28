import { encodePathSegment, encodeRouteKey } from "./http.mjs";

/**
 * Every entry below is a pure request spec: { method, path, label, body? }.
 * Nothing here performs I/O, so exact methods, paths, and bodies stay testable
 * without an HTTP boundary.
 *
 * Customer routes authenticate a Bearer `br_ctrl_` account control token
 * (server auth mode `github_or_control`), except `accountSelf`, which is
 * control-token only (`account_control_token`).
 */
/** Public reads: no credential (the website's status and frontier pages). */
export const publicPaths = {
  /** GET /v1/status — service status, uptime by component, incidents. */
  status: () => ({ method: "GET", path: "/v1/status", label: "public status" }),
  /** GET /v1/frontier — the public Pareto frontier of catalog models. */
  frontier: () => ({ method: "GET", path: "/v1/frontier", label: "public frontier" })
};

export const customerPaths = {
  /** GET /v1/account/control/me */
  accountSelf: () => ({ method: "GET", path: "/v1/account/control/me", label: "account show" }),

  /** GET /v1/dashboard/account — the website's account page; billing, auto-reload and keys only for an owner (MCP-001, BILL-001). */
  dashboardAccount: () => ({ method: "GET", path: "/v1/dashboard/account", label: "account show" }),

  /** GET /v1/dashboard/summary — billing, api_keys, and routes all live here. */
  dashboardSummary: (label = "dashboard summary") => ({
    method: "GET",
    path: "/v1/dashboard/summary",
    label
  }),

  /** POST /v1/billing/top-up-checkout — body { amount_usd } */
  /**
   * GET /v1/billing/activity[?from=&to=&view=payments&cursor=] — the ledger, newest first; with
   * section=summary, the period's opening and closing balance and spend by route (BILL-001). Owner only.
   */
  billingActivity: ({ from, to, payments, cursor, summary }, label) => {
    const query = new URLSearchParams();
    if (from) query.set("from", from);
    if (to) query.set("to", to);
    if (payments) query.set("view", "payments");
    if (cursor) query.set("cursor", cursor);
    if (summary) query.set("section", "summary");
    const suffix = query.toString();
    return { method: "GET", path: `/v1/billing/activity${suffix ? `?${suffix}` : ""}`, label };
  },

  billingTopUpCheckout: (amountUsd) => ({
    method: "POST",
    path: "/v1/billing/top-up-checkout",
    label: "billing top-up",
    body: { amount_usd: amountUsd }
  }),

  /** POST /v1/dashboard/api-keys — body { name | names, product_id } */
  apiKeyCreate: ({ name, names, productId }) => {
    const body = { product_id: productId };
    if (Array.isArray(names) && names.length > 0) body.names = names;
    else body.name = name;
    return { method: "POST", path: "/v1/dashboard/api-keys", label: "keys create", body };
  },

  /** POST /v1/dashboard/api-keys/:keyId/revoke — no body; returns non-secret key metadata. */
  apiKeyRevoke: (keyId) => ({
    method: "POST",
    path: `/v1/dashboard/api-keys/${encodePathSegment(keyId)}/revoke`,
    label: "keys revoke"
  }),

  /** GET /v1/setup/repos */
  setupRepos: () => ({ method: "GET", path: "/v1/setup/repos", label: "repos list" }),

  /** GET /v1/setup/diagnostic?repo=owner/repo */
  setupDiagnostic: (repoFullName) => ({
    method: "GET",
    path: `/v1/setup/diagnostic?repo=${encodePathSegment(repoFullName)}`,
    label: "setup status"
  }),

  /**
   * POST /v1/setup/sessions — body { repository_id, repo_full_name, installation_id, intent }.
   * installation_id is a number on the wire. intent is "initial" unless "new_route".
   * The response carries a one-time setup code.
   */
  setupSessionCreate: ({ repositoryId, repoFullName, installationId, intent }) => ({
    method: "POST",
    path: "/v1/setup/sessions",
    label: "setup create",
    body: {
      repository_id: repositoryId,
      repo_full_name: repoFullName,
      installation_id: installationId,
      intent
    }
  }),

  /** GET /v1/setup/sessions/:sessionId */
  setupSessionGet: (sessionId) => ({
    method: "GET",
    path: `/v1/setup/sessions/${encodePathSegment(sessionId)}`,
    label: "setup session show"
  }),

  /**
   * POST /v1/dashboard/setup-kit/upgrade-token — body { repo_full_name, route_id }.
   * The response carries a single-use br_upgrade_ token.
   */
  setupKitUpgradeToken: (repoFullName, routeId) => ({
    method: "POST",
    path: "/v1/dashboard/setup-kit/upgrade-token",
    label: "setup upgrade-token",
    body: { repo_full_name: repoFullName, route_id: routeId }
  }),

  /** GET /v1/dashboard/routes/:routeKey/catalog */
  routeCatalog: (routeKey, label = "routes catalog") => ({
    method: "GET",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/catalog`,
    label
  }),

  /** POST /v1/control/routes — body { name, model, route_slug?, product: { name, slug? } } or { ..., product_id } (SERVE-001). */
  routeCreate: (body) => ({ method: "POST", path: "/v1/control/routes", label: "routes create", body }),

  /** GET /v1/control/routes/:routeKey/pin — the model a route serves, its generations, and whether it can be re-pinned (ROUTE-004). */
  routePin: (routeKey) => ({ method: "GET", path: `/v1/control/routes/${encodePathSegment(routeKey)}/pin`, label: "routes pin" }),

  /** POST /v1/control/routes/:routeKey/pin — body { model, expected_route_id }; a stale id answers 409 route_changed (ROUTE-004). */
  routeRepin: (routeKey, model, expectedRouteId) => ({
    method: "POST",
    path: `/v1/control/routes/${encodePathSegment(routeKey)}/pin`,
    label: "routes pin",
    body: { model, expected_route_id: expectedRouteId }
  }),

  /** GET /v1/dashboard/routes/:routeKey/activity — the route's background eval activity (ROUTE-006). */
  routeActivity: (routeKey) => ({
    method: "GET",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/activity`,
    label: "routes activity"
  }),

  /** GET /v1/dashboard/routes/:routeKey/startup-details?blocked_event_id= — GitHub's annotations of one blocked runner startup (RUN-001 R5). */
  routeStartupDetails: (routeKey, blockedEventId) => ({
    method: "GET",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/startup-details?${new URLSearchParams({ blocked_event_id: blockedEventId })}`,
    label: "routes startup-failures"
  }),

  /** POST /v1/dashboard/routes/:routeKey/archive */
  routeArchive: (routeKey) => ({
    method: "POST",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/archive`,
    label: "routes archive"
  }),

  /** POST /v1/dashboard/archived-routes/:routeId/unarchive */
  routeUnarchive: (routeId) => ({
    method: "POST",
    path: `/v1/dashboard/archived-routes/${encodePathSegment(routeId)}/unarchive`,
    label: "routes unarchive"
  }),

  /** POST /v1/dashboard/routes/:routeKey/result-sets — body { model } */
  routeResultSetCreate: (routeKey, model) => ({
    method: "POST",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/result-sets`,
    label: "evals run",
    body: { model }
  }),

  /**
   * POST /v1/dashboard/routes/:routeKey/result-sets/:resultSetId/refresh-preview
   * Body is optional; { model } narrows the refresh to one model.
   */
  routeResultSetRefreshPreview: (routeKey, resultSetId, model) => ({
    method: "POST",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/result-sets/${encodePathSegment(resultSetId)}/refresh-preview`,
    label: "evals refresh-preview",
    body: model ? { model } : {}
  }),

  /** POST /v1/dashboard/routes/:routeKey/result-sets — body { full_refresh: true }: every model, fresh. */
  routeFullRefresh: (routeKey) => ({
    method: "POST",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/result-sets`,
    label: "evals run --full-refresh",
    body: { full_refresh: true }
  }),

  /**
   * POST /v1/dashboard/routes/:routeKey/result-sets — body { model, harness_retry }.
   * EVAL-015: one owner probe of a harness-blocked route, bound to the exact block identity.
   */
  routeHarnessRetry: (routeKey, model, block) => ({
    method: "POST",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/result-sets`,
    label: "evals harness-retry",
    body: { model, harness_retry: { generation: block.generation ?? null, blocked_at: block.blocked_at } }
  }),

  /** GET /v1/dashboard/blocks[?repo=owner/repo][&cursor=] — RUN-001 R5 blocks of visible repositories. */
  blocksList: (repoFullName, cursor) => {
    const query = new URLSearchParams();
    if (repoFullName) query.set("repo", repoFullName);
    if (cursor) query.set("cursor", cursor);
    const suffix = query.toString();
    return { method: "GET", path: `/v1/dashboard/blocks${suffix ? `?${suffix}` : ""}`, label: "blocks list" };
  },

  /**
   * POST /v1/dashboard/blocks/unblock — body { repo_full_name, route_key? } or { all_blocked: true, cursor? }.
   * RUN-001 R5: clears blocks only; it creates no evaluation.
   */
  blocksUnblock: ({ repoFullName, routeKey, allBlocked, cursor }) => {
    const body = allBlocked ? { all_blocked: true } : { repo_full_name: repoFullName };
    if (routeKey) body.route_key = routeKey;
    if (cursor) body.cursor = cursor;
    return { method: "POST", path: "/v1/dashboard/blocks/unblock", label: "blocks unblock", body };
  },

  /**
   * GET /v1/hosted-evals/:routeKey/status — the production context's search status, the
   * route's eval spend and polling (ROUTE-005). The route key is one encoded path segment.
   */
  evalsStatus: (routeKey) => ({
    method: "GET",
    path: `/v1/hosted-evals/${encodePathSegment(routeKey)}/status`,
    label: "evals status"
  }),

  /** GET /v1/hosted-evals/:routeKey/results — the best available model, the chain and per-model results (EVAL-016). */
  evalsResults: (routeKey) => ({
    method: "GET",
    path: `/v1/hosted-evals/${encodePathSegment(routeKey)}/results`,
    label: "evals results"
  }),

  /**
   * GET /v1/hosted-evals/:routeKey/models/:model[?view=<id>] — one model's result, runs and case
   * results, as the route model page reads them (MCP-001). The view is a PR preview context.
   */
  evalsModel: (routeKey, modelId, viewId) => ({
    method: "GET",
    path: `/v1/hosted-evals/${encodePathSegment(routeKey)}/models/${encodePathSegment(modelId)}${viewId ? `?view=${encodeURIComponent(viewId)}` : ""}`,
    label: "evals model"
  }),

  /** GET /v1/hosted-evals/:routeKey/case-output?model_run_id=&case_id= — one case's full output, archived ones too (MCP-001). */
  evalsCaseOutput: (routeKey, modelRunId, caseId) => ({
    method: "GET",
    path: `/v1/hosted-evals/${encodePathSegment(routeKey)}/case-output?${new URLSearchParams({ model_run_id: modelRunId, case_id: caseId })}`,
    label: "evals case-output"
  }),

  /** GET /v1/hosted-evals — every route of the account, as the dashboard lists it, and the open drafts (MCP-001). */
  evalsOverview: () => ({ method: "GET", path: "/v1/hosted-evals", label: "evals overview" }),

  /** POST /v1/hosted-evals/drafts — body { name, cases_jsonl, scorer, judge_model, ... }; returns the card (EVAL-016). */
  evalsDraft: (body) => ({ method: "POST", path: "/v1/hosted-evals/drafts", label: "evals draft", body }),

  /** POST /v1/hosted-evals/drafts/:draftId/approve — body { card_hash }; starts the first search (EVAL-016). */
  evalsApprove: (draftId, cardHash) => ({
    method: "POST",
    path: `/v1/hosted-evals/drafts/${encodePathSegment(draftId)}/approve`,
    label: "evals approve",
    body: { card_hash: cardHash }
  }),

  /** POST /v1/dashboard/evals/retry — body { result_set_id } or { route_key }. RUN-001 R5: never clears a block. */
  evalsRetry: ({ resultSetId, routeKey }) => {
    const body = {};
    if (resultSetId) body.result_set_id = resultSetId;
    if (routeKey) body.route_key = routeKey;
    return { method: "POST", path: "/v1/dashboard/evals/retry", label: "evals retry", body };
  },

  /** POST /v1/dashboard/api-keys/:keyId/disable|enable — no body (KEYS-001). */
  apiKeySetEnabled: (keyId, enabled) => ({
    method: "POST",
    path: `/v1/dashboard/api-keys/${encodePathSegment(keyId)}/${enabled ? "enable" : "disable"}`,
    label: enabled ? "keys enable" : "keys disable"
  }),

  /** POST /v1/billing/auto-reload/setup — body { threshold_usd, reload_amount_usd, consent } (BILL-005). */
  autoReloadSetup: ({ thresholdUsd, reloadAmountUsd }) => ({
    method: "POST",
    path: "/v1/billing/auto-reload/setup",
    label: "billing auto-reload setup",
    body: { threshold_usd: thresholdUsd, reload_amount_usd: reloadAmountUsd, consent: true }
  }),

  /** DELETE /v1/billing/auto-reload (BILL-005). */
  autoReloadDisable: () => ({ method: "DELETE", path: "/v1/billing/auto-reload", label: "billing auto-reload disable" }),

  /** POST /v1/dashboard/routes/:routeKey/result-sets/:resultSetId/set-baseline — body { model } */
  routeBaselineSet: (routeKey, resultSetId, model) => ({
    method: "POST",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/result-sets/${encodePathSegment(resultSetId)}/set-baseline`,
    label: "baseline set",
    body: { model }
  })
};

/** Admin / proposal request specs — Bearer bradm_. */
export const adminPaths = {
  proposalsList: () => ({ method: "GET", path: "/v1/dashboard/catalog/proposals", label: "proposals list" }),
  proposalsApprove: (id) => ({
    method: "POST",
    path: `/v1/dashboard/catalog/proposals/${encodePathSegment(id)}/approve`,
    label: "proposals approve"
  }),
  proposalsReject: (id) => ({
    method: "POST",
    path: `/v1/dashboard/catalog/proposals/${encodePathSegment(id)}/reject`,
    label: "proposals reject"
  }),
  providersList: () => ({ method: "GET", path: "/v1/admin/providers", label: "admin providers list" }),
  providerKeySet: (provider, { apiKey, baseUrl } = {}) => {
    const body = { api_key: apiKey };
    if (baseUrl) body.base_url = baseUrl;
    return {
      method: "PUT",
      path: `/v1/admin/providers/${encodePathSegment(provider)}/key`,
      label: "admin providers key set",
      body
    };
  },
  providerKeyDelete: (provider) => ({
    method: "DELETE",
    path: `/v1/admin/providers/${encodePathSegment(provider)}/key`,
    label: "admin providers key delete"
  }),
  providerSmoke: (provider) => ({
    method: "POST",
    path: `/v1/admin/providers/${encodePathSegment(provider)}/smoke`,
    label: "admin providers smoke"
  }),
  providerDisable: (provider) => ({
    method: "POST",
    path: `/v1/admin/providers/${encodePathSegment(provider)}/disable`,
    label: "admin providers disable"
  }),
  /** Clearing disable is DELETE …/disable; there is no /enable route. */
  providerEnable: (provider) => ({
    method: "DELETE",
    path: `/v1/admin/providers/${encodePathSegment(provider)}/disable`,
    label: "admin providers enable"
  }),
  catalogShow: () => ({ method: "GET", path: "/v1/admin/catalog", label: "admin catalog show" }),
  catalogActivity: () => ({ method: "GET", path: "/v1/admin/catalog/activity", label: "admin catalog activity" }),
  catalogObservations: (query) => ({
    method: "GET",
    path: query ? `/v1/admin/catalog/observations?${query}` : "/v1/admin/catalog/observations",
    label: "admin catalog observations"
  }),
  /**
   * POST /v1/admin/catalog/observations. The server requires `source`
   * (lab_notice | manual_admin) and `subject_kind`, and defaults derived_action
   * to "none". It stamps the actor into the stored payload itself.
   */
  observationCreate: ({
    source,
    subjectKind,
    derivedAction,
    matchConfidence,
    canonicalId,
    sourceVersion,
    rawSourceId,
    payload
  } = {}) => {
    const body = { source, subject_kind: subjectKind };
    if (derivedAction) body.derived_action = derivedAction;
    if (matchConfidence) body.match_confidence = matchConfidence;
    if (canonicalId) body.canonical_id = canonicalId;
    if (sourceVersion) body.source_version = sourceVersion;
    if (rawSourceId) body.raw_source_id = rawSourceId;
    if (payload !== undefined) body.payload = payload;
    return {
      method: "POST",
      path: "/v1/admin/catalog/observations",
      label: "admin catalog observations add",
      body
    };
  },
  /** GET /v1/admin/catalog/mappings — mapping work with no decision yet. */
  mappingsList: () => ({
    method: "GET",
    path: "/v1/admin/catalog/mappings",
    label: "admin catalog mappings list"
  }),
  /** POST /v1/admin/catalog/refresh-report — report-only; the server performs no writes. */
  catalogRefreshReport: () => ({
    method: "POST",
    path: "/v1/admin/catalog/refresh-report",
    label: "admin catalog refresh-report",
    body: {}
  }),
  /**
   * POST /v1/admin/catalog/drain-outbox — bounded operator recovery for the
   * durable catalog outbox. The server default and maximum are both 25.
   */
  catalogDrainOutbox: (limit) => ({
    method: "POST",
    path: "/v1/admin/catalog/drain-outbox",
    label: "admin catalog drain-outbox",
    body: limit === undefined ? {} : { limit }
  }),
  /** GET /v1/admin/model-id-maps — canonical to provider model-id pairs. */
  modelIdMaps: () => ({
    method: "GET",
    path: "/v1/admin/model-id-maps",
    label: "admin catalog model-maps"
  }),
  mappingResolve: ({ source, rawSourceId, canonicalId } = {}) => ({
    method: "POST",
    path: "/v1/admin/catalog/mappings/resolve",
    label: "admin catalog mappings resolve",
    body: { source, raw_source_id: rawSourceId, canonical_id: canonicalId }
  }),
  mappingIgnore: ({ source, rawSourceId } = {}) => ({
    method: "POST",
    path: "/v1/admin/catalog/mappings/ignore",
    label: "admin catalog mappings ignore",
    body: { source, raw_source_id: rawSourceId }
  }),
  catalogRebuild: () => ({
    method: "POST",
    path: "/v1/admin/catalog/rebuild-snapshot",
    label: "admin catalog rebuild",
    body: {}
  }),
  /** GET /v1/admin/keys — a bradm_ bearer is an accepted admin identity. */
  adminKeysList: () => ({ method: "GET", path: "/v1/admin/keys", label: "admin keys list" }),
  /** DELETE /v1/admin/keys/:id — a bradm_ bearer is an accepted admin identity. */
  adminKeysRevoke: (id) => ({
    method: "DELETE",
    path: `/v1/admin/keys/${encodePathSegment(id)}`,
    label: "admin keys revoke"
  })
};

/**
 * POST /v1/admin/keys rejects an admin-key bearer with `admin_session_required`.
 * Only a browser GitHub admin session may mint an admin key.
 */
export function adminKeysMintBrowserSessionRequired() {
  return (
    "Minting an admin key requires a browser GitHub admin session (POST /v1/admin/keys). " +
    "An admin bearer key cannot mint admin keys. Use `benchrouter admin token save` for an already-minted bradm_ token."
  );
}
