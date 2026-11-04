import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONTROL_COMMAND_FLAGS, controlFlagsEntry } from "../src/control-flags.mjs";
import { controlUsageText } from "../src/usage-text.mjs";

const cli = fileURLToPath(new URL("../bin/benchrouter.mjs", import.meta.url));

// Flags a help text names in its prose for another command, not as its own option.
const MENTIONED_FOR_OTHER_COMMANDS = {
  "setup create": ["setup-key"],
  "setup upgrade-token": ["upgrade-token"]
};

function flagsNamedIn(text) {
  const names = new Set();
  const flagChar = (char) => (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-";
  for (let index = text.indexOf("--"); index !== -1; index = text.indexOf("--", index + 2)) {
    let end = index + 2;
    while (end < text.length && flagChar(text[end])) end += 1;
    if (end > index + 2) names.add(text.slice(index + 2, end));
  }
  return [...names];
}

test("every flag a command's help documents is accepted by that command", () => {
  for (const commandPath of Object.keys(CONTROL_COMMAND_FLAGS)) {
    // A group's help also lists its subcommands' flags (admin catalog lists observations flags).
    const allowed = Object.entries(CONTROL_COMMAND_FLAGS)
      .filter(([name]) => name === commandPath || name.startsWith(`${commandPath} `))
      .flatMap(([, flags]) => flags);
    // Admin actions share their group's help text, so only entries with their own help are read.
    const help = controlUsageText(commandPath);
    if (!help) continue;
    const skipped = MENTIONED_FOR_OTHER_COMMANDS[commandPath] ?? [];
    for (const flag of flagsNamedIn(help)) {
      if (!skipped.includes(flag)) assert.ok(allowed.includes(flag), `${commandPath} documents --${flag}`);
    }
  }
});

test("a command path resolves to its longest table entry", () => {
  assert.equal(controlFlagsEntry(["routes", "pin", "app/chat"]), "routes pin");
  assert.equal(controlFlagsEntry(["admin", "catalog", "observations", "add"]), "admin catalog observations add");
  assert.equal(controlFlagsEntry(["admin", "catalog", "drain-outbox"]), "admin catalog drain-outbox");
  assert.equal(controlFlagsEntry(["admin", "providers", "key", "set", "openai"]), "admin providers key set");
  assert.equal(controlFlagsEntry(["billing", "auto-reload", "setup"]), "billing auto-reload setup");
  assert.equal(controlFlagsEntry(["routes", "nonsense"]), null);
});

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, BENCHROUTER_ACCOUNT_TOKEN: "", BENCHROUTER_ADMIN_TOKEN: "", HOME: "/nonexistent-br-home", XDG_CONFIG_HOME: "/nonexistent-br-home", npm_config_registry: "http://127.0.0.1:9" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("an unknown flag stops a control command before any request", { timeout: 4900 }, async (t) => {
  let requests = 0;
  const server = createServer((request, response) => { requests += 1; response.writeHead(500).end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const api = ["--api-url", `http://127.0.0.1:${server.address().port}`, "--account-token", "br_ctrl_recorded_fixture"];
  const cases = [
    [["routes", "pin", "app/chat", "--modle", "openai/gpt-5.4-mini", "--yes"], "routes pin", "--modle"],
    [["evals", "status", "app/chat", "--pr-number", "7"], "evals status", "--pr-number"],
    [["billing", "top-up", "--amount", "20", "--confirm"], "billing top-up", "--confirm"],
    [["routes", "list", "--yes"], "routes list", "--yes"],
    [["keys", "revoke", "k_1", "-f", "--yes"], "keys revoke", "-f"],
    [["databricks", "status", "--host", "https://x.example", "--force"], "databricks status", "--force"],
    [["public", "status", "--account-token", "br_ctrl_recorded_fixture"], "public status", "--account-token"],
    [["admin", "providers", "smoke", "openai", "--api-key", "candidate", "--yes"], "admin providers smoke", "--api-key"],
    [["admin", "catalog", "rebuild", "--limit", "1", "--yes"], "admin catalog rebuild", "--limit"],
    [["admin", "keys", "list", "--key-id", "k_1"], "admin keys list", "--key-id"],
    [["admin", "catalog", "observations", "--payload-json", "{}"], "admin catalog observations", "--payload-json"],
    [["admin", "catalog", "mappings", "list", "--source", "aa"], "admin catalog mappings list", "--source"]
  ];
  for (const [args, commandPath, flag] of cases) {
    const credential = commandPath === "public status" ? [] : commandPath.startsWith("admin") ? ["--admin-token", "bradm_recorded_fixture"] : api.slice(2);
    const result = await runCli([...args, ...api.slice(0, 2), ...credential]);
    assert.equal(result.status, 1, args.join(" "));
    assert.ok(result.stderr.startsWith(`Unknown flag for benchrouter ${commandPath}: ${flag}. Nothing was changed.\n`), `${args.join(" ")}: ${result.stderr}`);
  }
  const json = await runCli(["routes", "show", "app/chat", "--json", "--verbose", ...api]);
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stderr), {
    ok: false, error: { code: "invalid_arguments", message: "Unknown flag for benchrouter routes show: --verbose. Nothing was changed." }
  });
  assert.equal(requests, 0);

  // Documented write forms keep their flags and reach the server.
  for (const args of [
    ["admin", "providers", "key", "delete", "openai", "--yes", "--admin-token", "bradm_recorded_fixture"],
    ["admin", "catalog", "mappings", "resolve", "--source", "aa", "--raw-source-id", "x", "--canonical-id", "y", "--yes", "--admin-token", "bradm_recorded_fixture"]
  ]) {
    const result = await runCli([...args, ...api.slice(0, 2)]);
    assert.ok(!result.stderr.includes("Unknown flag"), `${args.join(" ")}: ${result.stderr}`);
  }
  assert.equal(requests, 2);
});

test("--help with only known flags still prints help", async () => {
  const result = await runCli(["routes", "pin", "--help", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith("Usage:\n  benchrouter routes pin"), result.stdout);
});
