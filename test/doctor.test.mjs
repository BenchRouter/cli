import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
const replacementConfirmationFixture = JSON.parse(
  await readFile(
    path.join(testDir, "fixtures/setup-packet/model-replacement-confirmation-required.json"),
    "utf8"
  )
);
const providerIdentityReviewFixture = JSON.parse(
  await readFile(
    path.join(testDir, "fixtures/setup-packet/provider-identity-review-required.json"),
    "utf8"
  )
);
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
  assert.match(result.stdout, /OPENAI_BASE_URL to .*\/v1/);
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

test("doctor accepts the repository env.template convention", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  await rename(path.join(root, ".env.example"), path.join(root, "env.template"));

  const result = await runDoctor(root, "http://127.0.0.1:9", { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BenchRouter doctor passed/);
});

test("doctor reads distinct multi-route refs only from canonical YAML", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), multiRouteManifestYaml());
  await writeFile(path.join(root, "src/summarize.js"), "const baseURL = process.env.SUMMARIZE_BASE_URL;\n");
  await writeFile(path.join(root, ".benchrouter/scorer.summarize.js"), "export function score() { return { pass: true }; }\n");
  await writeFile(path.join(root, ".benchrouter/cases.summarize.json"), '[{"id":"summary","input":{"messages":[{"role":"user","content":"summarize"}]}}]\n');
  await writeFile(path.join(root, ".env.example"), "BENCHROUTER_API_KEY=\nOPENAI_BASE_URL=https://api.benchrouter.com/v1\nSUMMARIZE_BASE_URL=https://api.benchrouter.com/v1\n");

  const result = await runDoctor(root, "http://127.0.0.1:9", { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runtime wiring .* 2 routes reference call_site\.base_url_env from code_refs/);
  assert.match(result.stdout, /OPENAI_BASE_URL to .*\/v1; set SUMMARIZE_BASE_URL to .*\/v1/);
});

test("doctor uses the Anthropic API root and validates repository-executable refs without replay shapes", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.ANTHROPIC_BASE_URL;" });
  await mkdir(path.join(root, "eval"), { recursive: true });
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
  await writeFile(path.join(root, "eval/evaluator.mjs"), "export {};\n");
  await writeFile(path.join(root, "eval/corpus.json"), '{"documents":[]}\n');
  await writeFile(path.join(root, "eval/qrels.json"), '{"query-1":{"document-1":1}}\n');
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), repositoryExecutableManifestYaml());
  await writeFile(
    path.join(root, ".env.example"),
    "BENCHROUTER_API_KEY=\nANTHROPIC_BASE_URL=https://api.benchrouter.com\nANTHROPIC_API_KEY=\n"
  );
  await rm(path.join(root, ".benchrouter/scorer.app__chat.js"), { force: true });

  const result = await runDoctor(root, "https://api.benchrouter.com", { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /runtime host checklist: set BENCHROUTER_API_KEY .* ANTHROPIC_BASE_URL to https:\/\/api\.benchrouter\.com(?:\s|$)/
  );
  assert.doesNotMatch(result.stdout, /ANTHROPIC_BASE_URL to https:\/\/api\.benchrouter\.com\/v1/);
  assert.doesNotMatch(result.stderr, /must be a JSON array|no runnable cases|scorer/);
});

test("doctor reports state routes only as obsolete cleanup", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  const statePath = path.join(root, ".benchrouter/.kit-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.routes = [{ route_id: "wrong/stale", incumbent_model: "wrong/old" }];
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const result = await runDoctor(root, "http://127.0.0.1:9", { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains obsolete route declarations.*benchrouter\.yml is canonical.*run benchrouter upgrade/);
  assert.doesNotMatch(result.stderr, /only in|drift|wrong\/stale/);
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

test("doctor accepts a local workflow before GitHub registers the first push", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  const ghBin = await createFixtureGh(t);
  const proxy = await startFixtureProxy(t, {
    status: 200,
    headers: { "x-benchrouter-selected-model": fixture.model },
    body: fixture
  });

  const result = await runCli(["doctor", "--output-dir", root, "--api-url", proxy.url, "--repo", "example/app"], root, {
    BENCHROUTER_API_KEY: "br_test_fixture",
    GH_WORKFLOW_MISSING: "1",
    PATH: `${ghBin}${path.delimiter}${process.env.PATH ?? ""}`
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GitHub workflow not registered yet; this is expected before the generated workflow is pushed/);
  assert.match(result.stdout, /BenchRouter doctor passed/);
});

test("init prints the runtime key, keeps OIDC keyless, and writes runtime-only env example", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-setup-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await writeFile(path.join(root, ".benchrouter/sidecar.mjs"), "// stale generated sidecar\n");
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
          },
          {
            path: ".benchrouter/sidecar.mjs",
            content: "// current generated sidecar\n"
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
      "--force",
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
  assert.match(result.stdout, /npx --yes --package @benchrouter\/cli benchrouter doctor/);
  assert.equal(await readFile(path.join(root, ".benchrouter/sidecar.mjs"), "utf8"), "// current generated sidecar\n");

  const envExample = await readFile(path.join(root, ".env.example"), "utf8");
  assert.match(envExample, /^BENCHROUTER_API_KEY= # runtime key/m);
  assert.match(envExample, /^OPENAI_BASE_URL=https:\/\/api\.benchrouter\.com\/v1 # point this call site's LLM base URL at BenchRouter/m);
  assert.doesNotMatch(envExample, /BENCHROUTER_EVAL_API_KEY/);
  assert.doesNotMatch(envExample, /BENCHROUTER_EVAL_RUN_ID/);
  assert.equal(setupServer.requests.length, 2);
  assert.equal(setupServer.requests[0].authorization, "Bearer br_setup_fixture");
  assert.equal(setupServer.requests[0].body.dry_run, true);
  assert.equal(Object.hasOwn(setupServer.requests[1].body, "dry_run"), false);
  assert.equal(setupServer.requests[1].body.route.provider_id, "openai");
  assert.equal(setupServer.requests[1].body.route.provider_ref, "gpt-4o-mini-2024-07-18");
  assert.equal(setupServer.requests[1].body.route.base_url_env, "OPENAI_BASE_URL");
  assert.deepEqual(setupServer.requests[1].body.route.code_refs, ["src/llm.js"]);
});

test("add-route init merges only requested preview routes and preserves local manifest config", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-add-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  const existingManifest = `# local manifest comment
version: 1
product:
  slug: app
  repo: example/app
  default_branch: custom-release # preserve branch comment
custom_local_config:
  owner: product-team
routes:
  - id: chat
    route_id: app/chat
    name: Local Chat Name
    code_refs: [src/local-chat.ts]
    call_site:
      base_url_env: LOCAL_CHAT_BASE_URL
    seed:
      incumbent_model: local/incumbent
    eval_pack:
      workflow: .github/workflows/benchrouter-evals.yml
      scorer: .benchrouter/scorer.chat.js
      result_schema: benchrouter.result.v1
      case_refs: [.benchrouter/cases.chat.json]
`;
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), existingManifest);
  await writeFile(path.join(root, "package.json"), '{"scripts":{}}\n');
  const previewManifest = `version: 1
product:
  slug: app
  repo: example/app
  default_branch: main
routes:
  - id: chat
    route_id: app/chat
    name: Server Reconstructed Chat
    code_refs: []
    call_site: { base_url_env: WRONG_BASE_URL }
    seed: { incumbent_model: wrong/model }
    eval_pack: { workflow: wrong, scorer: wrong, result_schema: wrong, case_refs: [wrong] }
  - id: summarize
    route_id: app/summarize
    name: Summarize
    code_refs: [src/summarize.ts]
    call_site: { base_url_env: SUMMARIZE_BASE_URL }
    seed: { incumbent_model: openai/gpt-5.4-nano }
    eval_pack: { workflow: .github/workflows/benchrouter-evals.yml, scorer: .benchrouter/scorer.summarize.js, result_schema: benchrouter.result.v1, case_refs: [.benchrouter/cases.summarize.json] }
  - id: classify
    route_id: app/classify
    name: Classify
    code_refs: [src/classify.ts]
    call_site: { base_url_env: CLASSIFY_BASE_URL }
    seed: { incumbent_model: google/gemini-2.5-flash-lite }
    eval_pack: { workflow: .github/workflows/benchrouter-evals.yml, scorer: .benchrouter/scorer.classify.js, result_schema: benchrouter.result.v1, case_refs: [.benchrouter/cases.classify.json] }
`;
  const setupServer = await startFixtureProxy(t, {
    status: 200,
    body: {
      repo_full_name: "example/app",
      setup_packet: {
        files: [
          { path: ".benchrouter/benchrouter.yml", content: previewManifest },
          { path: ".benchrouter/scorer.summarize.js", content: "export const summarize = true;\n" },
          { path: ".benchrouter/scorer.classify.js", content: "export const classify = true;\n" }
        ],
        package_json: { scripts: {}, dev_dependencies: [] },
        runtime_env: {},
        setup_api_keys: { production: { key: "br_live_add_route" } }
      }
    }
  });
  const command = [
    "init", "--setup-key", "br_setup_add_route", "--repo", "example/app",
    "--route-id", "app/summarize", "--name", "Summarize", "--incumbent-model", "openai/gpt-5.4-nano",
    "--route-id", "app/classify", "--name", "Classify", "--incumbent-model", "google/gemini-2.5-flash-lite",
    "--api-url", setupServer.url, "--output-dir", root
  ];

  const first = await runCli(command, root);
  assert.equal(first.status, 0, first.stderr);
  const merged = await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8");
  assert.match(merged, /# local manifest comment/);
  assert.match(merged, /default_branch: custom-release # preserve branch comment/);
  assert.match(merged, /custom_local_config:\n  owner: product-team/);
  assert.match(merged, /name: Local Chat Name/);
  assert.match(merged, /LOCAL_CHAT_BASE_URL/);
  assert.doesNotMatch(merged, /Server Reconstructed Chat|WRONG_BASE_URL|wrong\/model/);
  assert.equal((merged.match(/route_id: app\/chat/g) ?? []).length, 1);
  assert.equal((merged.match(/route_id: app\/summarize/g) ?? []).length, 1);
  assert.equal((merged.match(/route_id: app\/classify/g) ?? []).length, 1);
  assert.equal(setupServer.requests.length, 2);
  assert.equal(setupServer.requests[0].body.dry_run, true);
  assert.equal(Object.hasOwn(setupServer.requests[1].body, "dry_run"), false);
  assert.equal(setupServer.requests[1].body.routes.length, 1);

  const second = await runCli(command, root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8"), merged);
  assert.equal(setupServer.requests.length, 4);
});

test("init does not commit the server packet before local file application succeeds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-local-write-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".benchrouter"), "blocks generated directory creation\n");
  const setupServer = await startFixtureProxy(t, {
    status: 200,
    body: {
      repo_full_name: "example/app",
      setup_packet: {
        files: [{ path: ".benchrouter/README.md", content: "# BenchRouter\n" }],
        package_json: { scripts: {}, dev_dependencies: [] },
        runtime_env: {}
      }
    }
  });

  const result = await runCli([
    "init", "--setup-key", "br_setup_fixture", "--repo", "example/app",
    "--route-id", routeId, "--name", "Chat", "--incumbent-model", "openai/gpt-4o-mini",
    "--api-url", setupServer.url, "--output-dir", root
  ], root);

  assert.equal(result.status, 1);
  assert.equal(setupServer.requests.length, 1);
  assert.equal(setupServer.requests[0].body.dry_run, true);
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

test("init gives an actionable initial-setup key expiry error", async (t) => {
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
    "Setup access expired. Refresh it at https://benchrouter.com/cli and run init again.\n"
  );
  assert.equal(setupServer.requests.length, 1);
});

test("init sends expired add-route setup scope back to the add-route flow", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-expired-add-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), "version: 1\n");
  const setupServer = await startFixtureProxy(t, {
    status: 401,
    body: {
      error: "setup_scope_expired",
      message: "BenchRouter setup access has expired"
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
    "Setup access expired. Refresh it at https://benchrouter.com/cli/new and run init again.\n"
  );
  assert.equal(setupServer.requests.length, 1);
});

test("init stops for bound user approval and preserves the exact observed incumbent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-model-choice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setupServer = await startFixtureProxy(t, {
    status: 409,
    body: replacementConfirmationFixture
  });

  const result = await runCli(
    [
      "init",
      "--setup-key", "br_setup_model_choice_fixture",
      "--route-id", routeId,
      "--name", "Chat",
      "--incumbent-model", "grok-4-1-fast-reasoning-latest",
      "--provider-id", "xai",
      "--provider-ref", "grok-4-1-fast-reasoning-latest",
      "--api-url", setupServer.url,
      "--output-dir", root
    ],
    root
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Observed model: grok-4-1-fast-reasoning-latest/);
  assert.match(result.stderr, /Provider: xai/);
  assert.match(result.stderr, /Exact provider reference: grok-4-1-fast-reasoning-latest/);
  assert.match(result.stderr, /Canonical original: x-ai\/grok-4\.1-fast/);
  assert.match(result.stderr, /x-ai\/grok-4\.3 \(provider_successor; input \$0\.2\/1M, output \$0\.5\/1M, 1x incumbent price\)/);
  assert.match(result.stderr, /Approval context expires at: 2026-08-19T20:00:00\.000Z/);
  assert.match(result.stderr, /Do not choose or substitute one yourself/);
  assert.match(result.stderr, /Keep --incumbent-model, --provider-id, and --provider-ref unchanged/);
  assert.match(result.stderr, /--approved-baseline-model <listed-canonical-id>/);
  assert.match(result.stderr, /--incumbent-approval-context-id iac_fixture_grok_41_fast/);
  assert.equal(setupServer.requests.length, 1);
  assert.deepEqual(setupServer.requests[0].body.route, {
    route_id: routeId,
    name: "Chat",
    incumbent_model: "grok-4-1-fast-reasoning-latest",
    provider_id: "xai",
    provider_ref: "grok-4-1-fast-reasoning-latest"
  });
});

test("init sends replacement approval only with its server-bound context", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-bound-model-choice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setupServer = await startFixtureProxy(t, {
    status: 409,
    body: replacementConfirmationFixture
  });
  const baseArgs = [
    "init",
    "--setup-key", "br_setup_model_choice_fixture",
    "--route-id", routeId,
    "--name", "Chat",
    "--incumbent-model", "grok-4-1-fast-reasoning-latest",
    "--provider-id", "xai",
    "--provider-ref", "grok-4-1-fast-reasoning-latest",
    "--api-url", setupServer.url,
    "--output-dir", root
  ];

  const missingContext = await runCli([
    ...baseArgs,
    "--approved-baseline-model", "x-ai/grok-4.3"
  ], root);

  assert.equal(missingContext.status, 1);
  assert.match(missingContext.stderr, /Pass --approved-baseline-model and --incumbent-approval-context-id together/);
  assert.equal(setupServer.requests.length, 0);

  const approved = await runCli([
    ...baseArgs,
    "--approved-baseline-model", "x-ai/grok-4.3",
    "--incumbent-approval-context-id", "iac_fixture_grok_41_fast"
  ], root);

  assert.equal(approved.status, 1);
  assert.equal(setupServer.requests.length, 1);
  assert.deepEqual(setupServer.requests[0].body.route, {
    route_id: routeId,
    name: "Chat",
    incumbent_model: "grok-4-1-fast-reasoning-latest",
    provider_id: "xai",
    provider_ref: "grok-4-1-fast-reasoning-latest",
    approved_baseline_model: "x-ai/grok-4.3",
    incumbent_approval_context_id: "iac_fixture_grok_41_fast"
  });
});

test("init sends an unknown provider identity to review without offering substitution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-provider-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setupServer = await startFixtureProxy(t, {
    status: 409,
    body: providerIdentityReviewFixture
  });

  const result = await runCli([
    "init",
    "--setup-key", "br_setup_provider_review_fixture",
    "--route-id", routeId,
    "--name", "Synopsis",
    "--incumbent-model", "claude-haiku-4-5-20991231",
    "--provider-id", "anthropic",
    "--provider-ref", "claude-haiku-4-5-20991231",
    "--api-url", setupServer.url,
    "--output-dir", root
  ], root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot prove the identity of the observed incumbent/);
  assert.match(result.stderr, /Observed model: claude-haiku-4-5-20991231/);
  assert.match(result.stderr, /Provider: anthropic/);
  assert.match(result.stderr, /Exact provider reference: claude-haiku-4-5-20991231/);
  assert.match(result.stderr, /Do not substitute a model or remove provider metadata/);
  assert.doesNotMatch(result.stderr, /--approved-baseline-model/);
  assert.equal(setupServer.requests.length, 1);
  assert.deepEqual(setupServer.requests[0].body.route, {
    route_id: routeId,
    name: "Synopsis",
    incumbent_model: "claude-haiku-4-5-20991231",
    provider_id: "anthropic",
    provider_ref: "claude-haiku-4-5-20991231"
  });
});

test("init maps validated repository-executable eval packs to matching routes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-executable-packs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "eval"), { recursive: true });
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
  for (const file of [
    "route-a.mjs", "route-b.mjs", "corpus-a.json", "corpus-b.json",
    "queries-a.json", "queries-b.json", "qrels-a.json", "qrels-b.json"
  ]) {
    await writeFile(path.join(root, "eval", file), file.endsWith(".mjs") ? "// executable eval\n" : "{}\n");
  }
  const firstPack = repositoryExecutableEvalPack({
    api_family: "anthropic_messages",
    id: "route_a_retrieval_v1",
    command: "node eval/route-a.mjs",
    scorer: ".benchrouter/scorer.route-a.js",
    case_refs: ["eval/queries-a.json"],
    argv: ["node", "eval/route-a.mjs"],
    input_refs: ["eval/route-a.mjs", "eval/corpus-a.json"],
    acceptance_refs: ["eval/queries-a.json", "eval/qrels-a.json"],
    primary_metric: "recall_at_5"
  });
  const secondPack = repositoryExecutableEvalPack({
    api_family: "openai_responses",
    id: "route_b_retrieval_v1",
    command: "node eval/route-b.mjs",
    scorer: ".benchrouter/scorer.route-b.js",
    case_refs: ["eval/queries-b.json"],
    argv: ["node", "eval/route-b.mjs"],
    input_refs: ["eval/route-b.mjs", "eval/corpus-b.json"],
    acceptance_refs: ["eval/queries-b.json", "eval/qrels-b.json"],
    primary_metric: "recall_at_10",
    timeout_minutes: 350,
    secret_env: ["EMBEDDING_API_KEY"]
  });
  await writeFile(path.join(root, "route-a-pack.json"), `${JSON.stringify(firstPack, null, 2)}\n`);
  await writeFile(path.join(root, "route-b-pack.json"), `${JSON.stringify(secondPack, null, 2)}\n`);
  const setupServer = await startFixtureProxy(t, {
    status: 401,
    body: { error: "setup_scope_expired", message: "BenchRouter setup access has expired" }
  });

  const result = await runCli([
    "init",
    "--setup-key", "br_setup_executable_pack_fixture",
    "--route-id", "app/route-a",
    "--name", "Route A",
    "--incumbent-model", "openai/gpt-4o-mini",
    "--eval-pack", "route-a-pack.json",
    "--route-id", "app/route-b",
    "--name", "Route B",
    "--incumbent-model", "openai/gpt-4o-mini",
    "--eval-pack", "route-b-pack.json",
    "--api-url", setupServer.url,
    "--output-dir", root
  ], root);

  assert.equal(result.status, 1);
  assert.equal(setupServer.requests.length, 1);
  assert.deepEqual(setupServer.requests[0].body.route.eval_pack, firstPack);
  assert.deepEqual(setupServer.requests[0].body.routes[0].eval_pack, secondPack);
  assert.equal(setupServer.requests[0].body.route.eval_pack.api_family, "anthropic_messages");
  assert.equal(setupServer.requests[0].body.routes[0].eval_pack.api_family, "openai_responses");
});

test("init rejects an unsafe or mutable executable eval pack before HTTP", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-invalid-executable-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "eval"), { recursive: true });
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
  await writeFile(path.join(root, "eval/evaluator.mjs"), "// executable eval\n");
  await writeFile(path.join(root, "eval/cases.json"), "{}\n");
  await writeFile(path.join(root, "eval/qrels.json"), "{}\n");
  const packPath = path.join(root, "eval-pack.json");
  const command = [
    "init",
    "--setup-key", "br_setup_invalid_executable_pack",
    "--route-id", routeId,
    "--name", "Chat",
    "--incumbent-model", "openai/gpt-4o-mini",
    "--eval-pack", "eval-pack.json",
    "--api-url", "http://127.0.0.1:9",
    "--output-dir", root
  ];

  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ runtime_version: "latest" }))}\n`);
  const mutableRuntime = await runCli(command, root);
  assert.equal(mutableRuntime.status, 1);
  assert.match(mutableRuntime.stderr, /runtime_version must be an exact version/);
  assert.doesNotMatch(mutableRuntime.stderr, /fetch failed/);

  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ api_family: undefined }))}\n`);
  const missingApiFamily = await runCli(command, root);
  assert.equal(missingApiFamily.status, 1);
  assert.match(missingApiFamily.stderr, /api_family must be openai_chat_completions, anthropic_messages, or openai_responses/);
  assert.doesNotMatch(missingApiFamily.stderr, /fetch failed/);

  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ api_family: "responses" }))}\n`);
  const legacyApiFamily = await runCli(command, root);
  assert.equal(legacyApiFamily.status, 1);
  assert.match(legacyApiFamily.stderr, /api_family must be openai_chat_completions, anthropic_messages, or openai_responses/);
  assert.doesNotMatch(legacyApiFamily.stderr, /fetch failed/);

  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ acceptance_refs: ["../qrels.json"] }))}\n`);
  const traversal = await runCli(command, root);
  assert.equal(traversal.status, 1);
  assert.match(traversal.stderr, /acceptance_refs\[0\] must be a normalized repository-relative path/);
  assert.doesNotMatch(traversal.stderr, /fetch failed/);

  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ timeout_minutes: 351 }))}\n`);
  const excessiveTimeout = await runCli(command, root);
  assert.equal(excessiveTimeout.status, 1);
  assert.match(excessiveTimeout.stderr, /timeout_minutes must be from 1 through 350/);
  assert.doesNotMatch(excessiveTimeout.stderr, /fetch failed/);
});

test("init stops before local writes when preview reports the one-time runtime key was already provisioned", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-provisioned-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setupServer = await startFixtureProxy(t, {
    status: 200,
    body: {
      repo_full_name: "example/app",
      setup_packet: {
        keys_already_provisioned: true,
        rotate_url: "https://benchrouter.com/account",
        files: [{ path: ".benchrouter/README.md", content: "# must not be written\n" }],
        package_json: { scripts: {}, dev_dependencies: [] },
        runtime_env: {}
      }
    }
  });

  const result = await runCli(
    [
      "init",
      "--setup-key",
      "br_setup_used_fixture",
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
    "This setup session already provisioned its one-time runtime key. Create a replacement key at https://benchrouter.com/account, then start a new setup session and run init again.\n"
  );
  assert.equal(existsSync(path.join(root, ".benchrouter/README.md")), false);
  assert.equal(setupServer.requests.length, 1);
  assert.equal(setupServer.requests[0].body.dry_run, true);
});

test("upgrade removes obsolete state routes while preserving canonical multi-route semantics", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-setup-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  const oldUpload = "export const oldUpload = true;\n";
  const oldEvalRunner = "const DEFAULT_MODEL = 'wrong/older-model';\n";
  const canonicalYaml = `version: 1

product:
  slug: app
  repo: example/app
  default_branch: main

routes:
  - id: compose
    route_id: app/compose
    name: Compose
    code_refs:
      - src/compose.ts
      - src/prompts/compose.ts
    call_site:
      base_url_env: COMPOSE_BASE_URL
      provider_id: anthropic
      provider_ref: claude-haiku-4-5
    seed:
      incumbent_model: anthropic/claude-haiku-4.5
    eval_pack:
      workflow: .github/workflows/benchrouter-evals.yml
      scorer: .benchrouter/scorer.compose.js
      result_schema: benchrouter.result.v1
      case_refs:
        - .benchrouter/cases.compose.json
  - id: summarize
    route_id: app/summarize
    name: Summarize
    code_refs:
      - src/summarize.ts
    call_site:
      base_url_env: SUMMARIZE_BASE_URL
      provider_id: openai
      provider_ref: gpt-5.4-nano
    seed:
      incumbent_model: openai/gpt-5.4-nano
    eval_pack:
      workflow: .github/workflows/benchrouter-evals.yml
      scorer: .benchrouter/scorer.summarize.js
      result_schema: benchrouter.result.v1
      case_refs:
        - .benchrouter/cases.summarize.json
`;
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
      { path: ".benchrouter/benchrouter-eval.mjs", sha256: sha256(oldEvalRunner) },
      { path: ".benchrouter/scorer.compose.js", sha256: "a".repeat(64) }
    ]
  };
  await writeFile(
    path.join(root, ".benchrouter/.kit-state.json"),
    `${JSON.stringify(existingState, null, 2)}\n`
  );
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), canonicalYaml);
  await writeFile(path.join(root, ".benchrouter/upload-results.mjs"), oldUpload);
  await writeFile(path.join(root, ".benchrouter/benchrouter-eval.mjs"), oldEvalRunner);

  const preservedFiles = new Map([
    [".benchrouter/scorer.compose.js", "export const composeScorer = true;\n"],
    [".benchrouter/scorer.summarize.js", "export const summarizeScorer = true;\n"],
    [".benchrouter/cases.compose.json", '[{"id":"compose"}]\n'],
    [".benchrouter/cases.summarize.json", '[{"id":"summarize"}]\n'],
    [".benchrouter/calibration.compose.json", '{"fixtures":[]}\n'],
    ["src/compose.ts", "export const compose = true;\n"],
    ["src/prompts/compose.ts", "export const prompt = true;\n"],
    ["src/summarize.ts", "export const summarize = true;\n"]
  ]);
  for (const [relativePath, contents] of preservedFiles) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), contents);
  }

  const nextUpload = "export const upgradedUpload = true;\n";
  const workflow = "name: BenchRouter Evals\n";
  const nextEvalRunner = "// generic: reads .benchrouter/benchrouter.yml\n";
  const nextCalibrateRunner = "// generic: reads .benchrouter/benchrouter.yml\n";
  const nextSidecar = "// generic capture: reads .benchrouter/benchrouter.yml\n";
  const readme = "# BenchRouter\nCanonical routes: .benchrouter/benchrouter.yml\n";
  const events = [];
  const upgradeFiles = [
    { path: ".benchrouter/upload-results.mjs", content: nextUpload, sha256: sha256(nextUpload) },
    { path: ".benchrouter/benchrouter-eval.mjs", content: nextEvalRunner, sha256: sha256(nextEvalRunner) },
    { path: ".benchrouter/benchrouter-calibrate.mjs", content: nextCalibrateRunner, sha256: sha256(nextCalibrateRunner) },
    { path: ".benchrouter/sidecar.mjs", content: nextSidecar, sha256: sha256(nextSidecar) },
    { path: ".github/workflows/benchrouter-evals.yml", content: workflow, sha256: sha256(workflow) },
    { path: ".benchrouter/README.md", content: readme, sha256: sha256(readme) }
  ];
  assert.deepEqual(upgradeFiles.map((file) => file.path).sort(), [
    ".benchrouter/README.md",
    ".benchrouter/benchrouter-calibrate.mjs",
    ".benchrouter/benchrouter-eval.mjs",
    ".benchrouter/sidecar.mjs",
    ".benchrouter/upload-results.mjs",
    ".github/workflows/benchrouter-evals.yml"
  ].sort());
  await assert.rejects(
    applyUpgradePacket({
      outputDir: root,
      setupKitVersion: "0.0.10",
      files: [{
        path: ".benchrouter/cases.compose.json",
        content: "[]\n",
        sha256: sha256("[]\n")
      }]
    }),
    /unsupported path \.benchrouter\/cases\.compose\.json/
  );
  await applyUpgradePacket({
    outputDir: root,
    setupKitVersion: "0.0.10",
    files: upgradeFiles,
    onFile(action, filePath) {
      events.push(`${action} ${filePath}`);
    }
  });

  const upgradedState = JSON.parse(await readFile(path.join(root, ".benchrouter/.kit-state.json"), "utf8"));
  assert.equal(Object.hasOwn(upgradedState, "routes"), false);
  assert.equal(upgradedState.version, "0.0.10");
  assert.deepEqual(upgradedState.product, existingState.product);
  assert.equal(upgradedState.files.find((file) => file.path === ".benchrouter/upload-results.mjs").sha256, sha256(nextUpload));
  assert.equal(upgradedState.files.find((file) => file.path === ".benchrouter/benchrouter-eval.mjs").sha256, sha256(nextEvalRunner));
  assert.equal(upgradedState.files.find((file) => file.path === ".benchrouter/scorer.compose.js").sha256, "a".repeat(64));
  assert.equal(await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8"), canonicalYaml);
  assert.equal(await readFile(path.join(root, ".benchrouter/upload-results.mjs"), "utf8"), nextUpload);
  assert.equal(await readFile(path.join(root, ".benchrouter/benchrouter-eval.mjs"), "utf8"), nextEvalRunner);
  assert.doesNotMatch(await readFile(path.join(root, ".benchrouter/benchrouter-eval.mjs"), "utf8"), /wrong\/older-model|DEFAULT_MODEL/);
  assert.equal(await readFile(path.join(root, ".github/workflows/benchrouter-evals.yml"), "utf8"), workflow);
  for (const [relativePath, contents] of preservedFiles) {
    assert.equal(await readFile(path.join(root, relativePath), "utf8"), contents);
  }
  assert.equal(events.at(-1), "updated .benchrouter/.kit-state.json");
});

test("upgrade validates canonical YAML before any preview or token consumption", async (t) => {
  const root = await createUpgradeTarget(t, { writeManifest: false });
  const originalState = await readFile(path.join(root, ".benchrouter/.kit-state.json"), "utf8");
  const server = await startFixtureProxy(t, {
    status: 200,
    body: upgradePacketBody(exactUpgradeFiles())
  });
  const args = [
    "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", routeId, "--api-url", server.url, "--output-dir", root, "--yes"
  ];

  const missing = await runCli(args, root);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /benchrouter\.yml is not valid YAML.*ENOENT/);
  assert.equal(server.requests.length, 0);
  assert.equal(await readFile(path.join(root, ".benchrouter/.kit-state.json"), "utf8"), originalState);

  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), "routes:\n  - [broken\n");
  const invalid = await runCli(args, root);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /benchrouter\.yml is not valid YAML/);
  assert.equal(server.requests.length, 0);
  assert.equal(await readFile(path.join(root, ".benchrouter/.kit-state.json"), "utf8"), originalState);
});

test("upgrade revalidates canonical YAML immediately before apply", async (t) => {
  const root = await createUpgradeTarget(t);
  const statePath = path.join(root, ".benchrouter/.kit-state.json");
  const originalState = await readFile(statePath, "utf8");
  const server = await startFixtureProxy(t, {
    status: 200,
    body: upgradePacketBody(exactUpgradeFiles()),
    async onRequest({ requestIndex }) {
      if (requestIndex === 0) {
        await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), "routes:\n  - [broken\n");
      }
    }
  });

  const result = await runCli([
    "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", routeId, "--api-url", server.url, "--output-dir", root, "--yes"
  ], root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /benchrouter\.yml is not valid YAML/);
  assert.equal(server.requests.length, 1);
  assert.equal(await readFile(statePath, "utf8"), originalState);
  assert.equal(Object.hasOwn(JSON.parse(originalState), "routes"), true);
});

test("upgrade rejects legacy, subset, and duplicate generated packets before writes", async (t) => {
  const exact = exactUpgradeFiles();
  const cases = [
    ["legacy three-file packet", exact.filter((file) => [
      ".github/workflows/benchrouter-evals.yml",
      ".benchrouter/upload-results.mjs",
      ".benchrouter/README.md"
    ].includes(file.path))],
    ["five-file subset", exact.slice(0, 5)],
    ["duplicate path", [...exact.slice(0, 5), exact[0]]]
  ];

  for (const [label, files] of cases) {
    await t.test(label, async (subtest) => {
      const root = await createUpgradeTarget(subtest);
      const originalState = await readFile(path.join(root, ".benchrouter/.kit-state.json"), "utf8");
      const server = await startFixtureProxy(subtest, {
        status: 200,
        body: upgradePacketBody(files)
      });
      const result = await runCli([
        "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
        "--route-id", routeId, "--api-url", server.url, "--output-dir", root, "--dry-run"
      ], root);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /must contain exactly one of each generated path/);
      assert.equal(server.requests.length, 1);
      assert.equal(await readFile(path.join(root, ".benchrouter/.kit-state.json"), "utf8"), originalState);
      assert.equal(Object.hasOwn(JSON.parse(originalState), "routes"), true);
    });
  }
});

test("upgrade removes state routes only after valid YAML and an exact six-file apply", async (t) => {
  const root = await createUpgradeTarget(t);
  const yamlBefore = await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8");
  const files = exactUpgradeFiles();
  const server = await startFixtureProxy(t, {
    status: 200,
    body: upgradePacketBody(files)
  });

  const result = await runCli([
    "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", routeId, "--api-url", server.url, "--output-dir", root, "--yes"
  ], root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(server.requests.length, 2);
  assert.match(server.requests[0].url, /\/v1\/setup\/upgrade-packet\/preview$/);
  assert.match(server.requests[1].url, /\/v1\/control\/setup-packet\/upgrade$/);
  const state = JSON.parse(await readFile(path.join(root, ".benchrouter/.kit-state.json"), "utf8"));
  assert.equal(Object.hasOwn(state, "routes"), false);
  assert.equal(state.version, "0.0.10");
  assert.equal(await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8"), yamlBefore);
  for (const file of files) {
    assert.equal(await readFile(path.join(root, file.path), "utf8"), file.content);
  }
  assert.match(result.stdout, /npx --yes --package @benchrouter\/cli benchrouter doctor --repo example\/app/);
});

test("upgrade fails closed before HTTP when repository kit state is missing or invalid", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-upgrade-invalid-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), manifestYaml());
  const args = [
    "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", routeId, "--api-url", "http://127.0.0.1:1", "--output-dir", root, "--yes"
  ];

  const missing = await runCli(args, root);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Cannot upgrade without \.benchrouter\/\.kit-state\.json/);
  assert.match(missing.stderr, /benchrouter init/);

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

async function createUpgradeTarget(t, { writeManifest = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-upgrade-target-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  if (writeManifest) {
    await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), manifestYaml());
  }
  await writeFile(
    path.join(root, ".benchrouter/.kit-state.json"),
    `${JSON.stringify({
      version: "0.0.9",
      generated_by: "benchrouter.setup_packet.v1",
      product: { slug: "app", default_branch: "main", repo_full_name: "example/app" },
      routes: [{ route_id: routeId, incumbent_model: "wrong/old-model" }],
      files: []
    }, null, 2)}\n`
  );
  return root;
}

function exactUpgradeFiles() {
  return [
    generatedUpgradeFile(".github/workflows/benchrouter-evals.yml", "name: BenchRouter Evals\n"),
    generatedUpgradeFile(".benchrouter/upload-results.mjs", "// generic upload helper\n"),
    generatedUpgradeFile(".benchrouter/benchrouter-eval.mjs", "// generic eval runner\n"),
    generatedUpgradeFile(".benchrouter/benchrouter-calibrate.mjs", "// generic calibration runner\n"),
    generatedUpgradeFile(".benchrouter/sidecar.mjs", "// generic capture sidecar\n"),
    generatedUpgradeFile(".benchrouter/README.md", "# BenchRouter\n")
  ];
}

function generatedUpgradeFile(filePath, content) {
  return { path: filePath, content, sha256: sha256(content) };
}

function upgradePacketBody(files) {
  return {
    ok: true,
    repo_full_name: "example/app",
    route_id: routeId,
    setup_kit_version: "0.0.10",
    files
  };
}

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
      version: "0.0.10",
      files: [
        { path: ".benchrouter/scorer.app__chat.js", sha256: "a".repeat(64) },
        { path: ".benchrouter/cases.app__chat.json", sha256: "b".repeat(64) }
      ]
    }, null, 2)}\n`
  );
  await writeFile(
    path.join(root, ".benchrouter/upload-results.mjs"),
    [
      "const commands = ['prepare', 'validate-dispatch', 'report-snapshot', 'plan-pr', 'import-main', 'run-session', 'run-pack'];",
      "const paths = ['/v1/control/eval-plan', '/v1/control/eval-session/next', '/v1/route-snapshots', '/v1/eval-model-runs/'];",
      "const fields = ['pull_request_number', 'head_sha'];",
      "void commands; void paths; void fields;",
      ""
    ].join("\n")
  );
  await writeFile(path.join(root, ".benchrouter/sidecar.mjs"), "export {};\n");
  await writeFile(path.join(root, ".benchrouter/benchrouter-eval.mjs"), "export {};\n");
  await writeFile(path.join(root, ".benchrouter/benchrouter-calibrate.mjs"), "export {};\n");
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
      "      - name: Test route models and update the PPF",
      "        run: node .benchrouter/upload-results.mjs run-session",
      "        env:",
      "          BENCHROUTER_PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
      "      - run: node .benchrouter/upload-results.mjs run-pack",
      "      # workflow_dispatch benchrouter_plan pull_request id-token: write"
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
  if (process.env.GH_WORKFLOW_MISSING === "1") {
    process.stdout.write(JSON.stringify({ total_count: 0, workflows: [] }));
    process.exit(0);
  }
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

function multiRouteManifestYaml() {
  return `${manifestYaml()}  - id: summarize
    route_id: app/summarize
    name: Summarize
    code_refs:
      - src/summarize.js
    call_site:
      base_url_env: SUMMARIZE_BASE_URL
      provider_id: openai
      provider_ref: gpt-5.4-nano
    seed:
      incumbent_model: openai/gpt-5.4-nano
    eval_pack:
      id: summarize_v1
      config_path: .benchrouter/benchrouter.yml
      workflow: .github/workflows/benchrouter-evals.yml
      command: npm run benchrouter:eval
      capture_command: npm test
      scorer: .benchrouter/scorer.summarize.js
      result_schema: benchrouter.result.v1
      case_refs:
        - .benchrouter/cases.summarize.json
`;
}

function repositoryExecutableManifestYaml() {
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
      base_url_env: ANTHROPIC_BASE_URL
      provider_id: anthropic
      provider_ref: claude-haiku-4-5-20251001
    seed:
      incumbent_model: anthropic/claude-haiku-4.5
    eval_pack:
      mode: repository_executable
      api_family: anthropic_messages
      id: chat_repository_v1
      config_path: .benchrouter/benchrouter.yml
      workflow: .github/workflows/benchrouter-evals.yml
      command: node eval/evaluator.mjs
      scorer: .benchrouter/scorer.app__chat.js
      result_schema: benchrouter.executable_result.v1
      case_refs:
        - eval/qrels.json
      argv:
        - node
        - eval/evaluator.mjs
      runtime: node
      runtime_version: 22.18.0
      lockfile: package-lock.json
      input_refs:
        - eval/evaluator.mjs
        - eval/corpus.json
      acceptance_refs:
        - eval/qrels.json
      result_path: .benchrouter/executable-result.json
      primary_metric: recall_at_5
      max_model_calls: 100
      max_cost_usd: 10
      max_cost_per_call_usd: 0.1
      timeout_minutes: 60
      secret_env: []
`;
}

function repositoryExecutableEvalPack(overrides = {}) {
  return {
    mode: "repository_executable",
    api_family: "openai_chat_completions",
    id: "app_chat_repository_v1",
    config_path: ".benchrouter/benchrouter.yml",
    workflow: ".github/workflows/benchrouter-evals.yml",
    command: "node eval/evaluator.mjs",
    scorer: ".benchrouter/scorer.app__chat.js",
    result_schema: "benchrouter.executable_result.v1",
    case_refs: ["eval/cases.json"],
    argv: ["node", "eval/evaluator.mjs"],
    runtime: "node",
    runtime_version: "22.18.0",
    lockfile: "package-lock.json",
    input_refs: ["eval/evaluator.mjs", "eval/cases.json"],
    acceptance_refs: ["eval/qrels.json"],
    result_path: ".benchrouter/executable-result.json",
    primary_metric: "recall_at_5",
    max_model_calls: 100,
    max_cost_usd: 10,
    max_cost_per_call_usd: 0.1,
    timeout_minutes: 60,
    secret_env: [],
    ...overrides
  };
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
    await responseFixture.onRequest?.({ requestIndex: requests.length - 1, request, rawBody });

    const body = typeof responseFixture.body === "function"
      ? responseFixture.body({ requestIndex: requests.length - 1, requestBody: requests.at(-1).body })
      : responseFixture.body;
    const responseBody = JSON.stringify(body);
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
