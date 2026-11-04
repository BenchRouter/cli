import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../bin/benchrouter.mjs", import.meta.url));

function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: "utf8", timeout: 4000,
    env: { ...process.env, BENCHROUTER_API_KEY: "", BENCHROUTER_UPGRADE_TOKEN: "", BENCHROUTER_SETUP_KEY: "", npm_config_registry: "http://127.0.0.1:9" }
  });
}

// Async, so the local server in the same process can answer if the CLI ever calls it.
function runAsync(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: { ...process.env, BENCHROUTER_API_KEY: "", BENCHROUTER_UPGRADE_TOKEN: "", BENCHROUTER_SETUP_KEY: "", npm_config_registry: "http://127.0.0.1:9" }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

test("upgrade --force stops before any request or file change and names the flag", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "br-unknown-flag-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  const readme = path.join(root, ".benchrouter/README.md");
  await writeFile(readme, "# Old\n");
  let requests = 0;
  const server = createServer((request, response) => { requests += 1; response.writeHead(500).end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;

  const result = await runAsync(["upgrade", "--force", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", "app/chat", "--api-url", apiUrl, "--output-dir", root, "--yes"], root);

  assert.equal(result.status, 1);
  assert.ok(result.stderr.startsWith("Unknown flag for benchrouter upgrade: --force. Nothing was changed.\n"), result.stderr);
  assert.ok(result.stderr.includes("benchrouter upgrade --upgrade-token"), result.stderr);
  assert.equal(requests, 0);
  assert.equal(await readFile(readme, "utf8"), "# Old\n");
});

test("flags that the parser would hide are still rejected", () => {
  for (const [flag, shown] of [["-f", "-f"], ["--_", "--_"], ["--__proto__", "--__proto__"], ["--constructor", "--constructor"]]) {
    const result = run(["upgrade", flag, "--help"], os.tmpdir());
    assert.equal(result.status, 1, flag);
    assert.ok(result.stderr.startsWith(`Unknown flag for benchrouter upgrade: ${shown}. Nothing was changed.\n`), `${flag}: ${result.stderr}`);
  }
});

test("a boolean flag does not swallow the unknown flag after it", () => {
  for (const tokens of [["--yes", "-f"], ["--help", "-f"], ["--dry-run", "-f"], ["--json", "-f"]]) {
    const result = run(["upgrade", ...tokens], os.tmpdir());
    assert.equal(result.status, 1, tokens.join(" "));
    const output = tokens[0] === "--json" ? JSON.parse(result.stderr).error.message : result.stderr;
    assert.ok(output.startsWith("Unknown flag for benchrouter upgrade: -f. Nothing was changed."), `${tokens.join(" ")}: ${result.stderr}`);
  }
});

test("--json and -y stay accepted where documented", () => {
  const doctor = run(["doctor", "--json", "--phase", "nope"], os.tmpdir());
  assert.equal(doctor.status, 1);
  assert.equal(JSON.parse(doctor.stderr).ok, false);
  assert.ok(!doctor.stderr.includes("Unknown flag"), doctor.stderr);
  const yes = run(["upgrade", "-y", "--help"], os.tmpdir());
  assert.equal(yes.status, 0, yes.stderr);
});

test("every built-in command names all unknown flags, and JSON mode reports them as invalid_arguments", () => {
  for (const command of ["init", "doctor", "models", "status", "frontier", "failures", "explain"]) {
    const result = run([command, "--bogus", "--also-wrong=1"], os.tmpdir());
    assert.equal(result.status, 1, command);
    assert.ok(result.stderr.startsWith(`Unknown flags for benchrouter ${command}: --bogus, --also-wrong. Nothing was changed.\n`), `${command}: ${result.stderr}`);
  }
  const json = run(["models", "--json", "--bogus"], os.tmpdir());
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stderr), {
    ok: false,
    error: { code: "invalid_arguments", message: "Unknown flag for benchrouter models: --bogus. Nothing was changed." }
  });
});

test("init keeps --force, and --help still works with a known flag", () => {
  const help = run(["upgrade", "--help"], os.tmpdir());
  assert.equal(help.status, 0);
  const init = run(["init", "--force", "--help"], os.tmpdir());
  assert.equal(init.status, 0, init.stderr);
});
