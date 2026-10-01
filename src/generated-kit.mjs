import { existsSync, readFileSync } from "node:fs";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import path from "node:path";
import { parseDocument } from "yaml";
import { readRouteManifest } from "./route-manifest.mjs";

export const BOOTSTRAP_PATH = ".benchrouter/bootstrap.mjs";
export const TRUST_PATH = ".benchrouter/trust.json";
export const WORKFLOW_PATH = ".github/workflows/benchrouter-evals.yml";
export const LOCAL_SCRIPTS = {
  "benchrouter:capture": `node ${BOOTSTRAP_PATH} capture`,
  "benchrouter:calibrate": `node ${BOOTSTRAP_PATH} calibrate`
};
export const UPGRADE_GENERATED_PATHS = [WORKFLOW_PATH, BOOTSTRAP_PATH, TRUST_PATH, ".benchrouter/README.md"];
const DISPATCH_ONLY = "github.event_name == 'workflow_dispatch'";

function workflowDocument(source) {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) throw new Error(`${WORKFLOW_PATH} is not valid YAML: ${doc.errors[0].message}`);
  return doc;
}

function evalSteps(doc) {
  const steps = doc.getIn(["jobs", "eval", "steps"]);
  if (!steps || !Array.isArray(steps.items)) throw new Error(`${WORKFLOW_PATH} must contain jobs.eval.steps.`);
  return steps;
}

function setupBounds(steps) {
  const setup = steps.items.findIndex((step) => step?.get?.("name") === "Setup Node.js");
  const run = steps.items.findIndex((step) => step?.get?.("name") === "Run BenchRouter");
  if (setup < 0 || run <= setup) throw new Error(`${WORKFLOW_PATH} must contain Setup Node.js before Run BenchRouter.`);
  return { setup, run };
}

function dispatchOnly(condition) {
  if (typeof condition !== "string") return false;
  const text = condition.trim();
  return text === DISPATCH_ONLY || text === "${{ " + DISPATCH_ONLY + " }}";
}

// RUN-001: customer setup stays between the pinned Node setup and the runtime.
export function preserveCustomerSetup(existingSource, generatedSource) {
  if (existingSource === generatedSource) return existingSource;
  const existing = workflowDocument(existingSource);
  const generated = workflowDocument(generatedSource);
  const previousSteps = evalSteps(existing);
  const nextSteps = evalSteps(generated);
  const previous = setupBounds(previousSteps);
  const next = setupBounds(nextSteps);
  const customerSteps = previousSteps.items.slice(previous.setup + 1, previous.run);
  for (const step of customerSteps) {
    if (!dispatchOnly(step?.get?.("if"))) throw new Error("Every customer setup step must use if: " + DISPATCH_ONLY);
  }
  if (customerSteps.length === 0) return generatedSource;
  nextSteps.items.splice(next.setup + 1, next.run - next.setup - 1, ...customerSteps.map((step) => step.clone()));
  return generated.toString();
}

export function validateUpgradeFiles(files) {
  if (!Array.isArray(files)) throw new Error("BenchRouter upgrade response has no generated files.");
  const counts = new Map();
  for (const [index, file] of files.entries()) {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error(`BenchRouter upgrade response files[${index}] must be an object.`);
    if (!UPGRADE_GENERATED_PATHS.includes(file.path)) throw new Error(`BenchRouter upgrade response attempted to replace unsupported path ${file.path}.`);
    if (typeof file.content !== "string") throw new Error(`BenchRouter upgrade response files[${index}].content is required.`);
    const digest = createHash("sha256").update(file.content).digest("hex");
    if (file.sha256 !== digest) throw new Error(`BenchRouter upgrade response files[${index}].sha256 does not match its content.`);
    counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
  }
  if (files.length !== UPGRADE_GENERATED_PATHS.length || UPGRADE_GENERATED_PATHS.some((file) => counts.get(file) !== 1)) {
    throw new Error("BenchRouter upgrade response must contain exactly one of each generated path.");
  }
  return files;
}

export function prepareUpgradeFiles(outputDir, files) {
  readRouteManifest(outputDir);
  return validateUpgradeFiles(files).map((file) => {
    if (file.path !== WORKFLOW_PATH) return file;
    const target = path.join(outputDir, WORKFLOW_PATH);
    return existsSync(target) ? { ...file, content: preserveCustomerSetup(readFileSync(target, "utf8"), file.content) } : file;
  });
}

export function preparePackageJson(outputDir, instructions) {
  const target = path.join(outputDir, "package.json");
  if (!existsSync(target)) return [];
  const parsed = JSON.parse(readFileSync(target, "utf8"));
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(parsed)) throw new Error("package.json must contain an object.");
  for (const name of ["scripts", "dependencies", "devDependencies"]) {
    if (parsed[name] !== undefined && !object(parsed[name])) throw new Error(`package.json ${name} must contain an object.`);
  }
  parsed.scripts = { ...(parsed.scripts ?? {}), ...instructions.scripts };
  parsed.devDependencies = parsed.devDependencies ?? {};
  for (const dependency of instructions.dev_dependencies ?? []) {
    if (!parsed.dependencies?.[dependency] && !parsed.devDependencies[dependency]) parsed.devDependencies[dependency] = "latest";
  }
  return [{ path: "package.json", content: `${JSON.stringify(parsed, null, 2)}\n` }];
}

// Preflight is read-only and runs before consuming setup or upgrade credentials.
export async function preflightFileApplication(outputDir, files) {
  for (const file of files) {
    const target = path.resolve(outputDir, file.path);
    if (!target.startsWith(path.resolve(outputDir) + path.sep)) throw new Error(`Unsafe generated path ${file.path}.`);
    let parent = path.dirname(target);
    while (!existsSync(parent)) parent = path.dirname(parent);
    await access(parent, constants.W_OK | constants.X_OK);
    if (existsSync(target)) {
      if (!(await lstat(target)).isFile()) throw new Error(`${file.path} must be a regular file.`);
      await access(target, constants.R_OK | constants.W_OK);
    }
  }
}

// Each rename is atomic. Caught failures restore previous bytes; a process crash
// between renames is not a cross-file transaction.
export async function stageFileApplication({ outputDir, files, onFile }) {
  await preflightFileApplication(outputDir, files);
  const staged = [];
  const createdDirectories = [];
  const changes = [];
  const removeStaging = async () => {
    for (const file of staged) {
      await rm(file.next, { force: true });
      if (file.backup) await rm(file.backup, { force: true });
    }
    for (const directory of createdDirectories.reverse()) {
      try { await rmdir(directory); } catch (error) {
        if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error.code)) throw error;
      }
    }
  };
  const stage = async (target, content, mode) => {
    const handle = await open(target, "wx", mode ?? 0o666);
    try { await handle.writeFile(content); if (mode !== undefined) await chmod(target, mode); }
    finally { await handle.close(); }
  };
  try {
    for (const file of files) {
      const target = path.join(outputDir, file.path);
      const previous = existsSync(target) ? readFileSync(target) : null;
      const action = previous === null ? "created" : previous.equals(Buffer.from(file.content)) ? "unchanged" : "updated";
      changes.push({ action, path: file.path });
      if (action === "unchanged") continue;
      const missing = [];
      let parent = path.dirname(target);
      while (!existsSync(parent)) { missing.unshift(parent); parent = path.dirname(parent); }
      for (const directory of missing) { await mkdir(directory); createdDirectories.push(directory); }
      const mode = previous === null ? undefined : (await lstat(target)).mode & 0o777;
      const suffix = `.benchrouter-${randomUUID()}`;
      const entry = { target, next: target + suffix + ".next", backup: previous === null ? null : target + suffix + ".previous" };
      staged.push(entry);
      await stage(entry.next, file.content, mode);
      if (entry.backup) await stage(entry.backup, previous, mode);
    }
  } catch (error) { await removeStaging(); throw error; }
  return {
    discard: removeStaging,
    async commit() {
      const applied = [];
      try {
        for (const file of staged) { await rename(file.next, file.target); applied.push(file); }
      } catch (error) {
        const rollbackErrors = [];
        for (const file of applied.reverse()) {
          try {
            if (file.backup) await rename(file.backup, file.target);
            else await rm(file.target);
          } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "Kit application failed and rollback could not restore every file.");
        await removeStaging();
        throw error;
      }
      await removeStaging();
      for (const change of changes) onFile?.(change.action, change.path);
    }
  };
}

export async function applyUpgradePacket({ outputDir, files, onFile }) {
  const packetFiles = [...prepareUpgradeFiles(outputDir, files), ...preparePackageJson(outputDir, { scripts: LOCAL_SCRIPTS })];
  await (await stageFileApplication({ outputDir, files: packetFiles, onFile })).commit();
}

function trustObject(value, keys, what) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} is not an object`);
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(`${what} has unknown or missing fields`);
  return value;
}

function parseTrust(source) {
  const trust = trustObject(JSON.parse(source), ["schema", "protocol_major", "keys", "pins"], "trust.json");
  if (trust.schema !== "benchrouter.trust.v1" || trust.protocol_major !== 1) throw new Error("trust.json schema or protocol major is not supported");
  const keys = trustObject(trust.keys, ["current", "next"], "trust.json keys");
  for (const key of [keys.current, keys.next]) {
    trustObject(key, ["key_id", "alg", "public_key"], "trust.json key");
    const bytes = Buffer.from(String(key.public_key), "base64");
    if (typeof key.public_key !== "string" || bytes.toString("base64") !== key.public_key) throw new Error("trust.json public_key is not canonical base64");
    if (key.alg !== "ed25519" || bytes.length !== 32) throw new Error("trust.json key is not a raw Ed25519 key");
    if (key.key_id !== "ed25519:" + createHash("sha256").update(bytes).digest("hex").slice(0, 16)) throw new Error("trust.json key_id does not match its public key");
    createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: bytes.toString("base64url") }, format: "jwk" });
  }
  const isDigest = (value) => typeof value === "string" && value.length === 71 && value.startsWith("sha256:") && [...value.slice(7)].every((char) => "0123456789abcdef".includes(char));
  if (!Array.isArray(trust.pins) || !trust.pins.every(isDigest)) throw new Error("trust.json pins must be sha256 digests");
}

export function inspectSignedKit(root, failures) {
  const trustPath = path.join(root, TRUST_PATH);
  if (existsSync(trustPath)) {
    try {
      parseTrust(readFileSync(trustPath, "utf8"));
    } catch (error) { failures.push(`${TRUST_PATH}: ${error.message}`); }
  }
  const workflowPath = path.join(root, WORKFLOW_PATH);
  if (!existsSync(workflowPath)) return;
  try {
    const doc = workflowDocument(readFileSync(workflowPath, "utf8"));
    const workflow = doc.toJS();
    if (workflow.permissions?.["id-token"] !== "write" || workflow.permissions?.contents !== "read") throw new Error("requires id-token: write and contents: read");
    if (!workflow.on?.pull_request || !workflow.on?.push || workflow.on?.workflow_dispatch?.inputs?.claim?.required !== true) throw new Error("requires PR, push, and workflow_dispatch with a required claim");
    if (workflow.concurrency !== undefined || workflow.jobs?.eval?.strategy !== undefined) throw new Error("the signed runtime job must have no concurrency or matrix");
    if (Object.keys(workflow.jobs ?? {}).length !== 1) throw new Error("requires exactly one eval job");
    const job = workflow.jobs?.eval;
    if (job?.["timeout-minutes"] !== 120 || job?.["runs-on"] !== "ubuntu-24.04") throw new Error("requires ubuntu-24.04 and a 120-minute job ceiling");
    const guard = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
    if (job.if !== guard && job.if !== "${{ " + guard + " }}") throw new Error("requires the same-repository PR guard");
    for (const event of ["pull_request", "push"]) {
      const paths = workflow.on[event].paths;
      if (!Array.isArray(paths) || !paths.includes(".benchrouter/**") || !paths.includes(WORKFLOW_PATH)) throw new Error(`${event} must trigger on the generated kit and workflow`);
    }
    const steps = evalSteps(doc);
    const { setup, run } = setupBounds(steps);
    const checkout = steps.items[0]?.toJSON();
    if (checkout?.uses !== "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" || checkout.with?.["persist-credentials"] !== false || checkout.with?.path !== ".br-control") throw new Error("requires the pinned control checkout with persist-credentials: false");
    const node = steps.items[setup].toJSON();
    if (node.uses !== "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020") throw new Error("requires the pinned setup-node action");
    if (node.with?.["node-version"] !== "24" || node.with?.["package-manager-cache"] !== false) throw new Error("requires Node 24 with package-manager-cache: false");
    const runtime = steps.items[run].toJSON();
    if (runtime.run !== "node .br-control/.benchrouter/bootstrap.mjs run") throw new Error("must run the signed runtime bootstrap");
    for (const step of steps.items.slice(setup + 1, run)) {
      if (!dispatchOnly(step?.get?.("if"))) throw new Error("Every customer setup step must use if: " + DISPATCH_ONLY);
    }
  } catch (error) { failures.push(`${WORKFLOW_PATH}: ${error.message}`); }
}
