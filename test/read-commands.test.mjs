import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
const fixtureDir = path.join(testDir, "fixtures/repo-read");
const repoToken = "br_setup_recorded_fixture";

const fixtures = Object.fromEntries(
  await Promise.all(
    ["models", "status", "frontier", "failures", "invalid-token"].map(async (name) => [
      name,
      JSON.parse(await readFile(path.join(fixtureDir, `${name}.json`), "utf8"))
    ])
  )
);

test("models renders stable human and JSON output through the real CLI process", async (t) => {
  const replay = await startReplayServer(t);

  const human = await runCli(["models", "--api-url", replay.url]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(
    human.stdout,
    "anthropic/claude-fable-5\nanthropic/claude-haiku-4.5\n"
  );

  const json = await runCli(["models", "--api-url", replay.url, "--filter", "haiku", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    ok: true,
    models: ["anthropic/claude-haiku-4.5"]
  });
  assert.deepEqual(replay.requests.map((request) => request.pathname), ["/v1/models", "/v1/models"]);
});

test("status, frontier, failures, and explain replay server contracts end to end", async (t) => {
  const replay = await startReplayServer(t);
  const common = ["--repo", "example/app", "--api-url", replay.url];

  const statusHuman = await runCli(["status", ...common], { BENCHROUTER_TOKEN: repoToken });
  assert.equal(statusHuman.status, 0, statusHuman.stderr);
  assert.equal(
    statusHuman.stdout,
    "example/app\n- app/chat: best minimax/minimax-m2.7; incumbent minimax/minimax-m2.7; wired in production; latest eval decided; production evidence ers_recorded\n"
  );
  const statusJson = await runCli(["status", ...common, "--json"], { BENCHROUTER_TOKEN: repoToken });
  assert.equal(statusJson.status, 0, statusJson.stderr);
  assert.deepEqual(JSON.parse(statusJson.stdout), fixtures.status);

  const frontierHuman = await runCli(["frontier", "app/chat", ...common], { BENCHROUTER_TOKEN: repoToken });
  assert.equal(frontierHuman.status, 0, frontierHuman.stderr);
  assert.equal(
    frontierHuman.stdout,
    [
      "app/chat",
      "Incumbent: minimax/minimax-m2.7",
      "Best: minimax/minimax-m2.7",
      "Alternatives: none",
      ""
    ].join("\n")
  );
  const frontierJson = await runCli(["frontier", "app/chat", ...common, "--json"], { BENCHROUTER_TOKEN: repoToken });
  assert.equal(frontierJson.status, 0, frontierJson.stderr);
  assert.deepEqual(JSON.parse(frontierJson.stdout), fixtures.frontier);

  const failuresHuman = await runCli(
    ["failures", "app/chat", "minimax/minimax-m2.7", ...common],
    { BENCHROUTER_TOKEN: repoToken }
  );
  assert.equal(failuresHuman.status, 0, failuresHuman.stderr);
  assert.equal(
    failuresHuman.stdout,
    [
      "app/chat: minimax/minimax-m2.7 (emrun_recorded)",
      "- tone-critical: critical; assertion_failure: expected concise reply",
      ""
    ].join("\n")
  );
  const failuresJson = await runCli(["failures", "app/chat", ...common, "--json"], { BENCHROUTER_TOKEN: repoToken });
  assert.equal(failuresJson.status, 0, failuresJson.stderr);
  assert.deepEqual(JSON.parse(failuresJson.stdout), fixtures.failures);

  const explainHuman = await runCli(
    ["explain", "minimax/minimax-m2.7", "--route", "app/chat", ...common],
    { BENCHROUTER_TOKEN: repoToken }
  );
  assert.equal(explainHuman.status, 0, explainHuman.stderr);
  assert.equal(explainHuman.stdout, "minimax/minimax-m2.7: This is the route incumbent.\n");

  const explainJson = await runCli(
    ["explain", "openai/gpt-oss-20b", ...common, "--json"],
    { BENCHROUTER_TOKEN: repoToken }
  );
  assert.equal(explainJson.status, 0, explainJson.stderr);
  assert.deepEqual(JSON.parse(explainJson.stdout), {
    ok: true,
    model: "openai/gpt-oss-20b",
    route_key: "app/chat",
    standing: "not_eligible",
    detail: "This model is not on the eligible frontier for this route."
  });

  assert.ok(replay.requests.length > 0);
  assert.ok(replay.requests.every((request) => request.authorization === `Bearer ${repoToken}`));
  assert.ok(replay.requests.some((request) => request.rawUrl === "/v1/repo/app%2Fchat/frontier"));
  assert.ok(
    replay.requests.some(
      (request) => request.rawUrl === "/v1/repo/app%2Fchat/failures?model=minimax%2Fminimax-m2.7"
    )
  );
});

test("repo reads give actionable errors for missing and invalid access", async (t) => {
  const replay = await startReplayServer(t, { invalidToken: true });
  const common = ["--repo", "example/app", "--api-url", replay.url];

  const missing = await runCli(["status", ...common], { BENCHROUTER_TOKEN: undefined });
  assert.equal(missing.status, 1);
  assert.equal(
    missing.stderr,
    "Missing repo read token. Set BENCHROUTER_TOKEN, pass --token, or approve --save-token during init.\n"
  );
  assert.equal(replay.requests.length, 0);

  const invalid = await runCli(["status", ...common], { BENCHROUTER_TOKEN: repoToken });
  assert.equal(invalid.status, 1);
  assert.equal(
    invalid.stderr,
    "BenchRouter repo access expired or is invalid. Open https://benchrouter.com/setup to create a new repo token.\n"
  );
  assert.equal(replay.requests.length, 1);
});

async function startReplayServer(t, options = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({
      authorization: request.headers.authorization,
      pathname: url.pathname,
      rawUrl: request.url
    });

    if (url.pathname === "/v1/models") {
      return sendJson(response, 200, fixtures.models);
    }
    if (options.invalidToken) {
      return sendJson(response, 401, fixtures["invalid-token"]);
    }
    if (url.pathname === "/v1/repo/status") {
      return sendJson(response, 200, fixtures.status);
    }
    if (url.pathname === "/v1/repo/app%2Fchat/frontier") {
      return sendJson(response, 200, fixtures.frontier);
    }
    if (url.pathname === "/v1/repo/app%2Fchat/failures") {
      return sendJson(response, 200, fixtures.failures);
    }
    return sendJson(response, 404, { error: "fixture_not_found", message: `No fixture for ${request.url}` });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function runCli(cliArgs, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...envOverrides };
    if (Object.hasOwn(envOverrides, "BENCHROUTER_TOKEN") && envOverrides.BENCHROUTER_TOKEN === undefined) {
      delete env.BENCHROUTER_TOKEN;
    }
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      cwd: testDir,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
