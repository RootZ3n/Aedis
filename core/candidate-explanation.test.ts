import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSelectionExplanation,
  type Candidate,
} from "./candidate.js";

function makeCandidate(overrides: Partial<Candidate>): Candidate {
  return {
    workspaceId: overrides.workspaceId ?? "primary",
    role: overrides.role ?? "primary",
    workspacePath: "/tmp/ws",
    patchArtifact: null,
    verifierVerdict: overrides.verifierVerdict ?? "pass",
    criticalFindings: overrides.criticalFindings ?? 0,
    costUsd: overrides.costUsd ?? 0.01,
    latencyMs: overrides.latencyMs ?? 100,
    status: overrides.status ?? "passed",
    reason: overrides.reason ?? "",
    advisoryFindings: overrides.advisoryFindings,
    requiredDeliverablesCompleted: overrides.requiredDeliverablesCompleted ?? true,
    testsPassed: overrides.testsPassed ?? true,
    typecheckPassed: overrides.typecheckPassed ?? true,
    confidence: overrides.confidence,
    changedFiles: overrides.changedFiles ?? [],
    lane: overrides.lane,
    provider: overrides.provider,
    model: overrides.model,
  };
}

test("buildSelectionExplanation: empty input → null winner, no shadow promote", () => {
  const ex = buildSelectionExplanation([]);
  assert.equal(ex.winnerWorkspaceId, null);
  assert.equal(ex.winnerRole, null);
  assert.equal(ex.summaries.length, 0);
  // Architectural invariant: shadow can never promote.
  assert.equal(ex.shadowPromoteAllowed, false);
});

test("buildSelectionExplanation: single primary candidate → selected, no tiebreak fired", () => {
  const primary = makeCandidate({ workspaceId: "primary", role: "primary" });
  const ex = buildSelectionExplanation([primary]);
  assert.equal(ex.winnerWorkspaceId, "primary");
  assert.equal(ex.winnerRole, "primary");
  assert.equal(ex.summaries.length, 1);
  assert.equal(ex.summaries[0].outcome, "selected");
  assert.equal(ex.advisoryAffected, false);
  assert.equal(ex.costAffected, false);
  assert.equal(ex.rolePreferenceUsed, false);
});

test("buildSelectionExplanation: shadow with fewer advisories wins → advisoryAffected=true", () => {
  const primary = makeCandidate({
    workspaceId: "primary",
    role: "primary",
    advisoryFindings: 3,
  });
  const shadow = makeCandidate({
    workspaceId: "shadow-1",
    role: "shadow",
    advisoryFindings: 0,
  });
  const ex = buildSelectionExplanation([primary, shadow]);
  assert.equal(ex.winnerWorkspaceId, "shadow-1");
  assert.equal(ex.advisoryAffected, true);
  const winnerRow = ex.summaries.find((s) => s.outcome === "selected");
  assert.ok(winnerRow);
  assert.match(winnerRow!.reason, /advisor/i);
});

test("buildSelectionExplanation: role-preference tiebreak fires only on full tie", () => {
  const primary = makeCandidate({
    workspaceId: "primary",
    role: "primary",
    advisoryFindings: 1,
    costUsd: 0.05,
    changedFiles: ["a.ts", "b.ts"],
    lane: "local",
  });
  const shadow = makeCandidate({
    workspaceId: "shadow-1",
    role: "shadow",
    advisoryFindings: 1,
    costUsd: 0.05,
    changedFiles: ["a.ts", "b.ts"],
    lane: "local",
  });
  const ex = buildSelectionExplanation([primary, shadow]);
  assert.equal(ex.winnerWorkspaceId, "primary", "primary must win on full tie");
  assert.equal(ex.rolePreferenceUsed, true);
  // Shadow row carries the "primary preferred on tie" reason.
  const shadowRow = ex.summaries.find((s) => s.workspaceId === "shadow-1");
  assert.ok(shadowRow);
  assert.equal(shadowRow!.outcome, "lost");
  assert.match(shadowRow!.reason, /primary preferred on tie/i);
});

test("buildSelectionExplanation: disqualified candidates appear with reason and never win", () => {
  const passingPrimary = makeCandidate({ workspaceId: "primary", role: "primary" });
  const failingShadow = makeCandidate({
    workspaceId: "shadow-1",
    role: "shadow",
    criticalFindings: 2,
  });
  const ex = buildSelectionExplanation([passingPrimary, failingShadow]);
  assert.equal(ex.winnerWorkspaceId, "primary");
  const failedRow = ex.summaries.find((s) => s.workspaceId === "shadow-1");
  assert.ok(failedRow);
  assert.equal(failedRow!.outcome, "disqualified");
  assert.match(failedRow!.reason, /criticalFindings=2/);
  // Architectural invariant: shadow promote-allowed always false even
  // when shadow is the only qualified candidate.
  assert.equal(ex.shadowPromoteAllowed, false);
});

test("buildSelectionExplanation: every passing candidate's selection note never marks shadow as promotable", () => {
  // Even when the shadow is the only passing candidate and would be
  // selected, the explanation's `shadowPromoteAllowed` field stays
  // false — the runtime promote guard owns the actual block; this
  // field exists so the UI can surface the invariant.
  const failingPrimary = makeCandidate({
    workspaceId: "primary",
    role: "primary",
    status: "failed",
  });
  const passingShadow = makeCandidate({
    workspaceId: "shadow-1",
    role: "shadow",
  });
  const ex = buildSelectionExplanation([failingPrimary, passingShadow]);
  assert.equal(ex.winnerRole, "shadow");
  assert.equal(ex.shadowPromoteAllowed, false);
});
