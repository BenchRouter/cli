import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applySkillInstall,
  listSkills,
  parseAgents,
  parseSkillMarkdown,
  planSkillInstall,
  readSkill
} from "../src/skills.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");

test("skill pack ships named workflows with valid frontmatter", () => {
  const skills = listSkills();
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["add-route", "author-eval", "doctor-fix", "explain-frontier", "partition-route"]
  );
  for (const skill of skills) {
    const parsed = parseSkillMarkdown(skill.content);
    assert.equal(parsed.name, skill.name);
    assert.ok(parsed.description.length > 20);
    assert.match(skill.content, /^---\n/);
  }
  const partition = readSkill("partition-route");
  assert.match(partition.content, /ROUTE-007/);
  assert.ok(partition.files.some((file) => file.relativePath === "examples.md"));
});

test("parseAgents accepts all, csv, and rejects unknown names", () => {
  assert.deepEqual(parseAgents(undefined), ["cursor", "claude", "codex"]);
  assert.deepEqual(parseAgents("all"), ["cursor", "claude", "codex"]);
  assert.deepEqual(parseAgents("cursor,claude"), ["cursor", "claude"]);
  assert.throws(() => parseAgents("windsurf"), /Unknown agent/);
});

test("skills install writes the pack into agent directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = planSkillInstall({ root, agents: ["cursor"], names: ["partition-route"] });
  assert.equal(plan.files.some((file) => file.path === ".cursor/skills/partition-route/SKILL.md"), true);
  applySkillInstall(plan, root);
  const written = await readFile(path.join(root, ".cursor/skills/partition-route/SKILL.md"), "utf8");
  assert.match(written, /name: partition-route/);
  const again = planSkillInstall({ root, agents: ["cursor"], names: ["partition-route"] });
  assert.equal(again.files.every((file) => file.action === "unchanged"), true);
});

test("skills CLI lists, shows, and installs without a token", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-skills-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const listed = await runCli(["skills", "list", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  const listBody = JSON.parse(listed.stdout);
  assert.equal(listBody.ok, true);
  assert.ok(listBody.skills.some((skill) => skill.name === "partition-route"));

  const shown = await runCli(["skills", "show", "partition-route"]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Partition a BenchRouter route/);

  const help = await runCli(["skills", "install", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Writes the packaged skills/);

  const installed = await runCli(
    ["skills", "install", "partition-route", "--agent", "codex", "--output-dir", root, "--yes", "--json"]
  );
  assert.equal(installed.status, 0, installed.stderr);
  const body = JSON.parse(installed.stdout);
  assert.deepEqual(body.agents, ["codex"]);
  assert.ok(body.written.includes(".agents/skills/partition-route/SKILL.md"));
  assert.match(
    await readFile(path.join(root, ".agents/skills/partition-route/examples.md"), "utf8"),
    /astroturfed/
  );
});

test("skills install --json without --yes does not write", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-skills-confirm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runCli(
    ["skills", "install", "--agent", "cursor", "--output-dir", root, "--json"]
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /JSON mode requires --yes/);
});

function runCli(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...argv], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
