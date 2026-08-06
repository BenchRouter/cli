import {
  accountRequest,
  encodePathSegment,
  encodeRouteKey,
  MissingServerContractError
} from "./http.mjs";

/** GET /v1/account/control/me — account_control_token auth (exists). */
export function getAccountSelf(ctx) {
  return accountRequest({
    ...ctx,
    method: "GET",
    path: "/v1/account/control/me",
    label: "account show"
  });
}

/** GET /v1/billing/summary — path exists; server must accept account control tokens. */
export function getBillingSummary(ctx) {
  return accountRequest({
    ...ctx,
    method: "GET",
    path: "/v1/billing/summary",
    label: "billing show"
  });
}

/**
 * POST /v1/billing/top-up-checkout
 * Body: { amount_usd: number }
 * Response includes checkout_url (print only; never open a browser).
 */
export function createBillingTopUpCheckout(ctx, amountUsd) {
  return accountRequest({
    ...ctx,
    method: "POST",
    path: "/v1/billing/top-up-checkout",
    body: { amount_usd: amountUsd },
    label: "billing top-up"
  });
}

/** GET /v1/dashboard/summary — includes api_keys metadata and routes. */
export function getDashboardSummary(ctx) {
  return accountRequest({
    ...ctx,
    method: "GET",
    path: "/v1/dashboard/summary",
    label: "dashboard summary"
  });
}

/**
 * POST /v1/dashboard/api-keys
 * Body: { name, product_id } or { names, product_id }
 */
export function createDashboardApiKey(ctx, { name, names, productId }) {
  const body = { product_id: productId };
  if (Array.isArray(names) && names.length > 0) {
    body.names = names;
  } else {
    body.name = name;
  }
  return accountRequest({
    ...ctx,
    method: "POST",
    path: "/v1/dashboard/api-keys",
    body,
    label: "keys create"
  });
}

/**
 * MISSING SERVER CONTRACT — runtime API key revoke.
 * Required: an authenticated control-plane mutation that revokes one account
 * api_keys row by id, accepting Bearer br_ctrl_ (account control token), and
 * returning non-secret key metadata. No inventing a path here.
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
  return accountRequest({
    ...ctx,
    method: "GET",
    path: "/v1/setup/repos",
    label: "repos list"
  });
}

/** GET /v1/setup/diagnostic?repo=owner/repo */
export function getSetupDiagnostic(ctx, repoFullName) {
  return accountRequest({
    ...ctx,
    method: "GET",
    path: `/v1/setup/diagnostic?repo=${encodePathSegment(repoFullName)}`,
    label: "setup status"
  });
}

/** GET /v1/dashboard/routes/:routeKey/catalog */
export function getRouteCatalog(ctx, routeKey) {
  return accountRequest({
    ...ctx,
    method: "GET",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/catalog`,
    label: "routes catalog"
  });
}

/** GET /v1/dashboard/routes/:routeKey/models/:modelId */
export function getRouteModel(ctx, routeKey, modelId) {
  return accountRequest({
    ...ctx,
    method: "GET",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/models/${encodePathSegment(modelId)}`,
    label: "models show"
  });
}

/** POST /v1/dashboard/routes/:routeKey/archive */
export function archiveRoute(ctx, routeKey) {
  return accountRequest({
    ...ctx,
    method: "POST",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/archive`,
    label: "routes archive"
  });
}

/** POST /v1/dashboard/archived-routes/:routeId/unarchive */
export function unarchiveRoute(ctx, routeId) {
  return accountRequest({
    ...ctx,
    method: "POST",
    path: `/v1/dashboard/archived-routes/${encodePathSegment(routeId)}/unarchive`,
    label: "routes unarchive"
  });
}

/**
 * POST /v1/dashboard/routes/:routeKey/result-sets
 * Body: { model }
 */
export function createRouteResultSet(ctx, routeKey, model) {
  return accountRequest({
    ...ctx,
    method: "POST",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/result-sets`,
    body: { model },
    label: "evals run"
  });
}

/**
 * POST /v1/dashboard/routes/:routeKey/result-sets/:resultSetId/set-baseline
 * Body: { model }
 */
export function setRouteBaseline(ctx, routeKey, resultSetId, model) {
  return accountRequest({
    ...ctx,
    method: "POST",
    path: `/v1/dashboard/routes/${encodeRouteKey(routeKey)}/result-sets/${encodePathSegment(resultSetId)}/set-baseline`,
    body: { model },
    label: "baseline set"
  });
}
