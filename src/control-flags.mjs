// The flags each control-plane command reads, keyed by its command path. A command
// stops on any other flag before it sends a request: a coding agent that passes a
// flag the command ignores would otherwise believe something happened.
const ACCOUNT = ["help", "json", "account-token", "api-url"];
const ACCOUNT_WRITE = [...ACCOUNT, "yes"];
const ADMIN = ["help", "json", "admin-token", "api-url"];
const ADMIN_WRITE = [...ADMIN, "yes"];
const OBSERVATION_QUERY = ["source", "canonical-id", "subject-kind", "proposal-id", "raw-source-id", "limit"];
const PUBLIC = ["help", "json", "api-url"];

export const CONTROL_COMMAND_FLAGS = {
  login: ["help", "json", "api-url", "name", "expires-in-days", "timeout-seconds", "no-open"],
  "account show": ACCOUNT,
  "account token": ACCOUNT,
  "billing show": ACCOUNT,
  "billing activity": [...ACCOUNT, "from", "to", "payments", "cursor"],
  "billing statement": [...ACCOUNT, "from", "to"],
  "billing top-up": [...ACCOUNT_WRITE, "amount"],
  "billing auto-reload setup": [...ACCOUNT_WRITE, "threshold", "amount"],
  "billing auto-reload disable": ACCOUNT_WRITE,
  "keys list": ACCOUNT,
  "keys create": [...ACCOUNT_WRITE, "name", "product-id"],
  "keys revoke": [...ACCOUNT_WRITE, "key-id"],
  "keys disable": [...ACCOUNT_WRITE, "key-id"],
  "keys enable": [...ACCOUNT_WRITE, "key-id"],
  "repos list": ACCOUNT,
  "repos refresh": ACCOUNT,
  "setup status": [...ACCOUNT, "repo"],
  "setup create": [...ACCOUNT_WRITE, "repo", "repository-id", "installation-id", "intent"],
  "setup session": [...ACCOUNT, "session-id"],
  "setup approve": [...ACCOUNT_WRITE, "model"],
  "setup upgrade-token": [...ACCOUNT_WRITE, "repo", "route-id"],
  "routes list": ACCOUNT,
  "routes show": ACCOUNT,
  "routes catalog": ACCOUNT,
  "routes activity": ACCOUNT,
  "routes startup-failures": ACCOUNT,
  "routes create": [...ACCOUNT_WRITE, "name", "model", "group", "group-id", "group-slug", "route-slug"],
  "routes pin": [...ACCOUNT_WRITE, "model"],
  "routes archive": ACCOUNT_WRITE,
  "routes unarchive": ACCOUNT_WRITE,
  "evals list": ACCOUNT,
  "evals overview": ACCOUNT,
  "evals status": [...ACCOUNT, "pr"],
  "evals results": [...ACCOUNT, "pr"],
  "evals model": [...ACCOUNT, "pr"],
  "evals case-output": [...ACCOUNT, "run", "case"],
  "evals draft": [...ACCOUNT, "name", "cases", "scorer", "judge-model", "incumbent", "route", "parent-version", "request-id"],
  "evals approve": [...ACCOUNT_WRITE, "card"],
  "evals run": [...ACCOUNT_WRITE, "model", "full-refresh"],
  "evals retry": [...ACCOUNT_WRITE, "result-set", "route"],
  "evals harness-retry": [...ACCOUNT_WRITE, "model"],
  "evals refresh-preview": [...ACCOUNT_WRITE, "result-set", "model"],
  baseline: [...ACCOUNT_WRITE, "result-set", "result-set-id", "model"],
  "blocks list": [...ACCOUNT, "repo"],
  "blocks unblock": [...ACCOUNT_WRITE, "repo", "route", "all-blocked"],
  "public status": PUBLIC,
  "public frontier": PUBLIC,
  // Admin groups list each action, so a flag that only a sibling action reads still stops.
  proposals: ADMIN,
  "proposals list": ADMIN,
  "proposals approve": ADMIN_WRITE,
  "proposals reject": ADMIN_WRITE,
  "admin token": ADMIN,
  "admin providers": ADMIN,
  "admin providers list": ADMIN,
  "admin providers key set": [...ADMIN_WRITE, "api-key", "base-url"],
  "admin providers key delete": ADMIN_WRITE,
  "admin providers smoke": ADMIN_WRITE,
  "admin providers disable": ADMIN_WRITE,
  "admin providers enable": ADMIN_WRITE,
  "admin catalog": ADMIN,
  "admin catalog show": ADMIN,
  "admin catalog activity": ADMIN,
  "admin catalog model-maps": ADMIN,
  "admin catalog refresh-report": ADMIN,
  "admin catalog drain-outbox": [...ADMIN_WRITE, "limit"],
  "admin catalog rebuild": ADMIN_WRITE,
  "admin catalog observations": [...ADMIN, ...OBSERVATION_QUERY],
  "admin catalog observations add": [...ADMIN_WRITE, "source", "subject-kind", "payload-json", "derived-action", "match-confidence",
    "canonical-id", "source-version", "raw-source-id"],
  "admin catalog mappings": ADMIN,
  "admin catalog mappings list": ADMIN,
  "admin catalog mappings resolve": [...ADMIN_WRITE, "source", "raw-source-id", "canonical-id"],
  "admin catalog mappings ignore": [...ADMIN_WRITE, "source", "raw-source-id"],
  "admin keys": ADMIN,
  "admin keys list": ADMIN,
  "admin keys revoke": [...ADMIN_WRITE, "key-id"],
  "admin keys mint": ADMIN_WRITE,
  "databricks connect": [...ACCOUNT, "host", "catalog", "schema", "warehouse", "results-group", "manage-group"],
  "databricks status": [...ACCOUNT, "host", "all"],
  "databricks add-eval": [...ACCOUNT, "host"],
  "databricks disconnect": [...ACCOUNT, "host", "force", "reclaim", "results-owner"]
};

/** The longest command path in the table that the positional words start with, or null. */
export function controlFlagsEntry(positional) {
  const parts = positional.filter((value) => typeof value === "string");
  for (let end = parts.length; end > 0; end -= 1) {
    const name = parts.slice(0, end).join(" ");
    if (Object.hasOwn(CONTROL_COMMAND_FLAGS, name)) return name;
  }
  return null;
}

/** The unknown flags among `optionNames` (as typed) and dash-led positional words, in order. */
export function unknownControlFlags(commandPath, optionNames, positional) {
  const allowed = CONTROL_COMMAND_FLAGS[commandPath];
  const unknown = [
    ...optionNames.filter((name) => !allowed.includes(name)).map((name) => `--${name}`),
    ...positional.filter((value) => typeof value === "string" && value.startsWith("-") && value.length > 1)
  ];
  return [...new Set(unknown)];
}
