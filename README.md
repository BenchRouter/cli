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
benchrouter status [--json]
benchrouter frontier <route-key> [--json]
benchrouter failures <route-key> [model] [--json]
benchrouter explain <model> [--route <route-key>] [--json]
```

`status` shows each route, incumbent, current best model, and latest eval state.

`frontier` shows the incumbent, best model, and ranked alternatives.

`failures` shows failed cases from the latest model run. Pass a model ID to
select the latest run for that model.

`explain` states whether a model is the incumbent, best pick, an eligible
alternative, or outside the eligible frontier. Pass `--route` when a repository
has more than one route.

All read commands accept `--json` for scripts and agents.

## Credentials and configuration

Read commands resolve credentials in this order:

1. `--token br_setup_...`
2. `BENCHROUTER_TOKEN`
3. the saved token for the detected or specified repository

Saved credentials are isolated by repository. Set `BENCHROUTER_CONFIG_DIR` to
move the entire configuration root. Tests and automation should always set this
variable to a temporary directory.

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

`upgrade` previews a server-generated kit update, asks for confirmation, then
applies the server-authoritative packet.

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
