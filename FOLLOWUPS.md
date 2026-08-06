# CLI follow-ups

These items still depend on server-side account-control-token wiring or APIs
that do not exist yet. The CLI command tree is present; do not invent client-only
placeholders beyond the isolated missing-contract method already named in code.

## Missing or incomplete server contracts

- **AUTH-006 wiring:** Most customer control-plane paths still authenticate with
  GitHub session/identity cookies. They must accept Bearer `br_ctrl_` account
  control tokens without duplicating dashboard business logic. Today only
  `GET /v1/account/control/me` is control-token authenticated.
  Affected CLI commands after that lands: `billing *`, `keys list|create`,
  `repos list`, `setup status`, `routes *`, `models show`, `evals *`,
  `baseline set`.
- **API key revoke:** No revoke endpoint exists for runtime `api_keys`.
  Isolated client method: `revokeDashboardApiKey` in `src/control-api.mjs`.
  Required contract example:
  `POST /v1/dashboard/api-keys/:id/revoke` with Bearer `br_ctrl_`, returning
  non-secret key metadata.
- **User session helpers:** Browser mint UX for `br_ctrl_` tokens remains
  session-only via `POST /v1/dashboard/control-tokens`. The CLI provides
  `account token save` for already-minted tokens only (no GitHub login).
- **Admin key lifecycle:** `admin keys list|mint|revoke` require a browser
  GitHub admin session. A `bradm_` bearer receives `admin_session_required`.
  The CLI states that accurately and does not pretend bearer calls work.
- **Enriched repo-read final integration:** `explain` is wired to
  `GET /v1/repo/:routeKey/models/:modelId`. Final human/JSON proof against the
  enriched status/frontier/failures/explain bodies needs the service worktree
  (`repo-read` / `service-integration`) — existing CLI fixtures predate that
  contract enrichment.

## Notes

- Repo-read commands keep using `br_setup_` / `BENCHROUTER_TOKEN`.
- Account commands use `--account-token`, then `BENCHROUTER_ACCOUNT_TOKEN`, then
  the owner-only local config entry.
- Admin/proposal commands use `--admin-token`, then `BENCHROUTER_ADMIN_TOKEN`,
  then owner-only local config. Tokens are never auto-substituted across scopes.
- `billing show` reads `billing` / `recent_ledger` from
  `GET /v1/dashboard/summary` (not `/v1/billing/summary`).
- Billing top-up prints a checkout URL only; it never opens a browser.
- The server owns policy, routing, billing, and catalog mutations. The CLI is a
  thin command, file-write, and presentation layer.
