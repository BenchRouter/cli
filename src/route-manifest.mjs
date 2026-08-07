import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export const ROUTE_MANIFEST_RELATIVE_PATH = ".benchrouter/benchrouter.yml";

export function readRouteManifest(root) {
  const manifestPath = path.join(root, ROUTE_MANIFEST_RELATIVE_PATH);
  let parsed;
  try {
    parsed = parseYaml(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${ROUTE_MANIFEST_RELATIVE_PATH} is not valid YAML: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  return normalizeRouteManifest(parsed);
}

export function normalizeRouteManifest(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${ROUTE_MANIFEST_RELATIVE_PATH} must contain a YAML object.`);
  }
  if (!Array.isArray(parsed.routes) || parsed.routes.length === 0) {
    throw new Error(`${ROUTE_MANIFEST_RELATIVE_PATH} must declare at least one route.`);
  }
  return {
    product: normalizeProduct(parsed.product),
    routes: parsed.routes.map(normalizeRoute)
  };
}

function normalizeProduct(product) {
  const value = objectValue(product, `${ROUTE_MANIFEST_RELATIVE_PATH}.product`);
  return {
    slug: requiredString(value.slug, `${ROUTE_MANIFEST_RELATIVE_PATH}.product.slug`),
    repo: requiredString(value.repo, `${ROUTE_MANIFEST_RELATIVE_PATH}.product.repo`),
    defaultBranch: requiredString(value.default_branch, `${ROUTE_MANIFEST_RELATIVE_PATH}.product.default_branch`)
  };
}

function normalizeRoute(route, index) {
  const prefix = `${ROUTE_MANIFEST_RELATIVE_PATH}.routes[${index}]`;
  const value = objectValue(route, prefix);
  const callSite = objectValue(value.call_site, `${prefix}.call_site`);
  const seed = objectValue(value.seed, `${prefix}.seed`);
  const evalPack = objectValue(value.eval_pack, `${prefix}.eval_pack`);
  const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
    ? value.metadata
    : {};
  if (!Array.isArray(value.code_refs) || value.code_refs.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`${prefix}.code_refs must be an array of paths.`);
  }
  if (!Array.isArray(evalPack.case_refs) || evalPack.case_refs.length === 0) {
    throw new Error(`${prefix}.eval_pack.case_refs must include at least one path.`);
  }
  const caseRefs = evalPack.case_refs.map((entry, caseIndex) => requiredString(entry, `${prefix}.eval_pack.case_refs[${caseIndex}]`));
  return {
    routeId: requiredString(value.route_id, `${prefix}.route_id`),
    slug: requiredString(value.id, `${prefix}.id`),
    name: requiredString(value.name, `${prefix}.name`),
    codeRefs: value.code_refs.map((entry) => entry.trim()),
    callSiteBaseUrlEnv: requiredString(callSite.base_url_env, `${prefix}.call_site.base_url_env`),
    providerId: optionalString(callSite.provider_id),
    providerRef: optionalString(callSite.provider_ref),
    incumbentModel: requiredString(seed.incumbent_model, `${prefix}.seed.incumbent_model`),
    evalArchetype: optionalString(metadata.eval_archetype),
    scorerPath: requiredString(evalPack.scorer, `${prefix}.eval_pack.scorer`),
    casesPath: caseRefs[0],
    caseRefs,
    workflowPath: requiredString(evalPack.workflow, `${prefix}.eval_pack.workflow`),
    resultSchema: requiredString(evalPack.result_schema, `${prefix}.eval_pack.result_schema`)
  };
}

function objectValue(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}
