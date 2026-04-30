import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInactiveCandidatesBlock,
  buildLoquiDecisionView,
  buildRunDetailResponse,
  projectCandidatesFromReceipt,
} from "./run-contracts.js";

// ─── Loqui decision projection ─────────────────────────────────────

test("buildLoquiDecisionView: scoped-build signal flips the explicit flag", () => {
  const view = buildLoquiDecisionView({
    intent: "build",
    action: "build",
    label: "Building",
    confidence: 1,
    reason: "Scoped build request",
    signals: ["build:imperative-build", "build:scoped-build-signal"],
  });
  assert.equal(view.scopedBuildSignal, true);
  assert.equal(view.safeFallbackSuppressed, true, "no safe-fallback when scoped-build fires");
  assert.equal(view.intent, "build");
  assert.equal(view.confidence, 1);
});

test("buildLoquiDecisionView: safe-fallback fired → safeFallbackSuppressed stays false", () => {
  const view = buildLoquiDecisionView({
    intent: "question",
    action: "clarify",
    label: "Clarifying",
    confidence: 0.4,
    reason: "Ambiguous between build and question; defaulting for safety",
    signals: ["build:refactor-verbs", "safe-fallback:question-vs-build"],
  });
  assert.equal(view.scopedBuildSignal, false);
  assert.equal(view.safeFallbackSuppressed, false);
});

test("buildLoquiDecisionView: tolerant of partial input", () => {
  const view = buildLoquiDecisionView({});
  assert.equal(view.intent, "unknown");
  assert.equal(view.confidence, 0);
  assert.deepEqual(view.signals, []);
  assert.equal(view.scopedBuildSignal, false);
  assert.equal(view.safeFallbackSuppressed, false);
});

// ─── Inactive candidates block ─────────────────────────────────────

test("buildInactiveCandidatesBlock: defaults explain shadow inactive and pin shadowPromoteAllowed=false", () => {
  const block = buildInactiveCandidatesBlock();
  assert.equal(block.shadowMode, "inactive");
  assert.equal(block.laneMode, "primary_only");
  assert.match(block.inactiveReason, /shadow workspace inactive/i);
  assert.equal(block.candidates.length, 0);
  assert.equal(block.selection.shadowPromoteAllowed, false);
  assert.match(block.selection.note, /only primary/i);
});

test("buildInactiveCandidatesBlock: respects an explicit reason", () => {
  const block = buildInactiveCandidatesBlock("primary_only", "Local-smoke profile is active.");
  assert.equal(block.inactiveReason, "Local-smoke profile is active.");
  assert.equal(block.shadowMode, "inactive");
});

// ─── Run-detail envelope passes the new blocks through ─────────────

// ─── Manifest projection ───────────────────────────────────────────

test("projectCandidatesFromReceipt: null receipt → inactive block, primary_only, shadowPromoteAllowed=false", () => {
  const block = projectCandidatesFromReceipt(null);
  assert.equal(block.shadowMode, "inactive");
  assert.equal(block.laneMode, "primary_only");
  assert.equal(block.candidates.length, 0);
  assert.equal(block.selection.shadowPromoteAllowed, false);
});

test("projectCandidatesFromReceipt: primary-only manifest → shadowMode inactive, primary card carries model/provider", () => {
  const block = projectCandidatesFromReceipt({
    laneMode: "primary_only",
    selectedCandidateWorkspaceId: "primary",
    candidates: [
      {
        workspaceId: "primary",
        role: "primary",
        lane: "cloud",
        provider: "openrouter",
        model: "xiaomi/mimo-v2.5",
        status: "passed",
        disqualification: null,
        costUsd: 0.012,
        latencyMs: 1500,
        verifierVerdict: "pass",
        reason: "primary candidate",
      },
    ],
  });
  assert.equal(block.shadowMode, "inactive");
  assert.equal(block.candidates.length, 1);
  const primary = block.candidates[0];
  assert.equal(primary.role, "primary");
  assert.equal(primary.provider, "openrouter");
  assert.equal(primary.model, "xiaomi/mimo-v2.5");
  assert.equal(primary.outcome, "selected");
});

test("projectCandidatesFromReceipt: shadow manifest carries model/provider/status; shadow can never be marked promotable", () => {
  const block = projectCandidatesFromReceipt({
    laneMode: "local_vs_cloud",
    selectedCandidateWorkspaceId: "shadow-1",
    candidates: [
      {
        workspaceId: "primary",
        role: "primary",
        lane: "local",
        provider: "ollama",
        model: "qwen3.5:9b",
        status: "passed",
        disqualification: null,
        costUsd: 0,
        latencyMs: 1100,
        verifierVerdict: "pass",
        reason: "primary candidate",
      },
      {
        workspaceId: "shadow-1",
        role: "shadow",
        lane: "cloud",
        provider: "openrouter",
        model: "xiaomi/mimo-v2.5",
        status: "passed",
        disqualification: null,
        costUsd: 0.014,
        latencyMs: 2200,
        verifierVerdict: "pass",
        reason: "shadow candidate",
      },
    ],
  });
  assert.equal(block.shadowMode, "active");
  assert.equal(block.candidates.length, 2);
  const shadow = block.candidates.find((c) => c.role === "shadow");
  assert.ok(shadow);
  assert.equal(shadow!.provider, "openrouter");
  assert.equal(shadow!.model, "xiaomi/mimo-v2.5");
  assert.equal(shadow!.status, "passed");
  // Architectural invariant: even when the shadow is the selected
  // winner, the block tells the UI that shadow cannot promote.
  assert.equal(block.selection.shadowPromoteAllowed, false);
  assert.equal(block.selection.winnerWorkspaceId, "shadow-1");
  assert.equal(block.selection.winnerRole, "shadow");
});

test("projectCandidatesFromReceipt: disqualified shadow renders with reason", () => {
  const block = projectCandidatesFromReceipt({
    laneMode: "local_vs_cloud",
    selectedCandidateWorkspaceId: "primary",
    candidates: [
      {
        workspaceId: "primary",
        role: "primary",
        lane: "local",
        provider: "ollama",
        model: "qwen3.5:9b",
        status: "passed",
        disqualification: null,
        costUsd: 0,
        latencyMs: 1100,
        verifierVerdict: "pass",
        reason: "primary candidate",
      },
      {
        workspaceId: "shadow-1",
        role: "shadow",
        lane: "cloud",
        provider: "openrouter",
        model: "xiaomi/mimo-v2.5",
        status: "failed",
        disqualification: "criticalFindings=2",
        costUsd: 0.005,
        latencyMs: 1800,
        verifierVerdict: "fail",
        reason: "critical injection finding",
      },
    ],
  });
  const shadow = block.candidates.find((c) => c.role === "shadow");
  assert.ok(shadow);
  assert.equal(shadow!.outcome, "disqualified");
  assert.equal(shadow!.disqualification, "criticalFindings=2");
});

test("buildRunDetailResponse passes loqui + candidates through unchanged", () => {
  const detail = buildRunDetailResponse({
    id: "run-1",
    taskId: "task-1",
    runId: "run-1",
    status: "COMPLETE",
    prompt: "fix auth flow",
    submittedAt: "2026-04-28T10:00:00.000Z",
    completedAt: "2026-04-28T10:01:00.000Z",
    receipt: null,
    filesChanged: [],
    summary: {
      classification: "VERIFIED_SUCCESS",
      headline: "done",
      narrative: "",
      verification: "pass",
    },
    confidence: { overall: 0.9 },
    errors: [],
    executionVerified: true,
    executionGateReason: null,
    blastRadius: null,
    totalCostUsd: 0.12,
    workerEvents: [],
    checkpoints: [],
    loqui: {
      intent: "build",
      action: "build",
      label: "Building",
      confidence: 1,
      reason: "Scoped build request",
      signals: ["build:scoped-build-signal"],
      scopedBuildSignal: true,
      safeFallbackSuppressed: true,
      clarification: "",
    },
    candidates: buildInactiveCandidatesBlock(),
  });
  assert.equal(detail.loqui?.scopedBuildSignal, true);
  assert.equal(detail.candidates?.shadowMode, "inactive");
  // Architectural invariant flowed through to the envelope.
  assert.equal(detail.candidates?.selection.shadowPromoteAllowed, false);
});
