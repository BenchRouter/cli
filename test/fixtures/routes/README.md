`pin-repo-route.json` is a real `GET /v1/control/routes/timeywimey%2Fvoice-places/pin` response,
captured from api.benchrouter.com on 2026-10-28 (BenchRouter PR #662). It is a repository route,
so `repin_blocked_reason` is `repo_route`.

The pinned-route, create and re-pin responses in `test/route-writes.test.mjs` follow
`routePinState`, `commitCreatePinnedRoute` and `commitRepinRoute` in the server's
`src/hosted-routes-http.ts`. No live route was created or re-pinned.

`group-required.json` preserves the HTTP 400 code and message from the user-reported
live H8 `POST /v1/control/routes` refusal on 2026-10-30. The request used the removed
`product` field. The JSON error envelope follows `src/shared/http.ts:errorResponse`;
the message matches `src/hosted-routes-http.ts:prepareCreatePinnedRoute` on server
`origin/main` after PR #693. Both human and JSON CLI paths replay this refusal.
The create success replay uses that handler's `group_created` response field and
keeps its internal `product` reference. These tests do not create a live route.
