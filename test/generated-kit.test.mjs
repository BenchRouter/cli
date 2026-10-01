import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  steps.items.splice(2, 0, doc.createNode({
    name: "Install evaluator tools", if: "github.event_name == 'workflow_dispatch'",
    run: "python --version", env: { EVALUATOR_TOOL_ROOT: ".br-control" }
  }));
  return doc.toString();
}

test("RUN-001 refresh keeps customer setup and rejects a step with broader authority", async (t) => {
  const existing = customerWorkflow();
  const next = preserveCustomerSetup(existing, kit.get(WORKFLOW_PATH));
  const parsed = parseDocument(next).toJS();
  assert.deepEqual(parsed.jobs.eval.steps[2], parseDocument(existing).toJS().jobs.eval.steps[2]);
  const root = await targetRepo(t);
  await writeFile(path.join(root, WORKFLOW_PATH), next);
  const failures = [];
  inspectSignedKit(root, failures);
  assert.deepEqual(failures, []);
  const invalid = parseDocument(existing);
  invalid.setIn(["jobs", "eval", "steps", 2, "if"], "always()");
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
  assert.equal(workflow.jobs.eval.steps[2].name, "Install evaluator tools");
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

test("RUN-001 caught rename failure restores kit and package bytes and removes new files", async (t) => {
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
  // Real I/O race after staging: another process replaces the final destination
  // with a directory. The preceding writes must be restored when rename fails.
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
