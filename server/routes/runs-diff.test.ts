import test from "node:test";
import assert from "node:assert/strict";

import { splitUnifiedDiffByFile, synthesizeCreateDiff } from "./runs.js";

// ─── splitUnifiedDiffByFile ─────────────────────────────────────────

test("splitUnifiedDiffByFile: empty input → empty map", () => {
  assert.equal(splitUnifiedDiffByFile("").size, 0);
});

test("splitUnifiedDiffByFile: keys by b-side path, preserves diff --git header", () => {
  const combined =
    "diff --git a/src/foo.ts b/src/foo.ts\n" +
    "index 1111111..2222222 100644\n" +
    "--- a/src/foo.ts\n" +
    "+++ b/src/foo.ts\n" +
    "@@ -1,1 +1,1 @@\n" +
    "-old\n" +
    "+new\n" +
    "diff --git a/README.md b/README.md\n" +
    "index 3333333..4444444 100644\n" +
    "--- a/README.md\n" +
    "+++ b/README.md\n" +
    "@@ -1,1 +1,1 @@\n" +
    "-stale\n" +
    "+fresh\n";
  const out = splitUnifiedDiffByFile(combined);
  assert.equal(out.size, 2);
  const fooDiff = out.get("src/foo.ts");
  assert.ok(fooDiff, "src/foo.ts entry must be present");
  // The split must carry the header back so the per-file diff is
  // self-contained — git-apply / patch parsers expect `diff --git`.
  assert.match(fooDiff!, /^diff --git a\/src\/foo\.ts b\/src\/foo\.ts/);
  assert.match(fooDiff!, /\+new/);
  // README diff must NOT contain foo.ts content.
  const readmeDiff = out.get("README.md");
  assert.doesNotMatch(readmeDiff!, /src\/foo\.ts/);
});

test("splitUnifiedDiffByFile: section without recognisable header is dropped", () => {
  // Garbage prefix that would split but has no `b/` path.
  const garbage = "diff --git malformed\n";
  assert.equal(splitUnifiedDiffByFile(garbage).size, 0);
});

// ─── synthesizeCreateDiff ───────────────────────────────────────────

test("synthesizeCreateDiff: marks every body line as added", () => {
  const out = synthesizeCreateDiff("a.ts", "line1\nline2\nline3");
  assert.match(out, /^--- \/dev\/null\n\+\+\+ b\/a\.ts\n@@ -0,0 \+1,3 @@\n/);
  assert.match(out, /\+line1/);
  assert.match(out, /\+line2/);
  assert.match(out, /\+line3/);
  // No removal markers — this is a new file.
  assert.doesNotMatch(out, /^-[^-]/m);
});

test("synthesizeCreateDiff: empty content produces single-line +", () => {
  const out = synthesizeCreateDiff("empty.ts", "");
  // Empty content split → single empty string → @@ -0,0 +1,1 @@
  assert.match(out, /@@ -0,0 \+1,1 @@/);
});
