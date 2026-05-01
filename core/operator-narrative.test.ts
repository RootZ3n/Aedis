import test from "node:test";
import assert from "node:assert/strict";

import {
  makeAwaitingApproval,
  makeBeforeEdit,
  makeInspectingFiles,
  makeModeSelected,
  makePlanDrafted,
  makeRiskAssessment,
  makeRunCompletedSummary,
  makeSafetyBlock,
  isOperatorNarrativeEvent,
  type OperatorNarrativeEvent,
} from "./operator-narrative.js";

// ─── Constructors are pure & shape-correct ───────────────────────────

test("makeRiskAssessment carries level, reasons, targets, and a readable headline", () => {
  const e = makeRiskAssessment({
    runId: "run-1",
    level: "medium",
    reasons: ["3 files in scope"],
    targets: ["a.ts", "b.ts", "c.ts"],
    scope: "multi-file",
    blastRadius: 5,
  });
  assert.equal(e.kind, "risk_assessment");
  assert.equal(e.runId, "run-1");
  assert.equal(e.level, "medium");
  assert.deepEqual([...e.reasons], ["3 files in scope"]);
  assert.match(e.headline, /MEDIUM/);
  assert.match(e.headline, /multi-file/);
  assert.match(e.detail, /3 files in scope/);
  assert.ok(typeof e.at === "string" && e.at.length > 0);
});

test("makeModeSelected exposes mode + reason + skipped stages", () => {
  const e = makeModeSelected({
    runId: "run-2",
    mode: "fast_review",
    reasonCode: "fast-eligible",
    reason: "Fast review: single-file docs change",
    skippedStages: ["critic-llm-review", "rehearsal-loop"],
    factors: ["impact:low", "targets:1"],
  });
  assert.equal(e.kind, "mode_selected");
  assert.equal(e.mode, "fast_review");
  assert.deepEqual([...e.skippedStages], ["critic-llm-review", "rehearsal-loop"]);
  assert.match(e.detail, /Skipping/);
});

test("makePlanDrafted emits headline scaled by step + file counts", () => {
  const e = makePlanDrafted({
    runId: "run-3",
    deliverables: [{ description: "Edit README", targetFiles: ["README.md"] }],
    targetFiles: ["README.md"],
    steps: ["Map seams", "Apply edits", "Verify"],
  });
  assert.equal(e.kind, "plan_drafted");
  assert.match(e.headline, /3 step.*1 file/);
  assert.match(e.detail, /Map seams.*Apply edits.*Verify/);
});

test("makeInspectingFiles records the actual files inspected", () => {
  const e = makeInspectingFiles({
    runId: "run-4",
    taskId: "task-x",
    trigger: "scout",
    files: ["src/foo.ts", "src/bar.ts"],
  });
  assert.equal(e.kind, "inspecting_files");
  assert.equal(e.trigger, "scout");
  assert.deepEqual([...e.files], ["src/foo.ts", "src/bar.ts"]);
});

test("makeBeforeEdit conveys the edit-imminent semantic", () => {
  const e = makeBeforeEdit({
    runId: "run-5",
    files: ["README.md"],
    deliverable: "Add changelog entry",
    mode: "fast_review",
  });
  assert.equal(e.kind, "before_edit");
  assert.match(e.headline, /Builder starting/);
  assert.match(e.detail, /fast_review/);
  assert.match(e.detail, /Add changelog entry/);
});

test("makeSafetyBlock names the gate and primary reason", () => {
  const e = makeSafetyBlock({
    runId: "run-6",
    gate: "merge_gate",
    primaryReason: "Critic rejected the diff",
    blockers: ["critic:final-reject: not aligned with intent"],
  });
  assert.equal(e.kind, "safety_block");
  assert.equal(e.gate, "merge_gate");
  assert.match(e.headline, /merge_gate/);
  assert.match(e.detail, /Critic rejected/);
});

test("makeAwaitingApproval lists remaining promotion steps", () => {
  const e = makeAwaitingApproval({
    runId: "run-7",
    changeCount: 3,
    mode: "standard_review",
    remainingSteps: ["Operator approves diff", "Commit", "Promote to source"],
  });
  assert.equal(e.kind, "awaiting_approval");
  assert.equal(e.changeCount, 3);
  assert.match(e.detail, /Operator approves diff/);
  assert.match(e.detail, /Promote to source/);
});

test("makeRunCompletedSummary reports classification, duration, files", () => {
  const e = makeRunCompletedSummary({
    runId: "run-8",
    classification: "VERIFIED_SUCCESS",
    verdict: "success",
    durationMs: 12345,
    filesChanged: 1,
  });
  assert.equal(e.kind, "run_completed_summary");
  assert.match(e.headline, /VERIFIED_SUCCESS/);
  assert.match(e.detail, /12345ms/);
  assert.match(e.detail, /1 file/);
});

// ─── Predicate ───────────────────────────────────────────────────────

test("isOperatorNarrativeEvent discriminates from look-alikes", () => {
  const e: OperatorNarrativeEvent = makeRiskAssessment({
    runId: "r", level: "low", reasons: [], targets: [], scope: "simple", blastRadius: 1,
  });
  assert.equal(isOperatorNarrativeEvent(e), true);
  assert.equal(isOperatorNarrativeEvent({}), false);
  assert.equal(isOperatorNarrativeEvent({ kind: "risk_assessment" }), false);
  assert.equal(isOperatorNarrativeEvent(null), false);
});
