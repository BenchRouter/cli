# BenchRouter CLI

Use BenchRouter from a terminal. The CLI initializes a repository, checks its
integration, upgrades the generated kit, and reads route evidence.

The package is `@benchrouter/cli`. It installs the `benchrouter` command.

```bash
npx @benchrouter/cli --help
```

## Initialize a repository

Run `init` from the repository that will use BenchRouter:

```bash
npx @benchrouter/cli init \
  --setup-key br_setup_... \
  --route-id product/route \
  --name "Route Name" \
  --incumbent-model provider/model
```

For a direct-provider incumbent, also pass `--provider-id <id>` and
`--provider-ref <exact-ref>`. Pass both or neither.

The setup key comes from the signed-in BenchRouter setup page. It is scoped to
one GitHub repository. A successful setup can return one runtime key:
`BENCHROUTER_API_KEY`. Install that key only in the application host.

BenchRouter Evals does not use a stored GitHub Actions key. The generated
workflow uses GitHub OIDC with `id-token: write` to get a short-lived eval token.
Do not create `BENCHROUTER_EVAL_API_KEY`.

By default, `init` does not save the setup token. Pass `--save-token`, or approve
the interactive prompt, to keep repo-scoped read access on the current computer.
For non-interactive use, set `BENCHROUTER_TOKEN` instead.

```bash
npx @benchrouter/cli init ... --save-token
```

The generated files include `.benchrouter/SETUP_README.md`. Read that file
before changing the call site, eval cases, or scorer.

## Commands

```bash
benchrouter init --help
benchrouter upgrade --help
benchrouter doctor
benchrouter models [--filter text] [--json]
benchrouter models show <route-key> <model-id> [--account-token br_ctrl_...] [--json]
benchrouter status [--json]
benchrouter frontier <route-key> [--json]
benchrouter failures <route-key> [model] [--json]
benchrouter explain <model> [--route <route-key>] [--json]
benchrouter account show [--json]
benchrouter account token save --account-token br_ctrl_...
benchrouter billing show [--json]
benchrouter billing top-up --amount 25 [--yes]
benchrouter keys list|create|revoke
benchrouter repos list
benchrouter setup status [--repo owner/repo]
benchrouter setup create --repository-id <id> --installation-id <id> [--intent initial|new_route]
benchrouter setup session show <session-id>
benchrouter setup upgrade-token --route-id <id> [--repo owner/repo]
benchrouter routes list|show|catalog|archive|unarchive
benchrouter evals list|run|failures
benchrouter evals refresh-preview <route-key> <result-set-id> [--model <id>]
benchrouter baseline set <route-key> --result-set <id> --model <id> [--yes]
benchrouter proposals list|approve|reject [--admin-token bradm_...]
benchrouter admin providers|catalog|keys|token [--admin-token bradm_...]
benchrouter admin catalog show|activity|model-maps|refresh-report|drain-outbox|rebuild
benchrouter admin catalog observations [add]|mappings [list|resolve|ignore]
benchrouter admin keys list|revoke [--admin-token bradm_...]
```

Account commands authenticate with a `br_ctrl_` account token
(`--account-token`, then `BENCHROUTER_ACCOUNT_TOKEN`, then private local
config). Proposal/admin commands use a `bradm_` admin token
(`--admin-token`, then `BENCHROUTER_ADMIN_TOKEN`, then private local config).
Repo-read commands keep using the setup/read token. Tokens are never
auto-substituted across scopes. Runtime API keys never authorize control-plane
commands.

Mutations print an exact action summary and prompt unless `--yes`. JSON mode
never prompts and requires `--yes`. Billing top-up prints a checkout URL; it
does not open a browser. `billing show` reads billing fields from
`GET /v1/dashboard/summary`.

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

`setup create` starts a setup session and prints a one-time setup code plus the
server-authored `init` command. `setup upgrade-token` mints a single-use
`br_upgrade_` token and prints it once. Both secrets are printed once and never
saved; pass them to `init --setup-key` and `upgrade --upgrade-token`. Read
`repository_id` and `installation_id` from `repos list`.

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
secret.

All read commands accept `--json` for scripts and agents.

## Credentials and configuration

Read commands resolve credentials in this order:

1. `--token br_setup_...`
2. `BENCHROUTER_TOKEN`
3. the saved token for the detected or specified repository

Saved credentials are isolated by repository (and account/admin files are
owner-only mode `0600`). Set `BENCHROUTER_CONFIG_DIR` to move the entire
configuration root. Tests and automation should always set this variable to a
temporary directory.

The CLI does not write runtime keys to disk. It never saves a setup token unless
the user approves the write.

## Doctor

`doctor` checks the generated files, runnable eval cases, scorer syntax,
package-script wiring, runtime call-site wiring, and the GitHub OIDC workflow.
It can also make one real proxy call when `BENCHROUTER_API_KEY` is present.

```bash
benchrouter doctor --repo owner/repo --skip-github-workflow
BENCHROUTER_API_KEY=br_live_... benchrouter doctor --repo owner/repo
```

Use `--skip-github-workflow` when `gh` is unavailable or the workflow does not
exist on the default branch yet.

## Multiple routes

Repeat `--route-id`, `--name`, and `--incumbent-model` in the same order:

```bash
benchrouter init --setup-key br_setup_... \
  --route-id product/route-a --name "Route A" --incumbent-model provider/model-a \
  --route-id product/route-b --name "Route B" --incumbent-model provider/model-b
```

Each runtime call site uses its stable route ID as the OpenAI-compatible `model`
value. Do not create one global model variable for a repository with several
routes.

## Upgrade

`upgrade` previews a server-generated update for generated kit files, asks for
confirmation, then applies it. The repository keeps ownership of
`.benchrouter/benchrouter.yml` and `.benchrouter/.kit-state.json`. Upgrade keeps
the full route index, changes only its kit version and generated-file hashes,
and fails closed when the existing kit state is missing or invalid.

```bash
benchrouter upgrade \
  --upgrade-token br_upgrade_... \
  --repo owner/repo \
  --route-id product/route
```

Use `--dry-run` to preview a single-use upgrade token without applying it. Use
`--yes` only when an interactive confirmation is not possible.

## Model IDs

`models` prints the current BenchRouter catalog. A route incumbent can be an
exact OpenRouter model that is not an automatic candidate. If BenchRouter cannot
resolve the incumbent, stop and ask the user for one exact replacement. Do not
substitute a model automatically.
