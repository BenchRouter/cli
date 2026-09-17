// Route partition: split one isolated-replay route into children, one per
// consume contract (ROUTE-007). `plan` is read-only and produces the plan file
// that is the approval boundary. `apply` validates that file, registers the
// children through the existing init path, then writes the split case files
// and scorers. It never archives the parent, closes a PR, or copies evidence.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { readRouteManifest, ROUTE_MANIFEST_RELATIVE_PATH } from "./route-manifest.mjs";

export const PARTITION_PLAN_VERSION = 1;
export const PARTITION_GROUPS = ["method", "label", "case"];
export const DEFAULT_MIN_CHILD_CASES = 3;
export const MAX_BY_CASE_CHILDREN = 16;
export const INCUMBENT_CHOICES = ["parent_original", "parent_best"];
const PARENT_DISPOSITIONS = ["archive", "keep"];
const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/** Read-only: group the parent's cases and draft a plan. */
export function buildPartitionPlan(root, parentRouteKey, options = {}) {
  const by = options.by ?? "method";
  const minCases = options.minCases ?? DEFAULT_MIN_CHILD_CASES;
  if (!PARTITION_GROUPS.includes(by)) {
    throw new Error(`Unknown partition grouping: ${by}. Use ${PARTITION_GROUPS.join(", ")}.`);
  }
  const manifest = readRouteManifest(root);
  const parent = findRoute(manifest, parentRouteKey);
  if (parent.evalMode === "repository_executable") {
    throw new Error("partition supports isolated-replay routes only; repository_executable routes own their evaluator.");
  }
  const cases = readParentCases(root, parent);
  if (by === "case" && cases.length > MAX_BY_CASE_CHILDREN) {
    throw new Error(`--by case would create ${cases.length} routes; the limit is ${MAX_BY_CASE_CHILDREN}. Label cases with scorer_metadata.partition and use --by label.`);
  }

  const groups = new Map();
  const unassigned = [];
  for (const entry of cases) {
    const key = groupKeyFor(entry, by);
    if (!key) {
      unassigned.push(entry.id);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry.id);
  }

  const productSlug = parent.routeId.split("/")[0];
  const existingIds = new Set(manifest.routes.map((route) => route.routeId));
  const warnings = [];
  const children = [...groups.entries()].map(([key, caseIds]) => {
    const slug = slugify(key);
    const routeId = `${productSlug}/${slug}`;
    if (existingIds.has(routeId)) warnings.push(`${routeId} already exists in ${ROUTE_MANIFEST_RELATIVE_PATH}; rename this child before apply.`);
    if (caseIds.length < minCases) warnings.push(`${routeId} has ${caseIds.length} case(s), below the minimum ${minCases}; set allow_small or merge it.`);
    const child = {
      route_id: routeId,
      name: humanize(key),
      cases: caseIds,
      scorer: "inherit"
    };
    if (parent.evalArchetype) child.metadata = { eval_archetype: parent.evalArchetype };
    return child;
  });
  if (children.length < 2 && unassigned.length === 0) {
    warnings.push(`Grouping by ${by} yields ${children.length} child; a partition needs at least two contracts. Try a different --by or label the cases.`);
  }
  if (unassigned.length > 0) {
    warnings.push(`${unassigned.length} case(s) have no ${by} key and are unassigned; assign them to a child or leave them with the parent.`);
  }

  const plan = {
    version: PARTITION_PLAN_VERSION,
    parent: {
      route_id: parent.routeId,
      after_children_serve: "archive"
    },
    incumbent: "parent_original",
    children,
    unassigned
  };
  return { plan, warnings, parent: summarizeParent(parent), by, case_count: cases.length };
}

/**
 * Validate a plan against the local kit. Returns `{ errors, ... }`; callers stop on
 * any error. Children already present in the manifest are reported in `existing`
 * so a re-apply can be a no-op instead of a failure.
 */
export function validatePartitionPlan(root, plan, options = {}) {
  const errors = [];
  const minCases = options.minCases ?? DEFAULT_MIN_CHILD_CASES;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { errors: ["Plan must be a JSON object."] };
  }
  if (plan.version !== PARTITION_PLAN_VERSION) {
    errors.push(`Plan version must be ${PARTITION_PLAN_VERSION}.`);
  }
  const parentRouteId = typeof plan.parent?.route_id === "string" ? plan.parent.route_id : "";
  if (!parentRouteId) errors.push("plan.parent.route_id is required.");
  const disposition = plan.parent?.after_children_serve ?? "archive";
  if (!PARENT_DISPOSITIONS.includes(disposition)) {
    errors.push(`plan.parent.after_children_serve must be ${PARENT_DISPOSITIONS.join(" or ")}.`);
  }
  const incumbent = typeof plan.incumbent === "string" && plan.incumbent.length > 0 ? plan.incumbent : "parent_original";
  if (!INCUMBENT_CHOICES.includes(incumbent) && !incumbent.includes("/")) {
    errors.push("plan.incumbent must be parent_original, parent_best, or an exact canonical model id.");
  }
  if (!Array.isArray(plan.children) || plan.children.length === 0) {
    errors.push("plan.children must be a non-empty array.");
  }
  if (plan.unassigned !== undefined && !Array.isArray(plan.unassigned)) {
    errors.push("plan.unassigned must be an array of case ids when present.");
  }
  if (errors.length > 0) return { errors };

  let manifest;
  try {
    manifest = readRouteManifest(root);
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : "Could not read the route manifest."] };
  }
  const parent = manifest.routes.find((route) => route.routeId === parentRouteId);
  if (!parent) return { errors: [`Parent route ${parentRouteId} is not declared in ${ROUTE_MANIFEST_RELATIVE_PATH}.`] };
  if (parent.evalMode === "repository_executable") {
    return { errors: ["partition supports isolated-replay routes only."] };
  }
  const parentScorerPath = path.join(root, parent.scorerPath);
  if (!existsSync(parentScorerPath)) errors.push(`Parent scorer is missing: ${parent.scorerPath}`);

  let parentCases;
  try {
    parentCases = readParentCases(root, parent);
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : "Could not read parent cases."] };
  }
  const caseById = new Map(parentCases.map((entry) => [entry.id, entry]));

  const seenRouteIds = new Set();
  const assigned = new Map();
  const existing = [];
  const children = [];
  plan.children.forEach((child, index) => {
    const label = `plan.children[${index}]`;
    const routeId = typeof child?.route_id === "string" ? child.route_id.trim() : "";
    if (!ROUTE_ID_PATTERN.test(routeId)) {
      errors.push(`${label}.route_id must look like product/route (lowercase, digits, hyphens).`);
    } else if (routeId === parentRouteId) {
      errors.push(`${label}.route_id equals the parent route id.`);
    } else if (seenRouteIds.has(routeId)) {
      errors.push(`${label}.route_id ${routeId} is duplicated in the plan.`);
    }
    seenRouteIds.add(routeId);
    if (routeId.split("/")[0] !== parentRouteId.split("/")[0]) {
      errors.push(`${label}.route_id ${routeId} must share the parent's product prefix ${parentRouteId.split("/")[0]}.`);
    }
    const name = typeof child?.name === "string" ? child.name.trim() : "";
    if (!name) errors.push(`${label}.name is required.`);
    const caseIds = Array.isArray(child?.cases) ? child.cases : null;
    if (!caseIds || caseIds.length === 0) {
      errors.push(`${label}.cases must list at least one parent case id.`);
    } else {
      for (const caseId of caseIds) {
        if (!caseById.has(caseId)) {
          errors.push(`${label}.cases includes unknown case id ${JSON.stringify(caseId)}.`);
          continue;
        }
        if (assigned.has(caseId)) {
          errors.push(`Case ${caseId} is assigned to both ${assigned.get(caseId)} and ${routeId}.`);
        }
        assigned.set(caseId, routeId);
      }
      if (caseIds.length < minCases && child.allow_small !== true) {
        errors.push(`${label} (${routeId}) has ${caseIds.length} case(s), below the minimum ${minCases}. Set "allow_small": true to accept it.`);
      }
    }
    const scorer = child?.scorer === undefined ? "inherit" : child.scorer;
    if (scorer !== "inherit") {
      if (typeof scorer !== "string" || scorer.length === 0 || path.isAbsolute(scorer) || scorer.includes("..")) {
        errors.push(`${label}.scorer must be "inherit" or a repository-relative path.`);
      } else if (!existsSync(path.join(root, scorer))) {
        errors.push(`${label}.scorer path does not exist: ${scorer}`);
      }
    }
    const metadata = child?.metadata;
    if (metadata !== undefined) {
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        errors.push(`${label}.metadata must be an object.`);
      } else {
        for (const key of Object.keys(metadata)) {
          if (key !== "eval_archetype") errors.push(`${label}.metadata.${key} is not an allowed field; only eval_archetype is accepted.`);
        }
      }
    }
    const alreadyDeclared = manifest.routes.find((route) => route.routeId === routeId);
    if (alreadyDeclared) existing.push(routeId);
    children.push({
      route_id: routeId,
      name,
      case_ids: caseIds ?? [],
      cases: (caseIds ?? []).filter((caseId) => caseById.has(caseId)).map((caseId) => ({ ...caseById.get(caseId), route: routeId })),
      scorer,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      declared: Boolean(alreadyDeclared)
    });
  });

  const unassigned = Array.isArray(plan.unassigned) ? plan.unassigned : [];
  for (const caseId of unassigned) {
    if (!caseById.has(caseId)) errors.push(`plan.unassigned includes unknown case id ${JSON.stringify(caseId)}.`);
    if (assigned.has(caseId)) errors.push(`Case ${caseId} is both unassigned and assigned to ${assigned.get(caseId)}.`);
  }
  const missing = parentCases.map((entry) => entry.id).filter((caseId) => !assigned.has(caseId) && !unassigned.includes(caseId));
  if (missing.length > 0) {
    errors.push(`Every parent case must be in exactly one child or in unassigned. Missing: ${missing.join(", ")}`);
  }
  if (children.length > 0 && children.every((child) => !child.declared) && children.length < 2 && unassigned.length === 0) {
    errors.push("A partition needs at least two children, or one child plus unassigned cases that stay with the parent.");
  }

  return {
    errors,
    parent,
    parentCases,
    children,
    existing,
    unassigned,
    incumbent,
    disposition
  };
}

/** Route specs for the existing init path, one per child not yet declared. */
export function partitionRouteSpecs(validated, incumbentModel) {
  return validated.children
    .filter((child) => !child.declared)
    .map((child) => ({
      route_id: child.route_id,
      name: child.name,
      incumbent_model: incumbentModel,
      provider_id: validated.parent.providerId || undefined,
      provider_ref: validated.parent.providerRef || undefined,
      eval_pack: undefined,
      code_refs: validated.parent.codeRefs,
      base_url_env: validated.parent.callSiteBaseUrlEnv
    }));
}

/**
 * After init has merged the children into the manifest, write each child's cases
 * (route rewritten, otherwise byte-identical), its scorer, and any metadata or
 * custom scorer path. Returns a change list; an identical file is `unchanged`.
 */
export async function applyPartitionFiles(root, validated, { dryRun = false } = {}) {
  const manifest = readRouteManifest(root);
  const parentScorerSource = readFileSync(path.join(root, validated.parent.scorerPath), "utf8");
  const changes = [];
  const manifestEdits = [];
  for (const child of validated.children) {
    const declared = manifest.routes.find((route) => route.routeId === child.route_id);
    if (!declared) {
      throw new Error(`Child ${child.route_id} is not declared in ${ROUTE_MANIFEST_RELATIVE_PATH} after init; apply stopped before writing files.`);
    }
    const casesContent = `${JSON.stringify(child.cases, null, 2)}\n`;
    changes.push(await writeIfChanged(root, declared.casesPath, casesContent, dryRun));

    if (child.scorer === "inherit") {
      changes.push(await writeIfChanged(root, declared.scorerPath, parentScorerSource, dryRun));
    } else if (child.scorer !== declared.scorerPath) {
      manifestEdits.push({ route_id: child.route_id, scorer: child.scorer });
    }
    if (child.metadata.eval_archetype && child.metadata.eval_archetype !== (declared.evalArchetype || "")) {
      manifestEdits.push({ route_id: child.route_id, metadata: { eval_archetype: child.metadata.eval_archetype } });
    }
  }
  if (manifestEdits.length > 0) {
    const manifestPath = path.join(root, ROUTE_MANIFEST_RELATIVE_PATH);
    const before = readFileSync(manifestPath, "utf8");
    const after = editManifestRoutes(before, manifestEdits);
    changes.push(await writeIfChanged(root, ROUTE_MANIFEST_RELATIVE_PATH, after, dryRun, before));
  }
  return changes;
}

/** Targeted YAML edits that preserve comments and unrelated formatting. */
export function editManifestRoutes(source, edits) {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`${ROUTE_MANIFEST_RELATIVE_PATH} is not valid YAML: ${document.errors[0].message}`);
  }
  const routes = document.get("routes", true);
  if (!isSeq(routes)) throw new Error(`${ROUTE_MANIFEST_RELATIVE_PATH} must contain a routes sequence.`);
  for (const edit of edits) {
    const route = routes.items.find((item) => isMap(item) && item.get("route_id") === edit.route_id);
    if (!route) throw new Error(`Route ${edit.route_id} is not declared in ${ROUTE_MANIFEST_RELATIVE_PATH}.`);
    if (edit.scorer) {
      route.setIn(["eval_pack", "scorer"], edit.scorer);
    }
    if (edit.metadata) {
      for (const [key, value] of Object.entries(edit.metadata)) {
        route.setIn(["metadata", key], value);
      }
    }
  }
  return document.toString();
}

export function renderPartitionPlan(draft) {
  const { plan, warnings, parent, by, case_count: caseCount } = draft;
  const lines = [];
  lines.push(`Partition plan for ${plan.parent.route_id} (${caseCount} cases, grouped by ${by})`);
  lines.push(`Incumbent for children: ${plan.incumbent}${plan.incumbent === "parent_original" ? ` (${parent.incumbent_model})` : ""}`);
  lines.push("");
  const rows = plan.children.map((child) => [child.route_id, child.name, String(child.cases.length), child.cases.slice(0, 4).join(", ") + (child.cases.length > 4 ? ", …" : "")]);
  lines.push(...table(["child route", "name", "cases", "case ids"], rows));
  if (plan.unassigned.length > 0) {
    lines.push("");
    lines.push(`Unassigned (stay with parent): ${plan.unassigned.join(", ")}`);
  }
  lines.push("");
  lines.push(`Parent after children serve: ${plan.parent.after_children_serve}`);
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  lines.push("");
  lines.push("Review and edit the plan file, then run: benchrouter routes partition apply --plan <file> --setup-key br_setup_...");
  return `${lines.join("\n")}\n`;
}

export function renderPartitionApplySummary({ validated, changes, initRan, dryRun, incumbentModel }) {
  const lines = [];
  lines.push(`${dryRun ? "Dry run: " : ""}partition of ${validated.parent.routeId} into ${validated.children.length} route(s)`);
  lines.push(`Children incumbent: ${incumbentModel}`);
  const pending = validated.children.filter((child) => !child.declared);
  if (pending.length === 0) {
    lines.push("All children are already declared; init was skipped (no-op re-apply).");
  } else if (initRan) {
    lines.push(`Registered ${pending.length} new route(s) through init.`);
  } else {
    lines.push(`Would register ${pending.length} new route(s) through init: ${pending.map((child) => child.route_id).join(", ")}`);
    lines.push("Then would write each child's cases file and scorer at the paths the setup packet assigns.");
  }
  for (const change of changes) {
    lines.push(`${change.status} ${change.path}`);
  }
  if (validated.unassigned.length > 0) {
    lines.push(`Unassigned cases stay with ${validated.parent.routeId}: ${validated.unassigned.join(", ")}`);
  }
  lines.push("");
  lines.push("Next:");
  lines.push("- npm run benchrouter:calibrate, then npx --yes --package @benchrouter/cli benchrouter doctor --phase evaluation");
  lines.push("- Open the evaluation PR for the new routes. The parent keeps its evidence; nothing was copied.");
  if (validated.disposition === "archive") {
    lines.push(`- After every child has production evidence, and only then: benchrouter routes archive ${validated.parent.routeId}`);
  } else {
    lines.push(`- Parent disposition is keep; ${validated.parent.routeId} continues to serve.`);
  }
  lines.push("- If the parent has an open evaluation PR, leave it; apply does not close PRs.");
  return `${lines.join("\n")}\n`;
}

async function writeIfChanged(root, relativePath, content, dryRun, previous) {
  const target = path.join(root, relativePath);
  const before = previous ?? (existsSync(target) ? readFileSync(target, "utf8") : null);
  if (before === content) return { path: relativePath, status: "unchanged" };
  const status = before === null ? (dryRun ? "would create" : "created") : (dryRun ? "would update" : "updated");
  if (!dryRun) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { path: relativePath, status };
}

function findRoute(manifest, routeKey) {
  const route = manifest.routes.find((entry) => entry.routeId === routeKey);
  if (!route) throw new Error(`Route not found in ${manifest.product.repo}: ${routeKey}`);
  return route;
}

export function readParentCases(root, parent) {
  const casesPath = path.join(root, parent.casesPath);
  if (!existsSync(casesPath)) throw new Error(`Parent cases file is missing: ${parent.casesPath}`);
  const parsed = JSON.parse(readFileSync(casesPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${parent.casesPath} must be a JSON array of declared cases.`);
  const cases = parsed.filter((entry) => {
    const route = typeof entry?.route === "string" ? entry.route.trim() : "";
    return route.length === 0 || route === parent.routeId;
  });
  const ids = new Set();
  for (const entry of cases) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) throw new Error(`${parent.casesPath} contains a case without an id.`);
    if (ids.has(entry.id)) throw new Error(`${parent.casesPath} contains duplicate case id ${entry.id}.`);
    ids.add(entry.id);
  }
  return cases;
}

function groupKeyFor(entry, by) {
  const metadata = objectValue(entry?.scorer_metadata);
  const request = objectValue(entry?.request);
  if (by === "case") return entry.id;
  if (by === "label") return stringOrNull(metadata.partition);
  return stringOrNull(request.method) ?? stringOrNull(metadata.method);
}

function summarizeParent(parent) {
  return {
    route_id: parent.routeId,
    name: parent.name,
    incumbent_model: parent.incumbentModel,
    provider_id: parent.providerId || null,
    provider_ref: parent.providerRef || null,
    scorer: parent.scorerPath,
    cases: parent.casesPath,
    code_refs: parent.codeRefs
  };
}

export function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "route";
}

function humanize(value) {
  const words = String(value).trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function table(headers, rows) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)));
  const format = (row) => row.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ").trimEnd();
  return [format(headers), ...rows.map(format)];
}
