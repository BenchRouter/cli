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

`me-m2m.json` follows the H8 `/Me` probes from 2026-10-30
(`51-me-probe-admin2.txt` and `51-me-probe-nav.txt`). The M2M response uses
the same fields as the user response. It has no `applicationId` field.
Its `userName` is the SP application id, and its groups include `admins`.
The fixture keeps the recorded user response structure and replaces identity
values with test values. M2M login claims set both `sub` and `client_id` to
that application id. Replay variants change the subject match or admin group
to check refusal before writes.

`job-deleted.json` is the HTTP 400 body from the first live Connect/Disconnect
run on 2026-10-30. Jobs get and cleanup delete use `INVALID_PARAMETER_VALUE`
as absence only for a validated positive job id. The replay also asserts the
complete rule-set PUT body, including matching top-level and nested names.
Diagnostic variants reflect a synthetic login token to verify redaction before
the 300-character message limit in text and JSON output.

`connect.json` is a contract fixture from the final shared `headless-contract.ts`.
It is not a live H1/H2 response. Its scope and principal fields are filled from
that test's SP. The fake wheel digest is never downloaded. Live H1/H2 integration
and two real workspace Connect runs remain a deployment check.

`binding-read.json` contains setup-item contract fixtures from the final
`DatabricksSetupItemView` and `DatabricksFailure` types (2026-10-30). These are
not live server recordings. The experiment and eval job targets match the live
H8 findings (2026-10-30). The replay sets queue timestamps when it receives the
register POST. Scenario variants preserve old timestamps, omit expected rows,
or change state and failure to check completion from the current setup state.
`timeout-clock.mjs` advances only the subprocess clock to exercise the three-minute
timeout within the four-second subprocess limit. HTTP replay and polling stay real.

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

## H5 contract and replay coverage

`binding-{connecting,verified,agent_silent,disconnecting,disconnected,archived}.json`
are contract fixtures derived from the supplied `headless-contract.ts` and
`databricks-dto.ts`. They are not live H2 recordings. Disconnecting is represented
by a verified binding with `disconnect_requested_at`, as the contract specifies.
The failure and grant records follow the DTO builders. Test identities replace
all account and workspace identifiers. Live binding reads for these states and
a live force-disconnect remain integration checks once the H2 target is supplied.

`eval-manifest.yml` is the YAML example from the supplied runner `manifest.py`,
with its route and scope changed to fixed test identifiers. The replay exports
that file over the Workspace API as base64. Invalid variants change the fields
that H5 consumes. The parser does not validate unused runner code or scoring fields.

H4 and H5 share `test/helpers/databricks-replay.mjs`, the same ordered loopback
server, credential boundary assertions, four-second subprocess timeout, and
recorded Databricks CLI binary. No internal function is mocked. H5 replays the
supplied endpoint/provider-service permission evidence and the UC grant/volume
shapes used by H4. Every H5 test has a 4.9-second test timeout.
The shared runner checks output for credential leaks after every command, including
help and refusal paths. The server also checks each request's credential boundary.
It supports deferred setup snapshots for the Connect tests.

Round 2 coverage uses the final typed `results_owner` and disconnect response
contracts. Status always wraps the unchanged reads in `{bindings: [...]}`. Setup
failures use `binding-read.json`. Job-owner checks use the same Databricks job ACL
shape as Connect, with user-owner, SP-owner, denied and missing variants. The user
warning is on stderr, outside the server-read JSON. Replay request timestamps
verify the two-second disconnect interval. Ordered requests require one inventory
list and one read per other open binding before cleanup. Closed-binding variants
expect neither a disconnect POST nor run-now. Invalid manifests and non-admin
logins expect no BenchRouter POST.

The REST mapping also follows the official
[Workspace export API](https://docs.databricks.com/api/workspace/workspace/export),
[Workspace permissions API](https://docs.databricks.com/api/workspace/workspace/updatepermissions),
and [Secrets API](https://docs.databricks.com/api/workspace/secrets/listacls).
A scope existence check reads its ACL metadata, never secret values.

The generic outbound User-Agent contains no user or repository identifier.

Cleanup identity checks follow Databricks' documented
[lowercase UC names](https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-names)
and [case-insensitive scope names](https://docs.databricks.com/aws/en/security/secrets).
The replay covers a newer binding that records the same scope and volumes with
different casing. Deletion is acknowledged only after a confirming missing-object
read; a service that still exists remains pending.
