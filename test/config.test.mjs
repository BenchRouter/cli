import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("saved repo access is explicit, isolated by repository, and relocatable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.BENCHROUTER_CONFIG_DIR;
  process.env.BENCHROUTER_CONFIG_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.BENCHROUTER_CONFIG_DIR;
    else process.env.BENCHROUTER_CONFIG_DIR = previous;
  });

  const { resolveRepoToken, saveRepoToken } = await import("../src/config.mjs");
  const firstPath = await saveRepoToken("Example/First", "br_setup_first_recorded");
  const secondPath = await saveRepoToken("example/second", "br_setup_second_recorded");

  assert.notEqual(firstPath, secondPath);
  assert.ok(firstPath.startsWith(root));
  assert.deepEqual(resolveRepoToken("example/first"), {
    token: "br_setup_first_recorded",
    source: "config",
    path: firstPath
  });
  assert.deepEqual(resolveRepoToken("EXAMPLE/SECOND"), {
    token: "br_setup_second_recorded",
    source: "config",
    path: secondPath
  });
  assert.equal(JSON.parse(await readFile(firstPath, "utf8")).repo_full_name, "example/first");
});

test("BENCHROUTER_TOKEN overrides saved repo access", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-env-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousDir = process.env.BENCHROUTER_CONFIG_DIR;
  const previousToken = process.env.BENCHROUTER_TOKEN;
  process.env.BENCHROUTER_CONFIG_DIR = root;
  process.env.BENCHROUTER_TOKEN = "br_setup_environment_recorded";
  t.after(() => {
    if (previousDir === undefined) delete process.env.BENCHROUTER_CONFIG_DIR;
    else process.env.BENCHROUTER_CONFIG_DIR = previousDir;
    if (previousToken === undefined) delete process.env.BENCHROUTER_TOKEN;
    else process.env.BENCHROUTER_TOKEN = previousToken;
  });

  const { resolveRepoToken, saveRepoToken } = await import("../src/config.mjs");
  await saveRepoToken("example/app", "br_setup_saved_recorded");
  assert.deepEqual(resolveRepoToken("example/app"), {
    token: "br_setup_environment_recorded",
    source: "environment"
  });
});
