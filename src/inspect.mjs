import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readRouteManifest } from "./route-manifest.mjs";

export const CASE_GROUPS = ["method", "archetype", "critical"];

export function inspectRoutes(root, routeKey) {
  const manifest = readRouteManifest(root);
  const routes = manifest.routes
    .filter((route) => !routeKey || route.routeId === routeKey)
    .map((route) => inspectRoute(root, route));
  if (routeKey && routes.length === 0) {
    throw new Error(`Route not found in ${manifest.product.repo}: ${routeKey}`);
  }
  return {
    ok: true,
    product: manifest.product,
    routes
  };
}

export function inspectCases(root, routeKey, groupBy = "method") {
  if (!CASE_GROUPS.includes(groupBy)) {
    throw new Error(`Unknown case group: ${groupBy}. Use ${CASE_GROUPS.join(", ")}.`);
  }
  const inspected = inspectRoutes(root, routeKey);
  return {
    ok: true,
    product: inspected.product,
    group_by: groupBy,
    routes: inspected.routes.map((route) => ({
      route_id: route.route_id,
      eval_mode: route.eval_mode,
      eval_archetype: route.eval_archetype,
      cases_error: route.cases_error ?? null,
      inventory: route.cases ? inventoryFromRows(route.cases.cases, groupBy) : null
    }))
  };
}

export function inventoryCases(cases, groupBy = "method") {
  return inventoryFromRows(cases.map(summarizeCase), groupBy);
}

export function inventoryFromRows(rows, groupBy = "method") {
  const groups = new Map();
  for (const row of rows) {
    const key = groupKey(row, groupBy);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.id);
  }
  return {
    count: rows.length,
    group_by: groupBy,
    groups: [...groups.entries()].map(([key, ids]) => ({
      key,
      count: ids.length,
      case_ids: ids
    })),
    cases: rows
  };
}

function inspectRoute(root, route) {
  const summary = {
    route_id: route.routeId,
    slug: route.slug,
    name: route.name,
    code_refs: route.codeRefs,
    call_site_base_url_env: route.callSiteBaseUrlEnv,
    incumbent_model: route.incumbentModel,
    eval_archetype: route.evalArchetype || null,
    eval_mode: route.evalMode,
    scorer: route.scorerPath,
    case_refs: route.caseRefs,
    missing_code_refs: route.codeRefs.filter((entry) => !existsSync(path.join(root, entry))),
    missing_case_refs: route.caseRefs.filter((entry) => !existsSync(path.join(root, entry))),
    scorer_present: existsSync(path.join(root, route.scorerPath))
  };
  if (route.evalMode === "repository_executable") {
    return {
      ...summary,
      cases: null,
      cases_error: "repository_executable routes declare case_refs; they are not isolated-replay JSON arrays."
    };
  }
  try {
    const cases = readDeclaredCases(root, route.casesPath);
    return {
      ...summary,
      cases: inventoryCases(cases, "method")
    };
  } catch (error) {
    return {
      ...summary,
      cases: null,
      cases_error: error instanceof Error ? error.message : "Could not read cases."
    };
  }
}

function readDeclaredCases(root, relativePath) {
  const source = readFileSync(path.join(root, relativePath), "utf8");
  const parsed = JSON.parse(source);
  if (!Array.isArray(parsed)) {
    throw new Error(`${relativePath} must be a JSON array of declared cases.`);
  }
  return parsed;
}

function summarizeCase(entry) {
  const metadata = objectValue(entry?.scorer_metadata);
  const request = objectValue(entry?.request);
  const expect = objectValue(metadata.expect);
  const input = objectValue(entry?.input);
  return {
    id: typeof entry?.id === "string" ? entry.id : "",
    route: typeof entry?.route === "string" ? entry.route : null,
    critical: Boolean(entry?.critical),
    method: stringOrNull(request.method) ?? stringOrNull(metadata.method),
    eval_archetype: stringOrNull(metadata.eval_archetype),
    expect_fields: Array.isArray(expect.fields) ? expect.fields.filter((value) => typeof value === "string") : [],
    max_tokens: Number.isFinite(input.max_tokens) ? input.max_tokens : null
  };
}

function groupKey(row, groupBy) {
  if (groupBy === "archetype") return row.eval_archetype || "unlabeled";
  if (groupBy === "critical") return row.critical ? "critical" : "noncritical";
  return row.method || "unlabeled";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
