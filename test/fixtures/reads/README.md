Real responses captured from api.benchrouter.com on 2026-10-28:

- `route-activity.json`: `GET /v1/dashboard/routes/timeywimey/voice-places/activity`.
- `public-status.json`: `GET /v1/status`, with each component's `days` cut to the last two.
- `public-frontier.json`: `GET /v1/frontier`, cut to three Pareto members and two near ones of 249.

The startup-failure and billing responses in `test/remaining-reads.test.mjs` follow the
server's `RunnerStartupFailure`, `RunnerStartupDetails` and `BillingReport` types, with
invented values: the live billing values are an account's payments.
