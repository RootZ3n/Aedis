import test from "node:test";
import assert from "node:assert/strict";

import { IntegrationJudge } from "./integration-judge.js";
import { CharterGenerator } from "./charter.js";
import { createIntent, type IntentObject } from "./intent.js";
import { createRunState, type RunState } from "./runstate.js";
import type { FileChange, WorkerResult } from "../workers/base.js";

// ─── Fixtures ────────────────────────────────────────────────────────

function makeIntent(userRequest = "fix the parser in src/parser.ts"): IntentObject {
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(userRequest);
  const charter = gen.generateCharter(analysis);
  return createIntent({
    runId: "test-run-adversarial",
    userRequest,
    charter,
    constraints: [],
  });
}

function makeRunState(intent: IntentObject): RunState {
  return createRunState(intent.id, intent.runId);
}

function scoutResult(readPaths: readonly string[]): WorkerResult {
  return {
    workerType: "scout",
    taskId: "scout",
    success: true,
    output: {
      kind: "scout",
      dependencies: [],
      patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "",
      inspections: {
        reads: readPaths.map((p) => ({ path: p, content: "", lineCount: 0 })),
        summaries: [],
        directoryListing: null,
        grepMatches: [],
        gitStatus: null,
        gitDiff: null,
        complexity: [],
      },
    } as any,
    issues: [],
    cost: { model: "test", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    confidence: 0.9,
    touchedFiles: readPaths.map((p) => ({ path: p, operation: "read" })),
    assumptions: [],
    durationMs: 1,
  };
}

function builderChange(path: string): FileChange {
  return {
    path,
    operation: "modify",
    diff: "@@ -1 +1 @@\n-a\n+b\n",
    content: "b",
    originalContent: "a",
  };
}

// ─── Phase 8.5 — consensus: scout reads zero files, builder changes files ──

test("integration-judge: scout read 0 files + builder changed N files → adversarial consensus downgrade (Phase 8.5)", () => {
  const intent = makeIntent("fix the parser in src/parser.ts");
  const runState = makeRunState(intent);
  const changes: FileChange[] = [builderChange("src/parser.ts")];
  const workers: WorkerResult[] = [scoutResult([])]; // scout read nothing

  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, workers, "pre-apply");

  const consensus = report.checks.find((c) => c.name === "Adversarial Consensus");
  assert.ok(consensus);
  // Before the fix this would have returned passed=true/score=1 with
  // the skipped-message. Now: passed (non-blocking) but severe score
  // → coherence penalty + warning in the judgment report.
  assert.equal(consensus!.passed, true, "non-blocking by design");
  assert.ok(consensus!.score <= 0.3, `score ${consensus!.score} should be severe`);
  assert.match(consensus!.details, /no corroboration/);
  assert.ok(report.warnings.some((w) => w.category === "adversarial-guard"));
});

test("integration-judge: scout read 0 files + builder changed 0 files → consensus skipped cleanly", () => {
  const intent = makeIntent("fix the parser in src/parser.ts");
  const runState = makeRunState(intent);
  const changes: FileChange[] = []; // no changes
  const workers: WorkerResult[] = [scoutResult([])];

  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, workers, "pre-apply");

  const consensus = report.checks.find((c) => c.name === "Adversarial Consensus");
  assert.ok(consensus);
  // No changes to evaluate — legitimately skipped, score stays high.
  assert.equal(consensus!.score, 1);
  assert.match(consensus!.details, /builder produced no changes/);
});

test("integration-judge: scout read N files + builder changed 0 files → consensus skipped cleanly", () => {
  const intent = makeIntent("fix the parser in src/parser.ts");
  const runState = makeRunState(intent);
  const changes: FileChange[] = [];
  const workers: WorkerResult[] = [scoutResult(["src/parser.ts", "src/lexer.ts"])];

  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, workers, "pre-apply");

  const consensus = report.checks.find((c) => c.name === "Adversarial Consensus");
  assert.ok(consensus);
  assert.equal(consensus!.score, 1);
  assert.match(consensus!.details, /builder produced no changes/);
});

test("integration-judge (P11): bugfix source+test change does not fail intent-alignment just because the test file is extra", () => {
  const intent = makeIntent("fix the parser in src/parser.ts");
  const runState = makeRunState(intent);
  const changes: FileChange[] = [
    {
      path: "src/parser.ts",
      operation: "modify",
      diff: "@@ -1 +1 @@\n-export function parse() { return 0; }\n+export function parse() { return 1; }\n",
      content: "export function parse() { return 1; }\n",
      originalContent: "export function parse() { return 0; }\n",
    },
    {
      path: "test/parser.test.ts",
      operation: "modify",
      diff: "@@ -1 +1 @@\n-expect(parse()).toBe(0)\n+expect(parse()).toBe(1)\n",
      content: "expect(parse()).toBe(1)\n",
      originalContent: "expect(parse()).toBe(0)\n",
    },
  ];

  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, [], "pre-apply");

  const intentCheck = report.checks.find((c) => c.name === "Intent Alignment");
  assert.ok(intentCheck);
  assert.equal(intentCheck!.passed, true);
  assert.doesNotMatch(intentCheck!.details, /Files changed outside deliverables/);
});

test("integration-judge (P11): whole-word removed export matching avoids substring false positives", () => {
  const intent = makeIntent("fix the parser in src/parser.ts");
  const runState = makeRunState(intent);
  const changes: FileChange[] = [
    {
      path: "src/source.ts",
      operation: "modify",
      diff: "@@ -1 +0,0 @@\n-export function parse() {}\n",
      content: "",
      originalContent: "export function parse() {}\n",
    },
    {
      path: "src/consumer.ts",
      operation: "modify",
      diff: "@@ -1 +1 @@\n-const x = parserMode\n+const x = parserMode\n",
      content: "const parserMode = true;\n",
      originalContent: "const parserMode = true;\n",
    },
  ];

  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, [], "pre-apply");

  const typeAlignment = report.checks.find((c) => c.name === "Type Alignment");
  assert.ok(typeAlignment);
  assert.equal(typeAlignment!.passed, true);
});
