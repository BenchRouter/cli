# Setup diagnostic fixtures

`production-decided.json` was recorded from the deployed
`GET /v1/setup/diagnostic` endpoint on 2026-09-13. It contains no credentials.

`imported-eval-pending.json` records the response shape produced by the
BenchRouter server's real Worker and D1 readiness integration test after a
default-branch import while the latest evaluation was still queued. It proves
that evaluation completion and production eligibility are separate facts.
