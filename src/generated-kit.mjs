import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, rename, rm, rmdir } from "node:fs/promises";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CST, isAlias, isMap, isSeq, parseDocument, visit } from "yaml";
import { readRouteManifest } from "./route-manifest.mjs";

// The local runtime files. Local capture and calibrate write the CLI's vendored copies here
// (gitignored); kits before the eval-action stub committed them, so the upgrade deletes those.
export const BOOTSTRAP_PATH = ".benchrouter/bootstrap.mjs";
export const TRUST_PATH = ".benchrouter/trust.json";
export const GITIGNORE_PATH = ".benchrouter/.gitignore";
export const WORKFLOW_PATH = ".github/workflows/benchrouter-evals.yml";
export const LOCAL_SCRIPTS = {
  "benchrouter:capture": "npx --yes benchrouter@latest capture",
  "benchrouter:calibrate": "npx --yes benchrouter@latest calibrate"
};
// The values kits before the eval-action stub wrote for LOCAL_SCRIPTS.
export const LEGACY_LOCAL_SCRIPTS = {
  "benchrouter:capture": `node ${BOOTSTRAP_PATH} capture`,
  "benchrouter:calibrate": `node ${BOOTSTRAP_PATH} calibrate`
};
export const UPGRADE_GENERATED_PATHS = [WORKFLOW_PATH, ".benchrouter/README.md"];
const VENDOR_FILES = [
  [BOOTSTRAP_PATH, new URL("./vendor/bootstrap.mjs", import.meta.url)],
  [TRUST_PATH, new URL("./vendor/trust.json", import.meta.url)]
];
const DISPATCH_ONLY = "github.event_name == 'workflow_dispatch'";
const PREPARE_ID = "benchrouter_prepare";
const RUNTIME_ID = "benchrouter_runtime";
const PREPARE_ACTION = "BenchRouter/eval-action/prepare@";
const RUNTIME_ACTION = "BenchRouter/eval-action@";
const PREPARE_OUTPUT = "${{ steps.benchrouter_prepare.outputs.node }}";
const NPM_TOKEN_ENV = "${{ github.event_name == 'workflow_dispatch' && secrets.NPM_TOKEN || '' }}";
// The workflow before the eval-action stub. The upgrade reads it only to migrate it.
const LEGACY_NODE24_ID = "benchrouter_node24";
const LEGACY_INTERPRETER_ID = "benchrouter_bootstrap_node";
const LEGACY_INTERPRETER_OUTPUT = "${{ steps.benchrouter_bootstrap_node.outputs.node }}";
const LEGACY_RUNTIME_LAUNCH = '"$BENCHROUTER_BOOTSTRAP_NODE" .br-control/.benchrouter/bootstrap.mjs run';
const LEGACY_INTERPRETER_SCRIPT = [
  "node --input-type=module <<'BENCHROUTER_NODE'",
  "import { appendFileSync, realpathSync } from 'node:fs';",
  "import { isAbsolute } from 'node:path';",
  "const node = realpathSync(process.execPath);",
  "if (process.versions.node.split('.')[0] !== '24' || !isAbsolute(node) || node.includes('\\n') || node.includes('\\r')) {",
  "  throw new Error('Expected an absolute Node 24 interpreter');",
  "}",
  "appendFileSync(process.env.GITHUB_OUTPUT, `node=${node}\\n`);",
  "BENCHROUTER_NODE",
  ""
].join("\n");
// The legacy workflow's generated uploads. The eval action uploads the results now.
const LEGACY_UPLOADS = new Map([
  ["Upload BenchRouter results", "benchrouter-results-${{ github.run_id }}-${{ github.run_attempt }}"],
  ["Upload evaluator artifacts", "benchrouter-artifacts-${{ github.run_id }}-${{ github.run_attempt }}"]
]);

function workflowDocument(source, options) {
  const doc = parseDocument(source, options);
  if (doc.errors.length > 0) throw new Error(`${WORKFLOW_PATH} is not valid YAML: ${doc.errors[0].message}`);
  return doc;
}

function evalSteps(doc) {
  const steps = doc.getIn(["jobs", "eval", "steps"]);
  if (!steps || !Array.isArray(steps.items)) throw new Error(`${WORKFLOW_PATH} must contain jobs.eval.steps.`);
  return steps;
}

function stepIds(steps) {
  const ids = new Map();
  for (const [index, step] of steps.items.entries()) {
    const id = step?.get?.("id");
    if (id === undefined) continue;
    if (typeof id !== "string" || ids.has(id)) throw new Error(`${WORKFLOW_PATH} requires unique step IDs.`);
    ids.set(id, index);
  }
  return ids;
}

const onlyKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

// SETUP-001: the stub pins both actions to one ref: the v1 tag, or a full commit SHA for teams
// that pin strictly.
function actionRef(uses, action) {
  if (typeof uses !== "string" || !uses.startsWith(action)) return null;
  const ref = uses.slice(action.length);
  const sha = ref.length === 40 && [...ref].every((char) => "0123456789abcdef".includes(char));
  return ref === "v1" || sha ? ref : null;
}

// RUN-001: the runtime step's env is BenchRouter's: the job ceiling, fetch token, kit marker,
// the npm token for executable routes, and dispatch-only passthroughs of declared secrets.
function validRuntimeEnv(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return false;
  if (env.BENCHROUTER_JOB_CEILING_MIN !== "120" || env.BENCHROUTER_FETCH_TOKEN !== "${{ github.token }}") return false;
  if (typeof env.BENCHROUTER_KIT_VERSION !== "string" || env.BENCHROUTER_KIT_VERSION === "") return false;
  const fixed = ["BENCHROUTER_JOB_CEILING_MIN", "BENCHROUTER_FETCH_TOKEN", "BENCHROUTER_KIT_VERSION"];
  return Object.entries(env).every(([name, value]) => fixed.includes(name) ||
    (name === "BENCHROUTER_INSTALL_NPM_TOKEN" ? value === NPM_TOKEN_ENV : value === `\${{ ${DISPATCH_ONLY} && secrets.${name} || '' }}`));
}

// Returns the index of the last BenchRouter step before customer setup (open) and of the runtime step (run).
function stubBounds(steps) {
  const ids = stepIds(steps);
  if (ids.has(LEGACY_INTERPRETER_ID) && !ids.has(PREPARE_ID)) throw new Error("is the workflow from before the BenchRouter eval action. Run benchrouter upgrade.");
  const prepare = ids.get(PREPARE_ID);
  const run = ids.get(RUNTIME_ID);
  if (prepare !== 0 || run === undefined) throw new Error("requires the BenchRouter prepare step first, then customer setup, then the runtime step");
  const prepareStep = steps.items[prepare].toJSON();
  const ref = actionRef(prepareStep.uses, PREPARE_ACTION);
  if (!ref || !onlyKeys(prepareStep, ["name", "id", "uses"])) throw new Error(`requires the unconditional ${PREPARE_ACTION}<v1 or commit SHA> step`);
  const runtime = steps.items[run].toJSON();
  if (actionRef(runtime.uses, RUNTIME_ACTION) !== ref || !onlyKeys(runtime, ["name", "id", "uses", "with", "env"]) ||
    !onlyKeys(runtime.with, ["node"]) || runtime.with.node !== PREPARE_OUTPUT) {
    throw new Error(`must run ${RUNTIME_ACTION}${ref} with the prepared Node 24 interpreter`);
  }
  if (!validRuntimeEnv(runtime.env)) throw new Error("the runtime step env must hold only BenchRouter's job ceiling, fetch token, kit version and dispatch-only secrets");
  return { open: prepare, run, postStart: run + 1 };
}

// Reads the workflow from before the eval-action stub, for migration only.
function legacyBounds(steps) {
  const ids = stepIds(steps);
  const setup = ids.get(LEGACY_NODE24_ID);
  const interpreter = ids.get(LEGACY_INTERPRETER_ID);
  const run = ids.get(RUNTIME_ID);
  if (setup !== 1 || interpreter !== 2 || run === undefined || run <= interpreter) throw new Error(`${WORKFLOW_PATH} requires the canonical Node 24 prefix before customer setup and runtime.`);
  const node = steps.items[setup].toJSON();
  if (node.uses !== "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020" || node.with?.["node-version"] !== "24" || node.with?.["package-manager-cache"] !== false || Object.keys(node).some((key) => !["name", "id", "uses", "with"].includes(key)) || Object.keys(node.with).some((key) => !["node-version", "package-manager-cache"].includes(key))) throw new Error("requires the unconditional pinned Node 24 setup with package-manager-cache: false");
  const recorder = steps.items[interpreter].toJSON();
  if (recorder.shell !== "bash" || recorder.run !== LEGACY_INTERPRETER_SCRIPT || Object.keys(recorder).some((key) => !["name", "id", "shell", "run"].includes(key))) throw new Error("requires the exact unconditional Node 24 interpreter recorder");
  const runtime = steps.items[run].toJSON();
  if (runtime.shell !== "bash" || runtime.run !== LEGACY_RUNTIME_LAUNCH || runtime.env?.BENCHROUTER_BOOTSTRAP_NODE !== LEGACY_INTERPRETER_OUTPUT || Object.keys(runtime).some((key) => !["name", "id", "shell", "run", "env"].includes(key))) throw new Error("must run the signed runtime bootstrap with the saved Node 24 interpreter");
  // The generated uploads directly after the runtime step are BenchRouter's, not customer post steps.
  let postStart = run + 1;
  while (postStart < steps.items.length && isLegacyUpload(steps.items[postStart].toJSON())) postStart += 1;
  return { open: interpreter, run, postStart };
}

function isLegacyUpload(step) {
  return typeof step?.uses === "string" && step.uses.startsWith("actions/upload-artifact@") &&
    LEGACY_UPLOADS.has(step.name) && step.with?.name === LEGACY_UPLOADS.get(step.name);
}

// The upgrade migrates a legacy workflow; every other caller requires the stub.
function workflowBounds(steps) {
  const ids = stepIds(steps);
  return ids.has(LEGACY_INTERPRETER_ID) && !ids.has(PREPARE_ID) ? legacyBounds(steps) : stubBounds(steps);
}

function dispatchOnly(condition) {
  if (typeof condition !== "string") return false;
  const text = condition.trim();
  return text === DISPATCH_ONLY || text === "${{ " + DISPATCH_ONLY + " }}";
}

// RUN-001: the secrets context supports dot, indexed and whole-context expressions.
// Inspect YAML values, not JSON spelling, so whitespace and case cannot hide a grant.
function grantsPostStepSecrets(value, key = "") {
  if (typeof value === "string") {
    if (key === "if" && /\bsecrets\b/i.test(value)) return true;
    // Conservatively scan the whole interpolated value: quoted closing braces
    // are legal expression data and must not truncate the grant check.
    return value.includes("${{") && /\bsecrets\b/i.test(value);
  }
  if (value && typeof value === "object") return Object.entries(value).some(([name, child]) => grantsPostStepSecrets(child, name));
  return false;
}

function validateCustomerSteps(steps, { open, run, postStart }) {
  for (const step of steps.items.slice(open + 1, run)) {
    if (!dispatchOnly(step?.get?.("if"))) throw new Error("Every customer setup step must use if: " + DISPATCH_ONLY);
  }
  // Customer postprocessing is distinct from dispatch-only evaluator setup.
  for (const step of steps.items.slice(postStart)) {
    if (grantsPostStepSecrets(step.toJSON())) throw new Error("Customer post steps must not add secret grants.");
  }
}

// SETUP-001: the customer owns the eval job's runner, GitHub-hosted or self-hosted.
// Any GitHub runs-on shape passes: a label, a list of labels, or a group/labels object.
function validRunsOn(value) {
  const label = (item) => typeof item === "string" && item.trim() !== "";
  const labels = (item) => label(item) || (Array.isArray(item) && item.length > 0 && item.every(label));
  if (labels(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) return false;
  return Object.entries(value).every(([key, item]) => key === "group" ? label(item) : key === "labels" && labels(item));
}

const runsOnPath = ["jobs", "eval", "runs-on"];
const setupEnd = "---- end customer-setup ----";
const lineStart = (source, offset) => offset === 0 ? 0 : source.lastIndexOf("\n", offset - 1) + 1;

function isSetupGuide(line) {
  return line.startsWith("---- customer-setup (customer-owned).") ||
    line.startsWith("Every customer setup step must use:") ||
    line.startsWith("Replay-only repos need no customer setup.") ||
    line === setupEnd;
}

function additionalComment(existing, template) {
  if (!existing) return "";
  const lines = (comment) => comment?.replaceAll("\r\n", "\n").replaceAll("\r", "").split("\n");
  const current = new Set(lines(template));
  return lines(existing).filter((line) => !current.has(line)).join("\n");
}

function standaloneComments(doc, source) {
  const comments = new Map();
  // YAML may attach a dedented comment to the preceding collection. Use CST offsets to find its key.
  CST.visit({ start: [], value: doc.contents?.srcToken }, (item) => {
    for (const token of [...item.start, ...(item.sep ?? []), ...(item.value?.end ?? [])]) {
      if (token.type !== "comment") continue;
      const from = lineStart(source, token.offset);
      if (!source.slice(from, token.offset).trim()) comments.set(from, token);
    }
  });
  return comments;
}

function commentAboveKey(key, source, comments) {
  const offset = key.range?.[0];
  if (offset === undefined) return key.commentBefore;
  let start = lineStart(source, offset);
  const indent = offset - start;
  if (source.slice(start, offset).trim()) return key.commentBefore;
  const lines = [];
  while (start > 0) {
    const end = start - 1;
    start = lineStart(source, end);
    const token = comments.get(start);
    if (token?.offset === start + indent) lines.push(token.source.slice(1));
    else if (source.slice(start, end).trim()) break;
    else if (lines.length > 0) lines.push("");
  }
  return lines.length ? lines.reverse().join("\n").trimEnd() : key.commentBefore;
}

function mergeLeadingComments(existing, oldSource, generated, source) {
  const edits = [];
  const oldComments = standaloneComments(existing, oldSource);
  const newComments = standaloneComments(generated, source);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let stringify = false;
  const copy = (newNode, previous, current = newNode?.commentBefore) => {
    const comment = additionalComment(previous, current);
    if (!comment) return;
    newNode.commentBefore = [newNode.commentBefore, comment].filter(Boolean).join("\n");
    const offset = newNode.range?.[0];
    if (offset === undefined) {
      stringify = true;
      return;
    }
    const from = lineStart(source, offset);
    const indent = source.slice(from, offset);
    if (indent.trim()) {
      stringify = true;
      return;
    }
    edits.push({ from, to: from, text: comment.split("\n").map((line) => (line ? indent + "#" + line : "") + newline).join("") });
  };
  const merge = (oldNode, newNode) => {
    if (isMap(oldNode) && isMap(newNode)) {
      for (const { key, value } of newNode.items) {
        const oldPair = oldNode.items.find((pair) => pair.key?.value === key?.value);
        if (!oldPair || !key || !oldPair.key) continue;
        copy(key, commentAboveKey(oldPair.key, oldSource, oldComments), commentAboveKey(key, source, newComments));
        merge(oldPair.value, value);
      }
    } else if (isSeq(oldNode) && isSeq(newNode)) {
      for (const [index, item] of newNode.items.entries()) {
        const id = isMap(item) ? item.get("id") ?? item.get("name") : undefined;
        const previous = id === undefined ? oldNode.items[index] : oldNode.items.find(
          (candidate) => isMap(candidate) && (candidate.get("id") ?? candidate.get("name")) === id
        );
        merge(previous, item);
      }
    }
  };
  merge(existing.contents, generated.contents);
  copy(generated, existing.commentBefore);
  return stringify ? generated.toString({ lineWidth: 0 }) : applySourceEdits(source, edits);
}

function customerRunner(existing, generated) {
  const value = existing.toJS().jobs.eval["runs-on"];
  if (!validRunsOn(value)) return null;
  const copy = existing.getIn(runsOnPath, true).clone();
  let hasComments = false;
  let hasAliases = false;
  visit(copy, { Node(_, node) {
    hasComments ||= Boolean(node.comment || node.commentBefore);
    hasAliases ||= isAlias(node);
  } });
  if (!hasComments && isDeepStrictEqual(value, generated.toJS().jobs.eval["runs-on"])) return null;
  // Resolve aliases against the existing workflow. Their anchors may be replaced by the template.
  const resolveAlias = (_, alias) => {
    const node = generated.createNode(alias.toJS(existing));
    node.comment = alias.comment;
    node.commentBefore = alias.commentBefore;
    return node;
  };
  if (isAlias(copy)) return { node: resolveAlias(null, copy), hasAliases };
  if (hasAliases) visit(copy, { Alias: resolveAlias });
  return { node: copy, hasAliases };
}

function postCommentTokens(steps) {
  const last = steps.srcToken?.items?.at(-1);
  if (!last || last.value || last.start.some((token) => token.type === "seq-item-ind")) return [];
  return last.start.filter((token) => token.type === "comment" && token.indent >= steps.srcToken.indent);
}

// RUN-001: preserve customer setup after the prepare step and postprocessing after runtime.
// SETUP-001: also keep the customer's valid eval-job runs-on. A legacy workflow migrates: its setup
// between the interpreter recorder and the runtime step, and its post steps, move into the stub.
export function preserveCustomerSetup(existingSource, generatedSource) {
  const existing = workflowDocument(existingSource, { keepSourceTokens: true });
  const generated = workflowDocument(generatedSource, { keepSourceTokens: true });
  const previousSteps = evalSteps(existing);
  const nextSteps = evalSteps(generated);
  const previous = workflowBounds(previousSteps);
  const next = stubBounds(nextSteps);
  validateCustomerSteps(previousSteps, previous);
  validateCustomerSteps(nextSteps, next);
  const customerSteps = previousSteps.items.slice(previous.open + 1, previous.run);
  const customerPostSteps = previousSteps.items.slice(previous.postStart);
  const runner = customerRunner(existing, generated);
  const spliced = runner?.hasAliases ? null : spliceCustomerSource(
    existingSource, existing, previousSteps, previous, generatedSource, generated, nextSteps, next, Boolean(runner)
  );
  if (runner) generated.setIn(runsOnPath, runner.node);
  const guide = setupGuideTokens(nextSteps, next).map((token) => token.source.slice(1).trim());
  const withoutGuide = (comment) => comment?.split("\n").filter((line) => !isSetupGuide(line.trim()) && !guide.includes(line.trim())).join("\n");
  const setup = customerSteps.map((step) => step.clone());
  for (const step of setup) step.commentBefore = withoutGuide(step.commentBefore);
  const runtime = nextSteps.items[next.run];
  const runtimeComment = withoutGuide(previousSteps.items[previous.run].commentBefore);
  runtime.commentBefore = [runtime.commentBefore, additionalComment(runtimeComment, runtime.commentBefore)].filter(Boolean).join("\n");
  if (customerPostSteps.length > 0) {
    const postComment = postCommentTokens(previousSteps).map((token) => token.source.slice(1).trimEnd()).join("\n");
    nextSteps.comment = [nextSteps.comment, additionalComment(postComment, nextSteps.comment)].filter(Boolean).join("\n");
  }
  nextSteps.items.splice(next.run + 1, nextSteps.items.length - next.run - 1, ...customerPostSteps.map((step) => step.clone()));
  nextSteps.items.splice(next.open + 1, next.run - next.open - 1, ...setup);
  stubBounds(nextSteps);
  // Prefer the text splice: BenchRouter's bytes stay as sent and the customer's sections keep their
  // own formatting. Use it only when the parser reads it as exactly the merged workflow.
  if (spliced !== null) {
    const check = parseDocument(spliced, { keepSourceTokens: true });
    if (check.errors.length === 0 && isDeepStrictEqual(check.toJS(), generated.toJS())) {
      return mergeLeadingComments(existing, existingSource, check, spliced);
    }
  }
  const rendered = generated.toString({ lineWidth: 0 });
  return mergeLeadingComments(existing, existingSource, workflowDocument(rendered, { keepSourceTokens: true }), rendered);
}

function setupGuideTokens(steps, { open, run }) {
  if (steps.srcToken?.type !== "block-seq") return [];
  return steps.srcToken.items.slice(open + 1, run + 1)
    .flatMap((item) => item.start.filter((token) => token.type === "comment" && token.indent === steps.srcToken.indent));
}

function applySourceEdits(source, edits) {
  let result = source;
  for (const { from, to, text } of edits.sort((left, right) => right.from - left.from)) {
    result = result.slice(0, from) + text + result.slice(to);
  }
  return result;
}

// Copies the customer's sections of the old workflow text into BenchRouter's new workflow text:
// the setup region between the prepare step (legacy: the interpreter recorder) and the runtime
// step (with its comments),
// the steps after the runtime step, and a customer runs-on value.
function spliceCustomerSource(oldSource, oldDoc, oldSteps, oldBounds, newSource, newDoc, newSteps, newBounds, customerRunsOn) {
  const newline = newSource.includes("\r\n") ? "\r\n" : "\n";
  const sameEndings = (text) => text.replaceAll("\r\n", "\n").replaceAll("\n", newline);
  const oldItems = oldSteps.items;
  const newItems = newSteps.items;
  if (oldSteps.srcToken?.type !== "block-seq" || newSteps.srcToken?.type !== "block-seq") return null;
  if ([...oldItems, ...newItems].some((item) => !Array.isArray(item?.range))) return null;
  // A legacy generated upload after the customer's post steps cannot be cut from the text.
  if (oldItems.slice(oldBounds.postStart).some((item) => isLegacyUpload(item.toJSON()))) return null;
  const fromSetup = oldItems[oldBounds.open].range[2];
  const toSetup = lineStart(oldSource, oldItems[oldBounds.run].range[0]);
  const guide = setupGuideTokens(newSteps, newBounds);
  const templateLines = new Set(guide.map((token) => token.source.trimEnd()));
  const oldGuideEdits = setupGuideTokens(oldSteps, oldBounds)
    .filter((token) => isSetupGuide(token.source.slice(1).trim()) || templateLines.has(token.source.trimEnd()))
    .map((token) => ({
      from: lineStart(oldSource, token.offset) - fromSetup,
      to: oldSource.indexOf("\n", token.offset) + 1 - fromSetup,
      text: ""
    }));
  const customerSetup = applySourceEdits(oldSource.slice(fromSetup, toSetup), oldGuideEdits);
  const guideLine = (token) => " ".repeat(token.indent) + token.source + newline;
  const setupOpen = guide.filter((token) => token.source.slice(1).trim() !== setupEnd).map(guideLine).join("");
  const setupClose = guide.filter((token) => token.source.slice(1).trim() === setupEnd).map(guideLine).join("");
  const postComment = oldBounds.postStart < oldItems.length ? postCommentTokens(oldSteps).at(-1) : undefined;
  const oldPostEnd = postComment ? oldSource.indexOf("\n", postComment.offset) + 1 || oldSource.length : oldItems.at(-1).range[2];
  const edits = [
    {
      from: newItems[newBounds.run].range[2],
      to: newItems.at(-1).range[2],
      text: oldSource.slice(oldItems[oldBounds.postStart - 1].range[2], oldPostEnd)
    },
    {
      from: newItems[newBounds.open].range[2],
      to: lineStart(newSource, newItems[newBounds.run].range[0]),
      text: setupOpen + customerSetup + setupClose
    }
  ];
  if (customerRunsOn) {
    // Copy from the end of the runs-on key, so a block list or map keeps its own line breaks.
    const runsOnPair = (doc) => doc.getIn(["jobs", "eval"], true)?.items?.find((pair) => pair.key?.value === "runs-on");
    const oldPair = runsOnPair(oldDoc);
    const newPair = runsOnPair(newDoc);
    if (![oldPair?.key, oldPair?.value, newPair?.key, newPair?.value].every((node) => Array.isArray(node?.range))) return null;
    // A block value's range ends after its last newline and a plain value's does not, so both
    // sides run to the end of that line (which also keeps a trailing comment).
    const lineEnd = (source, offset) => {
      if (source[offset - 1] === "\n") return offset;
      const next = source.indexOf("\n", offset);
      return next === -1 ? source.length : next + 1;
    };
    edits.push({
      from: newPair.key.range[1],
      to: lineEnd(newSource, newPair.value.range[1]),
      text: oldSource.slice(oldPair.key.range[1], lineEnd(oldSource, oldPair.value.range[1]))
    });
  }
  if (edits.some((edit) => edit.to < edit.from)) return null;
  return applySourceEdits(newSource, edits.map((edit) => ({ ...edit, text: sameEndings(edit.text) })));
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
      if (file.delete) {
        // A deletion stages a backup only, so a failed commit can restore the file.
        const entry = { path: file.path, previous, next: null, backup: null, delete: true };
        staged.push(entry);
        if (previous === null) continue;
        changes.push({ action: "deleted", path: file.path });
        entry.backup = file.path + `.benchrouter-${randomUUID()}.previous`;
        await stage(entry, "backup", previous.content, previous.stat.mode & 0o777);
        continue;
      }
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
          if (file.delete && file.previous) {
            await requirePreimage(context, file.path, file.previous);
            await rm((await destination(context, file.path)).target);
            applied.push(file);
            file.installed = null;
            continue;
          }
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

// The CLI-side kit changes an upgrade makes besides the server's files: the local scripts, the
// .gitignore lines for the local runtime files, and deletion of the committed legacy copies.
// init passes the packet's package.json instructions and the paths it already plans.
export function prepareLocalKitFiles(outputDir, { packageJson = { scripts: LOCAL_SCRIPTS }, planned = [] } = {}) {
  return [
    ...preparePackageJson(outputDir, packageJson),
    ...(planned.includes(GITIGNORE_PATH) ? [] : prepareGitignore(outputDir)),
    ...prepareLegacyRuntimeDeletions(outputDir).filter((file) => !planned.includes(file.path))
  ];
}

export function planUpgradeFiles(outputDir, files) {
  return [...prepareUpgradeFiles(outputDir, files), ...prepareLocalKitFiles(outputDir)];
}

export async function applyUpgradePacket({ outputDir, files, onFile }) {
  await (await stageFileApplication({ outputDir, files: planUpgradeFiles(outputDir, files), onFile })).commit();
}

const GITIGNORE_LINES = ["bootstrap.mjs", "trust.json"];

// Adds the local runtime files to .benchrouter/.gitignore. A planned packet copy (init) gets the
// lines too; otherwise the file on disk does, or a new file is created.
export function ensureGitignoreLines(content) {
  const lines = new Set(content.replaceAll("\r\n", "\n").split("\n").map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !lines.has(line) && !lines.has("/" + line));
  if (missing.length === 0) return content;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const base = content === "" || content.endsWith("\n") ? content : content + newline;
  return base + missing.map((line) => line + newline).join("");
}

function prepareGitignore(outputDir) {
  const target = path.join(outputDir, GITIGNORE_PATH);
  const previousContent = existsSync(target) ? readFileSync(target, "utf8") : null;
  const content = ensureGitignoreLines(previousContent ?? "");
  return content === previousContent ? [] : [{ path: GITIGNORE_PATH, previousContent, content }];
}

// Recognizes BenchRouter's own committed copies: trust.json by its schema, the bootstrap by the
// header every released bootstrap has. A file that is not BenchRouter's stays.
function isLegacyRuntimeFile(filePath, content) {
  if (filePath === TRUST_PATH) {
    try { parseTrust(content); return true; } catch { return false; }
  }
  return content.startsWith("#!/usr/bin/env node\n// BenchRouter bootstrap (RUN-001");
}

export function prepareLegacyRuntimeDeletions(outputDir) {
  const deletions = [];
  for (const filePath of [BOOTSTRAP_PATH, TRUST_PATH]) {
    const target = path.join(outputDir, filePath);
    if (!lstatSync(target, { throwIfNoEntry: false })?.isFile()) continue;
    const previousContent = readFileSync(target, "utf8");
    if (isLegacyRuntimeFile(filePath, previousContent)) deletions.push({ path: filePath, previousContent, delete: true });
  }
  return deletions;
}

// Local capture and calibrate: write the vendored bootstrap and trust into the repository's
// .benchrouter/ (gitignored), so the bootstrap's control root is the repository root.
export function writeLocalRuntime(root) {
  if (!lstatSync(path.join(root, ".benchrouter"), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Missing .benchrouter/. Run benchrouter init in this repository first.");
  }
  for (const [filePath, source] of VENDOR_FILES) {
    const target = path.join(root, filePath);
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error(`${filePath} must be a regular file.`);
    writeFileSync(target, readFileSync(source));
  }
  return path.join(root, BOOTSTRAP_PATH);
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
    if (job?.["timeout-minutes"] !== 120) throw new Error("requires a 120-minute job ceiling");
    if (!validRunsOn(job["runs-on"])) throw new Error("requires runs-on: a runner label, a list of labels, or a group/labels object");
    const guard = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
    if (job.if !== guard && job.if !== "${{ " + guard + " }}") throw new Error("requires the same-repository PR guard");
    for (const event of ["pull_request", "push"]) {
      const paths = workflow.on[event].paths;
      if (!Array.isArray(paths) || !paths.includes(".benchrouter/**") || !paths.includes(WORKFLOW_PATH)) throw new Error(`${event} must trigger on the generated kit and workflow`);
    }
    const steps = evalSteps(doc);
    validateCustomerSteps(steps, stubBounds(steps));
  } catch (error) { failures.push(`${WORKFLOW_PATH}: ${error.message}`); }
}
