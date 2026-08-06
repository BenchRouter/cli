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
  Isolated client method: `revokeDashboardApiKey` in `src/customer-api.mjs`.
  Required contract example:
  `POST /v1/dashboard/api-keys/:id/revoke` with Bearer `br_ctrl_`, returning
  non-secret key metadata.
- **User session helpers:** `login`, `logout`, `whoami` with mint/save UX for
  `br_ctrl_` tokens (mint today is browser-session-only via
  `POST /v1/dashboard/control-tokens`).
- **Admin catalog work:** `catalog review`, `catalog activity`, and identity
  mappings remain operator/admin surfaces, not this customer CLI.

## Notes

- Repo-read commands keep using `br_setup_` / `BENCHROUTER_TOKEN`.
- Account commands use `--account-token`, then `BENCHROUTER_ACCOUNT_TOKEN`, then
  the owner-only local config entry. Runtime keys are rejected.
- Billing top-up prints a checkout URL only; it never opens a browser.
- The server owns policy, routing, billing, and catalog mutations. The CLI is a
  thin command, file-write, and presentation layer.
