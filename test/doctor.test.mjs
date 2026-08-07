import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyUpgradePacket } from "../src/upgrade-state.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const cliPath = path.join(repoRoot, "bin/benchrouter.mjs");
const routeId = "app/chat";
const fixture = JSON.parse(
  await readFile(path.join(testDir, "fixtures/benchrouter-proxy/chat-completion.json"), "utf8")
);
const cliSource = await readFile(path.join(repoRoot, "src/cli.mjs"), "utf8");

test("doctor passes with wired code_refs and a proxy fixture replay", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  const proxy = await startFixtureProxy(t, {
    status: 200,
    headers: { "x-benchrouter-selected-model": fixture.model },
    body: fixture
  });

  const result = await runDoctor(root, proxy.url);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runtime host checklist: set BENCHROUTER_API_KEY .* OPENAI_BASE_URL/);
  assert.match(result.stdout, /GitHub Actions checklist: ensure BenchRouter Evals is enabled; CI authenticates with GitHub OIDC/);
  assert.match(result.stdout, /optional fallback provider key detected .* OPENAI_API_KEY/);
  assert.match(result.stdout, /runtime wiring/);
  assert.match(result.stdout, /auth .*live proxy ping used runtime BENCHROUTER_API_KEY/);
  assert.match(result.stdout, /model resolution .*configured route model app\/chat -> selected provider\/canonical slug minimax\/minimax-m2\.7.*usage present/);
  assert.match(result.stdout, /GitHub workflow check skipped/);
  assert.match(result.stdout, /BenchRouter doctor passed\./);
  assert.equal(proxy.requests.length, 1);
  assert.equal(proxy.requests[0].method, "POST");
  assert.equal(proxy.requests[0].url, "/v1/chat/completions");
  assert.equal(proxy.requests[0].authorization, "Bearer br_test_fixture");
  assert.equal(proxy.requests[0].body.model, routeId);
  assert.equal(proxy.requests[0].body.max_tokens, 1);
});

test("doctor skips live proxy ping when the runtime key is absent", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  const proxy = await startFixtureProxy(t, {
    status: 200,
    headers: { "x-benchrouter-selected-model": fixture.model },
    body: fixture
  });

  const result = await runDoctor(root, proxy.url, { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /auth skipped: no BENCHROUTER_API_KEY in environment; live proxy ping not run/);
  assert.equal(proxy.requests.length, 0);
});

test("doctor reports disabled BenchRouter Evals workflow from gh", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  const ghBin = await createFixtureGh(t);
  const proxy = await startFixtureProxy(t, {
    status: 200,
    headers: { "x-benchrouter-selected-model": fixture.model },
    body: fixture
  });

  const result = await runCli(["doctor", "--output-dir", root, "--api-url", proxy.url, "--repo", "example/app"], root, {
    BENCHROUTER_API_KEY: "br_test_fixture",
    GH_WORKFLOW_STATE: "disabled_manually",
    PATH: `${ghBin}${path.delimiter}${process.env.PATH ?? ""}`
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /BenchRouter Evals workflow is disabled_manually/);
  assert.match(result.stderr, /gh workflow enable benchrouter-evals\.yml --repo example\/app/);
});

test("doctor confirms active BenchRouter Evals workflow from gh", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  const ghBin = await createFixtureGh(t);
  const proxy = await startFixtureProxy(t, {
    status: 200,
    headers: { "x-benchrouter-selected-model": fixture.model },
    body: fixture
  });

  const result = await runCli(["doctor", "--output-dir", root, "--api-url", proxy.url, "--repo", "example/app"], root, {
    BENCHROUTER_API_KEY: "br_test_fixture",
    GH_WORKFLOW_STATE: "active",
    PATH: `${ghBin}${path.delimiter}${process.env.PATH ?? ""}`
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub workflow .*BenchRouter Evals is active/);
  assert.match(result.stdout, /BenchRouter Evals uses keyless OIDC/);
});

test("init prints the runtime key, keeps OIDC keyless, and writes runtime-only env example", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-setup-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

  const setupServer = await startFixtureProxy(t, {
    status: 200,
    body: {
      repo_full_name: "example/app",
      setup_packet: {
        files: [
          {
            path: ".benchrouter/SETUP_README.md",
            content: "# BenchRouter setup\n"
          },
          {
            path: ".benchrouter/README.md",
            content: "# BenchRouter\n"
          },
          {
            path: ".benchrouter/benchrouter.yml",
            content: "version: 1\n"
          }
        ],
        package_json: {
          scripts: { "benchrouter:eval": "node .benchrouter/benchrouter-eval.mjs" },
          dev_dependencies: []
        },
        runtime_env: {
          BENCHROUTER_API_KEY: "<runtime key>",
          OPENAI_BASE_URL: "https://api.benchrouter.com/v1",
          BENCHROUTER_EVAL_API_KEY: "<github eval key>",
          BENCHROUTER_EVAL_RUN_ID: "<ci only>"
        },
        setup_api_keys: {
          production: { key: "br_live_runtime_fixture" }
        }
      }
    }
  });

  const result = await runCli(
    [
      "init",
      "--setup-key",
      "br_setup_fixture",
      "--route-id",
      routeId,
      "--name",
      "Chat",
      "--incumbent-model",
      "openai/gpt-4o-mini",
      "--provider-id",
      "openai",
      "--provider-ref",
      "gpt-4o-mini-2024-07-18",
      "--base-url-env",
      "OPENAI_BASE_URL",
      "--code-ref",
      "src/llm.js",
      "--api-url",
      setupServer.url,
      "--output-dir",
      root
    ],
    root
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runtime\/host BENCHROUTER_API_KEY: br_live_runtime_fixture/);
  assert.doesNotMatch(result.stdout, /BENCHROUTER_EVAL_API_KEY/);
  assert.match(result.stdout, /Store it now/);
  assert.match(result.stdout, /Tell your coding agent: read \.benchrouter\/SETUP_README\.md/);
  assert.match(result.stdout, /call-site patch, eval evidence, scorer, calibration, and env-var install/);
  assert.match(result.stdout, /installing runtime BENCHROUTER_API_KEY in the app host/);
  assert.match(result.stdout, /BenchRouter Evals uses GitHub OIDC/);

  const envExample = await readFile(path.join(root, ".env.example"), "utf8");
  assert.match(envExample, /^BENCHROUTER_API_KEY= # runtime key/m);
  assert.match(envExample, /^OPENAI_BASE_URL=https:\/\/api\.benchrouter\.com\/v1 # point this call site's LLM base URL at BenchRouter/m);
  assert.doesNotMatch(envExample, /BENCHROUTER_EVAL_API_KEY/);
  assert.doesNotMatch(envExample, /BENCHROUTER_EVAL_RUN_ID/);
  assert.equal(setupServer.requests.length, 1);
  assert.equal(setupServer.requests[0].authorization, "Bearer br_setup_fixture");
  assert.equal(setupServer.requests[0].body.route.provider_id, "openai");
  assert.equal(setupServer.requests[0].body.route.provider_ref, "gpt-4o-mini-2024-07-18");
  assert.equal(setupServer.requests[0].body.route.base_url_env, "OPENAI_BASE_URL");
  assert.deepEqual(setupServer.requests[0].body.route.code_refs, ["src/llm.js"]);
});

test("init requires direct-provider identity flags together", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-provider-flags-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runCli(
    [
      "init",
      "--setup-key",
      "br_setup_fixture",
      "--route-id",
      routeId,
      "--name",
      "Chat",
      "--incumbent-model",
      "openai/gpt-4o-mini",
      "--provider-id",
      "openai",
      "--output-dir",
      root
    ],
    root
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Pass --provider-id and --provider-ref together\./);
});

test("init gives an actionable setup-key expiry error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-expired-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setupServer = await startFixtureProxy(t, {
    status: 401,
    body: {
      error: {
        code: "setup_code_expired",
        message: "BenchRouter setup key has expired"
      }
    }
  });

  const result = await runCli(
    [
      "init",
      "--setup-key",
      "br_setup_expired_fixture",
      "--route-id",
      routeId,
      "--name",
      "Chat",
      "--incumbent-model",
      "openai/gpt-4o-mini",
      "--api-url",
      setupServer.url,
      "--output-dir",
      root
    ],
    root
  );

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "Setup key expired. Refresh it at https://benchrouter.com/setup/new and run init again.\n"
  );
  assert.equal(setupServer.requests.length, 1);
});

test("upgrade preserves the full multi-route kit state and updates only generated bookkeeping", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-setup-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  const oldUpload = "export const oldUpload = true;\n";
  const existingState = {
    version: "0.0.9",
    generated_by: "benchrouter.setup_packet.v1",
    product: {
      slug: "app",
      default_branch: "main",
      repo_full_name: "example/app"
    },
    routes: [
      {
        route_id: "app/compose",
        route_slug: "compose",
        name: "Compose",
        incumbent_model: "anthropic/claude-haiku-4.5",
        original_model: "anthropic/claude-haiku-4.5",
        best_model: "openai/gpt-5.6-luna",
        code_refs: ["src/compose.ts", "src/prompts/compose.ts"]
      },
      {
        route_id: "app/summarize",
        route_slug: "summarize",
        name: "Summarize",
        incumbent_model: "openai/gpt-5.4-nano",
        original_model: "openai/gpt-5.4-nano",
        best_model: "google/gemini-3.5-flash-lite",
        code_refs: ["src/summarize.ts"]
      }
    ],
    files: [
      { path: ".benchrouter/upload-results.mjs", sha256: sha256(oldUpload) },
      { path: ".benchrouter/scorer.compose.js", sha256: "a".repeat(64) }
    ]
  };
  await writeFile(
    path.join(root, ".benchrouter/.kit-state.json"),
    `${JSON.stringify(existingState, null, 2)}\n`
  );
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), "routes:\n  - id: app/compose\n");
  await writeFile(path.join(root, ".benchrouter/upload-results.mjs"), oldUpload);

  const nextUpload = "export const upgradedUpload = true;\n";
  const workflow = "name: BenchRouter Evals\n";
  const events = [];
  await applyUpgradePacket({
    outputDir: root,
    setupKitVersion: "0.0.10",
    files: [
      {
        path: ".benchrouter/upload-results.mjs",
        content: nextUpload,
        sha256: sha256(nextUpload)
      },
      {
        path: ".github/workflows/benchrouter-evals.yml",
        content: workflow,
        sha256: sha256(workflow)
      }
    ],
    onFile(action, filePath) {
      events.push(`${action} ${filePath}`);
    }
  });

  const upgradedState = JSON.parse(await readFile(path.join(root, ".benchrouter/.kit-state.json"), "utf8"));
  assert.deepEqual(upgradedState.routes, existingState.routes);
  assert.equal(upgradedState.routes[0].original_model, "anthropic/claude-haiku-4.5");
  assert.equal(upgradedState.routes[0].best_model, "openai/gpt-5.6-luna");
  assert.deepEqual(upgradedState.routes[0].code_refs, ["src/compose.ts", "src/prompts/compose.ts"]);
  assert.equal(upgradedState.version, "0.0.10");
  assert.deepEqual(upgradedState.product, existingState.product);
  assert.deepEqual(upgradedState.files, [
    { path: ".benchrouter/upload-results.mjs", sha256: sha256(nextUpload) },
    { path: ".benchrouter/scorer.compose.js", sha256: "a".repeat(64) },
    { path: ".github/workflows/benchrouter-evals.yml", sha256: sha256(workflow) }
  ]);
  assert.equal(await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8"), "routes:\n  - id: app/compose\n");
  assert.equal(await readFile(path.join(root, ".benchrouter/upload-results.mjs"), "utf8"), nextUpload);
  assert.equal(await readFile(path.join(root, ".github/workflows/benchrouter-evals.yml"), "utf8"), workflow);
  assert.deepEqual(events, [
    "updated .benchrouter/upload-results.mjs",
    "created .github/workflows/benchrouter-evals.yml",
    "updated .benchrouter/.kit-state.json"
  ]);
});

test("upgrade fails closed before HTTP when repository kit state is missing or invalid", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-upgrade-invalid-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = [
    "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", routeId, "--api-url", "http://127.0.0.1:1", "--output-dir", root, "--yes"
  ];

  const missing = await runCli(args, root);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot upgrade without \.benchrouter\/\.kit-state\.json/);
  assert.match(missing.stderr, /benchrouter init/);

  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await writeFile(path.join(root, ".benchrouter/.kit-state.json"), "{broken json\n");
  const invalid = await runCli(args, root);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /\.kit-state\.json is not valid JSON/);
});

test("doctor fails when call_site.base_url_env is not referenced by route code_refs", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.PROVIDER_BASE_URL;" });
  const proxy = await startFixtureProxy(t, {
    status: 200,
    headers: { "x-benchrouter-selected-model": fixture.model },
    body: fixture
  });

  const result = await runDoctor(root, proxy.url);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /runtime wiring route app\/chat: call_site\.base_url_env OPENAI_BASE_URL is not referenced by any route code_refs/
  );
});

test("doctor reports proxy ping failure classes", async (t) => {
  await t.test("auth rejected", async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "process.env.OPENAI_BASE_URL;" });
    const proxy = await startFixtureProxy(t, {
      status: 401,
      body: { error: { code: "invalid_token", message: "Invalid API key" } }
    });

    const result = await runDoctor(root, proxy.url);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /proxy ping auth rejected: HTTP 401 invalid_token/);
  });

  await t.test("route not found", async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "process.env.OPENAI_BASE_URL;" });
    const proxy = await startFixtureProxy(t, {
      status: 404,
      body: { error: { code: "route_not_found", message: "Route not found" } }
    });

    const result = await runDoctor(root, proxy.url);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /proxy ping route not found: app\/chat \(route_not_found\)/);
  });

  await t.test("malformed response", async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "process.env.OPENAI_BASE_URL;" });
    const proxy = await startFixtureProxy(t, {
      status: 200,
      body: { id: "chatcmpl-route-id", model: routeId, usage: { total_tokens: 1 } }
    });

    const result = await runDoctor(root, proxy.url);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /proxy ping malformed response: expected response\.model to be a concrete model/);
  });

  await t.test("network", async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "process.env.OPENAI_BASE_URL;" });

    const result = await runDoctor(root, "http://127.0.0.1:9");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /proxy ping network:/);
  });
});

async function createTargetRepo(t, { codeRefText }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-setup-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });

  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), manifestYaml());
  await writeFile(path.join(root, ".benchrouter/README.md"), "# BenchRouter\n");
  await writeFile(path.join(root, ".benchrouter/SETUP_README.md"), "# BenchRouter Setup\n");
  await writeFile(
    path.join(root, ".benchrouter/.kit-state.json"),
    `${JSON.stringify({
      routes: [
        {
          route_id: routeId,
          route_slug: "app/chat",
          incumbent_model: "openai/gpt-4o-mini",
          base_url_env: "OPENAI_BASE_URL",
          code_refs: ["src/llm.js"],
          scorer_path: ".benchrouter/scorer.app__chat.js",
          cases_path: ".benchrouter/cases.app__chat.json"
        }
      ],
      files: [
        { path: ".benchrouter/scorer.app__chat.js" },
        { path: ".benchrouter/cases.app__chat.json" }
      ]
    }, null, 2)}\n`
  );
  await writeFile(
    path.join(root, ".benchrouter/upload-results.mjs"),
    `const snippets = ${JSON.stringify(doctorUploadHelperSnippets())};\nvoid snippets;\n`
  );
  await writeFile(path.join(root, ".benchrouter/sidecar.mjs"), "export {};\n");
  await writeFile(path.join(root, ".benchrouter/benchrouter-eval.mjs"), "export {};\n");
  await writeFile(path.join(root, ".benchrouter/scorer.app__chat.js"), "export function score() { return { pass: true, score: 1 }; }\n");
  await writeFile(
    path.join(root, ".benchrouter/cases.app__chat.json"),
    `${JSON.stringify([{ id: "case-1", input: { messages: [{ role: "user", content: "hello" }] } }], null, 2)}\n`
  );
  await writeFile(
    path.join(root, ".github/workflows/benchrouter-evals.yml"),
    [
      "name: BenchRouter Evals",
      "on: [pull_request, workflow_dispatch]",
      "permissions:",
      "  id-token: write",
      "jobs:",
      "  eval:",
      "    steps:",
      "      - run: node .benchrouter/upload-results.mjs",
      "        env:",
      "          BENCHROUTER_MODEL_RUN_ID: x",
      "          BENCHROUTER_UPLOAD_RESULTS: '1'",
      ...doctorWorkflowSnippets().map((snippet) => `      # doctor-contract: ${snippet}`)
    ].join("\n")
  );
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      scripts: { "benchrouter:eval": "node .benchrouter/benchrouter-eval.mjs" }
    }, null, 2)}\n`
  );
  await writeFile(path.join(root, ".env.example"), "BENCHROUTER_API_KEY=\nOPENAI_BASE_URL=https://api.benchrouter.com/v1\nOPENAI_API_KEY=\n");
  await writeFile(path.join(root, "src/llm.js"), `${codeRefText}\n`);

  return root;
}

async function createFixtureGh(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "benchrouter-gh-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ghPath = path.join(dir, "gh");
  await writeFile(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "repos/example/app/actions/workflows") {
  process.stdout.write(JSON.stringify({
    total_count: 1,
    workflows: [{
      id: 271768590,
      name: "BenchRouter Evals",
      path: ".github/workflows/benchrouter-evals.yml",
      state: process.env.GH_WORKFLOW_STATE || "active"
    }]
  }));
  process.exit(0);
}
process.stderr.write("unexpected gh fixture args: " + args.join(" ") + "\\n");
process.exit(1);
`
  );
  await chmod(ghPath, 0o755);
  return dir;
}

function doctorWorkflowSnippets() {
  return readStringArrayConstant("DOCTOR_WORKFLOW_SNIPPETS");
}

function doctorUploadHelperSnippets() {
  return readStringArrayConstant("DOCTOR_UPLOAD_HELPER_SNIPPETS");
}

function readStringArrayConstant(name) {
  const match = cliSource.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  assert(match, `${name} not found in CLI source`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestYaml() {
  return `version: 1

product:
  slug: app
  repo: example/app
  default_branch: main

routes:
  - id: chat
    route_id: ${routeId}
    name: Chat
    code_refs:
      - src/llm.js
    call_site:
      base_url_env: OPENAI_BASE_URL
    seed:
      incumbent_model: openai/gpt-4o-mini
    eval_pack:
      id: chat_v1
      config_path: .benchrouter/benchrouter.yml
      workflow: .github/workflows/benchrouter-evals.yml
      command: npm run benchrouter:eval
      capture_command: npm test
      scorer: .benchrouter/scorer.app__chat.js
      result_schema: benchrouter.result.v1
      case_refs:
        - .benchrouter/cases.app__chat.json
`;
}

async function startFixtureProxy(t, responseFixture) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    for await (const chunk of request) {
      rawBody += chunk;
    }
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: JSON.parse(rawBody)
    });

    const responseBody = JSON.stringify(responseFixture.body);
    response.writeHead(responseFixture.status, {
      "content-type": "application/json",
      ...(responseFixture.headers ?? {})
    });
    response.end(responseBody);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests
  };
}

function runDoctor(root, apiUrl, envOverrides = {}) {
  return runCli(["doctor", "--output-dir", root, "--api-url", apiUrl, "--skip-github-workflow"], root, {
    BENCHROUTER_API_KEY: "br_test_fixture",
    ...envOverrides
  });
}

function runCli(cliArgs, cwd, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ...envOverrides
    };
    if (Object.hasOwn(envOverrides, "BENCHROUTER_API_KEY") && envOverrides.BENCHROUTER_API_KEY === undefined) {
      delete env.BENCHROUTER_API_KEY;
    }

    const child = spawn(
      process.execPath,
      [cliPath, ...cliArgs],
      {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
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
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}
