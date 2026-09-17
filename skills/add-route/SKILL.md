---
name: add-route
description: Add another BenchRouter route to a repo that already has the kit. Use when the user asks to cover a new call site, run /cli/new, or onboard a second route.
---

# Add a BenchRouter route

Reuse the existing kit. Do not re-init the whole product.

## Phase 1 — read only

```sh
npx --yes --package @benchrouter/cli benchrouter routes inspect --json
npx --yes --package @benchrouter/cli benchrouter status --json
```

Find one production LLM call that should become its own route:

- an uncovered call site, or
- a task already sharing a route with a different consume contract (`partition-route`)

A shared HTTP wrapper is not proof of one route.

Record, then stop for approval:

- call-site file and function
- proposed route id and name
- exact current model id (no alias or substitute)
- transport and base URL env
- direct provider id and provider-native ref, when present
- eval source: test-derived, captured, or authored
- eval mode: isolated_replay, or repository_executable

If the call site is already a BenchRouter route id, say so. Do not invent a
second route for the same consume contract.

## Phase 2 — after approval

1. Get a setup session from `/cli/new` or
   `benchrouter setup create --intent new_route`.
2. Run `benchrouter init` with the new `--route-id`. Init merges the route into
   the existing `.benchrouter/benchrouter.yml`. Do not hand-edit that file.
3. Patch only the confirmed call site. Send the new route id as the outbound
   model. Source the SDK key from `BENCHROUTER_API_KEY`.
4. Author cases and scorer, or pass `--eval-pack` for repository_executable.
5. Calibrate, `doctor`, PR.
