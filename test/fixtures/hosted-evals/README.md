`overview.json` and `results.json` are real `GET /v1/hosted-evals` and
`GET /v1/hosted-evals/timeywimey%2Fvoice-places/results` responses, captured from
api.benchrouter.com on 2026-10-28. `overview.json` keeps only the BenchRouter test routes
`timeywimey/voice-places` and `pinned-smoke/br-b4-smoke`. `results.json` keeps the chain, the
serving model, the incumbent, one too-slow model and one unmeasured model of 110.

The draft and approve responses in `test/hosted-evals.test.mjs` follow the shapes of
`handleCreateHostedDraft` and `handleApproveHostedDraft` in the server's
`src/hosted-evals/http.ts`. No live draft was made, because approval spends from the balance.

`model-low-pass.json` and `case-output-archived.json` are real
`GET /v1/hosted-evals/timeywimey%2Fvoice-places/models/bytedance-seed%2Fseed-2.0-mini` and
`GET .../case-output?model_run_id=emrun_541d6bfe5b684ff6a1187503d7ed5347&case_id=additive_preserves_existing`
responses, captured from api.benchrouter.com on 2026-10-28 (BenchRouter PR #654). The model
fails every case, and its case outputs are archived.
