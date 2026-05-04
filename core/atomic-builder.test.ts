import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAtomicStep,
  changedLineCount,
  filesInUnifiedDiff,
  validateAtomicDiff,
  validateAtomicDispatchTarget,
} from "./atomic-builder.js";
import type { FileChange } from "../workers/base.js";

function change(path: string, diff: string): FileChange {
  return {
    path,
    operation: "modify",
    diff,
    originalContent: "old",
    content: "new",
  };
}

test("atomic builder validation rejects empty diffs", () => {
  const step = buildAtomicStep("src/a.ts", "Add function to src/a.ts");
  const result = validateAtomicDiff(step, [change("src/a.ts", "")]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty diff/i);
});

test("atomic builder validation rejects multi-file output", () => {
  const step = buildAtomicStep("src/a.ts", "Add function to src/a.ts");
  const result = validateAtomicDiff(step, [
    change(
      "src/a.ts",
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1,2 @@",
        " export const a = 1;",
        "+export function added() { return a; }",
      ].join("\n"),
    ),
    change(
      "src/b.ts",
      [
        "diff --git a/src/b.ts b/src/b.ts",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -1 +1,2 @@",
        " export const b = 1;",
        "+export const c = 2;",
      ].join("\n"),
    ),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /exactly one FileChange|multiple files/i);
});

test("atomic builder validation rejects repeated identical output", () => {
  const step = buildAtomicStep("src/a.ts", "Modify src/a.ts");
  const result = validateAtomicDiff(step, [
    {
      path: "src/a.ts",
      operation: "modify",
      diff: "",
      originalContent: "export const a = 1;\n",
      content: "export const a = 1;\n",
    },
  ]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty diff/i);
});

test("validateAtomicDispatchTarget: rejects empty file with reason='empty'", () => {
  const result = validateAtomicDispatchTarget({
    file: "",
    deliverable: { description: "Modify magister/router.ts", type: "modify" },
    knownTargets: ["magister/router.ts"],
    advisoryTargets: [],
    fileExists: () => true,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "empty");
  assert.match(result.message, /no target file/i);
  assert.deepEqual([...result.suggestedTargets], ["magister/router.ts"]);
});

test("validateAtomicDispatchTarget: rejects missing file (modify) with reason='missing'", () => {
  const result = validateAtomicDispatchTarget({
    file: "magister/router.ts",
    deliverable: { description: "Modify magister/router.ts", type: "modify" },
    knownTargets: ["magister/router.ts"],
    advisoryTargets: [],
    fileExists: () => false,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "missing");
  assert.match(result.message, /does not exist on disk/i);
});

test("validateAtomicDispatchTarget: allows missing file when deliverable.type === 'create'", () => {
  const result = validateAtomicDispatchTarget({
    file: "magister/modes/teach-me-anything.ts",
    deliverable: { description: "Create new mode", type: "create" },
    knownTargets: ["magister/modes/teach-me-anything.ts"],
    advisoryTargets: [],
    fileExists: () => false,
  });
  assert.equal(result.ok, true);
});

test("validateAtomicDispatchTarget: allows missing file when allowMissingFile=true (create-intent prompt)", () => {
  // Mirrors prepareDeliverablesForGraph: a "modify" deliverable for a
  // file the prompt explicitly asks to create must NOT be rejected
  // for missingness. The coordinator sets allowMissingFile=true when
  // the prompt's analysis.raw matches the create-intent regex.
  const result = validateAtomicDispatchTarget({
    file: "hello-aedis.txt",
    deliverable: { description: "Modify hello-aedis.txt", type: "modify" },
    knownTargets: ["hello-aedis.txt"],
    advisoryTargets: [],
    fileExists: () => false,
    allowMissingFile: true,
  });
  assert.equal(result.ok, true);
});

test("validateAtomicDispatchTarget: phantom target NOT in scout/charter results → reason='unknown'", () => {
  // The bug we're patching: deliverable.targetFiles[0] points at a real
  // file that nobody asked for (the file exists in the repo but was
  // never surfaced by the discovery pipeline for THIS task).
  const result = validateAtomicDispatchTarget({
    file: "web/app/components/MarkdownMessage.tsx",
    deliverable: { description: "Register TEACH_ME_ANYTHING", type: "modify" },
    knownTargets: ["magister/router.ts"],          // charter/extract
    advisoryTargets: ["magister/modes/narrator.ts"], // scout
    fileExists: () => true,                         // file exists, but not for this task
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "unknown");
  assert.match(result.message, /not discovered by Scout\/charter/i);
  assert.ok(
    result.suggestedTargets.includes("magister/router.ts"),
    "must surface the real charter target as a suggestion",
  );
  assert.ok(
    result.suggestedTargets.includes("magister/modes/narrator.ts"),
    "must include scout advisory targets in the suggestion list",
  );
});

test("validateAtomicDispatchTarget: target found in advisoryTargets only → ok", () => {
  const result = validateAtomicDispatchTarget({
    file: "magister/router.ts",
    deliverable: { description: "Register mode", type: "modify" },
    knownTargets: [],
    advisoryTargets: ["magister/router.ts"],
    fileExists: () => true,
  });
  assert.equal(result.ok, true);
});

test("validateAtomicDispatchTarget: target found in knownTargets only → ok", () => {
  const result = validateAtomicDispatchTarget({
    file: "magister/router.ts",
    deliverable: { description: "Register mode", type: "modify" },
    knownTargets: ["magister/router.ts"],
    advisoryTargets: [],
    fileExists: () => true,
  });
  assert.equal(result.ok, true);
});

test("atomic diff helpers parse changed lines and touched files", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1,2 @@",
    " export const a = 1;",
    "+export function added() { return a; }",
  ].join("\n");
  assert.deepEqual(filesInUnifiedDiff(diff), ["src/a.ts"]);
  assert.equal(changedLineCount(diff), 1);
  const result = validateAtomicDiff(buildAtomicStep("src/a.ts", "Add function to src/a.ts"), [change("src/a.ts", diff)]);
  assert.equal(result.ok, true);
});
