const ACCOUNT_FLAGS = `  --account-token br_ctrl_...  Defaults to BENCHROUTER_ACCOUNT_TOKEN, then private local config.
  --api-url <url>              Defaults to https://api.benchrouter.com.
  --json                       Print machine-readable JSON.
`;

const ADMIN_FLAGS = `  --admin-token bradm_...      Defaults to BENCHROUTER_ADMIN_TOKEN, then private local config.
  --api-url <url>              Defaults to https://api.benchrouter.com.
  --json                       Print machine-readable JSON.
`;

const CONTROL_USAGE = {
  account: `Usage:
  benchrouter account show
  benchrouter account token save --account-token br_ctrl_...

Options:
${ACCOUNT_FLAGS}`,
  "account show": `Usage:
  benchrouter account show

Reads GET /v1/account/control/me.

Options:
${ACCOUNT_FLAGS}`,
  "account token": `Usage:
  benchrouter account token save --account-token br_ctrl_...

Saves an already-minted account token. Never prints the secret.
Minting still requires a browser session (POST /v1/dashboard/control-tokens).

Options:
${ACCOUNT_FLAGS}`,
  "account token save": `Usage:
  benchrouter account token save --account-token br_ctrl_...

Options:
${ACCOUNT_FLAGS}`,
  billing: `Usage:
  benchrouter billing show
  benchrouter billing top-up --amount 25

billing show reads billing fields from GET /v1/dashboard/summary.

Options:
${ACCOUNT_FLAGS}  --yes, -y                    Skip confirmation for top-up.
`,
  "billing show": `Usage:
  benchrouter billing show

Reads billing from GET /v1/dashboard/summary (not /v1/billing/summary).

Options:
${ACCOUNT_FLAGS}`,
  "billing top-up": `Usage:
  benchrouter billing top-up --amount <usd>

Prints a Stripe checkout URL. Does not open a browser or automate payment.

Options:
  --amount <usd>               Top-up credit amount (server-allowed values).
  --yes, -y                    Required with --json; skips the confirmation prompt.
${ACCOUNT_FLAGS}`,
  keys: `Usage:
  benchrouter keys list
  benchrouter keys create --product-id <id> [--name text]
  benchrouter keys revoke <key-id>

These manage runtime API keys. Revoke is immediate and cannot be undone.

Options:
${ACCOUNT_FLAGS}  --yes, -y                    Skip confirmation for create/revoke.
`,
  "keys list": `Usage:
  benchrouter keys list

Lists non-secret key metadata from GET /v1/dashboard/summary.

Options:
${ACCOUNT_FLAGS}`,
  "keys create": `Usage:
  benchrouter keys create --product-id <id> [--name text]

The new runtime key is returned once by the server and printed once here.
Store it in the application host; the CLI never writes runtime keys to disk.

Options:
  --product-id <id>
  --name <text>
  --yes, -y
${ACCOUNT_FLAGS}`,
  "keys revoke": `Usage:
  benchrouter keys revoke <key-id>

Calls POST /v1/dashboard/api-keys/:keyId/revoke and prints non-secret key
metadata. Any application still using that key stops working immediately.

Options:
  --key-id <id>
  --yes, -y
${ACCOUNT_FLAGS}`,
  repos: `Usage:
  benchrouter repos list

Options:
${ACCOUNT_FLAGS}`,
  "repos list": `Usage:
  benchrouter repos list

Options:
${ACCOUNT_FLAGS}`,
  setup: `Usage:
  benchrouter setup status [--repo owner/repo]
  benchrouter setup create --repository-id <id> --installation-id <id> [--repo owner/repo] [--intent initial|new_route]
  benchrouter setup session show <session-id>
  benchrouter setup upgrade-token --route-id <id> [--repo owner/repo]

create and upgrade-token each return a one-time secret. The CLI prints it once
and never saves it.

Options:
${ACCOUNT_FLAGS}  --yes, -y
`,
  "setup status": `Usage:
  benchrouter setup status [--repo owner/repo]

Options:
  --repo owner/repo
${ACCOUNT_FLAGS}`,
  "setup create": `Usage:
  benchrouter setup create --repository-id <id> --installation-id <id> [--repo owner/repo] [--intent initial|new_route]

Calls POST /v1/setup/sessions and prints the one-time setup code plus the
server-authored init command. The code is never written to disk; pass it to
\`benchrouter init --setup-key\`. Get --repository-id and --installation-id from
\`benchrouter repos list\`.

Options:
  --repository-id <id>         GitHub repository ID.
  --installation-id <id>       GitHub App installation ID (positive integer).
  --repo owner/repo            Defaults to the current git remote.
  --intent initial|new_route   Defaults to initial.
  --yes, -y
${ACCOUNT_FLAGS}`,
  "setup session": `Usage:
  benchrouter setup session show <session-id>

Options:
  --session-id <id>
${ACCOUNT_FLAGS}`,
  "setup session show": `Usage:
  benchrouter setup session show <session-id>

Reads GET /v1/setup/sessions/:id. Never returns the setup code.

Options:
  --session-id <id>
${ACCOUNT_FLAGS}`,
  "setup upgrade-token": `Usage:
  benchrouter setup upgrade-token --route-id <id> [--repo owner/repo]

Mints a single-use br_upgrade_ token through
POST /v1/dashboard/setup-kit/upgrade-token and prints it once. The CLI does not
save it. Pass it to \`benchrouter upgrade --upgrade-token\`.

Options:
  --route-id <id>
  --repo owner/repo            Defaults to the current git remote.
  --yes, -y
${ACCOUNT_FLAGS}`,
  routes: `Usage:
  benchrouter routes list
  benchrouter routes show <route-key>
  benchrouter routes catalog <route-key>
  benchrouter routes archive <route-key>
  benchrouter routes unarchive <route-id>

Options:
${ACCOUNT_FLAGS}  --yes, -y
`,
  "routes list": `Usage:
  benchrouter routes list

Options:
${ACCOUNT_FLAGS}`,
  "routes show": `Usage:
  benchrouter routes show <route-key>

Options:
${ACCOUNT_FLAGS}`,
  "routes catalog": `Usage:
  benchrouter routes catalog <route-key>

Options:
${ACCOUNT_FLAGS}`,
  "routes archive": `Usage:
  benchrouter routes archive <route-key>

Options:
  --yes, -y
${ACCOUNT_FLAGS}`,
  "routes unarchive": `Usage:
  benchrouter routes unarchive <route-id>

Options:
  --yes, -y
${ACCOUNT_FLAGS}`,
  "models show": `Usage:
  benchrouter models show <route-key> <model-id>

Options:
${ACCOUNT_FLAGS}`,
  evals: `Usage:
  benchrouter evals list <route-key>
  benchrouter evals run <route-key> --model <model-id>
  benchrouter evals failures <route-key> <model-id>
  benchrouter evals refresh-preview <route-key> <result-set-id> [--model <model-id>]

Options:
${ACCOUNT_FLAGS}  --yes, -y
`,
  "evals refresh-preview": `Usage:
  benchrouter evals refresh-preview <route-key> <result-set-id> [--model <model-id>]

Refreshes an open-PR preview result set. The result set must be a PR preview.
Omit --model to refresh every model the preview frontier needs.

Options:
  --result-set <id>
  --model <id>
  --yes, -y
${ACCOUNT_FLAGS}`,
  "evals list": `Usage:
  benchrouter evals list <route-key>

Options:
${ACCOUNT_FLAGS}`,
  "evals run": `Usage:
  benchrouter evals run <route-key> --model <model-id>

Options:
  --model <id>
  --yes, -y
${ACCOUNT_FLAGS}`,
  "evals failures": `Usage:
  benchrouter evals failures <route-key> <model-id>

Options:
  --model <id>
${ACCOUNT_FLAGS}`,
  baseline: `Usage:
  benchrouter baseline set <route-key> --result-set <id> --model <model-id>

Options:
  --result-set <id>
  --model <id>
  --yes, -y
${ACCOUNT_FLAGS}`,
  "baseline set": `Usage:
  benchrouter baseline set <route-key> --result-set <id> --model <model-id>

Options:
  --result-set <id>
  --model <id>
  --yes, -y
${ACCOUNT_FLAGS}`,
  proposals: `Usage:
  benchrouter proposals list
  benchrouter proposals approve <proposal-id> [--yes]
  benchrouter proposals reject <proposal-id> [--yes]

Requires a bradm_ admin bearer.

Options:
${ADMIN_FLAGS}  --yes, -y
`,
  "proposals list": `Usage:
  benchrouter proposals list

Options:
${ADMIN_FLAGS}`,
  "proposals approve": `Usage:
  benchrouter proposals approve <proposal-id> [--yes]

Options:
  --yes, -y
${ADMIN_FLAGS}`,
  "proposals reject": `Usage:
  benchrouter proposals reject <proposal-id> [--yes]

Options:
  --yes, -y
${ADMIN_FLAGS}`,
  admin: `Usage:
  benchrouter admin providers list|key set|key delete|smoke|disable|enable
  benchrouter admin catalog show|activity|model-maps|refresh-report|rebuild
  benchrouter admin catalog observations [add]|mappings [list|resolve|ignore]
  benchrouter admin keys list|revoke
  benchrouter admin token save --admin-token bradm_...

admin keys list and revoke accept a bradm_ bearer. Minting an admin key
requires a browser GitHub admin session; a bradm_ bearer cannot mint.
Provider enable maps to DELETE /v1/admin/providers/:provider/disable.

Options:
${ADMIN_FLAGS}  --yes, -y
`,
  "admin providers": `Usage:
  benchrouter admin providers list
  benchrouter admin providers key set <provider> --api-key <secret> [--base-url <url>] [--yes]
  benchrouter admin providers key delete <provider> [--yes]
  benchrouter admin providers smoke|disable|enable <provider> [--yes]

Options:
${ADMIN_FLAGS}  --yes, -y
`,
  "admin catalog": `Usage:
  benchrouter admin catalog show|activity|model-maps|rebuild
  benchrouter admin catalog refresh-report
  benchrouter admin catalog observations [--source <s>] [--canonical-id <id>] [--limit <n>]
  benchrouter admin catalog observations add --source <s> --subject-kind <k> [--payload-json '{}']
  benchrouter admin catalog mappings [list]
  benchrouter admin catalog mappings resolve --source <s> --raw-source-id <id> --canonical-id <id>
  benchrouter admin catalog mappings ignore --source <s> --raw-source-id <id>

refresh-report is POST /v1/admin/catalog/refresh-report. It is report-only:
the server fetches upstream state and performs no writes.

Options:
${ADMIN_FLAGS}  --yes, -y
`,
  "admin catalog observations": `Usage:
  benchrouter admin catalog observations [--source <s>] [--subject-kind <k>] [--canonical-id <id>] [--raw-source-id <id>] [--proposal-id <id>] [--limit <n>]
  benchrouter admin catalog observations add --source lab_notice|manual_admin --subject-kind model|target|provider|proposal [options]

add records a manual notice. It never changes routing, provider rank, or target
availability by itself. The server stamps the acting admin into the payload.

Options for add:
  --source lab_notice|manual_admin              Required.
  --subject-kind model|target|provider|proposal Required.
  --derived-action <action>                     Defaults to none on the server.
  --match-confidence high|low|unmatched
  --canonical-id <id>
  --source-version <text>
  --raw-source-id <id>
  --payload-json '{"key":"value"}'              Must parse to a JSON object.
  --yes, -y
${ADMIN_FLAGS}`,
  "admin catalog mappings": `Usage:
  benchrouter admin catalog mappings [list]
  benchrouter admin catalog mappings resolve --source <s> --raw-source-id <id> --canonical-id <id>
  benchrouter admin catalog mappings ignore --source <s> --raw-source-id <id>

list reads GET /v1/admin/catalog/mappings: upstream identities that still need a
decision. resolve requires an exact current OpenRouter model id.

Options:
  --source <s>
  --raw-source-id <id>
  --canonical-id <id>
  --yes, -y
${ADMIN_FLAGS}`,
  "admin keys": `Usage:
  benchrouter admin keys list
  benchrouter admin keys revoke <key-id> [--yes]

list reads GET /v1/admin/keys; revoke calls DELETE /v1/admin/keys/:id. Both
accept a bradm_ bearer and print non-secret metadata only.

Minting (POST /v1/admin/keys) requires a browser GitHub admin session. A bradm_
bearer receives admin_session_required, so the CLI does not offer a mint command.

Options:
  --yes, -y
${ADMIN_FLAGS}`,
  "admin token": `Usage:
  benchrouter admin token save --admin-token bradm_...

Saves an already-minted admin token. Never prints the secret.

Options:
${ADMIN_FLAGS}`,
  "admin token save": `Usage:
  benchrouter admin token save --admin-token bradm_...

Options:
${ADMIN_FLAGS}`
};

export function controlUsageText(commandName) {
  return CONTROL_USAGE[commandName] ?? null;
}

/**
 * Resolve `--help` to the most specific usage entry the positional path names,
 * so `admin providers key set --help` and `keys revoke k_1 --help` both work.
 * Returns null when the path names no control-plane command.
 */
export function resolveControlUsageName(positional) {
  const parts = positional.filter((value) => typeof value === "string");
  for (let end = parts.length; end > 0; end -= 1) {
    const name = parts.slice(0, end).join(" ");
    if (CONTROL_USAGE[name]) return name;
  }
  return null;
}

export function topLevelControlUsageLines() {
  return `  benchrouter account show|token save [--json]
  benchrouter billing show [--json]
  benchrouter billing top-up --amount <usd> [--yes]
  benchrouter keys list|create|revoke [--json]
  benchrouter repos list [--json]
  benchrouter setup status|create|session show|upgrade-token [--json]
  benchrouter routes list|show|catalog|archive|unarchive [--json]
  benchrouter models show <route-key> <model-id> [--json]
  benchrouter evals list|run|failures|refresh-preview [--json]
  benchrouter baseline set <route-key> --result-set <id> --model <id> [--yes]
  benchrouter proposals list|approve|reject [--json]
  benchrouter admin providers|catalog|keys|token [--json]`;
}
