import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "../bin/benchrouter.mjs");
// Real server responses (see fixtures/hosted-evals/README.md).
const overview = JSON.parse(await readFile(path.join(testDir, "fixtures/hosted-evals/overview.json"), "utf8"));
const results = JSON.parse(await readFile(path.join(testDir, "fixtures/hosted-evals/results.json"), "utf8"));
const token = ["--account-token", "br_ctrl_recorded_fixture"];
const cardHash = "sha256:6c1f0e1d9a7b";
const draftResponse = {
  ok: true,
  draft_id: "evd_ticket_labels",
  card: { name: "Ticket labels" },
  card_hash: cardHash,
  estimate: { total_usd: 0.42 },
  card_text: [
    "Approve eval \"Ticket labels\"?",
    "Cases: 2. Scorer: json_structure@1 (sha256:aa).",
    "Judge: none. Incumbent: openai/gpt-5.4-mini.",
    "Estimate: Up to about $0.4200 for the first search (2 cases x 12 models)",
    "BenchRouter will keep testing new models against this eval and spend from your balance until it runs out.",
    `Draft evd_ticket_labels, card ${cardHash}.`
  ].join("\n"),
  replayed: false
};

test("evals overview and results print the hosted-eval reads (MCP-001, EVAL-016)", async (t) => {
  const replay = await startServer(t, {
    "GET /v1/hosted-evals": overview,
    "GET /v1/hosted-evals/timeywimey%2Fvoice-places/results": results
  });
  const list = await runCli(["evals", "overview", "--api-url", replay.url, ...token]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, [
    "Account: patelnav (acct_patelnav)",
    "Routes:",
    "  pinned-smoke/br-b4-smoke  eval no_eval  serving google/gemini-2.5-flash-lite (no eval evidence)  saved $0.00  (Pinned, no eval)",
    "  timeywimey/voice-places   eval up_to_date  serving deepseek/deepseek-v4-flash  saved $0.04  (patelnav/timeywimey)",
    "Open drafts:",
    "  evd_fcba62966ce2409c90a4abc455ec0b9a  Smoke 608  new route  created 2026-10-24 16:51Z  card sha256:d7fae541efbad30267aa3f81a17d2c2a265a3eb4a38255492dcc9d4dbb5cc332",
    ""
  ].join("\n"));

  const human = await runCli(["evals", "results", "timeywimey/voice-places", "--api-url", replay.url, ...token]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, [
    "timeywimey/voice-places · your eval, version 6ebfa4f47deae9c97cc02efb947875ee33875d50",
    "Search: Done: 5 of 4 eligible",
    "Eval spend: $0.71",
    "Next:",
    "  2026-10-28 18:17Z  Background coverage checks one more challenger at the next batch.",
    "Serving: deepseek/deepseek-v4-flash; incumbent anthropic/claude-haiku-4.5",
    "Best available: sao10k/l3-lunaris-8b",
    "Chain: sao10k/l3-lunaris-8b > mistralai/voxtral-small-24b-2507 > microsoft/phi-4 > meta-llama/llama-3.1-8b-instruct > openai/gpt-5.6-luna",
    "Models:",
    "  sao10k/l3-lunaris-8b              pass 10/10 (1.000)  cost $0.0006  p95 1333ms  eligible #1 [previous]",
    "  mistralai/voxtral-small-24b-2507  pass 10/10 (1.000)  cost $0.0008  p95 1262ms  eligible #2",
    "  microsoft/phi-4                   pass 10/10 (1.000)  cost $0.0011  p95 1851ms  eligible #3",
    "  meta-llama/llama-3.1-8b-instruct  pass 10/10 (1.000)  cost $0.0014  p95 806ms  eligible #4",
    "  openai/gpt-6-luna                 pass 10/10 (1.000)  cost $0.0005  p95 21522ms  too_slow",
    "  openai/gpt-5.6-luna               pass 10/10 (1.000)  cost $0.0014  p95 3424ms  baseline",
    "  deepseek/deepseek-v4-flash        pass 10/10 (1.000)  cost $0.0029  p95 4485ms  too_slow [best]",
    "  anthropic/claude-haiku-4.5        pass 10/10 (1.000)  cost $0.0209  p95 3144ms  too_expensive [original]",
    "1 model(s) not measured.",
    ""
  ].join("\n"));
  const json = await runCli(["evals", "results", "timeywimey/voice-places", "--api-url", replay.url, ...token, "--json"]);
  assert.deepEqual(JSON.parse(json.stdout), results);
  // The approval audit tells the CLI from the API by this header.
  assert.ok(replay.requests.every((request) => request.client === "cli" && request.authorization === "Bearer br_ctrl_recorded_fixture"));
});

test("evals draft sends the cases file and scorer file as the documented draft body", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "benchrouter-hosted-draft-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = '{"id":"t1","input":{"messages":[{"role":"user","content":"Printer is down"}]}}\n{"id":"t2","input":{"messages":[{"role":"user","content":"Refund"}]}}\n';
  const scorer = { builtin: "json_structure@1", params: { schema: { type: "object", required: ["label"] } } };
  await writeFile(path.join(dir, "cases.jsonl"), cases);
  await writeFile(path.join(dir, "scorer.json"), JSON.stringify(scorer));
  await writeFile(path.join(dir, "bad.json"), "[1]");
  const replay = await startServer(t, { "POST /v1/hosted-evals/drafts": draftResponse });

  const draft = await runCli([
    "evals", "draft", "--name", "Ticket labels", "--cases", path.join(dir, "cases.jsonl"), "--scorer", path.join(dir, "scorer.json"),
    "--incumbent", "openai/gpt-5.4-mini", "--api-url", replay.url, ...token
  ]);
  assert.equal(draft.status, 0, draft.stderr);
  assert.equal(draft.stdout, `${draftResponse.card_text}\nApprove with: benchrouter evals approve evd_ticket_labels --card ${cardHash}\n`);
  assert.deepEqual(replay.requests.map((request) => request.body), [
    { name: "Ticket labels", cases_jsonl: cases, scorer, judge_model: null, incumbent: "openai/gpt-5.4-mini" }
  ]);

  const badScorer = await runCli(["evals", "draft", "--name", "x", "--cases", path.join(dir, "cases.jsonl"), "--scorer", path.join(dir, "bad.json"), "--api-url", replay.url, ...token]);
  assert.notEqual(badScorer.status, 0);
  assert.match(badScorer.stderr, /must hold a JSON object/);
  const missing = await runCli(["evals", "draft", "--name", "x", "--scorer", path.join(dir, "scorer.json"), "--api-url", replay.url, ...token]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Pass --name, --cases <cases.jsonl> and --scorer <scorer.json>/);
  assert.equal(replay.requests.length, 1);
});

test("evals approve needs --yes in JSON mode, then posts the card hash for the draft", async (t) => {
  const approved = { ok: true, version_id: "evv_1", route_key: "ticket-labels/main", result_set_id: "erset_1", replayed: false };
  const replay = await startServer(t, { "POST /v1/hosted-evals/drafts/evd_ticket_labels/approve": approved });
  const args = ["evals", "approve", "evd_ticket_labels", "--card", cardHash, "--api-url", replay.url, ...token];

  const refused = await runCli([...args, "--json"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires --yes/);
  assert.equal(replay.requests.length, 0);

  const human = await runCli([...args, "--yes"]);
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, [
    "Approved version evv_1 for ticket-labels/main; first search result set erset_1.",
    "Follow it with: benchrouter evals status ticket-labels/main",
    ""
  ].join("\n"));
  assert.deepEqual(replay.requests.map((request) => request.body), [{ card_hash: cardHash }]);
});

async function startServer(t, responses) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization ?? null,
        client: request.headers["x-benchrouter-client"] ?? null,
        body: text ? JSON.parse(text) : null
      });
      const body = responses[`${request.method} ${request.url}`];
      response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(body ?? { error: { message: `no fixture for ${request.method} ${request.url}`, code: "not_found" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function runCli(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
