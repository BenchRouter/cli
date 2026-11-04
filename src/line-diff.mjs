// The largest LCS table the preview builds (4 bytes a cell, so 16 MiB).
const MAX_TABLE_CELLS = 4_000_000;

// A unified line diff for previews. The common prefix and suffix are removed first, so a
// small edit to a large file builds a small table. A change too large for the table is
// reported in one line instead of a diff.
export function unifiedDiff(filePath, before, after, context = 3) {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  if (n * m > MAX_TABLE_CELLS) {
    return `--- a/${filePath}\n+++ b/${filePath}\n(${n} old and ${m} new lines differ; too large to show here. Review the change with git diff after applying.)\n`;
  }
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[prefix + i] === b[prefix + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  for (let k = 0; k < prefix; k += 1) ops.push({ kind: " ", text: a[k], i: k, j: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] === b[prefix + j]) { ops.push({ kind: " ", text: a[prefix + i], i: prefix + i, j: prefix + j }); i += 1; j += 1; }
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push({ kind: "-", text: a[prefix + i], i: prefix + i, j: prefix + j }); i += 1; }
    else { ops.push({ kind: "+", text: b[prefix + j], i: prefix + i, j: prefix + j }); j += 1; }
  }
  for (let k = 0; k < suffix; k += 1) ops.push({ kind: " ", text: a[prefix + n + k], i: prefix + n + k, j: prefix + m + k });
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (changed.length === 0) return "";
  const hunks = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = hunks.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const { start, end } of hunks) {
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    const oldStart = oldCount === 0 ? slice[0].i : slice[0].i + 1;
    const newStart = newCount === 0 ? slice[0].j : slice[0].j + 1;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) lines.push(`${op.kind}${op.text}`);
  }
  return `${lines.join("\n")}\n`;
}

function splitLines(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  else lines[lines.length - 1] += "\n\\ No newline at end of file";
  return lines;
}
