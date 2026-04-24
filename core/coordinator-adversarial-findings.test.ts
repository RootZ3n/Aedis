import test from "node:test";
import assert from "node:assert/strict";

import { collectAdversarialFindingsForConfidence } from "./coordinator.js";
import type { ExecutionGateDecision } from "./execution-gate.js";
import type { JudgmentReport } from "./integration-judge.js";
import type { WorkerResult } from "../workers/base.js";

test("collectAdversarialFindingsForConfidence aggregates scout, execution-gate, and judge signals", () => {
  const workerResults: WorkerResult[] = [
    {
      workerType: "scout",
      taskId: "task-scout",
      success: true,
      output: {
        kind: "scout",
        dependencies: [],
        patterns: [],
        riskAssessment: { level: "low", factors: [], mitigations: [] },
        suggestedApproach: "inspect",
        inspections: {
          reads: [],
          summaries: [],
          directoryListing: null,
          grepMatches: [],
          gitStatus: null,
          gitDiff: null,
          complexity: [],
          injectionFindings: [
            {
              code: "injection.override",
              severity: "escalate",
              message: "possible instruction-override directive embedded in repo text",
              ref: "README.md",
            },
          ],
        },
      } as WorkerResult["output"],
      issues: [],
      cost: { model: "test", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      confidence: 0.9,
      touchedFiles: [],
      assumptions: [],
      durationMs: 1,
    },
  ];

  const executionDecision: ExecutionGateDecision = {
    verdict: "no_op",
    executionVerified: false,
    evidence: [],
    workerReceipts: [],
    reason: "No-op execution detected",
    contentIdentityFindings: [
      {
        code: "execution.content_identity",
        severity: "downgrade",
        message: "modify operation produced no real change",
        ref: "src/utils.ts",
      },
    ],
    counts: {
      filesCreated: 0,
      filesModified: 0,
      filesDeleted: 0,
      evidenceItems: 0,
      workerReceipts: 0,
    },
  };

  const judgmentReport: JudgmentReport = {
    id: "judge-1",
    intentId: "intent-1",
    runId: "run-1",
    timestamp: new Date().toISOString(),
    phase: "pre-apply",
    checks: [
      {
        name: "Adversarial Consensus",
        category: "adversarial-guard",
        passed: true,
        score: 0.3,
        details: "builder touched 1 file(s); none were identified by scout",
        affectedFiles: ["src/other.ts"],
      },
      {
        name: "Adversarial Intent",
        category: "adversarial-guard",
        passed: true,
        score: 0.6,
        details: "intent-satisfaction score 0.20 — changes may not address the prompt",
        affectedFiles: ["src/other.ts"],
      },
    ],
    passed: true,
    coherenceScore: 0.82,
    blockers: [],
    warnings: [],
    summary: "warnings present",
  };

  const findings = collectAdversarialFindingsForConfidence(
    workerResults,
    executionDecision,
    judgmentReport,
  );

  assert.deepEqual(
    findings.map((f) => [f.code, f.severity]),
    [
      ["injection.override", "escalate"],
      ["execution.content_identity", "downgrade"],
      ["judge.adversarial_consensus", "downgrade"],
      ["judge.adversarial_intent", "warn"],
    ],
  );
});

test("collectAdversarialFindingsForConfidence deduplicates identical findings", () => {
  const repeated = {
    code: "execution.content_identity",
    severity: "downgrade" as const,
    message: "modify operation produced no real change",
    ref: "src/utils.ts",
  };

  const findings = collectAdversarialFindingsForConfidence(
    [],
    {
      verdict: "no_op",
      executionVerified: false,
      evidence: [],
      workerReceipts: [],
      reason: "No-op execution detected",
      contentIdentityFindings: [repeated, repeated],
      counts: {
        filesCreated: 0,
        filesModified: 0,
        filesDeleted: 0,
        evidenceItems: 0,
        workerReceipts: 0,
      },
    },
    null,
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "execution.content_identity");
});
