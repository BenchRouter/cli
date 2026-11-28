# Setup diagnostic fixtures

`production-decided.json` was recorded from the deployed
`GET /v1/setup/diagnostic` endpoint on 2026-09-13. It contains no credentials.

`imported-eval-pending.json` records the response shape produced by the
BenchRouter server's real Worker and D1 readiness integration test after a
default-branch import while the latest evaluation was still queued. It proves
that evaluation completion and production eligibility are separate facts.

`route-scoped.json` adapts `production-decided.json` to the shape checked by the
server's real Worker and D1 test in PR #970. The readiness scope is `route`
and the route key is the CLI tests' `app/chat`.

`missing-session.json` is the HTTP 404 body defined by PR #970's setup
diagnostic handler and checked by its Worker and D1 test. Its error scope is
`repository`.

The server no longer sends `readiness.production_eligible` (absent on main and in #968), so
`production-decided.json` and `imported-eval-pending.json` keep their recorded values without it.
