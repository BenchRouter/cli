# Databricks Connect recordings

The JSON recordings come from plan Appendix A.7, captured on 2026-10-29:

- `me.json`: `/api/2.0/preview/scim/v2/Me`.
- `p1-create.json`, `p1-sp2.json`, `p5-sp3.json`: SCIM SP creation and replacement.
- `p1-ruleset*.json`: the SP rule set before and after the user-role grant.
- `settings.json`: `p1-restrict-ws-admins.txt`, with `ALLOW_ALL`.
- `p2-run.json`: a successful serverless wheel job run after owner transfer.

The test replaces the recorded email and account/SP UUIDs with fixed test identities.
The source evidence also includes `p1-second-admin*.txt`, `p4-grants.txt`,
`p4-scope-volume.txt`, `p4-table-exp.txt`, and `p5-heal.txt`. These are trimmed
CLI answers rather than full HTTP responses. The replay uses their object,
owner, privilege and refusal shapes. Scenario variants change owners, error
codes, existence, restriction status and ACL membership to cover each branch.
No recording contains an access token or OAuth secret.

`connect.json` is a contract fixture from the final shared `headless-contract.ts`.
It is not a live H1/H2 response. Its scope and principal fields are filled from
that test's SP. The fake wheel digest is never downloaded. Live H1/H2 integration
and two real workspace Connect runs remain a deployment check.

`binding-read.json` contains setup-item contract fixtures from the final
`DatabricksSetupItemView` and `DatabricksFailure` types (2026-10-30). These are
not live server recordings. The replay sets fresh queue timestamps when it
receives the register POST. Scenario variants preserve old timestamps or change
item state and failure to prove that Connect waits for its own setup items.

`auth-describe.json` and `databricks-config.json` use the live wire shapes supplied
in the 2026-10-30 round 2 review (Databricks CLI v1.22.1 and the anonymous workspace
configuration document). Identifiers are synthetic. The replay varies auth type,
credential visibility, missing account id and workspace id to exercise refusals.
The second-admin refusal uses the recorded "Not authorized to perform this
operation" message with 403 and 400 `PERMISSION_DENIED` variants from that review.

`bin/databricks` returns the JSON shapes of `databricks auth describe` and
`databricks auth token`. `BR_FIXTURE_AUTH` selects U2M, PAT, unsupported auth,
child failure, U2M refresh or M2M. Only `describe --sensitive` exposes the synthetic
M2M client secret. `BR_FIXTURE_AUTH_LOG` records subprocess arguments without
credentials so tests prove PAT and M2M never call `auth token`. Its JWT
claims follow A.7 `p3-admin-cli-token.txt`; its token is synthetic and its expiry
is relative to test time. It requires no Databricks installation or saved login.
Token exchange uses the request in A.7 `p3-admin-exchange.txt`. The proof is
synthetic because the local replay server does not check JWT signatures.
The M2M replay returns a short-lived token then a refreshed token from the same
workspace token endpoint, using `client_credentials`, `all-apis` and HTTP Basic
authentication. Both tokens and the client secret carry distinct test markers.

The REST paths for rule sets, OAuth secret pagination, settings and host metadata
also follow the official generated Databricks SDK:
[rule sets](https://github.com/databricks/databricks-sdk-py/blob/main/databricks/sdk/service/iam.py),
[OAuth secrets](https://github.com/databricks/databricks-sdk-py/blob/main/databricks/sdk/service/oauth2.py),
[settings](https://github.com/databricks/databricks-sdk-py/blob/main/databricks/sdk/service/settings.py),
[host metadata](https://github.com/databricks/databricks-sdk-go/blob/main/config/host_metadata.go).

The test-only `BENCHROUTER_DATABRICKS_API_BASE` accepts a loopback HTTP origin.
It redirects Databricks calls to the replay server while preserving the real
workspace URL in the registration request. Do not set it for a real workspace.
