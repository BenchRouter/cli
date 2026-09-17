import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPartitionPlan, editManifestRoutes, validatePartitionPlan } from "../src/partition.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");

const PARENT_SCORER = "module.exports.score = () => ({ pass: true, checks: [], reasons: [] });\n";

test("partition plan groups by method, labels unassigned cases, and warns on small children", async (t) => {
  const root = await writeLadderRepo(t);
  const draft = buildPartitionPlan(root, "elo/ladder", { by: "method" });
  assert.deepEqual(
    draft.plan.children.map((child) => [child.route_id, child.cases.length]),
    [["elo/json-extract", 3], ["elo/sql-fix", 3], ["elo/regex-build", 2]]
  );
  assert.deepEqual(draft.plan.unassigned, ["orphan-1"]);
  assert.equal(draft.plan.incumbent, "parent_original");
  assert.equal(draft.plan.children[0].metadata.eval_archetype, "code-consumed");
  assert.ok(draft.warnings.some((warning) => warning.includes("elo/regex-build has 2 case(s)")));

  const byLabel = buildPartitionPlan(root, "elo/ladder", { by: "label" });
  assert.deepEqual(byLabel.plan.children.map((child) => child.route_id), ["elo/text", "elo/data"]);
});

test("partition plan rejects unknown grouping and repository_executable routes", async (t) => {
  const root = await writeLadderRepo(t);
  assert.throws(() => buildPartitionPlan(root, "elo/ladder", { by: "flavor" }), /Unknown partition grouping/);
  assert.throws(() => buildPartitionPlan(root, "elo/missing"), /Route not found/);
});

test("validatePartitionPlan enforces one-home-per-case, ids, scorer paths, and minimum sizes", async (t) => {
  const root = await writeLadderRepo(t);
  const { plan } = buildPartitionPlan(root, "elo/ladder");
  plan.children[2].allow_small = true;
  assert.deepEqual(validatePartitionPlan(root, plan).errors, []);

  const duplicated = structuredClone(plan);
  duplicated.children[0].cases.push("sql_fix-1");
  assert.match(validatePartitionPlan(root, duplicated).errors.join("\n"), /assigned to both elo\/json-extract and elo\/sql-fix/);

  const missing = structuredClone(plan);
  missing.unassigned = [];
  assert.match(validatePartitionPlan(root, missing).errors.join("\n"), /Missing: orphan-1/);

  const badId = structuredClone(plan);
  badId.children[0].route_id = "other/json-extract";
  assert.match(validatePartitionPlan(root, badId).errors.join("\n"), /must share the parent's product prefix elo/);

  const parentId = structuredClone(plan);
  parentId.children[0].route_id = "elo/ladder";
  assert.match(validatePartitionPlan(root, parentId).errors.join("\n"), /equals the parent route id/);

  const badScorer = structuredClone(plan);
  badScorer.children[0].scorer = ".benchrouter/scorer.nope.js";
  assert.match(validatePartitionPlan(root, badScorer).errors.join("\n"), /scorer path does not exist/);

  const small = structuredClone(plan);
  delete small.children[2].allow_small;
  assert.match(validatePartitionPlan(root, small).errors.join("\n"), /below the minimum 3/);

  const metadata = structuredClone(plan);
  metadata.children[0].metadata = { anticipated_elo: 1200 };
  assert.match(validatePartitionPlan(root, metadata).errors.join("\n"), /metadata.anticipated_elo is not an allowed field/);
});

test("editManifestRoutes sets scorer and metadata while preserving comments", () => {
  const source = `version: 1 # keep
routes:
  - id: a
    route_id: elo/a # child a
    eval_pack:
      scorer: .benchrouter/scorer.a.js
`;
  const edited = editManifestRoutes(source, [
    { route_id: "elo/a", scorer: ".benchrouter/scorer.custom.js", metadata: { eval_archetype: "human-read" } }
  ]);
  assert.match(edited, /version: 1 # keep/);
  assert.match(edited, /route_id: elo\/a # child a/);
  assert.match(edited, /scorer: \.benchrouter\/scorer\.custom\.js/);
  assert.match(edited, /metadata:\n\s+eval_archetype: human-read/);
  assert.throws(() => editManifestRoutes(source, [{ route_id: "elo/b", scorer: "x" }]), /elo\/b is not declared/);
});

test("partition apply registers children through init, splits cases and scorer, and re-applies as a no-op", async (t) => {
  const root = await writeLadderRepo(t);
  const plan = await runCli(["routes", "partition", "plan", "elo/ladder", "--out", "partition.json", "--output-dir", root], root);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /Wrote plan to partition.json/);
  const planFile = JSON.parse(await readFile(path.join(root, "partition.json"), "utf8"));
  planFile.children[2].allow_small = true;
  planFile.children[1].scorer = ".benchrouter/scorer.sql.js";
  planFile.children[1].metadata = { eval_archetype: "human-read" };
  await writeFile(path.join(root, "partition.json"), JSON.stringify(planFile, null, 2));
  await writeFile(path.join(root, ".benchrouter/scorer.sql.js"), "module.exports.score = () => ({ pass: false, checks: [], reasons: ['sql'] });\n");

  const dryRun = await runCli(["routes", "partition", "apply", "--plan", "partition.json", "--dry-run", "--output-dir", root], root);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Would register 3 new route\(s\) through init: elo\/json-extract, elo\/sql-fix, elo\/regex-build/);
  assert.match(dryRun.stdout, /Children incumbent: xai\/grok-4.6/);
  assert.equal(existsSync(path.join(root, ".benchrouter/cases.elo__json-extract.json")), false);

  const setupServer = await startFixtureServer(t, ({ requestBody }) => {
    const requested = [requestBody.route, ...(requestBody.routes ?? [])];
    return {
      repo_full_name: "example/elo",
      setup_packet: {
        files: [
          { path: ".benchrouter/benchrouter.yml", content: previewManifest(requested) },
          ...requested.flatMap((route) => [
            { path: `.benchrouter/cases.${slug(route.route_id)}.json`, content: "[]\n" },
            { path: `.benchrouter/scorer.${slug(route.route_id)}.js`, content: "// scaffold scorer\n" }
          ])
        ],
        package_json: { scripts: {}, dev_dependencies: [] },
        runtime_env: {},
        setup_api_keys: {}
      }
    };
  });

  const apply = await runCli([
    "routes", "partition", "apply", "--plan", "partition.json",
    "--setup-key", "br_setup_partition", "--repo", "example/elo",
    "--api-url", setupServer.url, "--output-dir", root
  ], root);
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /Registered 3 new route\(s\) through init/);
  assert.doesNotMatch(apply.stdout, /Suggested PR body/);

  // init contract: preview then commit, children carry the parent's exact incumbent tuple.
  assert.equal(setupServer.requests.length, 2);
  assert.equal(setupServer.requests[0].body.dry_run, true);
  const committed = setupServer.requests[1].body;
  assert.equal(committed.route.route_id, "elo/json-extract");
  assert.equal(committed.route.incumbent_model, "xai/grok-4.6");
  assert.equal(committed.route.provider_id, "xai");
  assert.equal(committed.route.provider_ref, "grok-4.6");
  assert.deepEqual(committed.route.code_refs, ["src/ladder.ts"]);
  assert.equal(committed.route.base_url_env, "OPENAI_BASE_URL");
  assert.deepEqual(committed.routes.map((route) => route.route_id), ["elo/sql-fix", "elo/regex-build"]);

  const manifest = await readFile(path.join(root, ".benchrouter/benchrouter.yml"), "utf8");
  assert.match(manifest, /name: Elo Ladder # keep me/);
  assert.equal((manifest.match(/route_id: elo\/ladder/g) ?? []).length, 1);
  assert.match(manifest, /route_id: elo\/json-extract/);
  assert.match(manifest, /scorer: \.benchrouter\/scorer\.sql\.js/);
  assert.match(manifest, /eval_archetype: human-read/);

  const jsonExtractCases = JSON.parse(await readFile(path.join(root, ".benchrouter/cases.elo__json-extract.json"), "utf8"));
  assert.deepEqual(jsonExtractCases.map((entry) => entry.id), ["json_extract-1", "json_extract-2", "json_extract-3"]);
  assert.ok(jsonExtractCases.every((entry) => entry.route === "elo/json-extract"));
  assert.equal(jsonExtractCases[0].critical, true);
  assert.equal(jsonExtractCases[0].reference_output, "x");
  assert.equal(await readFile(path.join(root, ".benchrouter/scorer.elo__json-extract.js"), "utf8"), PARENT_SCORER);
  assert.equal(await readFile(path.join(root, ".benchrouter/scorer.elo__sql-fix.js"), "utf8"), "// scaffold scorer\n");

  // Parent cases and scorer are untouched; nothing archived.
  const parentCases = JSON.parse(await readFile(path.join(root, ".benchrouter/cases.elo__ladder.json"), "utf8"));
  assert.equal(parentCases.length, 9);
  assert.equal(await readFile(path.join(root, ".benchrouter/scorer.elo__ladder.js"), "utf8"), PARENT_SCORER);

  const again = await runCli(["routes", "partition", "apply", "--plan", "partition.json", "--output-dir", root, "--json"], root);
  assert.equal(again.status, 0, again.stderr);
  const body = JSON.parse(again.stdout);
  assert.deepEqual(body.registered, []);
  assert.ok(body.changes.length > 0);
  assert.ok(body.changes.every((change) => change.status === "unchanged"), JSON.stringify(body.changes));
  assert.equal(setupServer.requests.length, 2);
});

test("partition apply stops on an invalid plan before any network call", async (t) => {
  const root = await writeLadderRepo(t);
  const { plan } = buildPartitionPlan(root, "elo/ladder");
  plan.children[0].cases.push("sql_fix-1");
  await writeFile(path.join(root, "bad.json"), JSON.stringify(plan));
  const result = await runCli(["routes", "partition", "apply", "--plan", "bad.json", "--setup-key", "br_setup_x", "--api-url", "http://127.0.0.1:9", "--output-dir", root], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Partition plan is not valid/);
  assert.match(result.stderr, /assigned to both/);
});

function slug(routeId) {
  return routeId.replace("/", "__");
}

function previewManifest(requested) {
  const routes = requested.map((route) => `  - id: ${slug(route.route_id)}
    route_id: ${route.route_id}
    name: ${route.name}
    code_refs: [${(route.code_refs ?? []).join(", ")}]
    call_site:
      base_url_env: ${route.base_url_env}
      provider_id: ${route.provider_id}
      provider_ref: ${route.provider_ref}
    seed:
      incumbent_model: ${route.incumbent_model}
    eval_pack:
      workflow: .github/workflows/benchrouter-evals.yml
      scorer: .benchrouter/scorer.${slug(route.route_id)}.js
      result_schema: benchrouter.result.v1
      case_refs: [.benchrouter/cases.${slug(route.route_id)}.json]
`).join("");
  return `version: 1
product:
  slug: elo
  repo: example/elo
  default_branch: main
routes:
  - id: ladder
    route_id: elo/ladder
    name: Server Reconstructed
    code_refs: []
    call_site: { base_url_env: WRONG }
    seed: { incumbent_model: wrong/model }
    eval_pack: { workflow: wrong, scorer: wrong, result_schema: wrong, case_refs: [wrong] }
${routes}`;
}

async function writeLadderRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "benchrouter-partition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".benchrouter"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"scripts":{}}\n');
  await writeFile(
    path.join(root, ".benchrouter/benchrouter.yml"),
    `version: 1

product:
  slug: elo
  repo: example/elo
  default_branch: main

routes:
  - id: ladder
    route_id: elo/ladder
    name: Elo Ladder # keep me
    code_refs:
      - src/ladder.ts
    metadata:
      eval_archetype: code-consumed
    call_site:
      base_url_env: OPENAI_BASE_URL
      provider_id: xai
      provider_ref: grok-4.6
    seed:
      incumbent_model: xai/grok-4.6
    eval_pack:
      workflow: .github/workflows/benchrouter-evals.yml
      scorer: .benchrouter/scorer.elo__ladder.js
      result_schema: benchrouter.result.v1
      case_refs:
        - .benchrouter/cases.elo__ladder.json
`
  );
  const cases = [];
  for (const [method, count] of [["json_extract", 3], ["sql_fix", 3], ["regex_build", 2]]) {
    for (let index = 1; index <= count; index += 1) {
      cases.push({
        id: `${method}-${index}`,
        route: "elo/ladder",
        critical: index === 1,
        request: { method },
        scorer_metadata: { method, partition: method === "sql_fix" ? "data" : "text", expect: { fields: ["out"] } },
        input: { messages: [{ role: "user", content: `${method} ${index}` }], max_tokens: 100 },
        reference_output: "x"
      });
    }
  }
  cases.push({ id: "orphan-1", route: "elo/ladder", input: { messages: [{ role: "user", content: "?" }] } });
  await writeFile(path.join(root, ".benchrouter/cases.elo__ladder.json"), `${JSON.stringify(cases, null, 2)}\n`);
  await writeFile(path.join(root, ".benchrouter/scorer.elo__ladder.js"), PARENT_SCORER);
  return root;
}

async function startFixtureServer(t, bodyFor) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    for await (const chunk of request) rawBody += chunk;
    const body = JSON.parse(rawBody);
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(bodyFor({ requestBody: body })));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function runCli(cliArgs, cwd, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      cwd,
      env: { ...process.env, BENCHROUTER_TOKEN: "", ...envOverrides },
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
