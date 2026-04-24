import test from "node:test";
import assert from "node:assert/strict";

import { scoreConfidence, type ConfidenceInput } from "./confidence-gate.js";
import type { GuardFinding } from "./adversarial-guard.js";

function base(overrides: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    testsPassed: true,
    integrationPassed: true,
    criticIterations: 0,
    impactLevel: "low",
    ...overrides,
  };
}

test("scoreConfidence: clean low-impact run → high", () => {
  const r = scoreConfidence(base());
  assert.equal(r.level, "high");
  assert.equal(r.escalationRecommended, undefined);
});

test("scoreConfidence: tests failed → low (pre-Phase-8 behavior preserved)", () => {
  const r = scoreConfidence(base({ testsPassed: false }));
  assert.equal(r.level, "low");
  assert.match(r.reasons.join(" "), /tests failed/);
});

test("scoreConfidence (Phase 8): adversarial downgrade finding forces low", () => {
  const findings: GuardFinding[] = [
    {
      code: "execution.content_identity",
      severity: "downgrade",
      message: "file byte-identical to original",
    },
  ];
  const r = scoreConfidence(base({ adversarialFindings: findings }));
  assert.equal(r.level, "low");
  assert.match(r.reasons.join(" "), /content_identity/);
  assert.equal(r.escalationRecommended, false);
});

test("scoreConfidence (Phase 8): escalate-severity finding flags escalation", () => {
  const findings: GuardFinding[] = [
    {
      code: "injection.override",
      severity: "escalate",
      message: "instruction-override in repo text",
    },
  ];
  const r = scoreConfidence(base({ adversarialFindings: findings }));
  assert.equal(r.level, "low");
  assert.equal(r.escalationRecommended, true);
});

test("scoreConfidence (Phase 8): warn-severity finding caps at medium on an otherwise-clean run", () => {
  const findings: GuardFinding[] = [
    {
      code: "consensus.partial_agreement",
      severity: "warn",
      message: "scout↔builder 40% agreement",
    },
  ];
  const r = scoreConfidence(base({ adversarialFindings: findings }));
  assert.equal(r.level, "medium");
  assert.match(r.reasons.join(" "), /adversarial warnings/);
});

test("scoreConfidence (Phase 8): empty findings array does not change behavior", () => {
  const r = scoreConfidence(base({ adversarialFindings: [] }));
  assert.equal(r.level, "high");
});

test("scoreConfidence (Phase 8): downgrade finding overrides a would-be-high path", () => {
  // Everything else says HIGH; the downgrade finding drags it to LOW.
  const r = scoreConfidence(
    base({
      impactLevel: "low",
      criticIterations: 0,
      adversarialFindings: [
        {
          code: "intent.no_files_changed",
          severity: "downgrade",
          message: "no files changed",
        },
      ],
    }),
  );
  assert.equal(r.level, "low");
});
