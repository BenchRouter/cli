# Repo-read fixture provenance

Captured on 2026-08-05 for process-level CLI replay tests.

- `models.json` is a reduced recording of `GET https://api.benchrouter.com/v1/models`.
  It preserves the production response shape and two production catalog entries.
- `invalid-token.json` records the production response from `GET /v1/repo/status`
  with a syntactically valid but unknown `br_setup_` token.
- `status.json`, `frontier.json`, and `failures.json` were captured from a real
  Miniflare Worker request through `SELF.fetch` after seeding the migrated test D1.
  The capture used BenchRouter server commit
  `7b2da10349ea10b34bb5e2fa06c833af51c7982a`. Only repository, route, result-set,
  and model-run identifiers were normalized after capture.

The replay server replaces only the external HTTP boundary. Each test starts the real
`benchrouter` subprocess and exercises argument parsing, authentication headers,
request construction, response parsing, and terminal output together.

`explain` now calls `GET /v1/repo/:routeKey/models/:modelId` (server model-explanation).
Enriched status/frontier/failures/explain bodies from the service worktree are not
recorded here yet; path/spelling coverage for explain is pure, and final integration
against those responses requires the service worktree.
