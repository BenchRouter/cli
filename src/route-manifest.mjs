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
  const evalMode = evalPack.mode === "repository_executable" ? "repository_executable" : "isolated_replay";
  const apiFamily = evalMode === "repository_executable"
    ? requiredExecutableApiFamily(evalPack.api_family, `${prefix}.eval_pack.api_family`)
    : "";
  const inputRefs = evalMode === "repository_executable"
    ? requiredStringList(evalPack.input_refs, `${prefix}.eval_pack.input_refs`)
    : [];
  const acceptanceRefs = evalMode === "repository_executable"
    ? requiredStringList(evalPack.acceptance_refs, `${prefix}.eval_pack.acceptance_refs`)
    : [];
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
    evalMode,
    apiFamily,
    scorerPath: requiredString(evalPack.scorer, `${prefix}.eval_pack.scorer`),
    casesPath: caseRefs[0],
    caseRefs,
    workflowPath: requiredString(evalPack.workflow, `${prefix}.eval_pack.workflow`),
    resultSchema: requiredString(evalPack.result_schema, `${prefix}.eval_pack.result_schema`),
    repositoryExecutableRefs: evalMode === "repository_executable"
      ? Array.from(new Set([
          requiredString(evalPack.lockfile, `${prefix}.eval_pack.lockfile`),
          ...caseRefs,
          ...inputRefs,
          ...acceptanceRefs
        ]))
      : []
  };
}

function requiredExecutableApiFamily(value, label) {
  if (value !== "openai_chat_completions" && value !== "anthropic_messages" && value !== "openai_responses") {
    throw new Error(`${label} must be openai_chat_completions, anthropic_messages, or openai_responses.`);
  }
  return value;
}

function requiredStringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must include at least one path.`);
  }
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
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
