`overview.json` and `results.json` are real `GET /v1/hosted-evals` and
`GET /v1/hosted-evals/timeywimey%2Fvoice-places/results` responses, captured from
api.benchrouter.com on 2026-10-28. `overview.json` keeps only the BenchRouter test routes
`timeywimey/voice-places` and `pinned-smoke/br-b4-smoke`. `results.json` keeps the chain, the
serving model, the incumbent, one too-slow model and one unmeasured model of 110.

The draft and approve responses in `test/hosted-evals.test.mjs` follow the shapes of
`handleCreateHostedDraft` and `handleApproveHostedDraft` in the server's
`src/hosted-evals/http.ts`. No live draft was made, because approval spends from the balance.
