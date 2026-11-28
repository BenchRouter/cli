# BenchRouter CLI

Use BenchRouter from a terminal. The CLI initializes a repository, checks its
integration, upgrades the generated kit, and reads route evidence.

The package is `benchrouter`. It installs the `benchrouter` command.

```bash
npx --yes benchrouter@latest --help
```

`benchrouter --version` prints the installed version. It and `doctor` also say when
npm has a newer `latest`. An installed copy does not update itself, so run
`npx --yes benchrouter@latest <command>` to use the newest CLI.

## Quick start

```bash
npx --yes benchrouter@latest login
npx --yes benchrouter@latest init --route product/route --name "Route Name" --incumbent-model provider/model
npx --yes benchrouter@latest doctor
```

To move an existing repository to the newest kit:

```bash
npx --yes benchrouter@latest upgrade
npx --yes benchrouter@latest doctor --full
```

`login` authorizes the CLI once in your browser. After that, `init`, `upgrade`,
`doctor` and the read commands use the login; no setup key or upgrade token is
needed. `doctor` and `upgrade` end with one line that says what is left, for example
`Done: kit 0.1.0 · 3 routes OK · nothing left to do`.

## Initialize a repository

Run `init` from the repository that will use BenchRouter:

```bash
npx --yes benchrouter@latest init \
  --route product/route \
  --name "Route Name" \
  --incumbent-model provider/model
```

`init` uses your login (`benchrouter login`) for a repository that already has a
BenchRouter group. The first route of a repository with no group needs a setup key
from `benchrouter setup create --repo owner/repo --yes`; a login-only init there stops
with `repo_not_found`. `init` needs `--repo owner/repo` when
the current directory has no GitHub remote. A setup key from the BenchRouter setup
page also works: pass `--setup-key br_setup_...` or set `BENCHROUTER_SETUP_KEY`.
An explicit setup key is used instead of the login. `--route` takes the route key;
`--route-id` is its deprecated old name and prints a note.

Pass `--eval-command "pnpm run test:customer"` only when an existing customer
test command is used for local capture. Without it, setup emits no
`capture_command`. The signed CI runtime command is separate.

For a direct-provider incumbent, also pass `--provider-id <id>` and
`--provider-ref <exact-ref>`. Pass both or neither.

Pass `--base-url-env <NAME>` with the environment variable the call site reads
for its LLM base URL, and `--api-family <family>` with the protocol the call
site speaks: `openai_chat_completions`, `anthropic_messages`, or
`openai_responses`. The family chooses the BenchRouter base URL value, not the
variable's name: a native Anthropic Messages call site gets
`https://api.benchrouter.com`, because the Anthropic SDK adds `/v1/messages`,
and the OpenAI families get `https://api.benchrouter.com/v1`. `--api-family` is
required for a route that sets `--base-url-env` or `--eval-pack`. Repeat either
option once per `--route`, in the same order, or pass it once for all routes.
The CLI sends both as the route's `call_site`, and setup records them in
`.benchrouter/benchrouter.yml`. For a route that is already in that file, init
keeps the local entry and writes only the `--api-family` you pass into its
`call_site.api_family` (and into a repository-executable eval's `api_family`).

BenchRouter preserves that exact observed tuple during setup. If the canonical
incumbent cannot serve, `init` stops and lists only replacements backed by
catalog evidence. The CLI prints the browser approval page. A signed-in GitHub
user with repository write access selects the replacement there. Then rerun the
exact same `init` command unchanged. The server binds the browser approval to
the setup session, route, exact observed model, provider, provider reference,
and offered options. An unknown identity stops for catalog review. It does not
become a free-form model selection.

### Repository-executable evals

If quality depends on the repository's full pipeline, pass one validated JSON
eval pack for each route. Repeat `--eval-pack` in the same order as `--route`:

```bash
benchrouter init ... --eval-pack .benchrouter/contextual-synopsis-eval.json
```

The file must use this contract:

```json
{
  "mode": "repository_executable",
  "id": "contextual_synopsis_v1",
  "config_path": ".benchrouter/benchrouter.yml",
  "workflow": ".github/workflows/benchrouter-evals.yml",
  "result_schema": "benchrouter.executable_result.v1",
  "case_refs": ["eval/queries.json"],
  "argv": ["node", "eval/contextual-synopsis.mjs"],
  "runtime": "node",
  "runtime_version": "22.18.0",
  "lockfile": "package-lock.json",
  "input_refs": ["eval/queries.json", "eval/corpus.json"],
  "acceptance_refs": ["eval/contextual-synopsis.mjs", "eval/qrels.json"],
  "result_path": ".benchrouter/executable-result.json",
  "primary_metric": "recall_at_5",
  "timeout_minutes": 60,
  "secret_env": ["OPENAI_API_KEY"]
}
```

The eval pack has no `command` and no `scorer`: the runtime runs `argv` and
reads the result file at `result_path`. The CLI rejects a pack that declares
either one.

The eval pack has no `api_family`. It inherits the route's `--api-family`, so
pass the family of the call site the evaluator exercises. The CLI rejects a pack
that declares its own.

The `lockfile` is `package-lock.json`, `npm-shrinkwrap.json` or `pnpm-lock.yaml`
for runtime `node`, and `bun.lock` or `bun.lockb` for runtime `bun`.

Four fields are optional:

- `working_directory`: the repository-relative directory where `argv` runs, such
  as `apps/web`. Leave it out for the repository root; `.` is refused. The
  `lockfile` is relative to this directory and may name a parent directory's
  lockfile, such as `../../pnpm-lock.yaml`; the install runs in the lockfile's
  directory. `result_path`, the refs, `config_path` and `workflow` stay relative
  to the repository root.
- `isolation`: `process` (the default) or `job`. Use `job` when the evaluator
  starts children that leave its process group, for example containers started
  through a Docker daemon.
- `artifacts`: files the evaluator writes that you want to keep from each model
  run, as repository-relative paths or globs (`*`, `**`, `?`), for example
  `"artifacts": [".benchrouter/composer-drafts.json", "out/drafts/**"]`. The runtime
  copies them into your repository's GitHub Actions artifacts; they never go to
  BenchRouter. At most 16 entries; each run keeps at most 32 files and 8 MiB per
  model. Linux runners only. The files need not exist when you run init.
  `evals status` shows each model's artifacts link when there is one.
- `runtime_version`: informational only. The job's `node` or `bun` runs, and the
  runtime records its version. When present, it must be an exact version.

`primary_metric` uses lowercase letters, digits and underscores, and starts with
a letter. `case_refs`, `input_refs` and `acceptance_refs` may not list a file
twice, and no file may be in both `input_refs` and `acceptance_refs`:

- `input_refs` are the data the evaluator reads: fixtures, prompts, scenarios.
  BenchRouter hashes them into the route's input fingerprint, together with the
  command, lockfile and code refs. A change to any of them starts a new input
  identity, so earlier model results are not reused.
- `acceptance_refs` are the files that decide what counts as good. BenchRouter
  hashes them, with the primary metric, into the acceptance fingerprint. A change
  to any of them redefines quality, so earlier scores are not comparable and the
  models are measured again.
- The evaluator program belongs in `acceptance_refs` when it contains the checks.
  Keep fixtures and other data it reads in `input_refs`.

The CLI rejects mutable runtime versions, unsafe paths, missing referenced
files, invalid or reserved secret names, fractional timeouts, and timeouts above
90 minutes before it sends the setup request. The eval pack declares no call or
spend limit: BenchRouter bounds each executable run's spend itself, at five
times the route baseline's measured spend on the same eval, with no floor.
Before the first reference run there is no measured spend, so only
`timeout_minutes` bounds that run. The CLI rejects `max_model_calls`, `max_cost_usd` and
`max_cost_per_call_usd` as unknown fields. The generated workflow runs `argv` without a shell. It receives only
the declared customer secrets and the scoped BenchRouter eval contract.

A setup key, when you use one, comes from the signed-in BenchRouter setup page. It
is scoped to one GitHub repository. A successful setup can return one runtime key:
`BENCHROUTER_API_KEY`. Install that key only in the application host. If it is
lost, create a replacement at https://benchrouter.com/keys.

BenchRouter Evals does not use a stored GitHub Actions key. The generated
workflow uses GitHub OIDC with `id-token: write` to get a short-lived eval token.
Do not create `BENCHROUTER_EVAL_API_KEY`.

The read commands (`status`, `frontier`, `failures`, `explain`) use your login,
like `init`. Without a login they accept the repository's setup key: `init` does
not save it by default. Pass `--save-token`, or approve the interactive prompt, to
keep it for this repository on the current computer, or keep
`BENCHROUTER_SETUP_KEY` set.

The generated files include `.benchrouter/SETUP_README.md`. Read that file
before changing the call site, eval cases, or scorer.

## Multiple routes

Repeat `--route`, `--name`, and `--incumbent-model` in the same order:

```bash
benchrouter init \
  --route product/route-a --name "Route A" --incumbent-model provider/model-a \
  --eval-pack eval/route-a-pack.json \
  --route product/route-b --name "Route B" --incumbent-model provider/model-b \
  --eval-pack eval/route-b-pack.json
```

Each runtime call site uses its stable route ID as the OpenAI-compatible `model`
value. Do not create one global model variable for a repository with several
routes. If any route uses `--eval-pack`, every route in that init command must
have one positionally matching file.

## Upgrade

`upgrade` previews the workflow, the `benchrouter:` package script values,
the `.benchrouter/.gitignore` lines, and the removal of a committed legacy
`.benchrouter/bootstrap.mjs` and `.benchrouter/trust.json`, and the removal of an
old `benchrouter:eval` script that ran `bootstrap.mjs run`, asks for
confirmation, then applies them. It leaves `.benchrouter/README.md` alone; only
`init` writes it. It edits the script values in `package.json` in place, so the
file keeps its other bytes, key order and indentation, and no empty
`devDependencies` appears. It preserves `.benchrouter/benchrouter.yml`
byte-for-byte. That YAML is the single route declaration. Upgrade validates
each file hash before it writes any file. It preserves customer setup steps
between the prepare step and Run BenchRouter, customer steps after Run BenchRouter,
and customer comments. A workflow from before the eval action migrates to the
stub with its setup steps, post steps, `runs-on`, and comments. Each customer step must use
`if: github.event_name == 'workflow_dispatch'`; upgrade keeps each step as it is
and does not add the condition, so a setup step without it stops the upgrade with
no change. It keeps the eval job's
`runs-on`, so a job moved to self-hosted runners stays there; `doctor` accepts
any `runs-on` label, label list, or `group`/`labels` object. It never replaces cases,
scorers, calibration fixtures, setup guides, or app files. Old generated-engine
installations must be removed and re-onboarded; they have no compatibility path.

```bash
benchrouter upgrade --repo owner/repo
```

The kit is repo-wide, so `upgrade` takes no route. It needs `benchrouter login`.
When BenchRouter reports your GitHub access stale, it refreshes the access with the
login and retries once; if that fails it prints
`npx --yes benchrouter@latest repos refresh`. Use `--dry-run` to preview without
applying. Use `--yes` only when an interactive confirmation is not possible. When
every file already matches, upgrade changes nothing and prints
`Done: kit <version> · <n> routes · nothing left to do`. Otherwise its last line
lists what is left: commit the changed files, run doctor, open the PR.

## Doctor

`doctor` checks the generated files, package-script wiring, and the GitHub OIDC
workflow. Activation mode also checks the selected runtime call site. For isolated replay, it also checks
runnable case arrays and scorer syntax. For `repository_executable`, it checks
that the declared lockfile, case, input, and acceptance refs exist. It does not
apply isolated-replay JSON shapes or scorer execution to repository files.

The runtime checklist uses the route's `call_site.base_url_env` and
`call_site.api_family`. It prints `https://api.benchrouter.com/v1` for the OpenAI
families and `https://api.benchrouter.com` for `anthropic_messages`, because the
Anthropic SDK adds its own `/v1/messages` path. A route without
`call_site.api_family` gets no value; the checklist names the missing field.

`doctor` defaults to evaluation checks. It does not require production wiring or a runtime key and never implicitly makes a provider call. Use `--phase activation --route product/route` to check one selected call site.

Both phases send the exact `.benchrouter/benchrouter.yml` text to the read-only
server manifest check when the repo is known. Doctor prefers your account login
(`--account-token`, `BENCHROUTER_ACCOUNT_TOKEN`, or saved login), then uses the
repo setup key (`--setup-key`, `BENCHROUTER_SETUP_KEY`, or `init --save-token`).
Runtime and admin keys cannot authenticate this check. Manifests over 256 KiB
fail locally. Server manifest errors fail doctor; checks the server did not run
are skipped. Missing credentials or a network/server failure produce a skipped
check. Rejected credentials fail with instructions to log in or use the repo's
setup key. `--route` also filters the server check.

Add `--live-chat-completions` only to opt into a billable synthetic Chat Completions diagnostic. An inherited `BENCHROUTER_API_KEY` alone does not opt in. This diagnostic does not verify the application request contract; use an authorized application smoke for that. Native Anthropic and Responses calls need their own application smoke.
It labels each external check as passed, failed, or skipped. A doctor pass only
means that every check that ran passed. It does not certify evaluation quality
or production readiness. Local calibration does not provide that certificate.

Doctor marks each skipped check that matters for this repo as
`doctor skipped (matters for this repo):`, with what runs it. Other skipped lines,
such as activation-only checks in the evaluation phase, need nothing. `doctor --full`
runs every check that costs nothing: it adds the default-branch check and reads the
server's production readiness with your login. Under `--full`, a check that cannot
run fails instead of being skipped, and `--skip-github-workflow` is refused.
`--full` never makes the billable `--live-chat-completions` request. The last line
is `Done: kit <version> · <n> routes OK · nothing left to do`, or `Left to do:`
followed by the remaining items.

`doctor --full` and `benchrouter setup status --repo owner/repo` read
the server's separate route-registration, evaluation, production-eligibility,
and observed-serving facts. A route the server has not registered fails `--full`. Evaluation completion is not a production
eligibility gate. Observed serving is historical delivery evidence, not a
current health check.

```bash
benchrouter doctor --repo owner/repo --skip-github-workflow
benchrouter doctor --full
benchrouter doctor --phase activation --route product/route --repo owner/repo --check-default-branch
```

Use `--skip-github-workflow` when `gh` is unavailable or the workflow does not
exist on the default branch yet.

## Signed runtime commands

Run these commands from the repository with the generated kit:

```bash
benchrouter capture
benchrouter calibrate
```

The CLI carries the signed runtime bootstrap and its trust file. Before each
command it writes them to `.benchrouter/bootstrap.mjs` and `.benchrouter/trust.json`
in the repository, then runs the bootstrap. `.benchrouter/.gitignore` lists both
files, so they are never committed. The bootstrap verifies the signed release
before it starts. Neither command takes flags, and neither proves production
readiness. `--help` on either writes no file.

- `capture` starts a proxy on `127.0.0.1` on a free port. It prints the address and
  writes the port to `.benchrouter/sidecar.port`. Leave it running and run the
  application tests in another shell with the call site's base URL variable set to
  `http://127.0.0.1:<port>/v1` (OpenAI families) or `http://127.0.0.1:<port>`
  (`anthropic_messages`). It needs `BENCHROUTER_API_KEY` (the runtime key). Each
  call is a real BenchRouter model call and spends your balance; it does not count
  as production traffic. It records the calls in `.benchrouter/cases.<route>.json`.
  Stop it with Ctrl-C.
- `calibrate` makes no model calls and costs nothing. It needs network access to
  fetch the signed runtime and check its release status. It checks each route's scorer
  against the route's reference outputs and `.benchrouter/calibration.<route>.json`.
  Set `BENCHROUTER_ROUTE_ID` to check one route.
- `benchrouter run` is for GitHub Actions only: it needs the job's OIDC token. The kit's `benchrouter:capture` and
`benchrouter:calibrate` scripts run `npx --yes benchrouter@latest capture` and
`calibrate`.

The generated workflow is a short stub. Its `benchrouter_prepare` step uses
`BenchRouter/eval-action/prepare@v1`, and its `benchrouter_runtime` step uses
`BenchRouter/eval-action@v1` with the same ref. A team that pins strictly can
replace `v1` in both steps with one full commit SHA; `doctor` accepts either.
The action carries the bootstrap and trust file in CI. `benchrouter run` uses the
same bootstrap and requires GitHub Actions OIDC. The workflow uses one Node 24 job
with a 120-minute ceiling. It grants evaluator secrets and customer setup only to
server-dispatched work. The trust file carries current and next signing keys, with
digest pins empty.

## Commands

```bash
benchrouter init --help
benchrouter upgrade [--repo owner/repo]
benchrouter doctor [--full]
benchrouter models [--filter text] [--json]
benchrouter status [--repo owner/repo] [--json]
benchrouter frontier <route-key> [--repo owner/repo] [--json]
benchrouter failures <route-key> [model] [--repo owner/repo] [--json]
benchrouter explain <model> [--route <route-key>] [--repo owner/repo] [--json]
benchrouter login [--name text] [--expires-in-days 90]
benchrouter feedback [--kind question|doc_gap|bug|other] [--json] "<message>"
benchrouter account show [--json]
benchrouter account token save --account-token br_ctrl_...
benchrouter billing show|activity|statement [--json]
benchrouter billing top-up --amount 25 [--yes]
benchrouter billing auto-reload setup --threshold <usd> --amount <usd> | disable
benchrouter keys list [--product-id <id>]
benchrouter keys create|disable|enable|revoke
benchrouter repos list|refresh
benchrouter setup status [--repo owner/repo]
benchrouter setup create [--repo owner/repo] [--intent initial|new_route]
benchrouter setup session show <session-id>
benchrouter setup approve <approval-id|approval-link> [--model <model-id>] [--yes]
benchrouter routes list [--repo owner/repo]
benchrouter routes show|catalog|activity|startup-failures|create|pin|archive|unarchive
benchrouter evals list|run
benchrouter evals status <route-key> [--pr <number>]
benchrouter evals results <route-key> [--pr <number>]
benchrouter evals model <route-key> <model-id> [--pr <number>]
benchrouter evals case-output <route-key> --run <model-run-id> --case <case-id>
benchrouter evals overview
benchrouter evals draft --name <text> --cases <cases.jsonl> --scorer <scorer.json>
benchrouter evals approve <draft-id> --card <card-hash> [--yes]
benchrouter evals run <route-key> --full-refresh
benchrouter evals retry --result-set <id> | --route <route-key>
benchrouter evals harness-retry <route-key> [--model <id>]
benchrouter evals refresh-preview <route-key> <result-set-id> [--model <id>]
benchrouter blocks list [--repo owner/repo]
benchrouter blocks unblock --repo owner/repo [--route <route-key>] | --route <route-key> | --all-blocked
benchrouter public status|frontier [--json]
benchrouter baseline set <route-key> --result-set <id> --model <id> [--yes]
benchrouter databricks connect|status|add-eval|disconnect
```

A route is always named by its route key, such as `product/route`: as a positional
`<route-key>` or as `--route <route-key>`. `routes archive` and `routes unarchive`
take the same key. When several archived routes share a key, `unarchive` lists them;
pass the archived route's id from `routes list`. A route key names one route across
the account, so the `routes` and `evals` commands need no `--repo`. The repository
reads (`status`, `frontier`, `failures`, `explain`) take `--repo`, or use the current
git remote.

`benchrouter --help` lists the customer commands. The BenchRouter-internal
`proposals` and `admin` commands need a `bradm_` admin token and appear only under
`benchrouter --help --all`:

```bash
benchrouter proposals list|approve|reject [--admin-token bradm_...]
benchrouter admin providers|catalog|keys|token [--admin-token bradm_...]
benchrouter admin catalog show|activity|model-maps|refresh-report|drain-outbox|rebuild
benchrouter admin catalog observations [add]|mappings [list|resolve|ignore]
benchrouter admin keys list|revoke [--admin-token bradm_...]
```

Run `benchrouter login` to authorize the CLI in your signed-in browser. The CLI
keeps the verifier locally, waits for approval, receives the new `br_ctrl_`
token directly, saves it in private local config, and proves the selected
account. The browser URL contains only an opaque transaction ID. The raw token
never appears in the URL, browser storage, terminal output, or logs.

Account commands authenticate with a `br_ctrl_` account token
(`--account-token`, then `BENCHROUTER_ACCOUNT_TOKEN`, then private local
config). A command that needs it and finds none prints
"Not signed in. Run `npx --yes benchrouter@latest login`". Proposal/admin
commands use a `bradm_` admin token (`--admin-token`, then
`BENCHROUTER_ADMIN_TOKEN`, then private local config). `init` and the repo-read
commands use the account login, or a repository setup key when one is passed.
Runtime API keys never authorize control-plane commands.

Mutations print their plan (`Plan: <action>: <details>`) and then prompt unless
`--yes`. A shell that cannot answer a prompt, and JSON mode, print the plan,
change nothing and ask you to rerun with `--yes`. If another eval already holds
the route (409 `route_context_busy`), the CLI names the open result set and,
when BenchRouter knows it, the time it expects that eval to finish. Billing top-up prints a checkout URL; it
does not open a browser. `billing show` reads billing fields from
`GET /v1/dashboard/summary`.

Create a pinned route in a new group or an existing group with no repository:

```bash
benchrouter routes create --name Triage --model anthropic/claude-haiku-4.5 --group Support --group-slug support --route-slug triage --yes
benchrouter routes create --name Triage --model anthropic/claude-haiku-4.5 --group-id <id> --yes
```

Pass exactly one of `--group <name>` or `--group-id <id>`. `--group-slug <slug>`
requires `--group`. Slugs default to the names. Creating a new group requires an
account owner. The request sends `group: {name, slug?}` or `group_id`.
The response keeps the internal `product` field and reports `group_created`.
To create a runtime key for the group, use `benchrouter keys create --product-id <id>`.
That endpoint still requires `product_id`.

`status` shows each route, incumbent, current best model, production wiring state,
latest eval state, and production result-set ID. Use `status --json` when an agent
or script must prove that the route has received a production call and identify
the exact evidence used in production.

`frontier` shows the incumbent, best model, and ranked alternatives.

`failures` shows failed cases from the latest model run. Pass a model ID to
select the latest run for that model.

`explain` calls the server model-explanation endpoint and states whether a model
is the incumbent, best pick, an eligible alternative, or outside the eligible
frontier. Pass `--route` when a repository has more than one route.

`keys revoke <key-id>` calls `POST /v1/dashboard/api-keys/:keyId/revoke` and
prints non-secret key metadata. Revocation is immediate: any application still
using that key stops authenticating.

A group can have several active runtime keys at once, so a rotation has no
downtime: `keys create --product-id <id>`, deploy the new key, then
`keys disable <old-key-id>` (`keys enable` undoes it), then `keys revoke` when
nothing uses the old key. `keys create --yes --json` prints the secret once as
`api_key.key`. `--yes` skips the confirmation of `create`, `disable`, `enable` and
`revoke`. `keys list --product-id <id>` lists one group's keys.

`setup create` starts a setup session and prints a one-time setup code plus an
`npx --yes benchrouter@latest init` command. With `--yes --json`, stdout contains
one JSON object with the session, setup code, command, and agent prompt.
The setup code is printed once and never saved; pass it to `init --setup-key`.
`setup create` looks up the repository ID and the GitHub App installation ID for
`--repo` (or the current git remote) from your synced GitHub access, as
`repos list` shows them. If the repository is missing, run `repos refresh` or
open the BenchRouter setup page once, or pass `--repository-id` and
`--installation-id` yourself.

To add a route to a repository that already has BenchRouter:

1. Sign in with `benchrouter login`.
2. Rerun `init` with the new route's `--route`, `--name` and
   `--incumbent-model` (plus `--eval-pack`, `--api-family` and `--base-url-env`
   when the route needs them). `init` adds the route to `benchrouter.yml` and
   keeps the existing routes. (`benchrouter setup create --intent new_route`
   still prints a one-time setup key for a run without a login.)
3. Commit the changes and open a pull request.

`blocks list` prints one line per block that stops evaluations: its kind, scope,
time, whether Unblock clears it, and how to clear it. `blocks unblock` (account
owners) clears BenchRouter's own breakers (`startup_failing`,
`snapshot_refresh_failing`, `harness_failing`) and re-checks `workflow_missing`
and `installation_revoked` against GitHub. Queued evaluations restart through
the normal dispatcher; Unblock creates no evaluation and reruns no model.
`evals retry` reruns the failed models of one production evaluation, or wakes it
when it is still open. Retry never clears a block, so a blocked route is
refused until you unblock it.

`evals refresh-preview` re-dispatches an open-PR preview result set. The result
set must be a PR preview; pass `--model` to refresh one model only.

`admin catalog refresh-report` is `POST`, not `GET`. It is report-only: the
server fetches upstream state and performs no writes.
`admin catalog drain-outbox [--limit 1..25]` publishes a bounded amount of
durable catalog work and reports both completed work and the remaining backlog.
It is an admin mutation, so it requires a `bradm_` token and confirmation (or
`--yes`). A `br_ctrl_` account token cannot authorize it.
`admin catalog observations add` records a manual notice; pass structured fields
through `--payload-json`, which must parse to a JSON object.

`admin keys list` and `admin keys revoke <key-id>` accept a `bradm_` bearer and
print non-secret metadata only. Minting an admin key requires a browser GitHub
admin session, so the CLI has no mint command. Use `admin token save` /
`account token save` for already-minted tokens. Save commands never print the
secret. Use `account token save` only as a recovery path. Use `benchrouter
login` for normal account authorization.

All read commands accept `--json` for scripts and agents.

## Credentials and configuration

`init` and the read commands resolve credentials in this order:

1. `--setup-key br_setup_...`
2. `--account-token br_ctrl_...`
3. `BENCHROUTER_SETUP_KEY`
4. `BENCHROUTER_ACCOUNT_TOKEN`, then the login that `benchrouter login` saved
5. the setup key that `init --save-token` saved for the detected or specified
   repository

With the login, the read commands name the repository in a `repo_full_name`
query parameter, because one login covers every repository you can see.

Saved credentials are isolated by repository (and account/admin files are
owner-only mode `0600`). Set `BENCHROUTER_CONFIG_DIR` to move the entire
configuration root. Tests and automation should always set this variable to a
temporary directory.

The CLI does not write runtime keys to disk. It never saves a setup token unless
the user approves the write.

## Model IDs

`models` prints the current BenchRouter catalog. A route incumbent can be an
exact OpenRouter model that is not an automatic candidate. If BenchRouter cannot
resolve the incumbent identity, stop for catalog review. Do not substitute a
model or remove the observed provider metadata. If a resolved incumbent cannot
serve, open the server-provided browser approval page. Then rerun the exact same
`init` command unchanged.

`init` prepares evaluation files and refreshes the generated BenchRouter workflow so added routes receive their declared triggers and executable secret mappings. It preserves production call sites and existing env examples. Add the runtime key and endpoint configuration in the later activation patch.

## Connect Databricks

Install the Databricks CLI and use an OAuth workspace-admin login:

```bash
benchrouter login
databricks auth login --host https://<workspace>.cloud.databricks.com
benchrouter databricks connect \
  --host https://<workspace>.cloud.databricks.com \
  --catalog workspace --schema <schema> --warehouse <warehouse-id>
```

Both a user OAuth login (U2M) and a service principal OAuth login (M2M) are
supported. For M2M, configure the Databricks CLI with the admin service principal's
client id and client secret. Connect reads the credentials into memory and obtains
an access token from the workspace. It refreshes either login when fewer than
five minutes remain. The client secret and login tokens never reach BenchRouter.

Connect needs an owner or admin role in the BenchRouter account. The catalog and
schema must exist. Omit `--warehouse` to use the only serverless warehouse.
With several warehouses, choose one on a terminal or pass its id. Add
`--results-group <group>` and `--manage-group <group>` to share results and management
with account groups. Use `--json` for a secret-free machine result. Existing
`--api-url`, `--account-token`, and saved login settings apply.

The Databricks login token stays in process memory on your machine. BenchRouter
receives only a fresh identity-only workspace proof. Connect writes the poll key
to Databricks before grants. A repeated Connect reuses the recorded SP and job ids.
It resets the job ACL. Under `restrict_workspace_admins`, the connecting admin
owns the job and the agent SP gets `CAN_MANAGE`. Removing that admin can stop the job.

Exit codes: `3` means a refused initial grant or heal and names the owners, `4` means
`workspace_admin_required`, and `5` means a PAT login. Use OAuth to replace a PAT.
Other errors exit with `1`. Connect waits up to three minutes for a successful agent
run, binding verification, and five expected setup rows to exist and be done:
volumes `<catalog>.<schema>.benchrouter_artifacts` and
`<catalog>.<schema>.benchrouter_results`, results table
`<catalog>.<schema>.benchrouter_eval_results`, experiment
`/Shared/benchrouter/<binding_id>`, and eval job `benchrouter-eval-<binding_id>`.
The catalog and schema are this Connect's `--catalog` and `--schema` values.
Volume and results-table targets match without regard to case. Experiment and eval-job
targets must match exactly.
The binding read gives each object's current state. An older done row can satisfy
completion. A re-queued row reads pending and keeps Connect waiting.
Pending serving endpoints do not block completion. Any failed setup row stops the command
and reports its title, message, and owner. A `customer` owner requires a workspace
admin to fix it. A timeout names the expected rows that are missing or incomplete.
The JSON result includes `setup_items`, with `kind`, `target`, and `state` for each
item. Human output prints one line per item.

After grants and heal, Connect runs every pending SP-change grant, then every
pending revoke from the server's `cleanup_pending`. It acknowledges completed or
absent steps once. A refused SP-change step stays pending. Missing folders, manifests,
objects and tables count as done. An invalid manifest, reserved secret scope or
undeclared route keeps the grant or revoke pending with a warning. Its `pending_steps`
entry includes the reason. Fix the manifest and run Connect again.
Connect continues through job creation and verification and exits `0` when setup succeeds.
Permission warnings name the step and its owner. Re-run `benchrouter databricks connect` as that owner or a
metastore admin. JSON includes refused steps in `pending_steps`, with `kind`, `id`,
`action`, `object`, `target`, and `owner`. A retry resumes steps even when
`sp_change` is null.

Read workspace state, attach an eval, or disconnect:

```bash
benchrouter databricks status --host https://<workspace>.cloud.databricks.com --json
benchrouter databricks add-eval support/triage /Shared/evals/triage --host https://<workspace>.cloud.databricks.com
benchrouter databricks disconnect --host https://<workspace>.cloud.databricks.com
benchrouter databricks disconnect --host https://<workspace>.cloud.databricks.com --force --json
benchrouter databricks disconnect --host https://<workspace>.cloud.databricks.com --reclaim --json
```

All four commands support `--json`. Status is available to any account member.
By default, it lists open bindings and closed bindings with nonempty `cleanup_pending`.
Pass `--all` to show every matching binding, including archived and disconnected
bindings without leftovers. Text and JSON use the same selection. Each binding includes
state, check-in, cadence, agent SP, routes, exposures, eval folders, grants, setup items,
failures and the server's exact cleanup
instructions and commands. JSON always has the shape `{bindings: [<server read>, ...]}`.
Each entry is the full server read after any cleanup acknowledgement. With no
matching bindings, it returns `{bindings: []}`. Text shows agent and eval job
links to their Databricks job pages, where admins can inspect the last runs.

Status needs no Databricks login. When an OAuth login is available, status checks
pending workspace objects. It reports objects that are gone to the cleanup endpoint
and reads the binding again. An account member can still read status if the server
refuses that acknowledgement. Account-console SP steps stay pending; a workspace
SCIM read cannot prove that an account SP was deleted. Status shows pending
grant/revoke instructions, actions and targets in Leftovers. It never runs or acknowledges those steps. Status never reads secret values.
With a login, status also reads the agent job ACL. If its owner is a user, status
warns on stderr that removing that user stops the job under
`restrict_workspace_admins`. This warning does not change the JSON server reads.

Add-eval and disconnect need an account owner/admin and a Databricks workspace-admin
OAuth login. With several workspaces, pass `--host`. Add-eval attaches the route and
folder only after checking the workspace admin, reading the folder, and exporting
and validating the YAML manifest. It then grants folder `CAN_READ` with PATCH and
grants the agent SP `SELECT` on its cases table. It also grants `USE_CATALOG` and `USE_SCHEMA`
when those namespaces differ from the binding. It uses the runner's validation rules
for the manifest fields it reads. It prints one `databricks secrets put-acl ... READ`
command for each declared scope and starts the recorded agent job. No secret value is
accepted. The server refuses routes with repository or hosted evals.

Before requesting closure, Disconnect runs pending SP-change grants and revokes
for the open binding, including with `--force`. Refusals warn and stay pending.
Disconnect requests closure and starts the recorded agent job. It waits up to three
minutes for `archived` or `disconnected`, then checks and deletes the closed binding's
recorded objects. It polls the binding every two seconds. Before deleting, it
reads the open-binding list once and each other open binding once. It preserves
ids they hold. `--force` closes at once and runs only that binding's server cleanup steps as
the admin. Jobs, secret scopes, serving endpoints, manageable provider services and
the two working volumes are removed. The results table and experiment remain.
The agent SP remains for an account admin to remove in the account console.
Unmanageable objects retain their cleanup instructions. Successful cleanup is
acknowledged with `{done: [{kind, id}]}`. Repeating disconnect can resume cleanup
for a closed binding without another disconnect request or agent run.

`--reclaim` needs `--host`. It creates a fresh identity-only proof and closes the
holding binding without requiring a role in its BenchRouter account. It reads no
holding binding. It removes only the returned endpoints and manageable provider
services. It cannot use `--force` or `--results-owner`.

`--results-owner <group>` sends `results_owner: {type: "group", name: <group>}`.
Without the flag, the field is omitted and the results table and experiment stay
with the agent SP. The server rejects string principals with `invalid_results_owner`.

These commands require the H1/H2 headless server contract.
For local replay tests only, `BENCHROUTER_DATABRICKS_API_BASE` redirects Databricks
REST calls to a loopback HTTP server. Keep it unset for real workspace setup.
New SP rule-set GET and PUT requests retry permission propagation failures with
up to six tries with 2, 4, 8, 16 and 30 second waits shared across both calls (60 seconds total).
Only 403 or `PERMISSION_DENIED` failures retry, and only for an SP created in the current run.
Recorded SP reads do not retry.
For tests only, `BENCHROUTER_DATABRICKS_TEST_RULE_RETRY_MS` (0 to 100) shortens
those waits when the loopback replay override is active.
If workspace discovery does not return the Databricks account id, set
`DATABRICKS_ACCOUNT_ID` to that id and retry.
