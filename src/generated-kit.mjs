import { existsSync, readFileSync } from "node:fs";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, rename, rm, rmdir } from "node:fs/promises";
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
    if (!existsSync(target)) return file;
    const previousContent = readFileSync(target, "utf8");
    return { ...file, previousContent, content: preserveCustomerSetup(previousContent, file.content) };
  });
}

export function preparePackageJson(outputDir, instructions) {
  const target = path.join(outputDir, "package.json");
  if (!existsSync(target)) return [];
  const previousContent = readFileSync(target, "utf8");
  const parsed = JSON.parse(previousContent);
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
  return [{ path: "package.json", previousContent, content: `${JSON.stringify(parsed, null, 2)}\n` }];
}

// Resolve the selected repository once. System aliases such as /tmp are allowed
// here; every ancestor below the selected real root must be a real directory.
async function applicationRoot(outputDir) {
  const selected = path.resolve(outputDir);
  let existing = selected;
  while (true) {
    try { await lstat(existing); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; existing = path.dirname(existing); }
  }
  const anchor = await realpath(existing);
  const stat = await lstat(anchor);
  if (!stat.isDirectory()) throw new Error("The selected repository root must be a directory.");
  return { root: path.resolve(anchor, path.relative(existing, selected)), anchor, directories: new Map([[anchor, stat]]) };
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function boundaryError(message) { return Object.assign(new Error(message), { code: "ESTALE" }); }

async function destination(context, filePath, allowMissingParents = false) {
  const target = path.resolve(context.root, filePath);
  const relative = path.relative(context.root, target);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error(`Unsafe generated path ${filePath}.`);
  const parent = path.dirname(target);
  const paths = [context.anchor];
  for (const part of path.relative(context.anchor, parent).split(path.sep).filter(Boolean)) paths.push(path.join(paths.at(-1), part));
  let nearest = context.anchor;
  for (const directory of paths) {
    let stat;
    try { stat = await lstat(directory); }
    catch (error) {
      if (allowMissingParents && error.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw boundaryError(`Refusing symlink ancestor ${directory}.`);
    if (!stat.isDirectory()) throw new Error(`Destination ancestor ${directory} must be a directory.`);
    const previous = context.directories.get(directory);
    if (previous && !sameIdentity(previous, stat)) throw boundaryError(`Destination ancestor changed: ${directory}.`);
    context.directories.set(directory, stat);
    nearest = directory;
  }
  return { target, nearest };
}

async function preimage(context, filePath, allowMissingParents = false) {
  const { target } = await destination(context, filePath, allowMissingParents);
  let stat;
  try { stat = await lstat(target); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile()) throw Object.assign(new Error(`${filePath} must be a regular file.`), { code: stat.isDirectory() ? "EISDIR" : "ESTALE" });
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!sameIdentity(stat, before)) throw boundaryError(`Destination changed while reading ${filePath}.`);
    const content = await handle.readFile();
    const after = await handle.stat();
    await destination(context, filePath, allowMissingParents);
    const current = await lstat(target);
    if (!sameMetadata(before, after) || !sameMetadata(after, current)) throw boundaryError(`Destination changed while reading ${filePath}.`);
    return { stat: current, content };
  } finally { await handle.close(); }
}

function sameMetadata(left, right) {
  return sameIdentity(left, right) && left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
function samePreimage(left, right) {
  return left === null || right === null ? left === right : sameMetadata(left.stat, right.stat) && left.content.equals(right.content);
}
async function requirePreimage(context, filePath, expected) {
  if (!samePreimage(await preimage(context, filePath), expected)) throw boundaryError(`Destination changed since staging: ${filePath}. Customer edits were preserved.`);
}

// Read-only preflight runs before consuming setup or upgrade credentials.
export async function preflightFileApplication(outputDir, files) {
  const context = await applicationRoot(outputDir);
  await preflight(context, files);
}
async function preflight(context, files) {
  const unique = new Set();
  for (const file of files) {
    if (unique.has(file.path)) throw new Error(`Duplicate generated path ${file.path}.`);
    unique.add(file.path);
    const { target, nearest } = await destination(context, file.path, true);
    await access(nearest, constants.W_OK | constants.X_OK);
    if (await preimage(context, file.path, true)) await access(target, constants.R_OK | constants.W_OK);
  }
}

// Each rename is atomic. Rechecks protect observed customer edits and path
// boundaries; they are not a filesystem lock or a cross-file crash transaction.
export async function stageFileApplication({ outputDir, files, onFile }) {
  const context = await applicationRoot(outputDir);
  await preflight(context, files);
  const staged = [];
  const createdDirectories = [];
  const changes = [];
  const removeStaging = async () => {
    for (const file of staged) {
      for (const [name, expected] of [[file.next, file.nextPreimage], [file.backup, file.backupPreimage]]) {
        if (!name) continue;
        const current = await preimage(context, name);
        if (!current) continue;
        // A partially staged file is owned only if its open-created inode matches.
        if (!expected || !sameIdentity(current.stat, expected.stat)) throw boundaryError(`Staging file changed: ${name}.`);
        if (expected.content && !samePreimage(current, expected)) throw boundaryError(`Staging file changed: ${name}.`);
        await destination(context, name);
        await rm(path.join(context.root, name));
      }
    }
    for (const directory of [...createdDirectories].reverse()) {
      const filePath = path.relative(context.root, path.join(directory, ".boundary-check"));
      await destination(context, filePath);
      try { await rmdir(directory); } catch (error) {
        if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(error.code)) throw error;
      }
    }
  };
  const stage = async (entry, name, content, mode) => {
    const { target } = await destination(context, entry[name]);
    const handle = await open(target, "wx", mode ?? 0o666);
    entry[name + "Preimage"] = { stat: await handle.stat() };
    try { await handle.writeFile(content); if (mode !== undefined) await handle.chmod(mode); }
    finally { await handle.close(); }
    entry[name + "Preimage"] = await preimage(context, entry[name]);
  };
  try {
    for (const file of files) {
      let { target, nearest } = await destination(context, file.path, true);
      const previous = await preimage(context, file.path, true);
      if (Object.hasOwn(file, "previousContent") && (previous?.content.toString("utf8") ?? null) !== file.previousContent) throw boundaryError(`Destination changed since planning: ${file.path}. Customer edits were preserved.`);
      const action = previous === null ? "created" : previous.content.equals(Buffer.from(file.content)) ? "unchanged" : "updated";
      changes.push({ action, path: file.path });
      const entry = { path: file.path, previous, next: null, backup: null };
      staged.push(entry);
      if (action === "unchanged") continue;
      while (nearest !== path.dirname(target)) {
        const part = path.relative(nearest, path.dirname(target)).split(path.sep)[0];
        const directory = path.join(nearest, part);
        await destination(context, file.path, true);
        await mkdir(directory);
        createdDirectories.push(directory);
        ({ nearest } = await destination(context, file.path, true));
      }
      const mode = previous === null ? undefined : previous.stat.mode & 0o777;
      const suffix = `.benchrouter-${randomUUID()}`;
      entry.next = file.path + suffix + ".next";
      entry.backup = previous === null ? null : file.path + suffix + ".previous";
      await stage(entry, "next", file.content, mode);
      if (entry.backup) await stage(entry, "backup", previous.content, mode);
    }
  } catch (error) {
    try { await removeStaging(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Kit staging failed; remaining staged files were preserved."); }
    throw error;
  }
  return {
    discard: removeStaging,
    async commit() {
      const applied = [];
      try {
        // Check the whole transaction first, including unchanged destinations.
        for (const file of staged) await requirePreimage(context, file.path, file.previous);
        for (const file of staged) {
          if (!file.next) continue;
          await requirePreimage(context, file.path, file.previous);
          await requirePreimage(context, file.next, file.nextPreimage);
          const { target } = await destination(context, file.path);
          await rename(path.join(context.root, file.next), target);
          applied.push(file);
          // The installed inode and bytes are those we staged, never a later
          // customer write read back after rename.
          file.installed = file.nextPreimage;
        }
      } catch (error) {
        const rollbackErrors = [];
        for (const file of applied.reverse()) {
          try {
            await requirePreimage(context, file.path, file.installed);
            if (file.backup) await requirePreimage(context, file.backup, file.backupPreimage);
            const { target } = await destination(context, file.path);
            if (file.backup) await rename(path.join(context.root, file.backup), target);
            else await rm(target);
          } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "Kit application failed; rollback preserved changed destinations and remaining backups.");
        try { await removeStaging(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Kit application failed; remaining staged files were preserved."); }
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
