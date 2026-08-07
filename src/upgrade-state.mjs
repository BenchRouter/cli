import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const KIT_STATE_RELATIVE_PATH = ".benchrouter/.kit-state.json";
const REPOSITORY_OWNED_PATHS = new Set([
  KIT_STATE_RELATIVE_PATH,
  ".benchrouter/benchrouter.yml"
]);

/**
 * Read and validate the repository-owned kit state before an upgrade token is
 * previewed or consumed. Pre-launch installs with no valid state must re-init.
 */
export function readUpgradeKitState(outputDir) {
  const target = safeUpgradePath(outputDir, KIT_STATE_RELATIVE_PATH);
  if (!existsSync(target)) {
    throw new Error(
      `Cannot upgrade without ${KIT_STATE_RELATIVE_PATH}. Run benchrouter init to re-onboard this repository.`
    );
  }

  let state;
  try {
    state = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(
      `${KIT_STATE_RELATIVE_PATH} is not valid JSON. Run benchrouter init to re-onboard this repository: ` +
        `${error instanceof Error ? error.message : "parse failed"}`
    );
  }
  validateKitState(state);
  return state;
}

/**
 * Apply only server-owned generated files, then update repository-owned
 * bookkeeping last. Route declarations and all other kit-state fields come
 * only from the existing repository state.
 */
export async function applyUpgradePacket({ outputDir, setupKitVersion, files, onFile }) {
  const existingState = readUpgradeKitState(outputDir);
  const packetFiles = validateUpgradeFiles(files);
  const nextState = mergeUpgradeKitState(existingState, setupKitVersion, packetFiles);

  for (const file of packetFiles) {
    const target = safeUpgradePath(outputDir, file.path);
    const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (previous === file.content) {
      onFile?.("unchanged", file.path);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
    onFile?.(previous === null ? "created" : "updated", file.path);
  }

  const kitStatePath = safeUpgradePath(outputDir, KIT_STATE_RELATIVE_PATH);
  await writeFile(kitStatePath, `${JSON.stringify(nextState, null, 2)}\n`);
  onFile?.("updated", KIT_STATE_RELATIVE_PATH);
  return nextState;
}

export function mergeUpgradeKitState(existingState, setupKitVersion, packetFiles) {
  validateKitState(existingState);
  if (typeof setupKitVersion !== "string" || setupKitVersion.trim().length === 0) {
    throw new Error("BenchRouter upgrade response is missing setup_kit_version.");
  }
  const validatedFiles = validateUpgradeFiles(packetFiles);
  const updates = new Map(validatedFiles.map((file) => [file.path, { path: file.path, sha256: file.sha256 }]));
  const mergedFiles = existingState.files.map((entry) => updates.get(entry.path) ?? entry);
  const existingPaths = new Set(existingState.files.map((entry) => entry.path));
  for (const file of validatedFiles) {
    if (!existingPaths.has(file.path)) {
      mergedFiles.push({ path: file.path, sha256: file.sha256 });
    }
  }
  return {
    ...existingState,
    version: setupKitVersion,
    files: mergedFiles
  };
}

function validateKitState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw invalidKitState("expected a JSON object");
  }
  if (typeof state.version !== "string" || state.version.length === 0) {
    throw invalidKitState("version is required");
  }
  if (!Array.isArray(state.routes) || state.routes.length === 0) {
    throw invalidKitState("routes must contain at least one route");
  }
  for (const [index, route] of state.routes.entries()) {
    if (!route || typeof route !== "object" || Array.isArray(route)) {
      throw invalidKitState(`routes[${index}] must be an object`);
    }
    if (typeof route.route_id !== "string" || route.route_id.length === 0) {
      throw invalidKitState(`routes[${index}].route_id is required`);
    }
    if (typeof route.incumbent_model !== "string" || route.incumbent_model.length === 0) {
      throw invalidKitState(`routes[${index}].incumbent_model is required`);
    }
    if (!Array.isArray(route.code_refs) || route.code_refs.some((entry) => typeof entry !== "string")) {
      throw invalidKitState(`routes[${index}].code_refs must be an array of paths`);
    }
  }
  if (!Array.isArray(state.files)) {
    throw invalidKitState("files must be an array");
  }
  for (const [index, file] of state.files.entries()) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw invalidKitState(`files[${index}] must be an object`);
    }
    if (typeof file.path !== "string" || file.path.length === 0) {
      throw invalidKitState(`files[${index}].path is required`);
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw invalidKitState(`files[${index}].sha256 must be a lowercase SHA-256 digest`);
    }
  }
}

function validateUpgradeFiles(files) {
  if (!Array.isArray(files)) {
    throw new Error("BenchRouter upgrade response has no generated files.");
  }
  return files.map((file, index) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error(`BenchRouter upgrade response files[${index}] must be an object.`);
    }
    if (typeof file.path !== "string" || file.path.length === 0) {
      throw new Error(`BenchRouter upgrade response files[${index}].path is required.`);
    }
    if (REPOSITORY_OWNED_PATHS.has(file.path)) {
      throw new Error(`BenchRouter upgrade response attempted to replace repository-owned ${file.path}.`);
    }
    if (typeof file.content !== "string") {
      throw new Error(`BenchRouter upgrade response files[${index}].content is required.`);
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`BenchRouter upgrade response files[${index}].sha256 must be a lowercase SHA-256 digest.`);
    }
    const contentSha256 = createHash("sha256").update(file.content).digest("hex");
    if (file.sha256 !== contentSha256) {
      throw new Error(`BenchRouter upgrade response files[${index}].sha256 does not match its content.`);
    }
    return file;
  });
}

function safeUpgradePath(root, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`Unsafe upgrade path: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Upgrade path escapes output directory: ${relativePath}`);
  }
  return target;
}

function invalidKitState(detail) {
  return new Error(
    `${KIT_STATE_RELATIVE_PATH} is invalid (${detail}). Run benchrouter init to re-onboard this repository.`
  );
}
