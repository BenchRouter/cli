import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
const { version } = JSON.parse(await readFile(path.resolve(testDir, "../package.json"), "utf8"));

test("--version prints the version, and a notice only when npm's latest is newer", async (t) => {
  const registry = await startRegistry(t);
  const [major, minor, patch] = version.split(".").map(Number);

  registry.latest = `${major}.${minor}.${patch + 1}`;
  const newer = await runCli(["--version"], registry.url);
  assert.equal(newer.status, 0, newer.stderr);
  assert.equal(newer.stdout, `${version}\n`);
  assert.equal(
    newer.stderr,
    `benchrouter ${registry.latest} is available; this is ${version}. Run: npx --yes benchrouter@latest --version\n`
  );
  assert.deepEqual(registry.paths, ["/benchrouter/latest"]);

  for (const latest of [version, `${major}.${minor}.${Math.max(patch - 1, 0)}`, `${major + 1}.0.0-beta.1`]) {
    registry.latest = latest;
    const quiet = await runCli(["--version"], registry.url);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stdout, `${version}\n`);
    assert.equal(quiet.stderr, "", `no notice for latest ${latest}`);
  }
});

test("--version follows a registry redirect to find the newer version", async (t) => {
  const registry = await startRegistry(t);
  const [major, minor, patch] = version.split(".").map(Number);
  registry.latest = `${major}.${minor}.${patch + 1}`;
  const redirect = http.createServer((request, response) => {
    response.writeHead(301, { location: `${registry.url}${request.url}` });
    response.end();
  });
  await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => redirect.close(resolve)));

  const result = await runCli(["--version"], `http://127.0.0.1:${redirect.address().port}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${version}\n`);
  assert.equal(
    result.stderr,
    `benchrouter ${registry.latest} is available; this is ${version}. Run: npx --yes benchrouter@latest --version\n`
  );
  assert.deepEqual(registry.paths, ["/benchrouter/latest"]);
});

test("--version ignores a redirect whose Location is not a URL", async (t) => {
  const broken = http.createServer((request, response) => {
    response.writeHead(302, { location: "http://[" });
    response.end();
  });
  await new Promise((resolve) => broken.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => broken.close(resolve)));

  const result = await runCli(["--version"], `http://127.0.0.1:${broken.address().port}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${version}\n`);
  assert.equal(result.stderr, "");
});

test("--version still prints the version when the registry cannot answer", async () => {
  const result = await runCli(["--version"], "http://127.0.0.1:9");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${version}\n`);
  assert.equal(result.stderr, "");
});

test("doctor lists the newer version as a note", async (t) => {
  const registry = await startRegistry(t);
  const [major, minor, patch] = version.split(".").map(Number);
  registry.latest = `${major}.${minor}.${patch + 1}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-version-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  // An empty directory fails doctor's file checks; the note is still in the report.
  const result = await runCli(["doctor", "--output-dir", root, "--skip-github-workflow"], registry.url);
  assert.equal(result.status, 1);
  assert.ok(
    result.stderr.includes(`doctor note: benchrouter ${registry.latest} is available; this is ${version}. Run: npx --yes benchrouter@latest doctor\n`),
    result.stderr
  );
});

test("--version exits within the deadline when the registry accepts but never answers", { timeout: 5000 }, async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));

  const started = Date.now();
  const result = await runCli(["--version"], `http://127.0.0.1:${server.address().port}`);
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${version}\n`);
  assert.equal(result.stderr, "");
  assert.equal(sockets.size, 1);
  assert.ok(elapsed < 4500, `exited after ${elapsed} ms`);
});

async function startRegistry(t) {
  const state = { latest: version, paths: [], url: "" };
  const server = http.createServer((request, response) => {
    state.paths.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "benchrouter", version: state.latest }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  state.url = `http://127.0.0.1:${server.address().port}`;
  return state;
}

function runCli(cliArgs, registryUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      env: { ...process.env, npm_config_registry: registryUrl },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
