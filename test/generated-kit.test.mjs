import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import { applyUpgradePacket, inspectSignedKit, preserveCustomerSetup, WORKFLOW_PATH } from "../src/generated-kit.mjs";

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
