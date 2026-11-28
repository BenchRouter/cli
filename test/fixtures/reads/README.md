Real responses captured from api.benchrouter.com:

- `route-activity.json`: `GET /v1/dashboard/routes/timeywimey/voice-places/activity`,
  captured by cold-read panel job J6 on 2026-11-27, with GitHub run URLs redacted.
  The activity test pairs it with the earlier production search data from
  `hosted-evals/results.json` to verify distinct result set IDs.
- `public-status.json`: `GET /v1/status`, with each component's `days` cut to the last two.
- `public-frontier.json`: `GET /v1/frontier`, cut to three Pareto members and two near ones of 249.

The startup-failure and billing responses in `test/remaining-reads.test.mjs` follow the
server's `RunnerStartupFailure`, `RunnerStartupDetails` and `BillingReport` types, with
invented values: the live billing values are an account's payments.
