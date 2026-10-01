import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

export async function applyUpgradePacket({ outputDir, files, onFile }) {
  const packetFiles = prepareUpgradeFiles(outputDir, files);
  for (const file of packetFiles) {
    const target = path.join(outputDir, file.path);
    const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (previous === file.content) {
      onFile?.("unchanged", file.path);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
    onFile?.(previous === null ? "created" : "updated", file.path);
  }
}

export function inspectSignedKit(root, failures) {
  const trustPath = path.join(root, TRUST_PATH);
  if (existsSync(trustPath)) {
    try {
      const trust = JSON.parse(readFileSync(trustPath, "utf8"));
      if (trust.schema !== "benchrouter.trust.v1" || trust.protocol_major !== 1 || !Array.isArray(trust.pins)) throw new Error("expected the runner protocol v1 trust contract");
      for (const name of ["current", "next"]) {
        const key = trust.keys?.[name];
        if (key?.alg !== "ed25519" || typeof key.public_key !== "string") throw new Error(`missing ${name} signing key`);
        const bytes = Buffer.from(key.public_key, "base64");
        const keyId = "ed25519:" + createHash("sha256").update(bytes).digest("hex").slice(0, 16);
        if (bytes.length !== 32 || bytes.toString("base64") !== key.public_key || key.key_id !== keyId) throw new Error(`invalid ${name} signing key`);
      }
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
