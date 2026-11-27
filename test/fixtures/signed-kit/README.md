# Signed runtime kit fixture

`workflow.yml` is the eval-action stub for the replay-only route, built with the same
`yaml` Document calls as the service's `src/setup-packet/workflow.ts` stub (kit 0.1.0).
It contains no customer setup steps.

`workflow-legacy.yml`, `bootstrap.mjs.txt` and `trust.json` are the kit from before the
eval action, from the setup-packet generator in the service repository at
171ae3008a008f5bb7deb6863f16d4066e69206b. Tests use them to check the upgrade migration
and the deletion of committed legacy runtime files. These are generated contract
artifacts, not production traffic.

Tests copy the files into real temporary repositories. They do not replace the
filesystem, child processes, or the bootstrap with mocks.
