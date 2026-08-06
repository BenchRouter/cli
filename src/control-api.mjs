import {
  apiRequest,
  encodePathSegment,
  encodeRouteKey,
  MissingServerContractError
} from "./http.mjs";

function request(ctx, method, path, label, body) {
  return apiRequest({ ...ctx, method, path, label, body });
}

/** GET /v1/account/control/me */
export function getAccountSelf(ctx) {
  return request(ctx, "GET", "/v1/account/control/me", "account show");
}

/** GET /v1/dashboard/summary — billing lives here; there is no CLI billing/summary path. */
export function getDashboardSummary(ctx) {
  return request(ctx, "GET", "/v1/dashboard/summary", "dashboard summary");
}

/** POST /v1/billing/top-up-checkout — body { amount_usd } */
export function createBillingTopUpCheckout(ctx, amountUsd) {
  return request(ctx, "POST", "/v1/billing/top-up-checkout", "billing top-up", { amount_usd: amountUsd });
}

/** POST /v1/dashboard/api-keys — body { name|names, product_id } */
export function createDashboardApiKey(ctx, { name, names, productId }) {
  const body = { product_id: productId };
  if (Array.isArray(names) && names.length > 0) body.names = names;
  else body.name = name;
  return request(ctx, "POST", "/v1/dashboard/api-keys", "keys create", body);
}

/**
 * MISSING SERVER CONTRACT — runtime API key revoke for account control tokens.
 * Do not invent a path.
 */
export function revokeDashboardApiKey(_ctx, _keyId) {
  throw new MissingServerContractError(
    "Missing server contract: authenticated API key revoke for account control tokens " +
      "(e.g. POST /v1/dashboard/api-keys/:id/revoke with Bearer br_ctrl_). " +
      "Only POST /v1/dashboard/api-keys (create) and summary api_keys metadata exist today."
  );
}

/** GET /v1/setup/repos */
export function listSetupRepos(ctx) {
  return request(ctx, "GET", "/v1/setup/repos", "repos list");
}

/** GET /v1/setup/diagnostic?repo=owner/repo */
export function getSetupDiagnostic(ctx, repoFullName) {
  return request(
    ctx,
    "GET",
    `/v1/setup/diagnostic?repo=${encodePathSegment(repoFullName)}`,
    "setup status"
  );
}

/** GET /v1/dashboard/routes/:routeKey/catalog */
export function getRouteCatalog(ctx, routeKey) {
  return request(
    ctx,
    "GET",
    `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/catalog`,
    "routes catalog"
  );
}

/** GET /v1/dashboard/routes/:routeKey/models/:modelId */
export function getRouteModel(ctx, routeKey, modelId) {
  return request(
    ctx,
    "GET",
    `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/models/${encodePathSegment(modelId)}`,
    "models show"
  );
}

/** POST /v1/dashboard/routes/:routeKey/archive */
export function archiveRoute(ctx, routeKey) {
  return request(
    ctx,
    "POST",
    `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/archive`,
    "routes archive"
  );
}

/** POST /v1/dashboard/archived-routes/:routeId/unarchive */
export function unarchiveRoute(ctx, routeId) {
  return request(
    ctx,
    "POST",
    `/v1/dashboard/archived-routes/${encodePathSegment(routeId)}/unarchive`,
    "routes unarchive"
  );
}

/** POST /v1/dashboard/routes/:routeKey/result-sets — body { model } */
export function createRouteResultSet(ctx, routeKey, model) {
  return request(
    ctx,
    "POST",
    `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/result-sets`,
    "evals run",
    { model }
  );
}

/** POST /v1/dashboard/routes/:routeKey/result-sets/:resultSetId/set-baseline — body { model } */
export function setRouteBaseline(ctx, routeKey, resultSetId, model) {
  return request(
    ctx,
    "POST",
    `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/result-sets/${encodePathSegment(resultSetId)}/set-baseline`,
    "baseline set",
    { model }
  );
}

/** Admin / proposal paths — Bearer bradm_ where the server accepts admin keys. */
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
  providerKeySet: (provider) => ({
    method: "PUT",
    path: `/v1/admin/providers/${encodePathSegment(provider)}/key`,
    label: "admin providers key set"
  }),
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
  mappingResolve: () => ({
    method: "POST",
    path: "/v1/admin/catalog/mappings/resolve",
    label: "admin catalog mappings resolve"
  }),
  mappingIgnore: () => ({
    method: "POST",
    path: "/v1/admin/catalog/mappings/ignore",
    label: "admin catalog mappings ignore"
  }),
  catalogRebuild: () => ({
    method: "POST",
    path: "/v1/admin/catalog/rebuild-snapshot",
    label: "admin catalog rebuild",
    body: {}
  })
};

/**
 * List/mint/revoke admin keys require a browser GitHub admin session.
 * An admin bearer receives 403 admin_session_required on the server.
 */
export function adminKeysBrowserSessionRequired(action) {
  const paths = {
    list: { method: "GET", path: "/v1/admin/keys" },
    mint: { method: "POST", path: "/v1/admin/keys" },
    revoke: { method: "DELETE", path: "/v1/admin/keys/:id" }
  };
  const server = paths[action];
  return (
    `${action === "mint" ? "Minting" : action === "list" ? "Listing" : "Revoking"} admin keys ` +
    `requires a browser GitHub admin session (${server.method} ${server.path}). ` +
    "An admin bearer key cannot list, mint, or revoke admin keys."
  );
}
