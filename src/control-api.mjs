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
export const customerPaths = {
  /** GET /v1/account/control/me */
  accountSelf: () => ({ method: "GET", path: "/v1/account/control/me", label: "account show" }),

  /** GET /v1/dashboard/summary — billing, api_keys, and routes all live here. */
  dashboardSummary: (label = "dashboard summary") => ({
    method: "GET",
    path: "/v1/dashboard/summary",
    label
  }),

  /** POST /v1/billing/top-up-checkout — body { amount_usd } */
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

  /** GET /v1/dashboard/routes/:routeKey/models/:modelId */
  routeModel: (routeKey, modelId, label = "models show") => ({
    method: "GET",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/models/${encodePathSegment(modelId)}`,
    label
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
