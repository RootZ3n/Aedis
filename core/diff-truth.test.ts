import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCanonicalDiff,
  countRealDiffLines,
  validateApprovalChanges,
  validateUnifiedDiff,
} from "./diff-truth.js";

test("diff truth: full-file identical synthetic patch is not approvable", () => {
  const diff = [
    "diff --git a/src/message.ts b/src/message.ts",
    "--- a/src/message.ts",
    "+++ b/src/message.ts",
    "@@ -1,1 +1,1 @@",
    " export const message = \"hello\";",
  ].join("\n");

  assert.equal(countRealDiffLines(diff), 0);
  const result = validateUnifiedDiff(diff);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no real line/i);
  assert.equal(validateApprovalChanges([{
    path: "src/message.ts",
    operation: "modify",
    originalContent: "export const message = \"hello\";\n",
    content: "export const message = \"hello\";\n",
    diff,
  }]).ok, false);
});

test("diff truth: valid one-file modification is approvable", () => {
  const diff = [
    "diff --git a/src/message.ts b/src/message.ts",
    "--- a/src/message.ts",
    "+++ b/src/message.ts",
    "@@ -1,1 +1,1 @@",
    "-export const message = \"hello\";",
    "+export const message = \"hello from aedis\";",
  ].join("\n");

  const result = validateApprovalChanges([{
    path: "src/message.ts",
    operation: "modify",
    originalContent: "export const message = \"hello\";\n",
    content: "export const message = \"hello from aedis\";\n",
    diff,
  }]);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.changedLines, 2);
});

test("diff truth: empty diff blocks approval", () => {
  const result = validateApprovalChanges([{
    path: "src/message.ts",
    operation: "modify",
    originalContent: "export const message = \"hello\";\n",
    content: "export const message = \"hello from aedis\";\n",
    diff: "",
  }]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/i);
});

test("diff truth: full-file modified change persists as canonical diff", () => {
  const original = "export const message = \"hello\";\n";
  const updated = "export const message = \"hello from aedis\";\n";
  const canonical = buildCanonicalDiff([{
    path: "src/message.ts",
    operation: "modify",
    originalContent: original,
    content: updated,
    diff: "",
  }]);

  assert.equal(canonical.ok, true, canonical.reason);
  assert.equal(validateUnifiedDiff(canonical.diff).ok, true);
  assert.match(canonical.diff, /^diff --git a\/src\/message\.ts b\/src\/message\.ts/m);
  assert.match(canonical.diff, /-export const message = "hello";/);
  assert.match(canonical.diff, /\+export const message = "hello from aedis";/);
});

test("diff truth: malformed supplied diff is replaced from full-file content", () => {
  const canonical = buildCanonicalDiff([{
    path: "src/message.ts",
    operation: "modify",
    originalContent: "export const message = \"hello\";\n",
    content: "export const message = \"hello from aedis\";\n",
    diff: "@@\n-export const message = \"hello\";\n+export const message = \"hello from aedis\";\n",
  }]);

  assert.equal(canonical.ok, true, canonical.reason);
  assert.match(canonical.diff, /^diff --git a\/src\/message\.ts b\/src\/message\.ts/m);
  assert.match(canonical.diff, /^@@ -1,1 \+1,1 @@/m);
  assert.equal(validateUnifiedDiff(canonical.diff).ok, true);
});

test("diff truth: canonical diff detects disappeared diff after non-empty state", () => {
  const first = buildCanonicalDiff([{
    path: "src/message.ts",
    operation: "modify",
    originalContent: "export const message = \"hello\";\n",
    content: "export const message = \"hello from aedis\";\n",
    diff: "",
  }]);
  const second = buildCanonicalDiff([]);

  assert.equal(first.ok, true, first.reason);
  assert.ok(first.diff.length > 0);
  assert.equal(second.ok, false);
  assert.equal(second.diff, "");
});
