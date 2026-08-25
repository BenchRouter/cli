---
name: doctor-fix
description: Diagnose and fix BenchRouter doctor failures in a customer repo. Use when doctor fails, kit files are missing, or setup/upgrade left the call site or workflow unwired.
---

# Fix BenchRouter doctor

```sh
npx --yes --package @benchrouter/cli benchrouter doctor --repo <owner/repo>
npx --yes --package @benchrouter/cli benchrouter routes inspect --json
```

Read the failing check. Fix only that check.

- Missing or drifted kit engines →
  `benchrouter upgrade --upgrade-token br_upgrade_...` (preserves
  `benchrouter.yml` and route-owned cases/scorers).
- Call site still sending a provider model id → send the route id; source the
  SDK key from `BENCHROUTER_API_KEY`; point the base URL env at BenchRouter.
- Isolated-replay cases/scorer broken → `author-eval`, then calibrate.
- GitHub workflow missing or disabled → restore
  `.github/workflows/benchrouter-evals.yml` via upgrade; do not add an eval API
  key. CI uses GitHub OIDC.
- Several consume contracts on one route id → `partition-route`, not a doctor
  workaround.

Do not hand-edit generated engines. Do not hand-edit `benchrouter.yml`.
Re-run `doctor` until it passes, then open the PR.
