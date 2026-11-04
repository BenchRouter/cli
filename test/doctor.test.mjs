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
import { applyUpgradePacket, LOCAL_SCRIPTS } from "../src/generated-kit.mjs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const cliPath = path.join(repoRoot, "bin/benchrouter.mjs");
const routeId = "app/chat";
const signedKitFixture = new Map(await Promise.all([
  [".benchrouter/bootstrap.mjs", "bootstrap.mjs.txt"],
  [".benchrouter/trust.json", "trust.json"],
  [".github/workflows/benchrouter-evals.yml", "workflow.yml"]
].map(async ([filePath, fixtureName]) => [filePath, await readFile(path.join(testDir, "fixtures/signed-kit", fixtureName), "utf8")])));

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

const acceptedManifest = { ok: true, errors: [], routes: [{ route_id: routeId, ok: true, errors: [] }], not_checked: [] };

for (const phase of ["evaluation", "activation"]) {
  test(`${phase} doctor checks the exact manifest with account auth and the route filter`, { timeout: 4900 }, async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
    const manifest = `${manifestYaml()}\n# Preserve this comment and UTF-8: café\n`;
    await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), manifest);
    const proxy = await startFixtureProxy(t, { status: 200, body: acceptedManifest });
    const result = await runManifestDoctor(root, proxy.url, {
      BENCHROUTER_ACCOUNT_TOKEN: "br_ctrl_manifest",
      BENCHROUTER_SETUP_KEY: "br_setup_unused",
      BENCHROUTER_API_KEY: "br_test_unused",
      BENCHROUTER_ADMIN_TOKEN: "bradm_unused"
    }, ["--phase", phase, "--route-id", routeId]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.split("\n").includes("doctor passed: manifest check: BenchRouter accepted benchrouter.yml"));
    assert.equal(proxy.requests.length, 1);
    assert.deepEqual(proxy.requests[0], {
      method: "POST", url: "/v1/repo/manifest-check", authorization: "Bearer br_ctrl_manifest",
      contentType: "application/json",
      body: { repo_full_name: "example/app", manifest_yaml: manifest, route_id: routeId }
    });
  });
}

test("doctor reports exact whole-manifest and route refusals and redacts the credential", { timeout: 4900 }, async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  const token = "br_ctrl_manifest_secret";
  const proxy = await startFixtureProxy(t, { status: 200, body: {
    ok: false, errors: ["Product repo does not match manifest.", `Refused ${token}.`],
    routes: [{ route_id: routeId, ok: false, errors: ["eval_pack.case_refs must include the snapshot input."] }], not_checked: []
  } });
  const result = await runManifestDoctor(root, proxy.url, { BENCHROUTER_ACCOUNT_TOKEN: token });
  assert.equal(result.status, 1);
  const lines = result.stderr.split("\n");
  assert.ok(lines.includes("doctor failed: manifest check: Product repo does not match manifest."));
  assert.ok(lines.includes("doctor failed: manifest check: Refused [REDACTED]."));
  assert.ok(lines.includes(`doctor failed: manifest check route ${routeId}: eval_pack.case_refs must include the snapshot input.`));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
  assert.ok(!result.stderr.includes("doctor passed: manifest check:"));
});

test("doctor prints not_checked entries as skipped and redacts all server fields", { timeout: 4900 }, async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  const token = "br_setup_manifest_secret";
  const proxy = await startFixtureProxy(t, { status: 200, body: {
    ...acceptedManifest, not_checked: [{ check: `snapshot ${token}`, detail: `No snapshot for ${token}.` }]
  } });
  const result = await runManifestDoctor(root, proxy.url, { BENCHROUTER_SETUP_KEY: token });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split("\n").includes("doctor skipped: manifest check snapshot [REDACTED]: No snapshot for [REDACTED]."));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token));
});

test("doctor skips manifest rules without credentials and never sends runtime or admin keys", { timeout: 4900 }, async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  const proxy = await startFixtureProxy(t, { status: 200, body: acceptedManifest });
  const result = await runManifestDoctor(root, proxy.url, {
    BENCHROUTER_API_KEY: "br_test_unused", BENCHROUTER_ADMIN_TOKEN: "bradm_unused"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split("\n").includes("doctor skipped: manifest rules not checked (no credential)"));
  assert.equal(proxy.requests.length, 0);
});

for (const source of ["argument", "environment", "saved"]) {
  test(`doctor uses the ${source} repository setup key`, { timeout: 4900 }, async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
    const token = "br_setup_manifest";
    const env = source === "environment" ? { BENCHROUTER_SETUP_KEY: token } : {};
    const flags = source === "argument" ? ["--setup-key", token] : [];
    if (source === "saved") {
      const configDir = path.join(root, ".test-config", "repositories");
      await mkdir(configDir, { recursive: true });
      await writeFile(path.join(configDir, `${Buffer.from("example/app").toString("base64url")}.json`),
        JSON.stringify({ repo_full_name: "example/app", token }), { mode: 0o600 });
    }
    const proxy = await startFixtureProxy(t, { status: 200, body: acceptedManifest });
    const result = await runManifestDoctor(root, proxy.url, env, flags);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(proxy.requests.length, 1);
    assert.equal(proxy.requests[0].authorization, `Bearer ${token}`);
    assert.ok(!Object.hasOwn(proxy.requests[0].body, "route_id"));
  });
}

test("doctor prefers a saved account login over an explicit setup key", { timeout: 4900 }, async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  const configDir = path.join(root, ".test-config");
  await mkdir(configDir);
  await writeFile(path.join(configDir, "account.json"), JSON.stringify({ token: "br_ctrl_saved" }), { mode: 0o600 });
  const proxy = await startFixtureProxy(t, { status: 200, body: acceptedManifest });
  const result = await runManifestDoctor(root, proxy.url, {}, ["--setup-key", "br_setup_unused"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(proxy.requests.length, 1);
  assert.equal(proxy.requests[0].authorization, "Bearer br_ctrl_saved");
});

for (const status of [400, 401, 403, 413, 503]) {
  test(`doctor handles manifest HTTP ${status} without printing remote messages`, { timeout: 4900 }, async (t) => {
    const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
    const proxy = await startFixtureProxy(t, { status, body: { error: { code: "manifest_check_refused", message: "private remote message" } } });
    const result = await runManifestDoctor(root, proxy.url, { BENCHROUTER_ACCOUNT_TOKEN: "br_ctrl_manifest" });
    assert.equal(result.status, status === 503 ? 0 : 1, result.stderr);
    const output = result.stdout + result.stderr;
    if (status === 401 || status === 403) {
      assert.ok(output.includes("doctor failed: manifest check: this credential cannot check this repo; run benchrouter login or use the repo's setup key"));
    } else if (status === 503) {
      assert.ok(output.includes("doctor skipped: manifest check: BenchRouter is unavailable or the request failed; retry later"));
    } else {
      assert.ok(output.includes(`doctor failed: manifest check: HTTP ${status} (manifest_check_refused); check benchrouter.yml, its size, and --route-id`));
    }
    assert.ok(!output.includes("private remote message"));
    assert.equal(proxy.requests.length, 1);
  });
}

test("doctor handles a manifest network failure", { timeout: 4900 }, async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  const proxy = await startFixtureProxy(t, {
    status: 200, body: acceptedManifest, onRequest: ({ request }) => request.socket.destroy()
  });
  const result = await runManifestDoctor(root, proxy.url, { BENCHROUTER_ACCOUNT_TOKEN: "br_ctrl_manifest" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("doctor skipped: manifest check: BenchRouter is unavailable or the request failed; retry later"));
  assert.equal(proxy.requests.length, 1);
});

test("doctor retains server errors when the route filter is unknown locally", { timeout: 4900 }, async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  const proxy = await startFixtureProxy(t, { status: 400, body: { error: "unknown_route_id" } });
  const result = await runManifestDoctor(root, proxy.url, { BENCHROUTER_ACCOUNT_TOKEN: "br_ctrl_manifest" }, ["--route-id", "app/missing"]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("doctor failed: manifest check: HTTP 400 (unknown_route_id); check benchrouter.yml, its size, and --route-id"));
  assert.ok(result.stderr.includes("Expected one declared route matching app/missing."));
  assert.equal(proxy.requests.length, 1);
  assert.equal(proxy.requests[0].body.route_id, "app/missing");
});

test("doctor refuses a manifest over 256 KiB of UTF-8 before sending", { timeout: 4900 }, async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  const manifest = `${manifestYaml()}\n#${"é".repeat(128 * 1024)}\n`;
  assert.ok(manifest.length < 256 * 1024);
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), manifest);
  const proxy = await startFixtureProxy(t, { status: 200, body: acceptedManifest });
  const result = await runManifestDoctor(root, proxy.url, { BENCHROUTER_ACCOUNT_TOKEN: "br_ctrl_manifest" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("doctor failed: manifest check: benchrouter.yml exceeds the 256 KiB UTF-8 limit"));
  assert.equal(proxy.requests.length, 0);
});

function runManifestDoctor(root, apiUrl, env = {}, flags = []) {
  return runCli(["doctor", "--repo", "example/app", "--skip-github-workflow", "--api-url", apiUrl, ...flags], root, env);
}

for (const phase of ["evaluation", "activation"]) {
  for (const mode of ["isolated_replay", "repository_executable"]) {
    test(`${phase} doctor names every missing declared file for ${mode}, including unselected routes`, { timeout: 4900 }, async (t) => {
      const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
      const manifest = parseYaml(mode === "repository_executable" ? repositoryExecutableManifestYaml() : manifestYaml());
      const route = manifest.routes[0];
      route.code_refs = ["src/missing.js"];
      route.eval_pack.config_path = "eval/missing-config.yml";
      route.eval_pack.case_refs = ["eval/missing-cases.json", "eval/missing-more-cases.json"];
      const refs = [route.eval_pack.config_path, ...route.eval_pack.case_refs, ...route.code_refs];
      // EVAL-012: only isolated replay declares a scorer.
      if (mode === "isolated_replay") {
        route.eval_pack.scorer = "eval/missing-scorer.mjs";
        refs.push(route.eval_pack.scorer);
      }
      if (mode === "repository_executable") {
        route.eval_pack.working_directory = "apps/service";
        route.eval_pack.lockfile = "../../pnpm-lock.yaml";
        route.eval_pack.input_refs = ["eval/missing-input.json"];
        route.eval_pack.acceptance_refs = ["eval/missing-checks.mjs", "eval/missing-cases.json"];
        refs.push("pnpm-lock.yaml", "eval/missing-input.json", "eval/missing-checks.mjs");
      }
      const other = parseYaml(manifestYaml()).routes[0];
      other.id = "other";
      other.route_id = "app/other";
      other.code_refs = ["src/other-missing.js"];
      manifest.routes.push(other);
      await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), stringifyYaml(manifest));
      const result = await runCli(["doctor", "--phase", phase, "--route-id", routeId, "--skip-github-workflow", "--api-url", "http://127.0.0.1:9"], root);
      assert.equal(result.status, 1);
      for (const ref of refs) {
        const message = `route ${routeId}: missing declared file ${ref}`;
        assert.ok(result.stderr.includes(message), result.stderr);
        assert.equal(result.stderr.split(message).length - 1, 1, "one diagnostic per route/file");
      }
      assert.ok(result.stderr.includes("route app/other: missing declared file src/other-missing.js"));
    });
  }
}

test("doctor refuses a directory where a declared file belongs", { timeout: 4900 }, async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  const manifest = parseYaml(manifestYaml());
  await mkdir(path.join(root, "eval/config-dir"), { recursive: true });
  manifest.routes[0].eval_pack.config_path = "eval/config-dir";
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), stringifyYaml(manifest));
  const result = await runCli(["doctor", "--skip-github-workflow", "--api-url", "http://127.0.0.1:9"], root);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`route ${routeId}: declared file eval/config-dir is not a regular file`), result.stderr);
});

test("doctor allows an undeclared scorer and still checks existing replay cases", { timeout: 4900 }, async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  const manifest = parseYaml(manifestYaml());
  delete manifest.routes[0].eval_pack.scorer;
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), stringifyYaml(manifest));
  await rm(path.join(root, ".benchrouter/scorer.app__chat.js"));
  const result = await runCli(["doctor", "--skip-github-workflow", "--api-url", "http://127.0.0.1:9"], root);
  assert.equal(result.status, 0, result.stderr);
});

test("evaluation doctor needs no production wiring and never uses an inherited runtime key", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  await rm(path.join(root, ".env.example"));
  const result = await runCli(["doctor", "--output-dir", root, "--api-url", "http://127.0.0.1:9", "--skip-github-workflow"], root, {
    BENCHROUTER_API_KEY: "br_test_inherited"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /evaluation preparation does not require a production call-site change/);
  assert.match(result.stdout, /no request made/);
  assert.doesNotMatch(result.stdout, /doctor passed: live proxy|runtime host checklist/);
});

test("RUN-001 doctor rejects every trust shape that the canonical bootstrap refuses locally", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  const original = JSON.parse(signedKitFixture.get(".benchrouter/trust.json"));
  const invalid = [
    (trust) => { trust.pins = ["not-a-sha256-digest"]; },
    (trust) => { trust.pins = ["sha256:" + "A".repeat(64)]; },
    (trust) => { trust.pins = ["sha256:" + "a".repeat(63)]; },
    (trust) => { trust.pins = [123]; },
    (trust) => { trust.unrecognized = true; },
    (trust) => { trust.keys.unrecognized = trust.keys.current; },
    (trust) => { trust.keys.current.unrecognized = true; },
    (trust) => { delete trust.keys.next; }
  ];
  for (const change of invalid) {
    const trust = structuredClone(original);
    change(trust);
    await writeFile(path.join(root, ".benchrouter/trust.json"), JSON.stringify(trust));
    const bootstrap = await runCli(["calibrate"], root);
    assert.equal(bootstrap.status, 1);
    assert.match(bootstrap.stderr, /trust.json/);
    assert.doesNotMatch(bootstrap.stderr, /fetch failed/);
    const doctor = await runCli(["doctor", "--skip-github-workflow", "--api-url", "http://127.0.0.1:9"], root);
    assert.equal(doctor.status, 1, doctor.stdout);
    assert.match(doctor.stderr, /trust.json/);
  }
  original.pins = ["sha256:" + "a".repeat(64)];
  await writeFile(path.join(root, ".benchrouter/trust.json"), JSON.stringify(original));
  const doctor = await runCli(["doctor", "--skip-github-workflow", "--api-url", "http://127.0.0.1:9"], root);
  assert.equal(doctor.status, 0, doctor.stderr);
});

test("RUN-001 init and upgrade reject invalid packages or unwritable destinations before HTTP", async (t) => {
  for (const command of ["init", "upgrade"]) {
    for (const problem of ["invalid JSON", "invalid scripts", "read-only package", "read-only trust"]) {
      const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
      const packagePath = path.join(root, "package.json");
      const trustPath = path.join(root, ".benchrouter/trust.json");
      if (problem === "invalid JSON") await writeFile(packagePath, "{broken");
      if (problem === "invalid scripts") await writeFile(packagePath, '{"scripts":"not-an-object"}');
      if (problem === "read-only package") await chmod(packagePath, 0o400);
      if (problem === "read-only trust") await chmod(trustPath, 0o400);
      const before = await readFile(path.join(root, ".benchrouter/README.md"), "utf8");
      const extra = command === "init"
        ? ["--setup-key", "br_setup_fixture", "--name", "Chat", "--incumbent-model", "openai/gpt-4o-mini"]
        : ["--upgrade-token", "br_upgrade_fixture", "--yes"];
      const result = await runCli([command, "--repo", "example/app", "--route-id", routeId, "--output-dir", root, "--api-url", "http://127.0.0.1:9", ...extra], root);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /JSON|package.json scripts|EACCES/);
      assert.doesNotMatch(result.stderr, /fetch failed/);
      assert.equal(await readFile(path.join(root, ".benchrouter/README.md"), "utf8"), before);
      await chmod(packagePath, 0o600);
      await chmod(trustPath, 0o600);
    }
  }
});

test("activation rejects absent or unknown route before making a request", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  for (const extra of [[], ["--route-id", "app/missing"]]) {
    const result = await runCli(["doctor", "--phase", "activation", "--live-chat-completions", "--output-dir", root, "--api-url", "http://127.0.0.1:9", ...extra], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /require --route-id|Expected one declared route/);
    assert.doesNotMatch(result.stderr, /fetch failed/);
  }
});

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
  assert.match(result.stdout, /doctor passed: live proxy authentication: runtime BENCHROUTER_API_KEY/);
  assert.match(result.stdout, /doctor passed: live proxy model resolution: configured route app\/chat selected minimax\/minimax-m2\.7 and returned usage/);
  assert.match(result.stdout, /doctor skipped: GitHub workflow state: --skip-github-workflow was passed/);
  assert.match(result.stdout, /doctor skipped: default-branch config/);
  assert.match(result.stdout, /doctor skipped: production readiness: run benchrouter setup status/);
  assert.match(result.stdout, /doctor skipped: evaluation quality: local files, calibration, and wiring do not certify/);
  assert.match(result.stdout, /BenchRouter doctor passed all checks that ran/);
  assert.match(result.stdout, /does not certify evaluation quality or production readiness/);
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
  assert.match(result.stdout, /doctor skipped: live proxy authentication and route resolution: no BENCHROUTER_API_KEY in environment; live proxy ping not run/);
  assert.equal(proxy.requests.length, 0);
});

test("doctor names the fix when benchrouter:calibrate is the customer's own script", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: { ...LOCAL_SCRIPTS, "benchrouter:calibrate": "node .benchrouter/verify-speaker-scorer.cjs" }
  }, null, 2) + "\n");
  const result = await runCli(["doctor", "--output-dir", root, "--api-url", "http://127.0.0.1:9", "--skip-github-workflow"], root);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(
    'package.json scripts.benchrouter:calibrate is "node .benchrouter/verify-speaker-scorer.cjs", not BenchRouter\'s "node .benchrouter/bootstrap.mjs calibrate". ' +
    'BenchRouter owns benchrouter:calibrate: rename your script to a name outside benchrouter:, then set benchrouter:calibrate back to "node .benchrouter/bootstrap.mjs calibrate" (upgrade does this).'
  ), result.stderr);
});

test("doctor sends an older BenchRouter script value to upgrade, not to a rename", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const model = 'incumbent';" });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: { ...LOCAL_SCRIPTS, "benchrouter:calibrate": "node .benchrouter/benchrouter-calibrate.mjs" }
  }, null, 2) + "\n");
  const result = await runCli(["doctor", "--output-dir", root, "--api-url", "http://127.0.0.1:9", "--skip-github-workflow"], root);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('package.json scripts.benchrouter:calibrate is an older BenchRouter value ("node .benchrouter/benchrouter-calibrate.mjs"); run benchrouter upgrade to set "node .benchrouter/bootstrap.mjs calibrate".'), result.stderr);
  assert.ok(!result.stderr.includes("rename your script"), result.stderr);
});

test("doctor accepts the repository env.template convention", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  await rename(path.join(root, ".env.example"), path.join(root, "env.template"));

  const result = await runDoctor(root, "http://127.0.0.1:9", { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BenchRouter doctor passed/);
});

test("doctor accepts the Wrangler .dev.vars.example, .env.sample and .env.template conventions", async (t) => {
  for (const name of [".dev.vars.example", ".env.sample", ".env.template"]) {
    const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
    await rename(path.join(root, ".env.example"), path.join(root, name));

    const result = await runDoctor(root, "http://127.0.0.1:9", { BENCHROUTER_API_KEY: undefined });

    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, /BenchRouter doctor passed/);
  }
});

test("doctor reads env.template before a newer accepted name", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  await rename(path.join(root, ".env.example"), path.join(root, "env.template"));
  await writeFile(path.join(root, ".env.sample"), "UNRELATED=1\n");

  const result = await runDoctor(root, "http://127.0.0.1:9", { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BenchRouter doctor passed/);
});

test("activation doctor without an accepted env example file lists the names it accepts", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  await rename(path.join(root, ".env.example"), path.join(root, ".env.local.example"));

  const result = await runDoctor(root, "http://127.0.0.1:9", { BENCHROUTER_API_KEY: undefined });

  assert.notEqual(result.status, 0);
  assert.ok(
    (result.stdout + result.stderr).includes(
      "missing a runtime env example file; doctor looks for .env.example, env.template, .env.sample, .env.template, .dev.vars.example"
    ),
    result.stdout + result.stderr
  );
});

test("activation doctor names a required key left as a comment", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  await rm(path.join(root, ".env.example"));
  await writeFile(
    path.join(root, ".dev.vars.example"),
    "# Secrets\n# BENCHROUTER_API_KEY=\n  ## OPENAI_BASE_URL = https://api.benchrouter.com/v1\n# NOT_AN_ASSIGNMENT\n"
  );

  const result = await runDoctor(root, "http://127.0.0.1:9", { BENCHROUTER_API_KEY: undefined });
  const output = result.stdout + result.stderr;

  assert.notEqual(result.status, 0);
  assert.ok(output.includes("found BENCHROUTER_API_KEY commented out in .dev.vars.example; uncomment it"), output);
  assert.ok(output.includes("found OPENAI_BASE_URL commented out in .dev.vars.example; uncomment it"), output);
  assert.ok(!output.includes(".dev.vars.example missing"), output);
});

test("activation doctor reads an uncommented key and still reports a missing one", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  await writeFile(path.join(root, ".env.example"), "BENCHROUTER_API_KEY=\n# OPENAI_BASE_URL_OLD=\n");

  const result = await runDoctor(root, "http://127.0.0.1:9", { BENCHROUTER_API_KEY: undefined });
  const output = result.stdout + result.stderr;

  assert.notEqual(result.status, 0);
  assert.ok(output.includes(".env.example missing OPENAI_BASE_URL"), output);
  assert.ok(!output.includes("BENCHROUTER_API_KEY commented out"), output);
});

test("doctor accepts a declared BENCHROUTER runtime base URL from the current generated kit", async (t) => {
  const root = await createTargetRepo(t, {
    codeRefText: "const baseURL = process.env.BENCHROUTER_DISPATCH_API_URL;"
  });
  const manifest = (await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8"))
    .replaceAll("OPENAI_BASE_URL", "BENCHROUTER_DISPATCH_API_URL");
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), manifest);
  await writeFile(
    path.join(root, ".env.example"),
    "BENCHROUTER_API_KEY=\nBENCHROUTER_DISPATCH_API_URL=https://api.benchrouter.com/v1\nOPENAI_API_KEY=\n"
  );

  const result = await runDoctor(root, "https://api.benchrouter.com", {
    BENCHROUTER_API_KEY: undefined
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runtime wiring: 1 route reference call_site\.base_url_env from code_refs/);
  assert.match(result.stdout, /set BENCHROUTER_DISPATCH_API_URL to https:\/\/api\.benchrouter\.com\/v1/);
  assert.doesNotMatch(result.stderr, /CI-only BenchRouter env vars/);
});

test("doctor rejects a declared reserved secret key as a runtime base URL", async (t) => {
  const root = await createTargetRepo(t, {
    codeRefText: "const baseURL = process.env.BENCHROUTER_ACCOUNT_TOKEN;"
  });
  const manifest = (await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8"))
    .replaceAll("OPENAI_BASE_URL", "BENCHROUTER_ACCOUNT_TOKEN");
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), manifest);
  await writeFile(
    path.join(root, ".env.example"),
    "BENCHROUTER_API_KEY=\nBENCHROUTER_ACCOUNT_TOKEN=\nOPENAI_API_KEY=\n"
  );

  const result = await runDoctor(root, "https://api.benchrouter.com", {
    BENCHROUTER_API_KEY: undefined
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /\.env\.example includes CI-only BenchRouter env vars: BENCHROUTER_ACCOUNT_TOKEN/
  );
});

test("doctor activation selects one route from canonical multi-route YAML", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), multiRouteManifestYaml());
  await writeFile(path.join(root, "src/summarize.js"), "const baseURL = process.env.SUMMARIZE_BASE_URL;\n");
  await writeFile(path.join(root, ".benchrouter/scorer.summarize.js"), "export function score() { return { pass: true }; }\n");
  await writeFile(path.join(root, ".benchrouter/cases.summarize.json"), '[{"id":"summary","input":{"messages":[{"role":"user","content":"summarize"}]}}]\n');
  await writeFile(path.join(root, ".env.example"), "BENCHROUTER_API_KEY=\nOPENAI_BASE_URL=https://api.benchrouter.com/v1\nSUMMARIZE_BASE_URL=https://api.benchrouter.com/v1\n");

  const result = await runDoctor(root, "http://127.0.0.1:9", { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /doctor passed: runtime wiring: 1 route reference call_site\.base_url_env from code_refs/);
  assert.match(result.stdout, /OPENAI_BASE_URL to .*\/v1/);
  assert.doesNotMatch(result.stdout, /set SUMMARIZE_BASE_URL/);
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
  // Declared scorers must exist, even for repository-executable packs.

  const result = await runDoctor(root, "https://api.benchrouter.com", { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /runtime host checklist: set BENCHROUTER_API_KEY .* ANTHROPIC_BASE_URL to https:\/\/api\.benchrouter\.com(?:\s|$)/
  );
  assert.doesNotMatch(result.stdout, /ANTHROPIC_BASE_URL to https:\/\/api\.benchrouter\.com\/v1/);
  assert.doesNotMatch(result.stderr, /must be a JSON array|no runnable cases|scorer/);
});

// EVAL-012: the declared call-site family chooses the value, not the variable's name.
test("doctor gives a native Anthropic call site the API root under any variable name", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.MY_CLAUDE_URL;" });
  await mkdir(path.join(root, "eval"), { recursive: true });
  await writeFile(path.join(root, "package-lock.json"), "{}\n");
  await writeFile(path.join(root, "eval/evaluator.mjs"), "export {};\n");
  await writeFile(path.join(root, "eval/corpus.json"), '{"documents":[]}\n');
  await writeFile(path.join(root, "eval/qrels.json"), '{"query-1":{"document-1":1}}\n');
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), repositoryExecutableManifestYaml().replace("base_url_env: ANTHROPIC_BASE_URL", "base_url_env: MY_CLAUDE_URL"));
  await writeFile(path.join(root, ".env.example"), "BENCHROUTER_API_KEY=\nMY_CLAUDE_URL=https://api.benchrouter.com\n");
  // Declared scorers must exist, even for repository-executable packs.

  const result = await runDoctor(root, "https://api.benchrouter.com", { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MY_CLAUDE_URL to https:\/\/api\.benchrouter\.com(?:\s|$)/);
  assert.doesNotMatch(result.stdout, /MY_CLAUDE_URL to https:\/\/api\.benchrouter\.com\/v1/);
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
  assert.match(result.stdout, /doctor skipped: GitHub workflow state: workflow is not registered yet; this is expected before the generated workflow is pushed/);
  assert.match(result.stdout, /BenchRouter doctor passed/);
});

test("init prints the runtime key, keeps OIDC keyless, and leaves runtime env examples unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-setup-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await writeFile(path.join(root, ".benchrouter/bootstrap.mjs"), "// stale bootstrap\n");
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
            path: ".benchrouter/bootstrap.mjs",
            content: signedKitFixture.get(".benchrouter/bootstrap.mjs")
          }
        ],
        package_json: {
          scripts: LOCAL_SCRIPTS,
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
      "--api-family",
      "openai_chat_completions",
      "--eval-command",
      "pnpm run test:customer",
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

  assert.equal(setupServer.requests[0].body.route.eval_command, "pnpm run test:customer");
  assert.equal(setupServer.requests[1].body.route.eval_command, "pnpm run test:customer");
  // EVAL-012: the setup request carries the call site's base URL env and API family together.
  assert.deepEqual(setupServer.requests[0].body.route.call_site, { base_url_env: "OPENAI_BASE_URL", api_family: "openai_chat_completions" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runtime\/host BENCHROUTER_API_KEY: br_live_runtime_fixture/);
  assert.doesNotMatch(result.stdout, /BENCHROUTER_EVAL_API_KEY/);
  assert.match(result.stdout, /Store it now/);
  assert.match(result.stdout, /Tell your coding agent: read \.benchrouter\/SETUP_README\.md/);
  assert.match(result.stdout, /evaluation PR, eval evidence, scorer, calibration, and later activation/);
  assert.match(result.stdout, /Keep production code and host configuration unchanged in the evaluation PR/);
  assert.match(result.stdout, /BenchRouter Evals uses GitHub OIDC/);
  assert.match(result.stdout, /npx --yes benchrouter@latest doctor/);
  assert.equal(await readFile(path.join(root, ".benchrouter/bootstrap.mjs"), "utf8"), signedKitFixture.get(".benchrouter/bootstrap.mjs"));

  assert.equal(existsSync(path.join(root, ".env.example")), false);
  assert.match(result.stdout, /Runtime env configuration is deferred until activation/);
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
  assert.equal(Object.hasOwn(setupServer.requests[0].body.route, "eval_command"), false);
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
  assert.equal(setupServer.requests.length, 0);
});

test("init dry run lists what it would write apart from what it would skip", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-init-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await writeFile(path.join(root, ".benchrouter/cases.compose.json"), "[\"customer edits\"]\n");
  await writeFile(path.join(root, ".benchrouter/SETUP_README.md"), "# Same\n");
  const setupServer = await startFixtureProxy(t, {
    status: 200,
    body: {
      repo_full_name: "example/app",
      setup_packet: {
        files: [
          { path: ".benchrouter/README.md", content: "# BenchRouter\n" },
          { path: ".benchrouter/SETUP_README.md", content: "# Same\n" },
          { path: ".benchrouter/cases.compose.json", content: "[]\n" }
        ],
        package_json: { scripts: {}, dev_dependencies: [] },
        runtime_env: {}
      }
    }
  });

  const result = await runCli([
    "init", "--setup-key", "br_setup_fixture", "--repo", "example/app",
    "--route-id", routeId, "--name", "Chat", "--incumbent-model", "openai/gpt-4o-mini",
    "--api-url", setupServer.url, "--output-dir", root, "--dry-run"
  ], root);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Would change 1 file(s):\n  create .benchrouter/README.md\n"), result.stdout);
  assert.ok(result.stdout.includes("Unchanged (1):\n  .benchrouter/SETUP_README.md\n"), result.stdout);
  assert.ok(result.stdout.includes("Would skip 2 file(s):\n  .benchrouter/cases.compose.json (it differs from BenchRouter's copy; --overwrite-user-edits replaces it)\n  package.json (no package.json found, so no scripts update)\n"), result.stdout);
  assert.ok(!result.stdout.includes("would write"), result.stdout);
  assert.equal(await readFile(path.join(root, ".benchrouter/cases.compose.json"), "utf8"), "[\"customer edits\"]\n");
  assert.equal(existsSync(path.join(root, ".benchrouter/README.md")), false);
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
    "Setup access expired. Refresh it at https://benchrouter.com/cli and run init again.\n" +
      "If BenchRouter's docs don't explain this, report it: benchrouter feedback --kind doc_gap '<what happened>'\n"
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
    "Setup access expired. Refresh it at https://benchrouter.com/cli/new and run init again.\n" +
      "If BenchRouter's docs don't explain this, report it: benchrouter feedback --kind doc_gap '<what happened>'\n"
  );
  assert.equal(setupServer.requests.length, 1);
});

test("init prints the recorded browser approval URL and preserves the exact observed incumbent", async (t) => {
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
  assert.match(result.stderr, /x-ai\/grok-4\.3 \(provider_recommended_successor; input \$1\.25\/1M, output \$2\.5\/1M, 5\.3571x incumbent price\)/);
  assert.match(result.stderr, /Approval context expires at: 2026-09-14T17:29:48\.651Z/);
  assert.match(
    result.stderr,
    /https:\/\/benchrouter\.com\/setup\/authorize\?approval=incapproval_3a4ebf2c77524af8ac552d0b6bd5578b/
  );
  assert.match(result.stderr, /signed-in GitHub user with repository write access must choose the replacement there/);
  assert.match(result.stderr, /Do not choose or substitute one yourself/);
  assert.match(result.stderr, /rerun the exact same init command unchanged/);
  assert.equal(setupServer.requests.length, 1);
  assert.deepEqual(setupServer.requests[0].body.route, {
    route_id: routeId,
    name: "Chat",
    incumbent_model: "grok-4-1-fast-reasoning-latest",
    provider_id: "xai",
    provider_ref: "grok-4-1-fast-reasoning-latest"
  });
});

test("init maps recorded browser approval to the matching additional route", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-additional-model-choice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setupServer = await startFixtureProxy(t, {
    status: 409,
    body: replacementConfirmationFixture
  });

  const result = await runCli([
    "init",
    "--setup-key", "br_setup_additional_model_choice_fixture",
    "--route-id", routeId,
    "--name", "Chat",
    "--incumbent-model", "openai/gpt-4o-mini",
    "--provider-id", "openai",
    "--provider-ref", "gpt-4o-mini-2024-07-18",
    "--route-id", "app/reasoning",
    "--name", "Reasoning",
    "--incumbent-model", "grok-4-1-fast-reasoning-latest",
    "--provider-id", "xai",
    "--provider-ref", "grok-4-1-fast-reasoning-latest",
    "--api-url", setupServer.url,
    "--output-dir", root
  ], root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Observed model: grok-4-1-fast-reasoning-latest/);
  assert.match(result.stderr, /Provider: xai/);
  assert.match(
    result.stderr,
    /https:\/\/benchrouter\.com\/setup\/authorize\?approval=incapproval_3a4ebf2c77524af8ac552d0b6bd5578b/
  );
  assert.match(result.stderr, /rerun the exact same init command unchanged/);
  assert.doesNotMatch(result.stderr, /Start a new setup session/);
  assert.equal(setupServer.requests.length, 1);
  assert.deepEqual(setupServer.requests[0].body.route, {
    route_id: routeId,
    name: "Chat",
    incumbent_model: "openai/gpt-4o-mini",
    provider_id: "openai",
    provider_ref: "gpt-4o-mini-2024-07-18"
  });
  assert.deepEqual(setupServer.requests[0].body.routes, [{
    route_id: "app/reasoning",
    name: "Reasoning",
    incumbent_model: "grok-4-1-fast-reasoning-latest",
    provider_id: "xai",
    provider_ref: "grok-4-1-fast-reasoning-latest"
  }]);
});

test("init preserves a route-bound browser URL when routes share one observed tuple", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-shared-model-choice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setupServer = await startFixtureProxy(t, {
    status: 409,
    body: replacementConfirmationFixture
  });

  const result = await runCli([
    "init",
    "--setup-key", "br_setup_shared_model_choice_fixture",
    "--route-id", "app/reasoning-primary",
    "--name", "Primary reasoning",
    "--incumbent-model", "grok-4-1-fast-reasoning-latest",
    "--provider-id", "xai",
    "--provider-ref", "grok-4-1-fast-reasoning-latest",
    "--route-id", "app/reasoning-secondary",
    "--name", "Secondary reasoning",
    "--incumbent-model", "grok-4-1-fast-reasoning-latest",
    "--provider-id", "xai",
    "--provider-ref", "grok-4-1-fast-reasoning-latest",
    "--api-url", setupServer.url,
    "--output-dir", root
  ], root);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /https:\/\/benchrouter\.com\/setup\/authorize\?approval=incapproval_3a4ebf2c77524af8ac552d0b6bd5578b/
  );
  assert.match(result.stderr, /rerun the exact same init command unchanged/);
  assert.doesNotMatch(result.stderr, /Start a new setup session/);
  assert.equal(setupServer.requests.length, 1);
  assert.deepEqual(setupServer.requests[0].body.route, {
    route_id: "app/reasoning-primary",
    name: "Primary reasoning",
    incumbent_model: "grok-4-1-fast-reasoning-latest",
    provider_id: "xai",
    provider_ref: "grok-4-1-fast-reasoning-latest"
  });
  assert.deepEqual(setupServer.requests[0].body.routes, [{
    route_id: "app/reasoning-secondary",
    name: "Secondary reasoning",
    incumbent_model: "grok-4-1-fast-reasoning-latest",
    provider_id: "xai",
    provider_ref: "grok-4-1-fast-reasoning-latest"
  }]);
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
    id: "route_a_retrieval_v1",
    case_refs: ["eval/queries-a.json"],
    argv: ["node", "eval/route-a.mjs"],
    input_refs: ["eval/route-a.mjs", "eval/corpus-a.json"],
    acceptance_refs: ["eval/queries-a.json", "eval/qrels-a.json"],
    primary_metric: "recall_at_5"
  });
  const secondPack = repositoryExecutableEvalPack({
    id: "route_b_retrieval_v1",
    case_refs: ["eval/queries-b.json"],
    argv: ["node", "eval/route-b.mjs"],
    input_refs: ["eval/route-b.mjs", "eval/corpus-b.json"],
    acceptance_refs: ["eval/queries-b.json", "eval/qrels-b.json"],
    primary_metric: "recall_at_10",
    timeout_minutes: 90,
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
    "--api-family", "anthropic_messages",
    "--route-id", "app/route-b",
    "--name", "Route B",
    "--incumbent-model", "openai/gpt-4o-mini",
    "--eval-pack", "route-b-pack.json",
    "--api-family", "openai_responses",
    "--api-url", setupServer.url,
    "--output-dir", root
  ], root);

  assert.equal(result.status, 1);
  assert.equal(setupServer.requests.length, 1);
  assert.deepEqual(setupServer.requests[0].body.route.eval_pack, firstPack);
  assert.deepEqual(setupServer.requests[0].body.routes[0].eval_pack, secondPack);
  // EVAL-012: each route's family travels on its call_site; the eval pack inherits it server-side.
  assert.deepEqual(setupServer.requests[0].body.route.call_site, { api_family: "anthropic_messages" });
  assert.deepEqual(setupServer.requests[0].body.routes[0].call_site, { api_family: "openai_responses" });
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
    "--api-family", "openai_chat_completions",
    "--api-url", "http://127.0.0.1:9",
    "--output-dir", root
  ];

  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ runtime_version: "latest" }))}\n`);
  const mutableRuntime = await runCli(command, root);
  assert.equal(mutableRuntime.status, 1);
  assert.match(mutableRuntime.stderr, /runtime_version must be an exact version/);
  assert.doesNotMatch(mutableRuntime.stderr, /fetch failed/);

  // EVAL-012: one family per route, declared with --api-family; the pack does not repeat it.
  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ api_family: "anthropic_messages" }))}\n`);
  const packApiFamily = await runCli(command, root);
  assert.equal(packApiFamily.status, 1);
  assert.match(packApiFamily.stderr, /must not contain api_family\. Pass --api-family for the route/);
  assert.doesNotMatch(packApiFamily.stderr, /fetch failed/);

  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack())}\n`);
  const familyAt = command.indexOf("--api-family");
  const missingApiFamily = await runCli([...command.slice(0, familyAt), ...command.slice(familyAt + 2)], root);
  assert.equal(missingApiFamily.status, 1);
  assert.match(missingApiFamily.stderr, /Route app\/chat sets --base-url-env or --eval-pack, so pass --api-family/);
  assert.doesNotMatch(missingApiFamily.stderr, /fetch failed/);

  const unknownApiFamily = await runCli(command.map((value) => value === "openai_chat_completions" ? "responses" : value), root);
  assert.equal(unknownApiFamily.status, 1);
  assert.match(unknownApiFamily.stderr, /--api-family responses is not supported/);
  assert.doesNotMatch(unknownApiFamily.stderr, /fetch failed/);

  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ acceptance_refs: ["../qrels.json"] }))}\n`);
  const traversal = await runCli(command, root);
  assert.equal(traversal.status, 1);
  assert.match(traversal.stderr, /acceptance_refs\[0\] must be a normalized repository-relative path/);
  assert.doesNotMatch(traversal.stderr, /fetch failed/);

  // A node pack may pin a pnpm lockfile; bun keeps its own lockfiles.
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ lockfile: "pnpm-lock.yaml" }))}\n`);
  const pnpmLockfile = await runCli(command, root);
  assert.equal(pnpmLockfile.status, 1);
  assert.ok(!pnpmLockfile.stderr.includes("lockfile is not valid"), pnpmLockfile.stderr);
  assert.ok(pnpmLockfile.stderr.includes("fetch failed"), pnpmLockfile.stderr);
  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ lockfile: "pnpm-lock.yaml", runtime: "bun", runtime_version: "1.2.0" }))}\n`);
  const bunPnpm = await runCli(command, root);
  assert.equal(bunPnpm.status, 1);
  assert.ok(bunPnpm.stderr.includes("lockfile is not valid for runtime bun"), bunPnpm.stderr);

  await writeFile(packPath, `${JSON.stringify(repositoryExecutableEvalPack({ timeout_minutes: 91 }))}\n`);
  const excessiveTimeout = await runCli(command, root);
  assert.equal(excessiveTimeout.status, 1);
  assert.match(excessiveTimeout.stderr, /timeout_minutes must be from 1 through 90/);
  assert.doesNotMatch(excessiveTimeout.stderr, /fetch failed/);
});

test("init completes evaluation files when its runtime key was already provisioned", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-provisioned-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setupServer = await startFixtureProxy(t, {
    status: 200,
    body: {
      repo_full_name: "example/app",
      setup_packet: {
        keys_already_provisioned: true,
        rotate_url: "https://benchrouter.com/account",
        files: [{ path: ".benchrouter/README.md", content: "# recovered evaluation setup\n" }],
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

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runtime key already issued.*Reuse the stored product key/);
  assert.match(result.stdout, /Do not restart setup to recover a key/);
  assert.equal(existsSync(path.join(root, ".benchrouter/README.md")), true);
  assert.equal(setupServer.requests.length, 2);
  assert.equal(setupServer.requests[0].body.dry_run, true);
});

test("upgrade validates canonical YAML before any preview or token consumption", async (t) => {
  const root = await createUpgradeTarget(t, { writeManifest: false });
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

  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), "routes:\n  - [broken\n");
  const invalid = await runCli(args, root);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /benchrouter\.yml is not valid YAML/);
  assert.equal(server.requests.length, 0);
});

test("upgrade revalidates canonical YAML immediately before apply", async (t) => {
  const root = await createUpgradeTarget(t);
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
  assert.equal(existsSync(path.join(root, ".benchrouter/bootstrap.mjs")), false);
});

test("upgrade rejects subset and duplicate generated packets before writes", async (t) => {
  const exact = exactUpgradeFiles();
  const cases = [
    ["three-file subset", exact.slice(0, 3)],
    ["duplicate path", [...exact.slice(0, 3), exact[0]]]
  ];

  for (const [label, files] of cases) {
    await t.test(label, async (subtest) => {
      const root = await createUpgradeTarget(subtest);
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
        });
  }
});

test("upgrade applies the exact signed kit while preserving canonical YAML", async (t) => {
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
  assert.equal(await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8"), yamlBefore);
  for (const file of files) {
    assert.equal(await readFile(path.join(root, file.path), "utf8"), file.content);
  }
  assert.match(result.stdout, /npx --yes benchrouter@latest doctor --repo example\/app/);
});

test("upgrade preview separates changed and unchanged files and diffs the changed ones", async (t) => {
  const root = await createUpgradeTarget(t);
  for (const [filePath, content] of signedKitFixture) {
    await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await writeFile(path.join(root, filePath), content);
  }
  await writeFile(path.join(root, ".benchrouter/README.md"), "# BenchRouter\nOld line\n");
  const server = await startFixtureProxy(t, { status: 200, body: upgradePacketBody(exactUpgradeFiles()) });

  const result = await runCli([
    "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", routeId, "--api-url", server.url, "--output-dir", root, "--dry-run"
  ], root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(server.requests.length, 1);
  assert.ok(result.stdout.includes("Would change 1 file(s):\n  update .benchrouter/README.md\n"), result.stdout);
  assert.ok(result.stdout.includes(`Unchanged (${signedKitFixture.size}):\n`), result.stdout);
  for (const filePath of signedKitFixture.keys()) assert.ok(result.stdout.includes(`\n  ${filePath}\n`), filePath);
  assert.ok(result.stdout.includes("--- a/.benchrouter/README.md\n+++ b/.benchrouter/README.md\n@@ -1,2 +1,1 @@\n # BenchRouter\n-Old line\n"), result.stdout);
  assert.ok(!result.stdout.includes("would write"), result.stdout);
});

test("upgrade preview names the same changes that apply makes, with customer steps and package.json", async (t) => {
  const root = await createUpgradeTarget(t);
  for (const [filePath, content] of signedKitFixture) {
    await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await writeFile(path.join(root, filePath), content);
  }
  const workflowPath = ".github/workflows/benchrouter-evals.yml";
  const marker = "      # ---- end customer-setup ----\n";
  const customer = "      - name: Install evaluator tools\n        if: github.event_name == 'workflow_dispatch'\n        run: python --version\n";
  const kitWorkflow = signedKitFixture.get(workflowPath);
  await writeFile(path.join(root, workflowPath), kitWorkflow.replace(marker, customer + marker));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app", private: true }, null, 2) + "\n");
  const files = exactUpgradeFiles().map((file) => file.path === workflowPath
    ? generatedUpgradeFile(workflowPath, file.content.replace('BENCHROUTER_JOB_CEILING_MIN: "120"\n', 'BENCHROUTER_JOB_CEILING_MIN: "120"\n          BENCHROUTER_KIT_VERSION: 0.0.11\n'))
    : file);
  const server = await startFixtureProxy(t, { status: 200, body: upgradePacketBody(files) });

  const result = await runCli([
    "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", routeId, "--api-url", server.url, "--output-dir", root, "--yes"
  ], root);

  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n");
  const previewChanged = lines.filter((line) => line.startsWith("  update ") || line.startsWith("  create ")).map((line) => line.trim().split(" ")[1]).sort();
  const applied = lines.filter((line) => line.startsWith("updated ") || line.startsWith("created ")).map((line) => line.split(" ")[1]).sort();
  assert.deepEqual(previewChanged, [".benchrouter/README.md", workflowPath, "package.json"].sort());
  assert.deepEqual(applied, previewChanged);
  const written = await readFile(path.join(root, workflowPath), "utf8");
  assert.ok(written.includes(customer + marker), written);
  assert.ok(written.includes("BENCHROUTER_KIT_VERSION: 0.0.11\n"), written);
});

test("upgrade preview warns before replacing a customer script or customer README sections", async (t) => {
  const root = await createUpgradeTarget(t);
  for (const [filePath, content] of signedKitFixture) {
    await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await writeFile(path.join(root, filePath), content);
  }
  await writeFile(path.join(root, ".benchrouter/README.md"),
    "# BenchRouter\n\n## Speaker scorer notes\n\n```sh\n# not a heading\n```\n\n### Calibration log\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "app",
    scripts: { "benchrouter:calibrate": "node .benchrouter/verify-speaker-scorer.cjs", "benchrouter:capture": "node .benchrouter/bootstrap.mjs capture" }
  }, null, 2) + "\n");
  const server = await startFixtureProxy(t, { status: 200, body: upgradePacketBody(exactUpgradeFiles()) });

  const result = await runCli([
    "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", routeId, "--api-url", server.url, "--output-dir", root, "--dry-run"
  ], root);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(
    "\nWarning: this replaces content BenchRouter did not write:\n" +
    "  - replaces .benchrouter/README.md, which has content BenchRouter did not write (sections: ## Speaker scorer notes; ### Calibration log). Move your notes to a file BenchRouter does not write\n" +
    "  - replaces your script benchrouter:calibrate (node .benchrouter/verify-speaker-scorer.cjs); keep your own scripts under another name\n"
  ), result.stdout);
  assert.ok(!result.stdout.includes("benchrouter:capture ("), result.stdout);
});

test("ownership warnings use per-script history and CommonMark fences", async (t) => {
  const root = await createUpgradeTarget(t);
  for (const [filePath, content] of signedKitFixture) {
    await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await writeFile(path.join(root, filePath), content);
  }
  await writeFile(path.join(root, ".benchrouter/README.md"), [
    "# BenchRouter", "", "## Credentials", "", "## Add another route to this repo", "", "````md", "```", "## Inside a long fence", "```", "````", "",
    "    ## Indented code", "", "##\tTabbed notes ##", ""
  ].join("\n"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "app",
    scripts: {
      "benchrouter:calibrate": "tsx scripts/benchrouter-calibrate.ts",
      "benchrouter:capture": "node .benchrouter/bootstrap.mjs calibrate"
    }
  }, null, 2) + "\n");
  const server = await startFixtureProxy(t, { status: 200, body: upgradePacketBody(exactUpgradeFiles()) });

  const result = await runCli([
    "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", routeId, "--api-url", server.url, "--output-dir", root, "--dry-run"
  ], root);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("(sections: ## Tabbed notes)"), result.stdout);
  assert.ok(result.stdout.includes("replaces your script benchrouter:capture (node .benchrouter/bootstrap.mjs calibrate)"), result.stdout);
  assert.ok(!result.stdout.includes("benchrouter:calibrate ("), result.stdout);
});

test("upgrade preview does not warn when the old README and scripts are BenchRouter's", async (t) => {
  const root = await createUpgradeTarget(t);
  for (const [filePath, content] of signedKitFixture) {
    await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await writeFile(path.join(root, filePath), content);
  }
  await writeFile(path.join(root, ".benchrouter/README.md"), "# BenchRouter\nOlder kit wording.\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node --test", "benchrouter:calibrate": "node .benchrouter/benchrouter-calibrate.mjs" } }, null, 2) + "\n");
  const server = await startFixtureProxy(t, { status: 200, body: upgradePacketBody(exactUpgradeFiles()) });

  const result = await runCli([
    "upgrade", "--upgrade-token", "br_upgrade_fixture", "--repo", "example/app",
    "--route-id", routeId, "--api-url", server.url, "--output-dir", root, "--dry-run"
  ], root);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("update .benchrouter/README.md"), result.stdout);
  assert.ok(!result.stdout.includes("Warning:"), result.stdout);
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
  return root;
}

function exactUpgradeFiles() {
  return [
    ...[...signedKitFixture].map(([filePath, content]) => generatedUpgradeFile(filePath, content)),
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
  for (const [filePath, content] of signedKitFixture) {
    await writeFile(path.join(root, filePath), content);
  }
  await writeFile(path.join(root, ".benchrouter/scorer.app__chat.js"), "export function score() { return { pass: true, score: 1 }; }\n");
  await writeFile(
    path.join(root, ".benchrouter/cases.app__chat.json"),
    `${JSON.stringify([{ id: "case-1", input: { messages: [{ role: "user", content: "hello" }] } }], null, 2)}\n`
  );
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      scripts: LOCAL_SCRIPTS
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

// EVAL-012: a route without call_site.api_family gets no guessed base URL value.
test("doctor names a missing call_site.api_family instead of guessing a base URL", async (t) => {
  const root = await createTargetRepo(t, { codeRefText: "const baseURL = process.env.OPENAI_BASE_URL;" });
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), manifestYaml().replace("      api_family: openai_chat_completions\n", ""));

  const result = await runDoctor(root, "https://api.benchrouter.com", { BENCHROUTER_API_KEY: undefined });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OPENAI_BASE_URL to the value its call_site\.api_family chooses/);
  assert.doesNotMatch(result.stdout, /OPENAI_BASE_URL to https:/);
});

// EVAL-012: the call_site carries both values; one --api-family applies to every route.
test("init pairs --api-family with routes and sends it on each call_site", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-api-family-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const setupServer = await startFixtureProxy(t, {
    status: 401,
    body: { error: "setup_scope_expired", message: "BenchRouter setup access has expired" }
  });
  const routes = [
    "--route-id", "app/route-a", "--name", "Route A", "--incumbent-model", "openai/gpt-4o-mini",
    "--route-id", "app/route-b", "--name", "Route B", "--incumbent-model", "openai/gpt-4o-mini"
  ];
  const base = ["init", "--setup-key", "br_setup_api_family", "--api-url", setupServer.url, "--output-dir", root, ...routes];

  const shared = await runCli([...base, "--base-url-env", "LLM_BASE_URL", "--api-family", "openai_responses"], root);
  assert.equal(shared.status, 1);
  const sharedBody = setupServer.requests[0].body;
  assert.deepEqual(sharedBody.route.call_site, { base_url_env: "LLM_BASE_URL", api_family: "openai_responses" });
  assert.deepEqual(sharedBody.routes[0].call_site, { base_url_env: "LLM_BASE_URL", api_family: "openai_responses" });
  assert.equal(Object.hasOwn(sharedBody.route, "base_url_env"), false);

  const neither = await runCli(base, root);
  assert.equal(neither.status, 1);
  assert.equal(Object.hasOwn(setupServer.requests[1].body.route, "call_site"), false);
  assert.equal(Object.hasOwn(setupServer.requests[1].body.routes[0], "call_site"), false);

  const mismatched = await runCli([...base, "--api-family", "openai_chat_completions", "--api-family", "anthropic_messages", "--api-family", "openai_responses"], root);
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /When repeating --api-family, pass one value per --route-id/);
  assert.equal(setupServer.requests.length, 2);
});

// EVAL-012: rerunning init with --api-family updates an existing route's declaration.
test("init rerun writes --api-family into an existing route's call_site and executable eval", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-cli-api-family-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"scripts":{}}\n');
  const existingManifest = `version: 1
product: { slug: app, repo: example/app, default_branch: main }
routes:
  - id: chat
    route_id: app/chat
    name: Local Chat Name
    code_refs: [src/chat.ts]
    call_site: { base_url_env: MY_CLAUDE_URL }
    seed: { incumbent_model: anthropic/claude-haiku-4.5 }
    eval_pack: { mode: repository_executable, api_family: openai_chat_completions, workflow: .github/workflows/benchrouter-evals.yml, scorer: .benchrouter/scorer.chat.js, result_schema: benchrouter.executable_result.v1, case_refs: [eval/cases.json] }
`;
  await writeFile(path.join(root, ".benchrouter/benchrouter.yml"), existingManifest);
  const setupServer = await startFixtureProxy(t, {
    status: 200,
    body: {
      repo_full_name: "example/app",
      setup_packet: {
        files: [{ path: ".benchrouter/benchrouter.yml", content: existingManifest.replace("name: Local Chat Name", "name: Server Chat") }],
        package_json: { scripts: {}, dev_dependencies: [] },
        runtime_env: {},
        setup_api_keys: { production: { key: "br_live_api_family_merge" } }
      }
    }
  });

  const result = await runCli([
    "init", "--setup-key", "br_setup_api_family_merge", "--repo", "example/app",
    "--route-id", "app/chat", "--name", "Chat", "--incumbent-model", "anthropic/claude-haiku-4.5",
    "--base-url-env", "MY_CLAUDE_URL", "--api-family", "anthropic_messages",
    "--api-url", setupServer.url, "--output-dir", root
  ], root);

  assert.equal(result.status, 0, result.stderr);
  const merged = parseYaml(await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8"));
  assert.equal(merged.routes[0].name, "Local Chat Name");
  assert.deepEqual(merged.routes[0].call_site, { base_url_env: "MY_CLAUDE_URL", api_family: "anthropic_messages" });
  assert.equal(merged.routes[0].eval_pack.api_family, "anthropic_messages");
});

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
      api_family: openai_chat_completions
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
      api_family: openai_chat_completions
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
      api_family: anthropic_messages
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
      timeout_minutes: 60
      secret_env: []
`;
}

function repositoryExecutableEvalPack(overrides = {}) {
  return {
    mode: "repository_executable",
    id: "app_chat_repository_v1",
    config_path: ".benchrouter/benchrouter.yml",
    workflow: ".github/workflows/benchrouter-evals.yml",
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
  return runCli(["doctor", "--phase", "activation", "--route-id", routeId, "--live-chat-completions", "--output-dir", root, "--api-url", apiUrl, "--skip-github-workflow"], root, {
    BENCHROUTER_API_KEY: "br_test_fixture",
    ...envOverrides
  });
}

function runCli(cliArgs, cwd, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      // A closed port: the newer-version check fails fast and adds no note.
      npm_config_registry: "http://127.0.0.1:9",
      BENCHROUTER_CONFIG_DIR: path.join(cwd, ".test-config"),
      BENCHROUTER_ACCOUNT_TOKEN: "",
      BENCHROUTER_SETUP_KEY: "",
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
