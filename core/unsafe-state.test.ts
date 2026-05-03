/**
 * Unit tests for core/unsafe-state.ts — the single source of truth
 * for "this run cannot be approved/promoted because rollback left
 * the workspace contaminated."
 *
 * The contracts pinned here are the ones every consumer (approval
 * API, promotion gate, UI, CLI) depends on:
 *
 *   • assessUnsafeState returns unsafe=true for ANY of:
 *       — runStatus ∈ { ROLLBACK_INCOMPLETE, ROLLBACK_FAILED, UNSAFE_STATE }
 *       — rollback.status !== "clean"
 *       — rollback.manualInspectionRequired === true
 *       — persisted error log contains a ROLLBACK marker (text fallback)
 *
 *   • dirtyFiles + failedPaths are surfaced verbatim and capped at 50
 *     so no malicious receipt can DoS the UI by ballooning the list.
 *
 *   • primaryReason is severity-ordered:
 *       rollback_failed > rollback_incomplete > unsafe_state >
 *       manual_inspection_required
 *
 *   • clean rollback + AWAITING_APPROVAL = SAFE (the operator can
 *     approve), proving the helper does not over-flag.
 *
 *   • assertSafeForApproval throws UnsafeStateError on unsafe input.
 *
 *   • buildInspectionPlan emits read-only commands only.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSafeForApproval,
  assessUnsafeState,
  buildInspectionPlan,
  UnsafeStateError,
} from "./unsafe-state.js";

test("safe: clean rollback + AWAITING_APPROVAL reads as safe", () => {
  const a = assessUnsafeState({
    runStatus: "AWAITING_APPROVAL",
    rollback: {
      status: "clean",
      restored: 0,
      deleted: 0,
      manualInspectionRequired: false,
      dirtyFiles: [],
      failedPaths: [],
      summary: "ok",
    },
  });
  assert.equal(a.unsafe, false);
  assert.equal(a.primaryReason, null);
  assert.equal(a.headline, null);
  assert.equal(a.errorCode, null);
  assert.equal(a.displayStatus, null);
});

test("unsafe: ROLLBACK_INCOMPLETE runStatus alone trips the assessment", () => {
  const a = assessUnsafeState({ runStatus: "ROLLBACK_INCOMPLETE" });
  assert.equal(a.unsafe, true);
  assert.equal(a.primaryReason, "rollback_incomplete");
  assert.equal(a.errorCode, "unsafe_state");
  assert.equal(a.displayStatus, "CONTAMINATED_WORKSPACE");
  assert.match(String(a.headline), /CONTAMINATED WORKSPACE/);
});

test("unsafe: rollback.status='incomplete' with dirtyFiles surfaces them", () => {
  const a = assessUnsafeState({
    runStatus: "ROLLBACK_INCOMPLETE",
    rollback: {
      status: "incomplete",
      manualInspectionRequired: true,
      dirtyFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      failedPaths: [],
    },
  });
  assert.equal(a.unsafe, true);
  assert.deepEqual(a.dirtyFiles, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(a.primaryReason, "rollback_incomplete");
  assert.match(String(a.headline), /3 file\(s\) still dirty/);
});

test("unsafe: rollback_failed beats rollback_incomplete in severity order", () => {
  const a = assessUnsafeState({
    rollback: {
      status: "failed",
      manualInspectionRequired: true,
      failedPaths: ["src/x.ts"],
      dirtyFiles: ["src/y.ts"],
    },
  });
  assert.equal(a.primaryReason, "rollback_failed");
  assert.match(String(a.headline), /could not restore 1 file/);
});

test("unsafe: unsafe_state status surfaces with explanatory headline", () => {
  const a = assessUnsafeState({
    runStatus: "UNSAFE_STATE",
    rollback: { status: "unsafe_state", manualInspectionRequired: true, error: "EACCES" },
  });
  assert.equal(a.primaryReason, "unsafe_state");
  assert.match(String(a.headline), /rollback status check failed/);
});

test("unsafe: manual_inspection_required-only is the lowest severity", () => {
  const a = assessUnsafeState({
    rollback: {
      status: "clean",
      manualInspectionRequired: true,
      dirtyFiles: [],
      failedPaths: [],
    },
  });
  assert.equal(a.unsafe, true);
  assert.equal(a.primaryReason, "manual_inspection_required");
  assert.equal(a.displayStatus, "MANUAL_INSPECTION_REQUIRED");
});

test("unsafe via text: persisted ROLLBACK INCOMPLETE error string trips even when structured rollback is missing", () => {
  // This is the load-bearing case for older receipts written before
  // structured rollback was persisted on finalReceipt.
  const a = assessUnsafeState({
    runStatus: "EXECUTION_ERROR",
    errors: [
      "some other error",
      "ROLLBACK INCOMPLETE — 3 file(s) still dirty after rollback; manual inspection required",
    ],
  });
  assert.equal(a.unsafe, true);
  assert.equal(a.primaryReason, "manual_inspection_required");
});

test("unsafe via text: 'manual inspection required' alone is enough", () => {
  const a = assessUnsafeState({
    errors: ["something something — manual inspection required"],
  });
  assert.equal(a.unsafe, true);
});

test("dirtyFiles + failedPaths are deduped and capped at 50", () => {
  const many = Array.from({ length: 80 }, (_, i) => `src/dup.ts`);
  const distinct = Array.from({ length: 80 }, (_, i) => `src/${i}.ts`);
  const a = assessUnsafeState({
    rollback: {
      status: "incomplete",
      manualInspectionRequired: true,
      dirtyFiles: [...many, ...distinct],
      failedPaths: distinct,
    },
  });
  assert.equal(a.dirtyFiles.length, 50);
  assert.equal(a.failedPaths.length, 50);
  // Dedup sanity: 'src/dup.ts' should appear at most once, even though
  // we passed 80 copies.
  assert.equal(a.dirtyFiles.filter((f) => f === "src/dup.ts").length, 1);
});

test("assertSafeForApproval throws UnsafeStateError when unsafe", () => {
  assert.throws(
    () => assertSafeForApproval({ runStatus: "ROLLBACK_FAILED" }),
    (e: unknown) => e instanceof UnsafeStateError && (e as UnsafeStateError).code === "unsafe_state",
  );
});

test("assertSafeForApproval is a no-op on safe input", () => {
  assertSafeForApproval({ runStatus: "AWAITING_APPROVAL" });
  // no throw → ok
});

test("finalReceipt.rollback alone (no runStatus, no top-level rollback) trips the helper", () => {
  // Mirrors the production path where the rollback is persisted on
  // finalReceipt but the run's status string was already overwritten
  // by a later patchRun.
  const a = assessUnsafeState({
    finalReceipt: {
      rollback: {
        status: "incomplete",
        manualInspectionRequired: true,
        dirtyFiles: ["a.ts"],
        failedPaths: [],
      },
    },
  });
  assert.equal(a.unsafe, true);
  assert.equal(a.primaryReason, "rollback_incomplete");
});

test("buildInspectionPlan emits ONLY read-only commands by default + explicit-discard step", () => {
  const a = assessUnsafeState({
    runStatus: "ROLLBACK_INCOMPLETE",
    rollback: {
      status: "incomplete",
      manualInspectionRequired: true,
      dirtyFiles: ["src/foo.ts"],
      failedPaths: [],
    },
  });
  const plan = buildInspectionPlan(a, { workspacePath: "/ws/repo" });
  // The first three steps must be read-only (status, diff --stat, per-file diff)
  // No git restore / git reset in the read-only set.
  for (let i = 0; i < 3; i += 1) {
    const c = plan.steps[i].command ?? "";
    assert.doesNotMatch(c, /\b(restore|reset|clean)\b.*--/);
  }
  // Last step is the explicit discard step — must be marked with a
  // warning note so the operator knows it's not read-only.
  assert.match(plan.steps[3].command ?? "", /restore --source/);
  assert.ok(plan.steps[3].note && /discard/.test(plan.steps[3].note));
  assert.match(plan.warning, /Do NOT trust this workspace/);
});

test("buildInspectionPlan handles empty file lists with a generic worktree note", () => {
  const a = assessUnsafeState({ runStatus: "UNSAFE_STATE" });
  const plan = buildInspectionPlan(a);
  // Step 3 should advise inspecting the whole worktree when no files
  // are listed.
  assert.ok(plan.steps[2].note && /whole worktree/i.test(plan.steps[2].note));
});

test("multiple reasons are ordered and reflected in `reasons`", () => {
  const a = assessUnsafeState({
    runStatus: "ROLLBACK_INCOMPLETE",
    rollback: {
      status: "failed",
      manualInspectionRequired: true,
      dirtyFiles: [],
      failedPaths: ["x"],
    },
  });
  // Both rollback_failed (from rollback.status) AND rollback_incomplete
  // (from runStatus) should be in `reasons`, ordered by severity.
  assert.deepEqual([...a.reasons], ["rollback_failed", "rollback_incomplete", "manual_inspection_required"]);
  assert.equal(a.primaryReason, "rollback_failed");
});
