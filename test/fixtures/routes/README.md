`pin-repo-route.json` is a real `GET /v1/control/routes/timeywimey%2Fvoice-places/pin` response,
captured from api.benchrouter.com on 2026-10-28 (BenchRouter PR #662). It is a repository route,
so `repin_blocked_reason` is `repo_route`.

The pinned-route, create and re-pin responses in `test/route-writes.test.mjs` follow
`routePinState`, `commitCreatePinnedRoute` and `commitRepinRoute` in the server's
`src/hosted-routes-http.ts`. No live route was created or re-pinned.
