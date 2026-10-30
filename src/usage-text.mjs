const ACCOUNT_FLAGS = `  --account-token br_ctrl_...  Defaults to BENCHROUTER_ACCOUNT_TOKEN, then private local config.
  --api-url <url>              Defaults to https://api.benchrouter.com.
  --json                       Print machine-readable JSON.
`;

const ADMIN_FLAGS = `  --admin-token bradm_...      Defaults to BENCHROUTER_ADMIN_TOKEN, then private local config.
  --api-url <url>              Defaults to https://api.benchrouter.com.
  --json                       Print machine-readable JSON.
`;

const DATABRICKS_CONNECT_USAGE = `Usage:
  benchrouter databricks connect --host <url> --catalog <catalog> --schema <schema> [options]

Uses your local Databricks OAuth login and BenchRouter control-token login.
Supports user (U2M) and service principal (M2M) OAuth logins.
The Databricks login token stays in memory on this machine. PAT logins are refused.
Connect writes the poll key, applies REST grants and heal, and starts the agent job.
It waits for the agent run to succeed, binding verification, and all five expected
setup rows to exist and be done: two volumes, the results table, experiment, and eval job.
Any failed setup row stops Connect. Pending serving endpoints do not block completion.
Pending SP-change grants run before revokes. Refused steps stay pending and warn;
setup continues and exits 0 on success. Re-run benchrouter databricks connect as
that owner or a metastore admin. JSON includes refused steps in pending_steps.
Human output lists each setup item. JSON includes setup_items (kind, target, state).

Options:
  --host <url>                 HTTPS Databricks workspace URL.
  --catalog <catalog>          Existing Unity Catalog catalog.
  --schema <schema>            Existing schema in the catalog.
  --warehouse <id>             Warehouse for agent/eval work. Defaults to the only serverless warehouse.
                              With several warehouses, select one on a TTY or pass this flag.
  --results-group <group>      Account group that can read results.
  --manage-group <group>       Account group that can manage serving objects.
${ACCOUNT_FLAGS}
Exit codes:
  0  Agent run succeeded, binding verified, and all five expected setup rows exist and are done.
  1  Other error, unsupported Databricks auth type, invalid arguments, or verification timeout.
  3  Initial grant or heal refused. The error names the catalog, schema, and known object owners.
  4  workspace_admin_required. Log in as a Databricks workspace admin.
  5  PAT login. Run databricks auth login --host <url>.
`;

const DATABRICKS_EXITS = `Exit codes:
  0  Command completed.
  1  Other error, refused request, invalid manifest, login missing, or disconnect timeout.
  3  Grant refused. The error names the known owners.
  4  workspace_admin_required. Log in as a Databricks workspace admin.
  5  PAT login. Run databricks auth login --host <url>.
`;
const DATABRICKS_STATUS_USAGE = `Usage:
  benchrouter databricks status [--host <url>] [--all] [--json]

Any account member can read matching bindings, setup items, routes, evals, failures and leftovers.
By default, show open bindings and closed bindings with cleanup pending.
JSON always returns {bindings: [<server read>, ...]}.
With an available OAuth login, check the agent job owner and leftovers.
Warn if removing the user who owns the job will stop it. Acknowledge objects that are gone.
Pending grant/revoke steps show instructions, actions and targets in Leftovers.
Status never runs or acknowledges those steps.
A missing Databricks login does not prevent status. Cleanup acknowledgement needs owner/admin.
Options:
  --host <url>                 Filter by HTTPS Databricks workspace URL.
  --all                        Show every matching binding, including closed bindings without leftovers.
${ACCOUNT_FLAGS}
${DATABRICKS_EXITS}`;
const DATABRICKS_EVAL_USAGE = `Usage:
  benchrouter databricks add-eval <route> <folder> [--host <url>] [--json]

Needs a BenchRouter owner/admin and a Databricks workspace-admin OAuth login.
Check the workspace admin, read the folder, and export and validate its manifest.
Then attach the folder, PATCH folder CAN_READ and cases-table SELECT,
then start the recorded agent job. Grant USE CATALOG/USE SCHEMA outside the binding schema.
Print secret-scope READ commands. Supply no secret value.
Options:
  --host <url>                 Select a workspace when several bindings exist.
${ACCOUNT_FLAGS}
${DATABRICKS_EXITS}`;
const DATABRICKS_DISCONNECT_USAGE = `Usage:
  benchrouter databricks disconnect [--host <url>] [--force] [--reclaim] [--results-owner <group>] [--json]

Needs a BenchRouter owner/admin and a Databricks workspace-admin OAuth login.
Start the agent, wait up to three minutes for archive/closure, then delete only its recorded
objects. Preserve ids held by an open binding. Keep the agent SP for account-console cleanup.
Before closure (also with --force), run pending grants then revokes and acknowledge done steps.
Refused steps warn, stay pending and do not stop Disconnect. JSON includes pending_steps.
For a closed binding, resume cleanup without sending another disconnect request.
Without --results-owner, the results table and experiment stay with the agent SP.
Options:
  --host <url>                 Select a workspace. Required with --reclaim.
  --force                      Close now; perform the server's pending cleanup as admin.
  --reclaim                    Fresh proof closes the holding binding without its account role.
                               Delete only the returned endpoints and provider services.
                               Cannot use --force or --results-owner.
  --results-owner <group>      Give the results table and experiment to this group.
${ACCOUNT_FLAGS}
${DATABRICKS_EXITS}`;

const CONTROL_USAGE = {
  databricks: `${DATABRICKS_CONNECT_USAGE}\n${DATABRICKS_STATUS_USAGE}\n${DATABRICKS_EVAL_USAGE}\n${DATABRICKS_DISCONNECT_USAGE}`,
  "databricks status": DATABRICKS_STATUS_USAGE,
  "databricks add-eval": DATABRICKS_EVAL_USAGE,
  "databricks disconnect": DATABRICKS_DISCONNECT_USAGE,
  "databricks connect": DATABRICKS_CONNECT_USAGE,
  login: `Usage:
  benchrouter login [--name text] [--expires-in-days 90]

Creates a short-lived authorization request, opens BenchRouter in your browser,
and waits for you to approve one account. The browser never receives the token.
The CLI saves the token atomically in private local config and proves the account.

Options:
  --name <text>                Token name shown in the browser. Defaults to CLI login.
  --expires-in-days <1..365>  Token lifetime. Defaults to 90.
  --timeout-seconds <1..600>  Browser approval wait. Defaults to 600.
  --no-open                    Print the authorization URL without opening a browser.
  --api-url <url>              Defaults to https://api.benchrouter.com.
  --json                       Print the final non-secret result as JSON.
`,
  account: `Usage:
  benchrouter login
  benchrouter account show
  benchrouter account token save --account-token br_ctrl_...

Options:
${ACCOUNT_FLAGS}`,
  "account show": `Usage:
  benchrouter account show

Shows the account page of the website and your role. An owner also sees the balance,
free credit, spend, savings, auto-reload (with a paused reload's last error),
endpoint key prefixes (never full keys) and GitHub installations. --json adds the
recent ledger, top-up limits and products.

Options:
${ACCOUNT_FLAGS}`,
  "account token": `Usage:
  benchrouter account token save --account-token br_ctrl_...

Saves an already-minted account token. Never prints the secret.
This is a recovery path. Use \`benchrouter login\` for normal browser-assisted sign-in.

Options:
${ACCOUNT_FLAGS}`,
  "account token save": `Usage:
  benchrouter account token save --account-token br_ctrl_...

Options:
${ACCOUNT_FLAGS}`,
  billing: `Usage:
  benchrouter billing show
  benchrouter billing activity [--from <iso>] [--to <iso>] [--payments] [--cursor <cursor>]
  benchrouter billing statement [--from <iso>] [--to <iso>]
  benchrouter billing top-up --amount 25
  benchrouter billing auto-reload setup --threshold <usd> --amount <usd>
  benchrouter billing auto-reload disable

billing show reads billing fields from GET /v1/dashboard/summary.

Options:
${ACCOUNT_FLAGS}  --yes, -y                    Skip confirmation for top-up.
`,
  "billing show": `Usage:
  benchrouter billing show

Reads billing from GET /v1/dashboard/summary (not /v1/billing/summary).

Options:
${ACCOUNT_FLAGS}`,
  "billing activity": `Usage:
  benchrouter billing activity [--from <iso>] [--to <iso>] [--payments] [--cursor <cursor>]

Lists the billing history of the account page, newest first, 50 entries a page:
model calls, eval calls, credit purchases and reloads. The period defaults to the
last 30 days. --payments lists only payments. When there is a next page, the last
line is the command that reads it. Owner only.

Options:
  --from <iso>
  --to <iso>
  --payments
  --cursor <cursor>
${ACCOUNT_FLAGS}`,
  "billing statement": `Usage:
  benchrouter billing statement [--from <iso>] [--to <iso>]

Shows a period's opening and closing balance, credits, debits and the spend of each
route (runtime and evals). The period defaults to the last 30 days. Owner only.

Options:
  --from <iso>
  --to <iso>
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
  benchrouter keys disable <key-id>
  benchrouter keys enable <key-id>
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
  "keys disable": `Usage:
  benchrouter keys disable <key-id>

Calls POST /v1/dashboard/api-keys/:keyId/disable. Requests with the key fail
until you enable it again (KEYS-001).

Options:
  --key-id <id>
  --yes, -y
${ACCOUNT_FLAGS}`,
  "keys enable": `Usage:
  benchrouter keys enable <key-id>

Calls POST /v1/dashboard/api-keys/:keyId/enable.

Options:
  --key-id <id>
  --yes, -y
${ACCOUNT_FLAGS}`,
  "billing auto-reload": `Usage:
  benchrouter billing auto-reload setup --threshold <usd> --amount <usd>
  benchrouter billing auto-reload disable

Options:
${ACCOUNT_FLAGS}  --yes, -y
`,
  "billing auto-reload setup": `Usage:
  benchrouter billing auto-reload setup --threshold <usd> --amount <usd>

Prints a Stripe checkout URL that saves the card. Automatic reload turns on
after Stripe confirms it (BILL-005). The CLI never opens a browser.

Options:
  --threshold <usd>            Reload when the balance falls below this.
  --amount <usd>               Credit added on each reload.
  --yes, -y
${ACCOUNT_FLAGS}`,
  "billing auto-reload disable": `Usage:
  benchrouter billing auto-reload disable

Options:
  --yes, -y
${ACCOUNT_FLAGS}`,
  blocks: `Usage:
  benchrouter blocks list [--repo owner/repo]
  benchrouter blocks unblock --repo owner/repo [--route <route-key>]
  benchrouter blocks unblock --route <route-key>
  benchrouter blocks unblock --all-blocked

Unblock clears BenchRouter's own breakers (startup_failing,
snapshot_refresh_failing, harness_failing) and re-checks workflow_missing and
installation_revoked against GitHub. Queued evaluations restart through the
normal dispatcher. It creates no evaluation and reruns no model. Only an
account owner can unblock. Use \`evals retry\` to rerun failed evaluations.

Options:
${ACCOUNT_FLAGS}  --yes, -y
`,
  "blocks list": `Usage:
  benchrouter blocks list [--repo owner/repo]

Prints one line per block: kind, scope, since or until, whether Unblock clears
it, and how to clear it.

Options:
  --repo owner/repo
${ACCOUNT_FLAGS}`,
  "blocks unblock": `Usage:
  benchrouter blocks unblock --repo owner/repo [--route <route-key>]
  benchrouter blocks unblock --route <route-key>
  benchrouter blocks unblock --all-blocked

--route limits route blocks to one route; repository blocks always apply.
A repository with nothing blocked is unchanged.

Options:
  --repo owner/repo
  --route <route-key>
  --all-blocked                Every repository the account owns.
  --yes, -y
${ACCOUNT_FLAGS}`,
  repos: `Usage:
  benchrouter repos list
  benchrouter repos refresh

Options:
${ACCOUNT_FLAGS}`,
  "repos refresh": `Usage:
  benchrouter repos refresh

Re-reads your GitHub repository access with the GitHub sign-in BenchRouter holds, as
the Setup page's Refresh does, then lists the repositories. Run it after you install
the GitHub App on more repositories. When GitHub needs a fresh sign-in, it fails with
github_reauth_required: reconnect GitHub on the BenchRouter website, then run it again.

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
  benchrouter setup approve <approval-id|approval-link> [--model <model-id>] [--yes]
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
  "setup approve": `Usage:
  benchrouter setup approve <approval-id|approval-link>
  benchrouter setup approve <approval-id|approval-link> --model <model-id> [--yes]

When the setup agent finds that a call site's model is not one BenchRouter can
serve, it gives an approval link (.../setup/authorize?approval=...). Without
--model, this shows that approval: the observed model, the recommended baseline
and the alternatives. With --model, it approves that baseline, as the setup page
does. It needs your linked GitHub account to have write access to the repository.

Options:
  --model <model-id>
  --yes, -y
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
  benchrouter routes activity <route-key>
  benchrouter routes startup-failures <route-key>
  benchrouter routes create --name <text> --model <model-id> (--group <name> [--group-slug <slug>] | --group-id <id>) [--route-slug <slug>]
  benchrouter routes pin <route-key> [--model <model-id>]
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
  "routes activity": `Usage:
  benchrouter routes activity <route-key>

Shows the route's background eval activity: its state and trigger, how many models
are done, failed, running or queued, the times, the GitHub run, and a failure with
its automatic recovery.

Options:
${ACCOUNT_FLAGS}`,
  "routes startup-failures": `Usage:
  benchrouter routes startup-failures <route-key>

Lists the route's blocked runner startups (the GitHub worker did not start), each
with its message, its automatic retry time, and GitHub's annotations of the run.

Options:
${ACCOUNT_FLAGS}`,
  public: `Usage:
  benchrouter public status
  benchrouter public frontier

The website's public pages. They need no credential.
`,
  "public status": `Usage:
  benchrouter public status

Shows BenchRouter's service status: each component's status and uptime, and any
incident. Needs no credential.

Options:
  --api-url <url>
  --json
`,
  "public frontier": `Usage:
  benchrouter public frontier

Lists the public Pareto frontier of catalog models with each one's tier, benchmark
score and cost. --json also lists the models near the frontier. Needs no credential.

Options:
  --api-url <url>
  --json
`,
  "routes create": `Usage:
  benchrouter routes create --name <text> --model <model-id> --group <name> [--group-slug <slug>] [--route-slug <slug>]
  benchrouter routes create --name <text> --model <model-id> --group-id <id> [--route-slug <slug>]

Creates a pinned route: it serves one catalog model and has no eval. --group puts
it in a new group (creating one needs the account owner); --group-id puts
it in an existing group with no repository. Pass exactly one of --group or --group-id.
--group-slug requires --group. Slugs default to the names. A route key that exists
already is refused (route_key_taken). It spends nothing.

Options:
  --name <text>
  --model <model-id>
  --group <name>
  --group-slug <slug>
  --group-id <id>
  --route-slug <slug>
  --yes, -y
${ACCOUNT_FLAGS}`,
  "routes pin": `Usage:
  benchrouter routes pin <route-key>
  benchrouter routes pin <route-key> --model <model-id> [--yes]

Without --model, shows the model the route serves, its earlier models, and whether it
can be re-pinned. With --model, re-pins it to that catalog model. Only a route with no
repository and no eval can be re-pinned, by an owner or admin. The re-pin is refused
when the route changed after this command read it (route_changed).

Options:
  --model <model-id>
  --yes, -y
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
  evals: `Usage:
  benchrouter evals list <route-key>
  benchrouter evals status <route-key> [--pr <number>]
  benchrouter evals results <route-key>
  benchrouter evals model <route-key> <model-id> [--pr <number>]
  benchrouter evals case-output <route-key> --run <model-run-id> --case <case-id>
  benchrouter evals overview
  benchrouter evals draft --name <text> --cases <cases.jsonl> --scorer <scorer.json> [--judge-model <id>] [--incumbent <id>]
  benchrouter evals draft ... --route <route-key> --parent-version <version>
  benchrouter evals approve <draft-id> --card <card-hash> [--yes]
  benchrouter evals run <route-key> --model <model-id>
  benchrouter evals run <route-key> --full-refresh
  benchrouter evals retry --result-set <id> | --route <route-key>
  benchrouter evals harness-retry <route-key> [--model <model-id>]
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
  "evals status": `Usage:
  benchrouter evals status <route-key> [--pr <number>]

Says whether the eval search of the route's production context (or of an open PR's
preview with --pr) is searching, done, waiting or owed a broad search, what happens
next and when, and each model's score, cost, p95 latency and verdict. For production
it also gives the route's eval spend and says "still running" while the search runs.
With --json, search_status.state and search_status.waiting.reason give the reason.

Options:
  --pr <number>
${ACCOUNT_FLAGS}`,
  "evals results": `Usage:
  benchrouter evals results <route-key>

Shows the route's eval results: the search status, the best available model, the
best-available chain down to the incumbent, and each measured model's pass rate,
run cost, p95 latency and verdict. --json returns every model.

Options:
${ACCOUNT_FLAGS}`,
  "evals model": `Usage:
  benchrouter evals model <route-key> <model-id> [--pr <number>]

Shows one model on a route, as the route's model page does: its result (pass rate,
cost, p95 latency), its latest run and that run's failing cases with the scorer's
reason. --pr reads an open PR's preview context. --json returns every run and
every case result.

Options:
  --pr <number>
${ACCOUNT_FLAGS}`,
  "evals case-output": `Usage:
  benchrouter evals case-output <route-key> --run <model-run-id> --case <case-id>

Prints one case's full model output as it is. An output older than 30 days is
archived and still readable here until 90 days after it was made.

Options:
  --run <model-run-id>
  --case <case-id>
${ACCOUNT_FLAGS}`,
  "evals overview": `Usage:
  benchrouter evals overview

Lists every route of the account as the dashboard lists it (repository routes and
hosted evals), with each route's eval state, and the hosted-eval drafts that wait
for approval.

Options:
${ACCOUNT_FLAGS}`,
  "evals draft": `Usage:
  benchrouter evals draft --name <text> --cases <cases.jsonl> --scorer <scorer.json>
  benchrouter evals draft ... --route <route-key> --parent-version <version>

Drafts a hosted eval: BenchRouter runs your cases on its own Worker, with no eval
pack or GitHub workflow. Prints the card to approve, with its cost estimate. A
draft spends nothing.

--cases is a JSONL file of cases (at most 250). --scorer is a JSON file with one
built-in scorer: { "builtin": "json_structure@1", "params": { "schema": { ... } } }.
The built-ins are json_structure@1, field_match@1 and judge_compare@1. A judge
scorer needs --judge-model with the same model as its params.

To change an eval, pass its route and its current version (evals results shows it).
Leave out --incumbent only when there is no app yet; BenchRouter then proposes one.

Options:
  --name <text>
  --cases <file>
  --scorer <file>
  --judge-model <id>
  --incumbent <id>
  --route <route-key>
  --parent-version <version>
  --request-id <text>   a repeat with the same id returns the same draft
${ACCOUNT_FLAGS}`,
  "evals approve": `Usage:
  benchrouter evals approve <draft-id> --card <card-hash> [--yes]

Approves a draft with the card hash that evals draft printed. Approval stores the
eval version, creates the route on the first approval and starts the first search.
BenchRouter then keeps testing new models against the eval and spends from your
balance until it runs out.

Options:
  --card <hash>
  --yes, -y
${ACCOUNT_FLAGS}`,
  "evals run": `Usage:
  benchrouter evals run <route-key> --model <model-id>
  benchrouter evals run <route-key> --full-refresh

--full-refresh runs every model of the route again with fresh cases. It spends
eval credits.

Options:
  --model <id>
  --full-refresh
  --yes, -y
${ACCOUNT_FLAGS}`,
  "evals retry": `Usage:
  benchrouter evals retry --result-set <id>
  benchrouter evals retry --route <route-key>

Reruns the failed models of one production evaluation in a new result set, or
wakes it when it is still open. --route uses the route's newest production
evaluation. Retry never clears a block; a blocked route is refused, so run
\`blocks unblock\` first. Retry a PR preview with \`evals refresh-preview\`.

Options:
  --result-set <id>
  --route <route-key>
  --yes, -y
${ACCOUNT_FLAGS}`,
  "evals harness-retry": `Usage:
  benchrouter evals harness-retry <route-key> [--model <model-id>]

Runs one model against all of the route's tests while the evaluator is paused
(EVAL-015). An accepted upload clears the block. The model defaults to the
route's best, then its baseline. It spends eval credits. Account owners only.

Options:
  --model <id>
  --yes, -y
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
  benchrouter admin catalog show|activity|model-maps|refresh-report|drain-outbox|rebuild
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
  benchrouter admin catalog drain-outbox [--limit 1..25] [--yes]
  benchrouter admin catalog observations [--source <s>] [--canonical-id <id>] [--limit <n>]
  benchrouter admin catalog observations add --source <s> --subject-kind <k> [--payload-json '{}']
  benchrouter admin catalog mappings [list]
  benchrouter admin catalog mappings resolve --source <s> --raw-source-id <id> --canonical-id <id>
  benchrouter admin catalog mappings ignore --source <s> --raw-source-id <id>

refresh-report is POST /v1/admin/catalog/refresh-report. It is report-only:
the server fetches upstream state and performs no writes.

drain-outbox publishes a bounded amount of durable catalog work. It requires a
bradm_ admin bearer and confirmation. The default and maximum limit are 25.

Options:
${ADMIN_FLAGS}  --yes, -y
`,
  "admin catalog drain-outbox": `Usage:
  benchrouter admin catalog drain-outbox [--limit 1..25] [--yes] [--json]

Publishes a bounded amount of durable catalog outbox work. The response reports
completed work, failures, budget exhaustion, and the remaining backlog. Repeat
the command when work remains. It never accepts a br_ctrl_ account token.

Options:
  --limit <n>                 Integer from 1 to 25. Defaults to 25.
  --yes, -y                   Required with --json; skips confirmation.
${ADMIN_FLAGS}`,
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
  return `  benchrouter login [--name text] [--expires-in-days 90]
  benchrouter databricks connect --host <url> --catalog <catalog> --schema <schema> [--json]
  benchrouter databricks status [--host <url>] [--all] [--json]
  benchrouter databricks add-eval <route> <folder> [--host <url>] [--json]
  benchrouter databricks disconnect [--host <url>] [--force] [--reclaim] [--results-owner <group>] [--json]
  benchrouter account show|token save [--json]
  benchrouter billing show|activity|statement [--json]
  benchrouter billing top-up --amount <usd> [--yes]
  benchrouter billing auto-reload setup|disable [--yes]
  benchrouter keys list|create|disable|enable|revoke [--json]
  benchrouter repos list|refresh [--json]
  benchrouter setup status|create|session show|approve|upgrade-token [--json]
  benchrouter routes list|show|catalog|activity|startup-failures|create|pin|archive|unarchive [--json]
  benchrouter evals list|status|results|model|case-output|overview|draft|approve|run|retry|harness-retry|refresh-preview [--json]
  benchrouter blocks list|unblock [--json]
  benchrouter public status|frontier [--json]
  benchrouter baseline set <route-key> --result-set <id> --model <id> [--yes]
  benchrouter proposals list|approve|reject [--json]
  benchrouter admin providers|catalog|keys|token [--json]`;
}
