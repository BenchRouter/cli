import assert from "node:assert/strict";
import test from "node:test";
import { unifiedDiff } from "../src/line-diff.mjs";

test("unifiedDiff prints separate hunks with three context lines", () => {
  const before = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 2\n", "line two\n").replace("line 11\n", "");
  assert.equal(unifiedDiff("f.txt", before, after), [
    "--- a/f.txt", "+++ b/f.txt",
    "@@ -1,5 +1,5 @@", " line 1", "-line 2", "+line two", " line 3", " line 4", " line 5",
    "@@ -8,5 +8,4 @@", " line 8", " line 9", " line 10", "-line 11", " line 12", ""
  ].join("\n"));
});

test("unifiedDiff handles a new file, equal text and a missing final newline", () => {
  assert.equal(unifiedDiff("n.txt", "", "a\nb\n"), "--- a/n.txt\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  assert.equal(unifiedDiff("e.txt", "same\n", "same\n"), "");
  assert.equal(unifiedDiff("m.txt", "a\n", "a"), "--- a/m.txt\n+++ b/m.txt\n@@ -1,1 +1,1 @@\n-a\n+a\n\\ No newline at end of file\n");
});
