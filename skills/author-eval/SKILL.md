---
name: author-eval
description: Strengthen BenchRouter eval cases and scorers for a route. Use when setup asks for cases, calibration fails, failures look weak, or the user wants a harder eval.
---

# Author a BenchRouter eval

Grade what the code consumes, not the words the model wrote. The eval is a
conservative comparative gate. Unsure excludes the model.

## Inventory first

```sh
npx --yes --package @benchrouter/cli benchrouter routes inspect --json
npx --yes --package @benchrouter/cli benchrouter evals cases --json
npx --yes --package @benchrouter/cli benchrouter failures <route-key> --json
```

Read `.benchrouter/SETUP_README.md` and the route scorer before writing cases.

## Source, in order

1. **test-derived** — lift an existing test's input and consumed-output assertion.
2. **captured** — record the real wire request; captured output is calibration,
   not a gold answer.
3. **authored** — cite defensible product intent from code, schema, or the user.

Do not copy the app test harness into CI. Do not invent filler to reach a count.

## Scorer rules

- Deterministic and deps-free. No app imports, network, clock, or DB.
- Port the consume contract (parse → compare consumed fields, or run a local oracle).
- Pass a known-good output and fail a structurally valid, semantically wrong one.
- Regex on prose is wrong unless the literal is what the code consumes.
- If meaning is free text with no oracle, use a conservative comparative judge
  only after the structural layer, and abstain when unsure.

If one route mixes consume contracts, stop and use `partition-route` instead of
writing a blended scorer.

## Finish

```sh
npm run benchrouter:calibrate
npx --yes --package @benchrouter/cli benchrouter doctor
```
