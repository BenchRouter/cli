import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument } from "yaml";
import { applyUpgradePacket, inspectSignedKit, LOCAL_SCRIPTS, preparePackageJson, preserveCustomerSetup, stageFileApplication, WORKFLOW_PATH } from "../src/generated-kit.mjs";

const fixtureRoot = new URL("./fixtures/signed-kit/", import.meta.url);
const fixture = (file) => readFile(new URL(file, fixtureRoot), "utf8");
const kit = new Map([[WORKFLOW_PATH, await fixture("workflow.yml")]]);
// The kit before the eval-action stub: committed bootstrap and trust, and the long workflow.
const legacyKit = new Map([
  [".benchrouter/bootstrap.mjs", await fixture("bootstrap.mjs.txt")],
  [".benchrouter/trust.json", await fixture("trust.json")],
  [WORKFLOW_PATH, await fixture("workflow-legacy.yml")]
]);
const vendored = (file) => readFile(new URL(`../src/vendor/${file}`, import.meta.url), "utf8");
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


async function targetRepo(t, files = kit) {
  const root = await mkdtemp(path.join(os.tmpdir(), "br-cli-kit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  for (const [name, content] of files) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

// A real git index, so the upgrade sees the legacy files as committed.
function gitTrack(root, files) {
  for (const args of [["init", "-q"], ["add", "--", ...files]]) {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
}

const legacyManifest = `version: 1\nproduct: {slug: app, repo: example/app, default_branch: main}\nroutes:\n  - id: chat\n    route_id: app/chat\n    name: Chat\n    code_refs: [src/app.js]\n    seed: {incumbent_model: openai/gpt-4o-mini}\n    call_site: {base_url_env: OPENAI_BASE_URL}\n    eval_pack:\n      workflow: .github/workflows/benchrouter-evals.yml\n      scorer: .benchrouter/scorer.chat.js\n      result_schema: benchrouter.result.v1\n      case_refs: [.benchrouter/cases.chat.json]\n`;

function packetFiles() {
  return [...kit, [".benchrouter/README.md", "# BenchRouter\n"]].map(([name, content]) => ({
    path: name, content, sha256: createHash("sha256").update(content).digest("hex")
  }));
}

function customerWorkflow() {
  const doc = parseDocument(kit.get(WORKFLOW_PATH));
  const steps = doc.getIn(["jobs", "eval", "steps"]);
  steps.items.splice(1, 0, doc.createNode({
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
  assert.deepEqual(parsed.jobs.eval.steps[1], parseDocument(existing).toJS().jobs.eval.steps[1]);
  assert.deepEqual(parsed.jobs.eval.steps.at(-1), parseDocument(existing).toJS().jobs.eval.steps.at(-1));
  const root = await targetRepo(t);
  await writeFile(path.join(root, WORKFLOW_PATH), next);
  const failures = [];
  inspectSignedKit(root, failures);
  assert.deepEqual(failures, []);
  const invalid = parseDocument(existing);
  invalid.setIn(["jobs", "eval", "steps", 1, "if"], "always()");
  assert.throws(() => preserveCustomerSetup(invalid.toString(), kit.get(WORKFLOW_PATH)), /Every customer setup step/);
});

function handFormattedCustomerWorkflow(source, runsOn = "runs-on: [self-hosted, gcp]\n") {
  const setup = [
    "      - name: Install evaluator tools   # pinned by the eval owner",
    "        if: ${{ github.event_name == 'workflow_dispatch' }}",
    "        run: |",
    "          python -m pip install --requirement .benchrouter/evaluator-requirements.txt --no-deps --disable-pip-version-check",
    "          python --version",
    "      # keep the next step last",
    "      - {name: Warm cache, if: github.event_name == 'workflow_dispatch', run: echo warm}",
    ""
  ].join("\n");
  const post = [
    "      - name: Report speaker metrics",
    "        if: always()",
    "        run: >-",
    "          node .benchrouter/summarize-speaker-metrics.mjs",
    "          --format json",
    ""
  ].join("\n");
  const marker = "      # ---- end customer-setup ----\n";
  assert.ok(source.includes(marker) && source.includes("runs-on: ubuntu-24.04\n"));
  return source.replace(marker, setup + marker).replace("runs-on: ubuntu-24.04\n", runsOn) + post;
}

test("refresh copies customer sections as written and keeps BenchRouter's bytes", () => {
  const generated = kit.get(WORKFLOW_PATH);
  const existing = handFormattedCustomerWorkflow(generated);
  assert.equal(preserveCustomerSetup(existing, generated), existing);
  const runtimeLine = "          BENCHROUTER_KIT_VERSION: 0.1.0\n";
  const marked = "          BENCHROUTER_KIT_VERSION: 0.1.1\n";
  const nextKit = generated.replace(runtimeLine, marked);
  assert.notEqual(nextKit, generated);
  assert.equal(preserveCustomerSetup(existing, nextKit), existing.replace(runtimeLine, marked));
});

test("refresh keeps a block-list or block-map runner as written", () => {
  const generated = kit.get(WORKFLOW_PATH);
  for (const runsOn of [
    "runs-on:\n      - self-hosted\n      - gcp   # our pool\n",
    "runs-on:\n      group: gcp-runners\n      labels: [linux, x64]\n"
  ]) {
    const existing = handFormattedCustomerWorkflow(generated, runsOn);
    assert.equal(preserveCustomerSetup(existing, generated), existing, runsOn);
  }
});

test("refresh of a CRLF workflow writes the kit's LF line endings", () => {
  const generated = kit.get(WORKFLOW_PATH);
  const existing = handFormattedCustomerWorkflow(generated);
  assert.equal(preserveCustomerSetup(existing.replaceAll("\n", "\r\n"), generated), existing);
});

test("refresh keeps the SnapApp runner comment and blocks above surviving keys", () => {
  const generated = kit.get(WORKFLOW_PATH);
  const runner = [
    "    # The tic-tac-toe UX eval drives headless Chrome. The runner",
    "    # pool's image has it at /usr/bin/google-chrome-stable.",
    "    runs-on: [self-hosted, linux, x64, gcp-chrome] # Chrome is preinstalled",
    ""
  ].join("\n");
  const existing = generated
    .replace("    runs-on: ubuntu-24.04\n", runner)
    .replace("    timeout-minutes: 120", "    # Leave enough time for the suite.\n    timeout-minutes: 120")
    .replace("  id-token: write", "  # Used for token exchange.\n  id-token: write")
    .replace("  contents: read", "  contents: read\n  # Old permission.\n  actions: read");
  const updatedTemplate = generated.replace("    timeout-minutes: 120", "    # BenchRouter job ceiling.\n    timeout-minutes: 120");
  const refreshed = preserveCustomerSetup(existing, updatedTemplate);
  assert.ok(refreshed.includes(runner));
  assert.ok(refreshed.includes("    # BenchRouter job ceiling.\n    # Leave enough time for the suite.\n    timeout-minutes: 120\n"));
  assert.ok(refreshed.includes("  # Used for token exchange.\n  id-token: write\n"));
  assert.ok(!refreshed.includes("# Old permission."));
  assert.equal(preserveCustomerSetup(refreshed, updatedTemplate), refreshed);
});

test("refresh keeps comments in setup and post steps and updates the template setup guide", () => {
  const generated = kit.get(WORKFLOW_PATH);
  const existing = handFormattedCustomerWorkflow(generated, "runs-on: ubuntu-24.04 # Available on GitHub-hosted runners\n")
    .replace("        run: |\n          python", "        # Use the repo's pinned requirements.\n        run: |\n          python")
    .replace("      - name: Report speaker metrics", "      # Report these even if the eval fails.\n      - name: Report speaker metrics")
    + "      # End of repo post steps.\n";
  const guide = "Replay-only repos need no customer setup.";
  const revisedGuide = "Replay-only repos need no customer setup. Leave this section empty.";
  const updatedTemplate = generated.replace(guide, revisedGuide);
  assert.equal(preserveCustomerSetup(existing, updatedTemplate), existing.replace(guide, revisedGuide));
  assert.equal(preserveCustomerSetup(existing.replaceAll("\n", "\r\n"), updatedTemplate), existing.replace(guide, revisedGuide));
});

test("refresh keeps a post-step comment and the dedented comment above the next job key", () => {
  const generated = kit.get(WORKFLOW_PATH);
  const postStep = "      # Report after the eval.\n      - run: echo ok\n";
  const jobName = "    # This name appears in branch protection.\n";
  for (const end of ["", "      # End of repo post steps.\n"]) {
    const existing = generated + postStep + end + jobName + "    name: Old name\n";
    assert.equal(
      preserveCustomerSetup(existing, generated + "    name: New name\n"),
      generated + postStep + end + jobName + "    name: New name\n"
    );
  }
});

test("refresh retains a runner alias's value and comment when the kit removes its anchor", () => {
  const generated = kit.get(WORKFLOW_PATH);
  const existing = generated
    .replace("name: BenchRouter Evals", "name: &runner gcp-chrome")
    .replace("runs-on: ubuntu-24.04", "runs-on: *runner # Chrome is preinstalled");
  const refreshed = preserveCustomerSetup(existing, generated);
  assert.equal(parseDocument(refreshed).toJS().jobs.eval["runs-on"], "gcp-chrome");
  assert.ok(refreshed.includes("runs-on: gcp-chrome # Chrome is preinstalled\n"));
});

test("SETUP-001 doctor and refresh keep a customer runs-on and still check the rest of the job", async (t) => {
  const root = await targetRepo(t);
  const canonical = kit.get(WORKFLOW_PATH);
  const check = async (source) => {
    await writeFile(path.join(root, WORKFLOW_PATH), source);
    const failures = [];
    inspectSignedKit(root, failures);
    return failures;
  };
  for (const base of [canonical, customerWorkflow()]) {
    for (const runsOn of ["gcp-eval", ["self-hosted", "linux", "gcp"], { group: "gcp-runners", labels: ["linux"] }]) {
      const doc = parseDocument(base);
      doc.setIn(["jobs", "eval", "runs-on"], runsOn);
      const refreshed = preserveCustomerSetup(doc.toString(), canonical);
      assert.deepEqual(parseDocument(refreshed).toJS().jobs.eval, { ...doc.toJS().jobs.eval, "runs-on": runsOn });
      assert.deepEqual(await check(refreshed), []);
    }
  }
  for (const [keys, value, message] of [
    [["jobs", "eval", "runs-on"], [], /runs-on/],
    [["jobs", "eval", "runs-on"], { group: "gcp-runners", env: "prod" }, /runs-on/],
    [["jobs", "eval", "timeout-minutes"], 360, /120-minute job ceiling/],
    [["jobs", "eval", "steps", 0, "uses"], "BenchRouter/eval-action/prepare@main", /v1 or commit SHA/]
  ]) {
    const doc = parseDocument(canonical);
    doc.setIn(["jobs", "eval", "runs-on"], ["self-hosted", "gcp"]);
    doc.setIn(keys, value);
    const failures = await check(doc.toString());
    assert.equal(failures.length, 1);
    assert.match(failures[0], message);
  }
  const invalid = parseDocument(canonical);
  invalid.setIn(["jobs", "eval", "runs-on"], []);
  assert.equal(preserveCustomerSetup(invalid.toString(), canonical), canonical);
});

test("RUN-001 doctor refuses fork access, a parallel job, or concurrency", async (t) => {
  const root = await targetRepo(t);
  for (const [keys, value, message] of [
    [["concurrency"], "evals", /no concurrency or matrix/],
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

test("SETUP-001 doctor accepts the stub at v1 or one pinned commit SHA, with BenchRouter's runtime env", async (t) => {
  const root = await targetRepo(t);
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const doc = parseDocument(kit.get(WORKFLOW_PATH));
  doc.setIn(["jobs", "eval", "steps", 0, "uses"], `BenchRouter/eval-action/prepare@${sha}`);
  doc.setIn(["jobs", "eval", "steps", 1, "uses"], `BenchRouter/eval-action@${sha}`);
  doc.setIn(["jobs", "eval", "steps", 1, "env", "EVAL_API_KEY"], "${{ github.event_name == 'workflow_dispatch' && secrets.EVAL_API_KEY || '' }}");
  doc.setIn(["jobs", "eval", "steps", 1, "env", "BENCHROUTER_INSTALL_NPM_TOKEN"], "${{ github.event_name == 'workflow_dispatch' && secrets.NPM_TOKEN || '' }}");
  for (const source of [kit.get(WORKFLOW_PATH), doc.toString()]) {
    await writeFile(path.join(root, WORKFLOW_PATH), source);
    const failures = [];
    inspectSignedKit(root, failures);
    assert.deepEqual(failures, []);
    assert.equal(preserveCustomerSetup(source, source), source);
  }
});

test("RUN-001 doctor and refresh refuse altered stub wiring before customer writes", async (t) => {
  const root = await targetRepo(t);
  const customerFile = path.join(root, ".benchrouter/customer-report.mjs");
  await writeFile(customerFile, "Customer-authored report\n");
  const canonical = kit.get(WORKFLOW_PATH);
  const sha = "0123456789abcdef0123456789abcdef01234567";
  for (const [keys, value, message] of [
    [["jobs", "eval", "steps", 0, "id"], "customer_prepare", /prepare step first/],
    [["jobs", "eval", "steps", 0, "uses"], "BenchRouter/eval-action/prepare@v2", /v1 or commit SHA/],
    [["jobs", "eval", "steps", 0, "uses"], "BenchRouter/eval-action/prepare@0123456789ABCDEF0123456789ABCDEF01234567", /v1 or commit SHA/],
    [["jobs", "eval", "steps", 0, "if"], "always()", /unconditional/],
    [["jobs", "eval", "steps", 0, "with"], { ref: "main" }, /unconditional/],
    [["jobs", "eval", "steps", 1, "uses"], `BenchRouter/eval-action@${sha}`, /must run BenchRouter\/eval-action@v1/],
    [["jobs", "eval", "steps", 1, "uses"], "Customer/eval-action@v1", /must run/],
    [["jobs", "eval", "steps", 1, "with", "node"], "${{ steps.customer_node.outputs.node }}", /prepared Node 24/],
    [["jobs", "eval", "steps", 1, "continue-on-error"], true, /prepared Node 24/],
    [["jobs", "eval", "steps", 1, "env", "BENCHROUTER_BOOTSTRAP_NODE"], "/usr/bin/node", /runtime step env/],
    [["jobs", "eval", "steps", 1, "env", "EVAL_API_KEY"], "${{ secrets.EVAL_API_KEY }}", /runtime step env/],
    [["jobs", "eval", "steps", 1, "env", "BENCHROUTER_JOB_CEILING_MIN"], "360", /runtime step env/],
    [["jobs", "eval", "steps", 1, "id"], "benchrouter_prepare", /unique step IDs/]
  ]) {
    const doc = parseDocument(canonical);
    doc.setIn(keys, value);
    const invalid = doc.toString();
    await writeFile(path.join(root, WORKFLOW_PATH), invalid);
    const failures = [];
    inspectSignedKit(root, failures);
    assert.equal(failures.length, 1, String(value));
    assert.match(failures[0], message);
    assert.throws(() => preserveCustomerSetup(invalid, canonical), message);
    assert.equal(await readFile(customerFile, "utf8"), "Customer-authored report\n");
  }
  // A legacy workflow is readable for the upgrade, but doctor names the upgrade.
  await writeFile(path.join(root, WORKFLOW_PATH), legacyKit.get(WORKFLOW_PATH));
  const failures = [];
  inspectSignedKit(root, failures);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /before the BenchRouter eval action\. Run benchrouter upgrade/);
});

test("RUN-001 refresh preserves customer Node22 and post-step AST without new secret grants", async (t) => {
  const doc = parseDocument(customerWorkflow());
  const steps = doc.getIn(["jobs", "eval", "steps"]);
  steps.items.splice(1, 0, doc.createNode({
    name: "Evaluator Node", id: "customer_node22", if: "${{ github.event_name == 'workflow_dispatch' }}",
    uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    with: { "node-version": "22.18.0", "package-manager-cache": false }
  }));
  const before = doc.toJS().jobs.eval.steps;
  const refreshed = preserveCustomerSetup(doc.toString(), kit.get(WORKFLOW_PATH));
  assert.deepEqual(parseDocument(refreshed).toJS().jobs.eval.steps.slice(1), before.slice(1));
  const root = await targetRepo(t);
  await writeFile(path.join(root, WORKFLOW_PATH), refreshed);
  const failures = [];
  inspectSignedKit(root, failures);
  assert.deepEqual(failures, []);
  doc.setIn(["jobs", "eval", "steps", 4, "id"], "benchrouter_runtime");
  assert.throws(() => preserveCustomerSetup(doc.toString(), kit.get(WORKFLOW_PATH)), /unique step IDs/);
  doc.setIn(["jobs", "eval", "steps", 4, "id"], "customer_metrics");
  for (const expression of [
    "${{ secrets.REPORT_SECRET }}", "${{ secrets['REPORT_SECRET'] }}",
    "${{ secrets [ 'REPORT_SECRET' ] }}", "${{ toJSON(secrets) }}",
    "${{ SECRETS.REPORT_SECRET }}", "${{ format('}} {0}', secrets['REPORT_SECRET']) }}"
  ]) {
    doc.setIn(["jobs", "eval", "steps", 4, "env", "ADDED_SECRET"], expression);
    const invalid = doc.toString();
    assert.throws(() => preserveCustomerSetup(invalid, kit.get(WORKFLOW_PATH)), /must not add secret grants/);
    await writeFile(path.join(root, WORKFLOW_PATH), invalid);
    const failures = [];
    inspectSignedKit(root, failures);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /must not add secret grants/);
  }
  doc.deleteIn(["jobs", "eval", "steps", 4, "env", "ADDED_SECRET"]);
  doc.setIn(["jobs", "eval", "steps", 4, "if"], "always() && secrets['REPORT_SECRET'] != ''");
  assert.throws(() => preserveCustomerSetup(doc.toString(), kit.get(WORKFLOW_PATH)), /must not add secret grants/);
  doc.setIn(["jobs", "eval", "steps", 4, "if"], "always()");
  doc.setIn(["jobs", "eval", "steps", 4, "name"], "Report secrets inventory");
  doc.setIn(["jobs", "eval", "steps", 4, "run"], "node scripts/report-secrets-inventory.mjs");
  assert.equal(parseDocument(preserveCustomerSetup(doc.toString(), kit.get(WORKFLOW_PATH))).toJS().jobs.eval.steps.at(-1).name, "Report secrets inventory");
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
  files[1] = { ...files[1], sha256: "0".repeat(64) };
  await assert.rejects(applyUpgradePacket({ outputDir: root, files }), /sha256 does not match/);
  assert.equal(existsSync(path.join(root, ".benchrouter/README.md")), false);
  await applyUpgradePacket({ outputDir: root, files: packetFiles() });
  for (const [name, content] of preserved) assert.equal(await readFile(path.join(root, name), "utf8"), content);
  assert.equal(existsSync(path.join(root, ".benchrouter/.kit-state.json")), false);
  const workflow = parseDocument(await readFile(path.join(root, WORKFLOW_PATH), "utf8")).toJS();
  assert.equal(workflow.jobs.eval.steps[1].name, "Install evaluator tools");
  assert.equal(workflow.jobs.eval.steps.at(-1).name, "Report speaker metrics");
});

// A legacy workflow as a customer edited it: setup steps, post steps, a self-hosted runner, comments.
function legacyCustomerWorkflow() {
  const marker = "      # ---- end customer-setup ----\n";
  const source = legacyKit.get(WORKFLOW_PATH);
  assert.ok(source.includes(marker) && source.includes("    runs-on: ubuntu-24.04\n"));
  return source
    .replace("    runs-on: ubuntu-24.04\n", "    # Chrome is preinstalled on this pool.\n    runs-on: [self-hosted, gcp-chrome] # our pool\n")
    .replace(marker, [
      "      # Our evaluator needs Python.",
      "      - name: Install evaluator tools",
      "        if: github.event_name == 'workflow_dispatch'",
      "        run: python --version",
      ""
    ].join("\n") + marker) + [
    "      - name: Upload BenchRouter results",
    "        if: always()",
    "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "        with:",
    "          name: benchrouter-results-${{ github.run_id }}-${{ github.run_attempt }}",
    "          path: .br-results",
    "      # Report these even if the eval fails.",
    "      - name: Report speaker metrics",
    "        if: always()",
    "        run: node scripts/report.mjs",
    ""
  ].join("\n");
}

test("SETUP-001 upgrade migrates a legacy kit: setup, post steps, runner and comments move into the stub", async (t) => {
  const root = await targetRepo(t, legacyKit);
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), `version: 1\nproduct: {slug: app, repo: example/app, default_branch: main}\nroutes:\n  - id: chat\n    route_id: app/chat\n    name: Chat\n    code_refs: [src/app.js]\n    seed: {incumbent_model: openai/gpt-4o-mini}\n    call_site: {base_url_env: OPENAI_BASE_URL}\n    eval_pack:\n      workflow: .github/workflows/benchrouter-evals.yml\n      scorer: .benchrouter/scorer.chat.js\n      result_schema: benchrouter.result.v1\n      case_refs: [.benchrouter/cases.chat.json]\n`);
  await writeFile(path.join(root, ".benchrouter/.gitignore"), "results*.jsonl\nresults/\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {
    test: "node --test", "benchrouter:capture": "node .benchrouter/bootstrap.mjs capture", "benchrouter:calibrate": "node .benchrouter/bootstrap.mjs calibrate"
  } }));
  await writeFile(path.join(root, WORKFLOW_PATH), legacyCustomerWorkflow());
  gitTrack(root, [".benchrouter/bootstrap.mjs", ".benchrouter/trust.json"]);
  const changes = [];
  await applyUpgradePacket({ outputDir: root, files: packetFiles(), onFile: (action, file) => changes.push(`${action} ${file}`) });
  const migrated = await readFile(path.join(root, WORKFLOW_PATH), "utf8");
  const steps = parseDocument(migrated).toJS().jobs.eval.steps;
  assert.deepEqual(steps.map((step) => step.name), ["Prepare BenchRouter", "Install evaluator tools", "Run BenchRouter", "Report speaker metrics"]);
  assert.deepEqual(parseDocument(migrated).toJS().jobs.eval["runs-on"], ["self-hosted", "gcp-chrome"]);
  for (const text of ["    # Chrome is preinstalled on this pool.\n", "runs-on: [self-hosted, gcp-chrome] # our pool\n",
    "      # Our evaluator needs Python.\n", "      # Report these even if the eval fails.\n", "      # ---- end customer-setup ----\n"]) {
    assert.ok(migrated.includes(text), text);
  }
  assert.equal(migrated.split("---- end customer-setup ----").length, 2);
  const failures = [];
  inspectSignedKit(root, failures);
  assert.deepEqual(failures, []);
  assert.equal(existsSync(path.join(root, ".benchrouter/bootstrap.mjs")), false);
  assert.equal(existsSync(path.join(root, ".benchrouter/trust.json")), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts, { test: "node --test", ...LOCAL_SCRIPTS });
  assert.equal(await readFile(path.join(root, ".benchrouter/.gitignore"), "utf8"), "results*.jsonl\nresults/\nbootstrap.mjs\ntrust.json\n");
  assert.ok(changes.includes("deleted .benchrouter/bootstrap.mjs") && changes.includes("deleted .benchrouter/trust.json"), changes.join(", "));
  // A second upgrade of the migrated repo changes nothing.
  assert.equal(preserveCustomerSetup(migrated, kit.get(WORKFLOW_PATH)), migrated);
});

test("SETUP-001 migration drops legacy uploads that follow a customer post step", () => {
  const source = legacyKit.get(WORKFLOW_PATH) + [
    "      - name: Report speaker metrics",
    "        if: always()",
    "        run: node scripts/report.mjs",
    "      - name: Upload BenchRouter results",
    "        if: always()",
    "        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "        with:",
    "          name: benchrouter-results-${{ github.run_id }}-${{ github.run_attempt }}",
    "          path: .br-results",
    ""
  ].join("\n");
  const steps = parseDocument(preserveCustomerSetup(source, kit.get(WORKFLOW_PATH))).toJS().jobs.eval.steps;
  assert.deepEqual(steps.map((step) => step.name), ["Prepare BenchRouter", "Run BenchRouter", "Report speaker metrics"]);
});

test("SETUP-001 refresh keeps a customer's commit SHA pin on both eval-action steps", async (t) => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const template = kit.get(WORKFLOW_PATH);
  const pinned = template.replace("prepare@v1\n", `prepare@${sha}\n`).replace("eval-action@v1\n", `eval-action@${sha}\n`);
  assert.notEqual(pinned, template);
  const nextTemplate = template.replace("BENCHROUTER_KIT_VERSION: 0.1.0", "BENCHROUTER_KIT_VERSION: 0.1.1");
  const refreshed = preserveCustomerSetup(pinned, nextTemplate);
  assert.equal(refreshed, pinned.replace("BENCHROUTER_KIT_VERSION: 0.1.0", "BENCHROUTER_KIT_VERSION: 0.1.1"));
  const root = await targetRepo(t, new Map([[WORKFLOW_PATH, refreshed]]));
  const failures = [];
  inspectSignedKit(root, failures);
  assert.deepEqual(failures, []);
});

test("upgrade keeps a bootstrap or trust file that is not BenchRouter's or is not committed", async (t) => {
  const root = await targetRepo(t);
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), `version: 1\nproduct: {slug: app, repo: example/app, default_branch: main}\nroutes:\n  - id: chat\n    route_id: app/chat\n    name: Chat\n    code_refs: [src/app.js]\n    seed: {incumbent_model: openai/gpt-4o-mini}\n    call_site: {base_url_env: OPENAI_BASE_URL}\n    eval_pack:\n      workflow: .github/workflows/benchrouter-evals.yml\n      scorer: .benchrouter/scorer.chat.js\n      result_schema: benchrouter.result.v1\n      case_refs: [.benchrouter/cases.chat.json]\n`);
  await writeFile(path.join(root, ".benchrouter/bootstrap.mjs"), "console.log('customer tool');\n");
  await writeFile(path.join(root, ".benchrouter/trust.json"), '{"customer": true}\n');
  await applyUpgradePacket({ outputDir: root, files: packetFiles() });
  assert.equal(await readFile(path.join(root, ".benchrouter/bootstrap.mjs"), "utf8"), "console.log('customer tool');\n");
  assert.equal(await readFile(path.join(root, ".benchrouter/trust.json"), "utf8"), '{"customer": true}\n');
  // The gitignored copies a local command wrote are not committed, so the upgrade leaves them.
  const local = await targetRepo(t, legacyKit);
  await writeFile(path.join(local, ".benchrouter/benchrouter.yml"), legacyManifest);
  gitTrack(local, [WORKFLOW_PATH]);
  await applyUpgradePacket({ outputDir: local, files: packetFiles() });
  assert.equal(await readFile(path.join(local, ".benchrouter/bootstrap.mjs"), "utf8"), legacyKit.get(".benchrouter/bootstrap.mjs"));
  assert.equal(await readFile(path.join(local, ".benchrouter/trust.json"), "utf8"), legacyKit.get(".benchrouter/trust.json"));
});

test("RUN-001 local commands write the vendored bootstrap and trust into .benchrouter and run them", async (t) => {
  const root = await targetRepo(t);
  // A pinned trust is the customer's: the local command refuses to replace it and runs nothing.
  const pinnedTrust = JSON.stringify({ ...JSON.parse(legacyKit.get(".benchrouter/trust.json")), pins: ["sha256:" + "a".repeat(64)] });
  await writeFile(path.join(root, ".benchrouter/trust.json"), pinnedTrust);
  const refused = spawnSync(process.execPath, [cli.pathname, "capture"], { cwd: root, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /trust\.json is not BenchRouter's copy/);
  assert.equal(await readFile(path.join(root, ".benchrouter/trust.json"), "utf8"), pinnedTrust);
  assert.equal(existsSync(path.join(root, ".benchrouter/bootstrap.mjs")), false);
  // A legacy BenchRouter copy is replaced by the vendored one.
  await writeFile(path.join(root, ".benchrouter/trust.json"), legacyKit.get(".benchrouter/trust.json"));
  // A proxy that refuses connections stops the real bootstrap at its first fetch, with no network access.
  const env = { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "" };
  const result = spawnSync(process.execPath, [cli.pathname, "calibrate"], { cwd: root, encoding: "utf8", env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error title=BenchRouter bootstrap::https:\/\/runtime\.benchrouter\.com\/v1\/pointer is unreachable/);
  assert.equal(await readFile(path.join(root, ".benchrouter/bootstrap.mjs"), "utf8"), await vendored("bootstrap.mjs"));
  assert.equal(await readFile(path.join(root, ".benchrouter/trust.json"), "utf8"), await vendored("trust.json"));
  const empty = await mkdtemp(path.join(os.tmpdir(), "br-cli-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const missing = spawnSync(process.execPath, [cli.pathname, "capture"], { cwd: empty, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Run benchrouter init/);
});

test("RUN-001 a read-only legacy trust fails preflight without changing an earlier kit file", async (t) => {
  const root = await targetRepo(t, legacyKit);
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), `version: 1\nproduct: {slug: app, repo: example/app, default_branch: main}\nroutes:\n  - id: chat\n    route_id: app/chat\n    name: Chat\n    code_refs: [src/app.js]\n    seed: {incumbent_model: openai/gpt-4o-mini}\n    call_site: {base_url_env: OPENAI_BASE_URL}\n    eval_pack:\n      workflow: .github/workflows/benchrouter-evals.yml\n      scorer: .benchrouter/scorer.chat.js\n      result_schema: benchrouter.result.v1\n      case_refs: [.benchrouter/cases.chat.json]\n`);
  const before = new Map(packetFiles().map((file) => [file.path, file.content + "\n"]));
  for (const [name, content] of before) await writeFile(path.join(root, name), content);
  gitTrack(root, [".benchrouter/trust.json"]);
  await chmod(path.join(root, ".benchrouter/trust.json"), 0o400);
  await assert.rejects(applyUpgradePacket({ outputDir: root, files: packetFiles() }), { code: "EACCES" });
  for (const [name, content] of before) assert.equal(await readFile(path.join(root, name), "utf8"), content);
});

test("RUN-001 stale destination preflight preserves kit and package bytes without writing", async (t) => {
  const root = await targetRepo(t, legacyKit);
  const readme = ".benchrouter/README.md";
  await writeFile(path.join(root, readme), "Customer README before upgrade\n");
  await chmod(path.join(root, readme), 0o640);
  const previousPackage = '{"scripts":{"test":"node --test"},"dependencies":{"customer-tool":"1.0.0"}}\n';
  await writeFile(path.join(root, "package.json"), previousPackage);
  const application = await stageFileApplication({ outputDir: root, files: [
    { path: readme, content: "Generated README\n" },
    ...preparePackageJson(root, { scripts: { "benchrouter:capture": "node .benchrouter/bootstrap.mjs capture" } }),
    { path: ".benchrouter/new-file.txt", content: "New generated file\n" },
    { path: ".benchrouter/trust.json", content: legacyKit.get(".benchrouter/trust.json") + "\n" }
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
  const root = await targetRepo(t, legacyKit);
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
    { path: ".benchrouter/trust.json", content: legacyKit.get(".benchrouter/trust.json") + "\n" }
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
