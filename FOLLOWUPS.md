# CLI follow-ups

Every token-reachable server route that is useful from a terminal now has a
command. What remains below is browser-only by server design, deliberately not
built, or proof that still needs the service worktree.

## Browser-only by server design

- **Account control-token mint, list, and revoke:** `POST|GET /v1/dashboard/control-tokens`
  and `POST /v1/dashboard/control-tokens/:tokenId/revoke` authenticate a GitHub
  identity session only. The CLI provides `account token save` for an
  already-minted `br_ctrl_` token; it never mints one and never prints a secret.
  A leaked `br_ctrl_` token must be revoked in the dashboard.
- **Admin key mint:** `POST /v1/admin/keys` rejects an admin-key bearer with
  `admin_session_required`; only a GitHub-session admin may mint. `admin keys
  list` and `admin keys revoke` accept a `bradm_` bearer and are wired.
- **GitHub App install:** the install URL is part of browser onboarding.
  `repos list` surfaces installation status so the CLI can say when it is needed.

## Deliberately not built

- `GET /v1/dashboard/catalog/proposals/count` — `proposals list` already returns
  the rows this counts.
- `GET /v1/admin/me` — the browser admin gate. `admin keys list` already proves a
  `bradm_` bearer is a valid admin identity.
- `GET /v1/billing/summary` — `billing show` reads the same fields from
  `GET /v1/dashboard/summary`.

## Proof that still needs the service worktree

- **Enriched repo-read bodies:** `status`, `frontier`, `failures`, and `explain`
  render enriched fields (production wiring, decision, evidence). The recorded
  fixtures in `test/fixtures/repo-read/` were captured before that enrichment, so
  they exercise the parse and render path but not the enriched fields. Re-record
  them from the `repo-read` / `service-integration` worktree to close this.
- **Live smoke:** no command has been run against production with a real
  `br_ctrl_` or `bradm_` token. Request construction and every rendered field are
  verified against the service route table, shared DTOs, and handlers; the round
  trip is not.

## Notes

- Repo-read commands keep using `br_setup_` / `BENCHROUTER_TOKEN`.
- Account commands use `--account-token`, then `BENCHROUTER_ACCOUNT_TOKEN`, then
  the private local config entry.
- Admin/proposal commands use `--admin-token`, then `BENCHROUTER_ADMIN_TOKEN`,
  then private local config. Tokens are never auto-substituted across scopes.
- One-time secrets are printed once and never saved: the runtime key from
  `keys create` and `init`, the setup code from `setup create`, and the upgrade
  token from `setup upgrade-token`. Provider, admin, and account secrets never
  appear in confirmations, errors, or rendered output.
- `billing show` reads `billing` / `recent_ledger` from
  `GET /v1/dashboard/summary` (not `/v1/billing/summary`). `DashboardSummary.account`
  is `{ slug, display_name }` and carries no id.
- `GET /v1/admin/catalog`, `/v1/admin/providers`, `/v1/admin/keys`,
  `/v1/admin/model-id-maps`, and `/v1/admin/catalog/observations` return
  `{ object: "list", data: [...] }`. `/v1/admin/catalog/activity` returns
  `{ ok: true, activity: [...] }` and `/v1/admin/catalog/mappings` returns
  `{ ok: true, mappings: [...] }`. These envelopes differ; do not assume one.
- `POST /v1/admin/catalog/refresh-report` is report-only (`writes_performed:
  false`), so the CLI does not ask for confirmation even though it is a POST.
- Catalog mutations return `catalog_automation_report_only` (409) while the
  automation rollout is frozen. That is a server state, not a CLI failure.
- Dashboard route keys stay slash-separated in the path. The service matches
  `/v1/dashboard/routes/([^/]+/[^/]+)/models/(.+)`, so percent-encoding the route
  key breaks the match. Repo-read paths percent-encode the route key instead.
- The server owns policy, routing, billing, and catalog mutations. The CLI is a
  thin command, file-write, and presentation layer.
