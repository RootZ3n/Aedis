/**
 * Scope-lock pipeline tests — pinning the contract that catches the
 * burn-in 1-file → 9-files incident.
 *
 * Touches three layers:
 *   - prompt-sanitizer.ts: detects "do not modify anything else"
 *   - charter.ts: builds a Charter with scopeLock and skips test
 *     auto-injection when lockScope is set
 *   - integration-judge.ts: enforces the allowlist as a hard blocker
 *     regardless of the strictScope toggle
 */

import test from "node:test";
import assert from "node:assert/strict";

import { sanitizePromptForFileExtraction } from "./prompt-sanitizer.js";
import { CharterGenerator } from "./charter.js";
import { createIntent } from "./intent.js";
import { createRunState } from "./runstate.js";
import { IntegrationJudge } from "./integration-judge.js";
import type { FileChange, WorkerResult } from "../workers/base.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeChange(path: string): FileChange {
  return {
    path,
    operation: "modify",
    diff: "@@ -1 +1 @@\n-old\n+new\n",
    content: "new",
    originalContent: "old",
  };
}

const noWorkers: WorkerResult[] = [];

// ─── prompt-sanitizer: lockScope detection ───────────────────────────

test("sanitizer: 'do not modify anything else' sets lockScope=true (the burn-in-01 phrasing)", () => {
  const r = sanitizePromptForFileExtraction(
    "In core/run-summary.ts, add a comment '// burn-in: comment-swap probe.' Do not modify anything else.",
  );
  assert.equal(r.lockScope, true);
});

test("sanitizer: 'do not touch any other file' sets lockScope=true", () => {
  const r = sanitizePromptForFileExtraction(
    "In core/charter.ts, add a comment. Do not touch any other file.",
  );
  assert.equal(r.lockScope, true);
});

test("sanitizer: 'no other files should be modified' sets lockScope=true", () => {
  const r = sanitizePromptForFileExtraction(
    "Add a one-line comment to src/foo.ts. No other files should be modified.",
  );
  assert.equal(r.lockScope, true);
});

test("sanitizer: 'only modify core/x.ts' sets lockScope=true", () => {
  const r = sanitizePromptForFileExtraction("Only modify core/x.ts and append a comment.");
  assert.equal(r.lockScope, true);
});

test("sanitizer: lockScope is false when there is no catch-all phrase", () => {
  const r = sanitizePromptForFileExtraction("In core/x.ts, fix the bug.");
  assert.equal(r.lockScope, false);
});

test("sanitizer: literal 'do not modify anything else' inside quotes does NOT trip lockScope", () => {
  const r = sanitizePromptForFileExtraction(
    'Add a comment that says "do not modify anything else" to core/x.ts.',
  );
  assert.equal(r.lockScope, false, "quoted literals must not trigger the lock");
});

// ─── charter: lockScope plumbed through, no test auto-inject ─────────

test("charter: comment-only single-file prompt with lockScope does NOT auto-inject a test deliverable", () => {
  const gen = new CharterGenerator({ autoTestDeliverables: true });
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, add a comment '// burn-in: comment-swap probe.' Do not modify anything else.",
  );
  assert.equal(analysis.lockScope, true);
  const charter = gen.generateCharter(analysis);
  // Should be exactly one deliverable for run-summary.ts — no .test.ts pair.
  for (const d of charter.deliverables) {
    for (const t of d.targetFiles) {
      assert.doesNotMatch(t, /\.test\.ts$/, `unexpected test deliverable: ${t}`);
    }
  }
  assert.equal(charter.deliverables.length, 1);
});

test("charter: 'Do not modify anything else' creates an allowedFiles allowlist on the Charter", () => {
  const gen = new CharterGenerator({ autoTestDeliverables: true });
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, add a one-line comment. Do not modify anything else.",
  );
  const charter = gen.generateCharter(analysis);
  assert.ok(charter.scopeLock, "scopeLock must be present");
  assert.deepEqual([...charter.scopeLock.allowedFiles], ["core/run-summary.ts"]);
  assert.match(charter.scopeLock.reason, /do not modify anything else/i);
});

test("charter: prompt without a lock has scopeLock=null", () => {
  const gen = new CharterGenerator({ autoTestDeliverables: true });
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, fix the bug in formatVerdict.",
  );
  const charter = gen.generateCharter(analysis);
  assert.equal(charter.scopeLock, null);
});

test("charter: autoTest STILL fires for an unlocked code change (regression guard)", () => {
  const gen = new CharterGenerator({ autoTestDeliverables: true });
  const analysis = gen.analyzeRequest("In core/run-summary.ts, add a new exported helper.");
  const charter = gen.generateCharter(analysis);
  const hasTestDeliverable = charter.deliverables.some((d) =>
    d.targetFiles.some((t) => t.endsWith(".test.ts")),
  );
  assert.equal(hasTestDeliverable, true, "lock-off path must still produce a test deliverable");
});

// ─── integration-judge: scopeLock allowlist enforcement ──────────────

test("integration-judge: extra file outside scopeLock allowlist → scope_violation blocker", () => {
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, add a one-line comment. Do not modify anything else.",
  );
  const charter = gen.generateCharter(analysis);
  const intent = createIntent({
    runId: "scope-lock-test",
    userRequest: analysis.raw,
    charter,
    constraints: [],
  });
  const runState = createRunState(intent.id, intent.runId);

  // Builder touched the allowed file AND eight others.
  const changes: FileChange[] = [
    makeChange("core/run-summary.ts"),
    makeChange("core/run-summary.test.ts"),
    makeChange("core/charter.ts"),
    makeChange("core/coordinator.ts"),
    makeChange("core/intent.ts"),
    makeChange("core/change-set.ts"),
    makeChange("core/builder-tier-routing.ts"),
    makeChange("core/types.ts"),
    makeChange("core/multi-file-planner.ts"),
  ];

  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, noWorkers, "pre-apply");

  const scopeCheck = report.checks.find((c) => c.category === "scope-boundary");
  assert.ok(scopeCheck);
  assert.equal(scopeCheck.passed, false, "scope-boundary must fail");
  assert.match(scopeCheck.details, /scope_violation/);
  assert.match(scopeCheck.details, /outside the locked scope/);

  const blocker = report.blockers.find((b) => b.category === "scope-boundary");
  assert.ok(blocker, "scope-boundary failure must produce a blocker");
  assert.equal(report.passed, false, "judgment must fail overall");
  // Eight files outside scope.
  assert.equal(scopeCheck.affectedFiles.length, 8);
});

test("integration-judge: scopeLock enforcement is independent of strictScope=false", () => {
  // Even with permissive strictScope, the scope-lock allowlist must
  // block. The user explicitly said "no other files".
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, add a one-line comment. Do not modify anything else.",
  );
  const charter = gen.generateCharter(analysis);
  const intent = createIntent({
    runId: "scope-lock-strict-off",
    userRequest: analysis.raw,
    charter,
    constraints: [],
  });
  const runState = createRunState(intent.id, intent.runId);
  const changes: FileChange[] = [
    makeChange("core/run-summary.ts"),
    makeChange("core/charter.ts"),
  ];
  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake", strictScope: false });
  const report = judge.judge(intent, runState, changes, noWorkers, "pre-apply");
  const scopeCheck = report.checks.find((c) => c.category === "scope-boundary");
  assert.ok(scopeCheck);
  assert.equal(scopeCheck.passed, false, "lock must override strictScope=false");
});

test("integration-judge: when all changes are within the lock, scope-boundary passes", () => {
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(
    "In core/run-summary.ts, add a one-line comment. Do not modify anything else.",
  );
  const charter = gen.generateCharter(analysis);
  const intent = createIntent({
    runId: "scope-lock-clean",
    userRequest: analysis.raw,
    charter,
    constraints: [],
  });
  const runState = createRunState(intent.id, intent.runId);
  const changes: FileChange[] = [makeChange("core/run-summary.ts")];
  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, noWorkers, "pre-apply");
  const scopeCheck = report.checks.find((c) => c.category === "scope-boundary");
  assert.ok(scopeCheck);
  assert.equal(scopeCheck.passed, true, "single in-scope change must pass");
});

// ─── filesModified count consistency ─────────────────────────────────

test("scope-lock: judge.scopeCheck.affectedFiles count equals the number of out-of-scope changes", () => {
  // Pins the count consistency the user asked for: extra files
  // surfaced by the judge match the actual changes outside scope.
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(
    "In src/a.ts, append one line. Do not touch any other file.",
  );
  const charter = gen.generateCharter(analysis);
  const intent = createIntent({
    runId: "scope-lock-count",
    userRequest: analysis.raw,
    charter,
    constraints: [],
  });
  const runState = createRunState(intent.id, intent.runId);
  const changes: FileChange[] = [
    makeChange("src/a.ts"),
    makeChange("src/b.ts"),
    makeChange("src/c.ts"),
  ];
  const judge = new IntegrationJudge({ projectRoot: "/tmp/fake" });
  const report = judge.judge(intent, runState, changes, noWorkers, "pre-apply");
  const scopeCheck = report.checks.find((c) => c.category === "scope-boundary");
  assert.ok(scopeCheck);
  assert.equal(
    scopeCheck.affectedFiles.length,
    changes.length - 1,
    "affectedFiles count = total changes - allowlist size",
  );
  // Files reported must match the actual extra changes.
  assert.deepEqual(new Set(scopeCheck.affectedFiles), new Set(["src/b.ts", "src/c.ts"]));
});

// ─── burn-in-01 end-to-end shape ─────────────────────────────────────

test("scope-lock: burn-in-01 prompt produces a single-file deliverable + scopeLock (no decomposition)", () => {
  const burnIn01 =
    "In core/run-summary.ts, find the existing top-of-file comment block. " +
    "At the very end of that block, add a single new comment line that reads exactly: " +
    "'// burn-in: comment-swap probe.' Do not modify anything else.";
  const gen = new CharterGenerator({ autoTestDeliverables: true });
  const analysis = gen.analyzeRequest(burnIn01);
  assert.equal(analysis.lockScope, true);
  const charter = gen.generateCharter(analysis);
  // Exactly one deliverable, exactly one target — the file the user named.
  assert.equal(charter.deliverables.length, 1);
  assert.deepEqual([...charter.deliverables[0].targetFiles], ["core/run-summary.ts"]);
  assert.ok(charter.scopeLock);
  assert.deepEqual([...charter.scopeLock.allowedFiles], ["core/run-summary.ts"]);
});
