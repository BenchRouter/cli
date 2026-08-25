---
name: partition-route
description: Decide whether one BenchRouter route should become several narrower routes with their own evals. Use when a route mixes tasks or consume contracts, when the user mentions split, partition, or subroutes, or when reviewing a shared wrapper like astroturfed CRM activity generation.
---

# Partition a BenchRouter route

A route is one consume contract, not one HTTP client (`ROUTE-007`). The PPF is
route-specific (`CORE-001`). A blended eval across unequal tasks can false-include
a model that fails the hard subset, or overpay for the easy subset.

Do not write a partition engine. Inspect, propose, stop. Apply only after explicit
approval, through existing `init` / `/cli/new`.

## Phase 1 — read only

Do not edit files, run `init`, or archive a route until the user approves a split.

1. Inventory the current route:

```sh
npx --yes --package @benchrouter/cli benchrouter routes inspect --json
npx --yes --package @benchrouter/cli benchrouter evals cases --json --group method
npx --yes --package @benchrouter/cli benchrouter status --json
npx --yes --package @benchrouter/cli benchrouter frontier <route-key> --json
npx --yes --package @benchrouter/cli benchrouter failures <route-key> --json
```

2. Read the call site in `code_refs`. Note whether code branches by task *before*
   the LLM call, and whether senders share one outbound route id.
3. Cluster cases by **consume contract** (parser, schema, success condition), not
   by every function name.

### Keep one route when

- Cases share one consume contract and one scorer layer.
- Prompt variants are the same task with different inputs.

### Partition when two or more hold

- Distinct consume contracts (structured parse vs free-text notes).
- Code already branches by type before the LLM call.
- Failures or quality floors cluster by task.
- Output shape, `max_tokens`, or scorer layers differ enough that one PPF would
  overpay or under-gate.

### Do not partition when

- You would create one route per function name that shares a contract.
- Cases have no task labels and you cannot see branching — stop as unsure.
- A child would have too few cases to evaluate.

## Proposal (then stop)

Report, then wait:

- keep / partition / unsure
- each child: route id, name, methods and case ids, consume contract, eval
  archetype, which sender gets the new route id, incumbent (parent best or original)
- parent: keep as default, or archive after children have production evidence

Do not invent filler cases. Do not hand-edit `.benchrouter/benchrouter.yml`.
Do not transfer the parent PPF onto children.

## Phase 2 — after explicit approval

1. Start `/cli/new` (or one setup session) and run `init` with every new
   `--route-id` in one command. Same incumbent/provider tuple unless the user
   picks a replacement BenchRouter already offered.
2. Split cases and scorers by the approved clusters.
3. Patch senders so each task sends its own route id. Do not change a shared
   default model globally if other callers still need the parent.
4. `npm run benchrouter:calibrate` and
   `npx --yes --package @benchrouter/cli benchrouter doctor`.
5. Open a PR. Archive the fat parent only after the children serve.

See [examples.md](examples.md) for the astroturfed split.
