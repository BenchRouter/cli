import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

// RUN-001: copied from the benchrouter repository's pinned constants. The same values are pinned in
// BenchRouter/eval-action. benchrouter's runtime/bootstrap.mjs and generated trust.json are the source.
const EVAL_ACTION_BOOTSTRAP_SHA256 = "51030b0ddeb1aac3f176ee5cd3654184cffd5b7ca79ba093146e53f59e79fef9";
const EVAL_ACTION_TRUST_SHA256 = "53e2748549587d7958e43e3a88cef62cf2ca061454b7ceb204cfb2fe707c7179";
const BUMP_ALL_THREE = "A runtime bootstrap or trust change must update all three copies in one pass: benchrouter " +
  "(runtime/bootstrap.mjs, the generated trust.json and EVAL_ACTION_*_SHA256), BenchRouter/eval-action (its vendored files " +
  "and pins), and this CLI (src/vendor and these pins). Copy the files byte for byte, then bump the pinned sha256 in all three.";

for (const [file, pinned] of [["bootstrap.mjs", EVAL_ACTION_BOOTSTRAP_SHA256], ["trust.json", EVAL_ACTION_TRUST_SHA256]]) {
  test(`RUN-001 vendored ${file} matches the pinned eval-action sha256`, async () => {
    const bytes = await readFile(new URL(`../src/vendor/${file}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pinned, `src/vendor/${file} drifted. ${BUMP_ALL_THREE}`);
  });
}
