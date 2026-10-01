import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import { applyUpgradePacket, inspectSignedKit, preparePackageJson, preserveCustomerSetup, stageFileApplication, WORKFLOW_PATH } from "../src/generated-kit.mjs";

const fixtureRoot = new URL("./fixtures/signed-kit/", import.meta.url);
const kit = new Map(await Promise.all([
  [".benchrouter/bootstrap.mjs", "bootstrap.mjs.txt"],
  [".benchrouter/trust.json", "trust.json"],
  [WORKFLOW_PATH, "workflow.yml"]
].map(async ([name, file]) => [name, await readFile(new URL(file, fixtureRoot), "utf8")])));
const cli = new URL("../bin/benchrouter.mjs", import.meta.url);

// A real concurrent writer scheduled between awaited filesystem operations.
// Polling avoids depending on platform watcher quotas shared with other agents.
function observeWrite(target, expected, action) {
  let active = true;
  const poll = () => {
    if (!active) return;
    if (readFileSync(target, "utf8") === expected) { active = false; action(); }
    else setImmediate(poll);
  };
  setImmediate(poll);
  return { close() { active = false; } };
}


async function targetRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "br-cli-kit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of kit) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

function packetFiles() {
  return [...kit, [".benchrouter/README.md", "# BenchRouter\n"]].map(([name, content]) => ({
    path: name, content, sha256: createHash("sha256").update(content).digest("hex")
  }));
}

function customerWorkflow() {
  const doc = parseDocument(kit.get(WORKFLOW_PATH));
  const steps = doc.getIn(["jobs", "eval", "steps"]);
  steps.items.splice(3, 0, doc.createNode({
    name: "Install evaluator tools", if: "github.event_name == 'workflow_dispatch'",
    run: "python --version", env: { EVALUATOR_TOOL_ROOT: ".br-control" }
  }));
  steps.items.push(doc.createNode({
    name: "Report speaker metrics", id: "customer_metrics", if: "always()", shell: "bash",
    run: "node .benchrouter/summarize-speaker-metrics.mjs", env: { METRIC_FORMAT: "json" }
  }));
  return doc.toString();
}

test("RUN-001 refresh keeps customer setup and rejects a step with broader authority", async (t) => {
  const existing = customerWorkflow();
  const next = preserveCustomerSetup(existing, kit.get(WORKFLOW_PATH));
  const parsed = parseDocument(next).toJS();
  assert.deepEqual(parsed.jobs.eval.steps[3], parseDocument(existing).toJS().jobs.eval.steps[3]);
  assert.deepEqual(parsed.jobs.eval.steps.at(-1), parseDocument(existing).toJS().jobs.eval.steps.at(-1));
  const root = await targetRepo(t);
  await writeFile(path.join(root, WORKFLOW_PATH), next);
  const failures = [];
  inspectSignedKit(root, failures);
  assert.deepEqual(failures, []);
  const invalid = parseDocument(existing);
  invalid.setIn(["jobs", "eval", "steps", 3, "if"], "always()");
  assert.throws(() => preserveCustomerSetup(invalid.toString(), kit.get(WORKFLOW_PATH)), /Every customer setup step/);
});

test("RUN-001 doctor refuses unsafe checkout, fork access, or a parallel job", async (t) => {
  const root = await targetRepo(t);
  for (const [keys, value, message] of [
    [["jobs", "eval", "steps", 0, "with", "persist-credentials"], true, /persist-credentials/],
    [["jobs", "eval", "if"], "always()", /same-repository PR guard/],
    [["jobs", "other"], { "runs-on": "ubuntu-24.04", steps: [] }, /exactly one eval job/]
  ]) {
    const doc = parseDocument(kit.get(WORKFLOW_PATH));
    doc.setIn(keys, value);
    await writeFile(path.join(root, WORKFLOW_PATH), doc.toString());
    const failures = [];
    inspectSignedKit(root, failures);
    assert.equal(failures.length, 1);
    assert.match(failures[0], message);
  }
});

test("RUN-001 doctor and refresh refuse altered interpreter wiring before customer writes", async (t) => {
  const root = await targetRepo(t);
  const customerFile = path.join(root, ".benchrouter/customer-report.mjs");
  await writeFile(customerFile, "Customer-authored report\n");
  const canonical = kit.get(WORKFLOW_PATH);
  for (const [keys, value, message] of [
    [["jobs", "eval", "steps", 1, "id"], "customer_node", /canonical Node 24 prefix/],
    [["jobs", "eval", "steps", 1, "with", "node-version"], "22.18.0", /pinned Node 24/],
    [["jobs", "eval", "steps", 1, "with", "cache"], "npm", /pinned Node 24/],
    [["jobs", "eval", "steps", 2, "id"], "benchrouter_node24", /unique step IDs/],
    [["jobs", "eval", "steps", 2, "if"], "always()", /exact unconditional/],
    [["jobs", "eval", "steps", 2, "shell"], "sh", /exact unconditional/],
    [["jobs", "eval", "steps", 2, "run"], "echo node=node >> $GITHUB_OUTPUT", /exact unconditional/],
    [["jobs", "eval", "steps", 3, "run"], "node .br-control/.benchrouter/bootstrap.mjs run", /saved Node 24/],
    [["jobs", "eval", "steps", 3, "run"], '"$BENCHROUTER_BOOTSTRAP_NODE" .br-control/.benchrouter/bootstrap.mjs run; echo done', /saved Node 24/],
    [["jobs", "eval", "steps", 3, "env", "BENCHROUTER_BOOTSTRAP_NODE"], "${{ steps.customer_node.outputs.node }}", /saved Node 24/],
    [["jobs", "eval", "steps", 3, "continue-on-error"], true, /saved Node 24/]
  ]) {
    const doc = parseDocument(canonical);
    doc.setIn(keys, value);
    const invalid = doc.toString();
    await writeFile(path.join(root, WORKFLOW_PATH), invalid);
    const failures = [];
    inspectSignedKit(root, failures);
    assert.equal(failures.length, 1);
    assert.match(failures[0], message);
    assert.throws(() => preserveCustomerSetup(invalid, canonical), message);
    assert.equal(await readFile(customerFile, "utf8"), "Customer-authored report\n");
  }
});

test("RUN-001 refresh preserves customer Node22 and post-step AST without new secret grants", async (t) => {
  const doc = parseDocument(customerWorkflow());
  const steps = doc.getIn(["jobs", "eval", "steps"]);
  steps.items.splice(3, 0, doc.createNode({
    name: "Evaluator Node", id: "customer_node22", if: "${{ github.event_name == 'workflow_dispatch' }}",
    uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    with: { "node-version": "22.18.0", "package-manager-cache": false }
  }));
  const before = doc.toJS().jobs.eval.steps;
  const refreshed = preserveCustomerSetup(doc.toString(), kit.get(WORKFLOW_PATH));
  assert.deepEqual(parseDocument(refreshed).toJS().jobs.eval.steps.slice(3), before.slice(3));
  const root = await targetRepo(t);
  await writeFile(path.join(root, WORKFLOW_PATH), refreshed);
  const failures = [];
  inspectSignedKit(root, failures);
  assert.deepEqual(failures, []);
  doc.setIn(["jobs", "eval", "steps", 6, "id"], "benchrouter_runtime");
  assert.throws(() => preserveCustomerSetup(doc.toString(), kit.get(WORKFLOW_PATH)), /unique step IDs/);
  doc.setIn(["jobs", "eval", "steps", 6, "id"], "customer_metrics");
  doc.setIn(["jobs", "eval", "steps", 6, "env", "ADDED_SECRET"], "${{ secrets.REPORT_SECRET }}");
  assert.throws(() => preserveCustomerSetup(doc.toString(), kit.get(WORKFLOW_PATH)), /must not add secret grants/);
});

test("RUN-001 exact kit apply preserves customer files and checks every digest before writing", async (t) => {
  const root = await targetRepo(t);
  // A real declared route; no server or filesystem double.
  const yaml = `version: 1\nproduct:\n  slug: app\n  repo: example/app\n  default_branch: main\nroutes:\n  - id: chat\n    route_id: app/chat\n    name: Chat\n    code_refs: [src/app.js]\n    seed: {incumbent_model: openai/gpt-4o-mini}\n    call_site: {base_url_env: OPENAI_BASE_URL}\n    eval_pack:\n      command: node .benchrouter/bootstrap.mjs run\n      workflow: .github/workflows/benchrouter-evals.yml\n      scorer: .benchrouter/scorer.chat.js\n      result_schema: benchrouter.result.v1\n      case_refs: [.benchrouter/cases.chat.json]\n`;
  const preserved = new Map([
    [".benchrouter/benchrouter.yml", yaml], [".benchrouter/scorer.chat.js", "module.exports = { score: () => ({ pass: false }) };\n"],
    [".benchrouter/cases.chat.json", "[]\n"], [".benchrouter/SETUP_README.md", "Customer setup guide\n"],
    ["src/app.js", "export const app = true;\n"]
  ]);
  for (const [name, content] of preserved) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  await writeFile(path.join(root, WORKFLOW_PATH), customerWorkflow());
  const files = packetFiles();
  files[3] = { ...files[3], sha256: "0".repeat(64) };
  await assert.rejects(applyUpgradePacket({ outputDir: root, files }), /sha256 does not match/);
  assert.equal(existsSync(path.join(root, ".benchrouter/README.md")), false);
  await applyUpgradePacket({ outputDir: root, files: packetFiles() });
  for (const [name, content] of preserved) assert.equal(await readFile(path.join(root, name), "utf8"), content);
  assert.equal(existsSync(path.join(root, ".benchrouter/.kit-state.json")), false);
  const workflow = parseDocument(await readFile(path.join(root, WORKFLOW_PATH), "utf8")).toJS();
  assert.equal(workflow.jobs.eval.steps[3].name, "Install evaluator tools");
  assert.equal(workflow.jobs.eval.steps.at(-1).name, "Report speaker metrics");
});

test("RUN-001 local commands execute the canonical bootstrap and refuse invalid trust before network access", async (t) => {
  const root = await targetRepo(t);
  await writeFile(path.join(root, ".benchrouter/trust.json"), "{}\n");
  for (const command of ["capture", "calibrate", "run"]) {
    const result = spawnSync(process.execPath, [cli.pathname, command], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /trust|schema/);
    assert.doesNotMatch(result.stderr, /Unknown command|fetch failed/);
  }
});

test("RUN-001 read-only trust fails preflight without changing an earlier kit file", async (t) => {
  const root = await targetRepo(t);
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), `version: 1\nproduct: {slug: app, repo: example/app, default_branch: main}\nroutes:\n  - id: chat\n    route_id: app/chat\n    name: Chat\n    code_refs: [src/app.js]\n    seed: {incumbent_model: openai/gpt-4o-mini}\n    call_site: {base_url_env: OPENAI_BASE_URL}\n    eval_pack:\n      workflow: .github/workflows/benchrouter-evals.yml\n      scorer: .benchrouter/scorer.chat.js\n      result_schema: benchrouter.result.v1\n      case_refs: [.benchrouter/cases.chat.json]\n`);
  const before = new Map(packetFiles().map((file) => [file.path, file.content + "\n"]));
  for (const [name, content] of before) await writeFile(path.join(root, name), content);
  await chmod(path.join(root, ".benchrouter/trust.json"), 0o400);
  await assert.rejects(applyUpgradePacket({ outputDir: root, files: packetFiles() }), { code: "EACCES" });
  for (const [name, content] of before) assert.equal(await readFile(path.join(root, name), "utf8"), content);
});

test("RUN-001 stale destination preflight preserves kit and package bytes without writing", async (t) => {
  const root = await targetRepo(t);
  const readme = ".benchrouter/README.md";
  await writeFile(path.join(root, readme), "Customer README before upgrade\n");
  await chmod(path.join(root, readme), 0o640);
  const previousPackage = '{"scripts":{"test":"node --test"},"dependencies":{"customer-tool":"1.0.0"}}\n';
  await writeFile(path.join(root, "package.json"), previousPackage);
  const application = await stageFileApplication({ outputDir: root, files: [
    { path: readme, content: "Generated README\n" },
    ...preparePackageJson(root, { scripts: { "benchrouter:capture": "node .benchrouter/bootstrap.mjs capture" } }),
    { path: ".benchrouter/new-file.txt", content: "New generated file\n" },
    { path: ".benchrouter/trust.json", content: kit.get(".benchrouter/trust.json") + "\n" }
  ] });
  // A real destination change after staging refuses the entire stale transaction.
  const trust = path.join(root, ".benchrouter/trust.json");
  await rename(trust, trust + ".customer-save");
  await mkdir(trust);
  await assert.rejects(application.commit(), (error) => ["EISDIR", "ENOTEMPTY", "EEXIST"].includes(error.code));
  assert.equal(await readFile(path.join(root, readme), "utf8"), "Customer README before upgrade\n");
  assert.equal((await stat(path.join(root, readme))).mode & 0o777, 0o640);
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), previousPackage);
  assert.equal(existsSync(path.join(root, ".benchrouter/new-file.txt")), false);
  await rm(trust, { recursive: true });
  await rename(trust + ".customer-save", trust);
});

test("RUN-001 staging refuses package edits made after planning or before commit", async (t) => {
  const root = await targetRepo(t);
  const target = path.join(root, "package.json");
  const original = '{"scripts":{"test":"node --test"}}';
  const customerEdit = '{"scripts":{"test":"node --test","lint":"eslint ."},"dependencies":{"customer-tool":"1.0.0"}}';
  await writeFile(target, original);
  const planned = preparePackageJson(root, { scripts: { "benchrouter:capture": "node .benchrouter/bootstrap.mjs capture" } });
  await writeFile(target, customerEdit);
  await assert.rejects(stageFileApplication({ outputDir: root, files: planned }), /changed since planning/);
  assert.equal(await readFile(target, "utf8"), customerEdit);
  await writeFile(target, original);
  const application = await stageFileApplication({ outputDir: root, files: preparePackageJson(root, { scripts: { capture: "customer command" } }) });
  await writeFile(target, customerEdit);
  await assert.rejects(application.commit(), /changed since staging/);
  assert.equal(await readFile(target, "utf8"), customerEdit);
});

test("RUN-001 a newly created destination or an edited unchanged file refuses the whole commit", async (t) => {
  const root = await targetRepo(t);
  const unchanged = ".benchrouter/trust.json";
  const before = await readFile(path.join(root, unchanged), "utf8");
  for (const change of ["create", "edit unchanged"]) {
    await rm(path.join(root, "package.json"), { force: true });
    await writeFile(path.join(root, unchanged), before);
    const application = await stageFileApplication({ outputDir: root, files: [
      { path: unchanged, content: before }, { path: "package.json", content: "{}\n" }
    ] });
    if (change === "create") await writeFile(path.join(root, "package.json"), "Customer-created file\n");
    else await writeFile(path.join(root, unchanged), "Customer edit\n");
    await assert.rejects(application.commit(), /changed since staging/);
    if (change === "create") assert.equal(await readFile(path.join(root, "package.json"), "utf8"), "Customer-created file\n");
    else {
      assert.equal(await readFile(path.join(root, unchanged), "utf8"), "Customer edit\n");
      assert.equal(existsSync(path.join(root, "package.json")), false);
    }
  }
});

test("RUN-001 a symlinked ancestor is refused before staging and again before commit or cleanup", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "br-cli-boundary-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo");
  const outside = path.join(parent, "other-repo");
  await mkdir(root); await mkdir(outside);
  const target = path.join(outside, "README.md");
  await writeFile(target, "Unrelated customer file\n");
  await symlink(outside, path.join(root, ".benchrouter"), "dir");
  await assert.rejects(stageFileApplication({ outputDir: root, files: [{ path: ".benchrouter/README.md", content: "Generated content\n" }] }), /symlink ancestor/);
  await rm(path.join(root, ".benchrouter"));
  await mkdir(path.join(root, ".benchrouter"));
  await writeFile(path.join(root, ".benchrouter/README.md"), "Old kit\n");
  const application = await stageFileApplication({ outputDir: root, files: [{ path: ".benchrouter/README.md", content: "Generated content\n" }] });
  await rename(path.join(root, ".benchrouter"), path.join(root, ".customer-saved-kit"));
  await symlink(outside, path.join(root, ".benchrouter"), "dir");
  await assert.rejects(application.commit(), (error) => error instanceof AggregateError && error.errors.some((cause) => cause.message.includes("symlink ancestor")));
  assert.equal(await readFile(target, "utf8"), "Unrelated customer file\n");
  assert.equal(await readFile(path.join(root, ".customer-saved-kit/README.md"), "utf8"), "Old kit\n");
});

test("RUN-001 caught commit failure restores untouched writes and preserves later customer edits", async (t) => {
  const root = await targetRepo(t);
  const readme = path.join(root, ".benchrouter/README.md");
  const last = path.join(root, ".benchrouter/last-file.txt");
  const packagePath = path.join(root, "package.json");
  await writeFile(readme, "Old README\n");
  await writeFile(packagePath, '{"scripts":{"test":"node --test"}}\n');
  await writeFile(last, "Old final file\n");
  const originalPackage = await readFile(packagePath, "utf8");
  const application = await stageFileApplication({ outputDir: root, files: [
    { path: ".benchrouter/README.md", content: "Generated README\n" },
    ...preparePackageJson(root, { scripts: { capture: "customer command" } }),
    { path: ".benchrouter/created.txt", content: "New file\n" },
    { path: ".benchrouter/last-file.txt", content: "Final generated file\n" }
  ] });
  let customerWrote = false;
  const observer = observeWrite(readme, "Generated README\n", () => {
    customerWrote = true;
    writeFileSync(readme, "Concurrent customer README\n");
    unlinkSync(last); mkdirSync(last);
  });
  try {
    await assert.rejects(application.commit(), (error) => error instanceof AggregateError && error.errors.some((cause) => cause.message.includes("changed since staging")));
  } finally { observer.close(); }
  assert.equal(customerWrote, true, "the real filesystem observer must exercise the concurrent edit");
  assert.equal(await readFile(readme, "utf8"), "Concurrent customer README\n");
  assert.equal(await readFile(packagePath, "utf8"), originalPackage);
  assert.equal(existsSync(path.join(root, ".benchrouter/created.txt")), false);
});

test("RUN-001 rollback refuses an ancestor replacement and leaves its referent unchanged", async (t) => {
  const root = await targetRepo(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "br-cli-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "README.md"), "Unrelated customer README\n");
  const readme = path.join(root, ".benchrouter/README.md");
  await writeFile(readme, "Old README\n");
  const application = await stageFileApplication({ outputDir: root, files: [
    { path: ".benchrouter/README.md", content: "Generated README\n" },
    { path: ".benchrouter/trust.json", content: kit.get(".benchrouter/trust.json") + "\n" }
  ] });
  let moved = false;
  const observer = observeWrite(readme, "Generated README\n", () => {
    moved = true;
    renameSync(path.join(root, ".benchrouter"), path.join(root, ".customer-saved-kit"));
    // Creating the symlink synchronously keeps the observed boundary change
    // complete before the application performs its next awaited filesystem read.
    symlinkSync(outside, path.join(root, ".benchrouter"), "dir");
  });
  try { await assert.rejects(application.commit(), AggregateError); }
  finally { observer.close(); }
  assert.equal(moved, true);
  assert.equal(await readFile(path.join(outside, "README.md"), "utf8"), "Unrelated customer README\n");
});

test("RUN-001 staged package merge keeps customer commands and dependencies", async (t) => {
  const root = await targetRepo(t);
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: { test: "node --test" }, dependencies: { yaml: "2.8.1" }, devDependencies: { eslint: "9.0.0" }
  }));
  await (await stageFileApplication({ outputDir: root, files: preparePackageJson(root, {
    scripts: { "benchrouter:calibrate": "node .benchrouter/bootstrap.mjs calibrate" }, dev_dependencies: ["yaml", "eslint"]
  }) })).commit();
  const updated = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(updated.scripts, { test: "node --test", "benchrouter:calibrate": "node .benchrouter/bootstrap.mjs calibrate" });
  assert.deepEqual(updated.dependencies, { yaml: "2.8.1" });
  assert.deepEqual(updated.devDependencies, { eslint: "9.0.0" });
});
