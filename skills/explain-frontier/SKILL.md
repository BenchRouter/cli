---
name: explain-frontier
description: Explain a BenchRouter route's Personal Pareto Frontier in plain language. Use when the user asks why a model won, what the eligible stack is, or how to read status, frontier, or explain output.
---

# Explain a route frontier

The PPF is route-specific and comes from this customer's eval. It is a ranking
across cost × quality, not a pass/fail verdict on one model.

```sh
npx --yes --package @benchrouter/cli benchrouter status --json
npx --yes --package @benchrouter/cli benchrouter frontier <route-key> --json
npx --yes --package @benchrouter/cli benchrouter explain <model> --route <route-key> --json
npx --yes --package @benchrouter/cli benchrouter models show <route-key> <model-id> --json
```

Report:

- **original** — observed incumbent at setup; savings baseline, immutable
- **baseline** — user-selected comparison floor
- **best** — current served model after eval
- **eligible alternatives** — ranked chain down to the incumbent
- what an exact model override does **not** change (best, baseline, PPF)

Do not treat public benchmarks as route evidence. Do not recommend serving a
model that `explain` places outside the eligible frontier. If failures cluster
by task, point at `partition-route` instead of blaming the catalog.
