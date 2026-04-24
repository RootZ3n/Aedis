import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyResult,
  computeMetrics,
  detectRegressions,
  listTrials,
  loadPreviousTrial,
  loadTrial,
  persistTrial,
  runTrial,
  type ReliabilityTask,
  type TaskResult,
  type Trial,
} from "./reliability-harness.js";
import {
  gateRefusedReceipt,
  HttpTaskRunner,
  normalizeReceipt,
  type RunnerReceipt,
  type TaskRunner,
} from "./reliability-runner.js";

// ─── Phase 9 — failureCode → ErrorType mapping ──────────────────────

function mkRunReceipt(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    verdict: "failed",
    executionVerified: false,
    executionEvidence: [],
    commitSha: null,
    iterations: 1,
    totalCost: { usd: 0 },
    verificationReceipt: null,
    humanSummary: null,
    executionGateReason: "Execution failed — placeholder",
    ...overrides,
  };
}

const FAILURE_CODE_CASES: { code: string; want: string }[] = [
  { code: "no-op",             want: "empty_diff" },
  { code: "merge-blocked",     want: "merge_blocked" },
  { code: "merge-invariant",   want: "merge_blocked" },
  { code: "merge-typecheck",   want: "compile_fail" },
  { code: "merge-lint",        want: "lint_fail" },
  { code: "verification-fail", want: "verification_low" },
  { code: "verify-typecheck",  want: "compile_fail" },
  { code: "verify-test",       want: "test_fail" },
  { code: "worker-issue",      want: "worker_issue" },
  { code: "failed-nodes",      want: "worker_issue" },
  { code: "runtime-error",     want: "runtime_exception" },
  { code: "permission-denied", want: "runtime_exception" },
  { code: "missing-path",      want: "runtime_exception" },
  { code: "empty-graph",       want: "graph_empty" },
  { code: "timeout",           want: "timeout" },
];

for (const c of FAILURE_CODE_CASES) {
  test(`classifyResult (Phase 9): failureCode="${c.code}" → ${c.want}`, () => {
    const raw = mkRunReceipt({
      humanSummary: { failureExplanation: { code: c.code } },
    });
    const receipt = normalizeReceipt(raw);
    assert.ok(receipt, "normalizeReceipt should accept the synthetic blob");
    const r = classifyResult({
      task: task({ id: `stress-${c.code}` }),
      trialId: "T",
      receipt,
      error: null,
      startedAt: "2026-04-21T00:00:00.000Z",
      finishedAt: "2026-04-21T00:00:10.000Z",
    });
    assert.equal(r.outcome, "failure");
    assert.equal(r.errorType, c.want, `${c.code} should map to ${c.want}, got ${r.errorType}`);
    // failureCode is echoed into notes so dashboards can drill down
    // even when the mapping is coarser than the raw code.
    assert.ok(r.notes.some((n) => n.includes(`failureCode=${c.code}`)));
  });
}

test("classifyResult (Phase 9): unknown failureCode still lands in unknown bucket but note carries raw code", () => {
  const raw = mkRunReceipt({
    humanSummary: { failureExplanation: { code: "brand-new-thing" } },
  });
  const receipt = normalizeReceipt(raw);
  assert.ok(receipt);
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt,
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(r.errorType, "execution_unverified");
  // executionVerified=false in the fixture; that dominates.
  // The raw code is still preserved on notes for the dashboard.
  assert.ok(r.notes.some((n) => n.includes("failureCode=brand-new-thing")));
});

test("classifyResult (Phase 9): failed verdict + executionVerified=false, no humanSummary → execution_unverified", () => {
  // This is the exact shape coordinator produces on an execution-gate
  // no_op that happened before verification ran. Before Phase 9 this
  // produced "unknown".
  const raw = mkRunReceipt({
    executionVerified: false,
    executionGateReason: "No-op execution detected: no files were created, modified, or deleted",
    humanSummary: null,
  });
  const receipt = normalizeReceipt(raw);
  assert.ok(receipt);
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt,
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(r.errorType, "execution_unverified");
  assert.ok(r.notes.some((n) => n.includes("executionGateReason=No-op")));
});

test("classifyResult (Phase 9): verification stages drive compile_fail when humanSummary missing", () => {
  const raw = mkRunReceipt({
    executionVerified: true,
    verificationReceipt: {
      verdict: "fail",
      passed: false,
      stages: [
        { kind: "typecheck", passed: false },
        { kind: "tests", passed: true },
      ],
    },
    humanSummary: null,
  });
  const receipt = normalizeReceipt(raw);
  assert.ok(receipt);
  assert.equal(receipt!.compileFailed, true);
  assert.equal(receipt!.testsFailed, false);
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt,
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(r.errorType, "compile_fail");
});

test("classifyResult (Phase 9): verification stages drive lint_fail when humanSummary missing", () => {
  const raw = mkRunReceipt({
    executionVerified: true,
    verificationReceipt: {
      verdict: "fail",
      stages: [{ kind: "lint", passed: false }],
    },
    humanSummary: null,
  });
  const receipt = normalizeReceipt(raw);
  assert.ok(receipt);
  assert.equal(receipt!.lintFailed, true);
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt,
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(r.errorType, "lint_fail");
});

test("normalizeReceipt (Phase 9): extracts changed files from coordinator executionEvidence kind/ref shape", () => {
  const receipt = normalizeReceipt({
    verdict: "success",
    executionVerified: true,
    executionEvidence: [
      { kind: "file_modified", ref: "src/utils.ts" },
      { kind: "file_created", ref: "src/new.ts" },
      { kind: "verifier_pass", ref: "verify-1" },
    ],
    totalCost: { estimatedCostUsd: 0.25 },
    verificationReceipt: { confidenceScore: 0.9, verdict: "pass", stages: [] },
  });
  assert.ok(receipt);
  assert.deepEqual(receipt!.filesChanged, ["src/utils.ts", "src/new.ts"]);
  assert.equal(receipt!.costUsd, 0.25);
  assert.equal(receipt!.verificationConfidence, 0.9);
});

test("normalizeReceipt (Phase 9): verdict=fail marks verificationFailed without legacy passed=false", () => {
  const receipt = normalizeReceipt({
    verdict: "failed",
    executionVerified: true,
    executionEvidence: [],
    totalCost: { estimatedCostUsd: 0 },
    verificationReceipt: {
      verdict: "fail",
      stages: [],
    },
  });
  assert.ok(receipt);
  assert.equal(receipt!.verificationFailed, true);
});

// ─── Regression guards: preserve Phase 8 behavior for already-classified failures ──

test("classifyResult (Phase 9 guard): ambiguous_prompt from gateRefusedReceipt still classifies as ambiguous_prompt", () => {
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt: gateRefusedReceipt("ambiguous_prompt", "which file?"),
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(r.errorType, "ambiguous_prompt");
});

test("classifyResult (Phase 12): empty-graph and ambiguous_prompt stay distinct buckets", () => {
  // The clarification gate (gateRefusedReceipt) produces
  // ambiguous_prompt; the planner's empty-graph failure produces
  // graph_empty. Pinning both in a single test makes the contract
  // explicit so a future mapping change can't silently re-merge them.
  const ambiguous = classifyResult({
    task: task(),
    trialId: "T",
    receipt: gateRefusedReceipt("ambiguous_prompt", "which file?"),
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  const emptyGraphRaw = mkRunReceipt({
    humanSummary: { failureExplanation: { code: "empty-graph" } },
  });
  const emptyGraphReceipt = normalizeReceipt(emptyGraphRaw);
  assert.ok(emptyGraphReceipt);
  const emptyGraph = classifyResult({
    task: task(),
    trialId: "T",
    receipt: emptyGraphReceipt,
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(ambiguous.errorType, "ambiguous_prompt");
  assert.equal(emptyGraph.errorType, "graph_empty");
  assert.notEqual(ambiguous.errorType, emptyGraph.errorType);
});

test("classifyResult (Phase 9 guard): needs_decomposition from gateRefusedReceipt unchanged", () => {
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt: gateRefusedReceipt("needs_decomposition", "too big"),
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(r.errorType, "needs_decomposition");
});

// ─── Fixtures ────────────────────────────────────────────────────────

function task(overrides: Partial<ReliabilityTask> = {}): ReliabilityTask {
  return {
    id: "bugfix-utils-off-by-one",
    taskType: "bugfix",
    repoPath: "/tmp/fake",
    difficulty: "easy",
    prompt: "fix off-by-one in utils.ts",
    ...overrides,
  };
}

function receipt(overrides: Partial<RunnerReceipt> = {}): RunnerReceipt {
  return {
    verdict: "success",
    executionVerified: true,
    filesChanged: ["src/utils.ts"],
    commitSha: "abc123",
    iterations: 1,
    costUsd: 0.05,
    verificationConfidence: 0.8,
    diffLines: 12,
    ...overrides,
  };
}

class StubRunner implements TaskRunner {
  constructor(
    private readonly map: Map<string, RunnerReceipt | Error>,
  ) {}
  async run(t: ReliabilityTask): Promise<RunnerReceipt> {
    const r = this.map.get(t.id);
    if (!r) throw new Error(`no stub response for ${t.id}`);
    if (r instanceof Error) throw r;
    return r;
  }
}

let clock = 0;
function resetClock(start = 1_700_000_000_000) {
  clock = start;
}
function tick(step = 1_000): number {
  clock += step;
  return clock;
}

// ─── classifyResult ─────────────────────────────────────────────────

test("classifyResult: success verdict with evidence and good confidence → success", () => {
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt: receipt(),
    error: null,
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:01:00.000Z",
  });
  assert.equal(r.outcome, "success");
  assert.equal(r.errorType, "none");
  assert.equal(r.durationMs, 60_000);
  assert.deepEqual(r.filesChanged, ["src/utils.ts"]);
});

test("classifyResult: success verdict but no files changed → failure/empty_diff", () => {
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt: receipt({ filesChanged: [] }),
    error: null,
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:00:30.000Z",
  });
  assert.equal(r.outcome, "failure");
  assert.equal(r.errorType, "empty_diff");
});

test("classifyResult: executionVerified=false → failure/execution_unverified", () => {
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt: receipt({ executionVerified: false }),
    error: null,
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:00:30.000Z",
  });
  assert.equal(r.outcome, "failure");
  assert.equal(r.errorType, "execution_unverified");
});

test("classifyResult: expectedFiles not touched → downgrades to weak_success (non-bugfix path)", () => {
  // Note: this test pins the general "target missed" rule for
  // non-bugfix tasks. Bugfix tasks get the stricter P10.1 must-modify
  // rule, tested separately.
  const r = classifyResult({
    task: task({ taskType: "feature", expectedFiles: ["src/expected.ts"] }),
    trialId: "T",
    receipt: receipt({ filesChanged: ["src/other.ts"] }),
    error: null,
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:00:30.000Z",
  });
  assert.equal(r.outcome, "weak_success");
  assert.match(r.notes.join(" "), /expected files not touched/);
});

test("classifyResult: low verification confidence → weak_success/verification_low", () => {
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt: receipt({ verificationConfidence: 0.2 }),
    error: null,
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:00:30.000Z",
  });
  assert.equal(r.outcome, "weak_success");
  assert.equal(r.errorType, "verification_low");
});

test("classifyResult: partial verdict → weak_success", () => {
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt: receipt({ verdict: "partial" }),
    error: null,
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:00:30.000Z",
  });
  assert.equal(r.outcome, "weak_success");
});

test("classifyResult: failed verdict → failure, preserves errorType hint", () => {
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt: receipt({
      verdict: "failed",
      errorType: "compile_fail",
    }),
    error: null,
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:00:30.000Z",
  });
  assert.equal(r.outcome, "failure");
  assert.equal(r.errorType, "compile_fail");
});

test("classifyResult: gateRefusedReceipt with ambiguous_prompt propagates as failure/ambiguous_prompt (stress suite regression)", () => {
  const r = classifyResult({
    task: task({ id: "stress-03-divide-by-zero" }),
    trialId: "T",
    receipt: gateRefusedReceipt("ambiguous_prompt", "which file?"),
    error: null,
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:00:20.000Z",
  });
  assert.equal(r.outcome, "failure");
  assert.equal(r.errorType, "ambiguous_prompt");
  assert.equal(r.rawVerdict, "failed");
  // 20s duration survives classification; callers can see it was fast
  // not stuck, which rules out timeout and runtime_exception.
  assert.equal(r.durationMs, 20_000);
});

test("classifyResult: gateRefusedReceipt with needs_decomposition classifies distinctly", () => {
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt: gateRefusedReceipt("needs_decomposition", "too big"),
    error: null,
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:00:20.000Z",
  });
  assert.equal(r.outcome, "failure");
  assert.equal(r.errorType, "needs_decomposition");
});

test("HttpTaskRunner: needs_clarification response returns a gate-refused receipt (does NOT throw)", async () => {
  let posts = 0;
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.endsWith("/tasks")) {
      posts++;
      return new Response(
        JSON.stringify({
          status: "needs_clarification",
          question: "Which file or function should I modify?",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error("unexpected URL: " + u);
  }) as typeof fetch;

  const runner = new HttpTaskRunner({
    apiBase: "http://example.invalid",
    fetcher: fakeFetch,
    pollIntervalMs: 1,
    defaultTimeoutMs: 1000,
  });
  const receipt = await runner.run({
    id: "stress-03",
    taskType: "bugfix",
    repoPath: "/tmp/x",
    difficulty: "easy",
    prompt: "Fix divide function",
  });
  assert.equal(posts, 1);
  assert.equal(receipt.verdict, "failed");
  assert.equal(receipt.errorType, "ambiguous_prompt");
  assert.equal(receipt.filesChanged.length, 0);
});

test("HttpTaskRunner: needs_decomposition response returns a gate-refused receipt (does NOT poll)", async () => {
  let posts = 0;
  let gets = 0;
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.endsWith("/tasks")) {
      posts++;
      return new Response(
        JSON.stringify({
          status: "needs_decomposition",
          task_id: "plan_abc",
          plan: { waves: [] },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/receipts")) {
      gets++;
      return new Response("{}", { status: 200 });
    }
    throw new Error("unexpected URL: " + u);
  }) as typeof fetch;

  const runner = new HttpTaskRunner({
    apiBase: "http://example.invalid",
    fetcher: fakeFetch,
    pollIntervalMs: 1,
    defaultTimeoutMs: 500,
  });
  const receipt = await runner.run({
    id: "t",
    taskType: "refactor",
    repoPath: "/tmp/x",
    difficulty: "medium",
    prompt: "rewrite everything",
  });
  assert.equal(posts, 1);
  assert.equal(gets, 0, "runner must NOT poll after a decomposition refusal");
  assert.equal(receipt.errorType, "needs_decomposition");
});

test("classifyResult: no receipt + timeout error → failure/timeout", () => {
  const r = classifyResult({
    task: task(),
    trialId: "T",
    receipt: null,
    error: { type: "timeout", message: "deadline exceeded" },
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:05:00.000Z",
  });
  assert.equal(r.outcome, "failure");
  assert.equal(r.errorType, "timeout");
  assert.equal(r.rawVerdict, "timeout");
});

// ─── runTrial (batch execution) ─────────────────────────────────────

// ─── Phase 10 — behavioral improvements ──────────────────────────────

test("classifyResult (P10.1): bugfix task + success verdict + target file NOT touched → failure/empty_diff with must-modify note", () => {
  const r = classifyResult({
    task: task({
      id: "stress-01-off-by-one",
      taskType: "bugfix",
      expectedFiles: ["src/utils.ts"],
    }),
    trialId: "T",
    receipt: receipt({
      verdict: "success",
      executionVerified: true,
      filesChanged: ["docs/README.md"], // builder modified an unrelated file
    }),
    error: null,
    startedAt: "2026-04-21T00:00:00.000Z",
    finishedAt: "2026-04-21T00:00:10.000Z",
  });
  // Before P10.1 this was weak_success. Now: silent-failure is
  // promoted to real failure because the declared target was never
  // modified.
  assert.equal(r.outcome, "failure");
  assert.equal(r.errorType, "empty_diff");
  assert.ok(
    r.notes.some((n) => /bugfix must-modify/.test(n)),
    `notes should mention must-modify: ${r.notes.join(" | ")}`,
  );
});

test("classifyResult (P10.1 edge): bugfix must-modify failure is not downgraded by minDiffLines or low confidence", () => {
  const r = classifyResult({
    task: task({
      id: "stress-01-edge",
      taskType: "bugfix",
      expectedFiles: ["./src/utils.ts"],
      minDiffLines: 99,
    }),
    trialId: "T",
    receipt: receipt({
      verdict: "success",
      executionVerified: true,
      verificationConfidence: 0.2,
      diffLines: 1,
      filesChanged: ["docs/README.md"],
    }),
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(r.outcome, "failure");
  assert.equal(r.errorType, "empty_diff");
  assert.ok(r.notes.some((n) => /bugfix must-modify/.test(n)));
  assert.ok(!r.notes.some((n) => /verification confidence/.test(n)));
});

test("classifyResult (P10.1 guard): bugfix task + at least one target touched → stays on existing path (weak_success only if others missing)", () => {
  const r = classifyResult({
    task: task({
      taskType: "bugfix",
      expectedFiles: ["src/utils.ts", "src/other.ts"],
    }),
    trialId: "T",
    receipt: receipt({
      verdict: "success",
      executionVerified: true,
      filesChanged: ["src/utils.ts"], // one of two targets touched
    }),
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  // Touched at least one target → keeps the Phase 8 behavior:
  // weak_success with "expected files not touched" note. Does NOT
  // escalate to failure.
  assert.equal(r.outcome, "weak_success");
  assert.equal(r.errorType, "none");
  assert.ok(!r.notes.some((n) => /bugfix must-modify/.test(n)));
});

test("classifyResult (P10.1 guard): must-modify path matching tolerates leading ./ on expectedFiles", () => {
  const r = classifyResult({
    task: task({
      taskType: "bugfix",
      expectedFiles: ["./src/utils.ts"],
    }),
    trialId: "T",
    receipt: receipt({
      verdict: "success",
      executionVerified: true,
      filesChanged: ["src/utils.ts"],
    }),
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(r.outcome, "success");
  assert.equal(r.errorType, "none");
});

test("classifyResult (P10.1 guard): feature task + target not touched → stays weak_success (only bugfix is must-modify)", () => {
  const r = classifyResult({
    task: task({
      taskType: "feature",
      expectedFiles: ["src/new.ts"],
    }),
    trialId: "T",
    receipt: receipt({
      verdict: "success",
      executionVerified: true,
      filesChanged: ["src/other.ts"],
    }),
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  // Feature: the existing weak_success semantics hold — P10.1 does
  // not extend the must-modify rule beyond bugfix to avoid flipping
  // correctly-working feature outcomes.
  assert.equal(r.outcome, "weak_success");
});

test("runTrial (P10.2): simple task that empty_diffs gets ONE retry with stricter prompt; retry passes → final result is success", async () => {
  let calls = 0;
  const promptsSeen: string[] = [];
  const runner: TaskRunner = {
    async run(t: ReliabilityTask): Promise<RunnerReceipt> {
      calls++;
      promptsSeen.push(t.prompt);
      if (calls === 1) {
        // First attempt: verdict success but zero files — empty_diff.
        return receipt({
          verdict: "success",
          executionVerified: true,
          filesChanged: [],
        });
      }
      // Retry: succeeds and touches the target.
      return receipt({
        verdict: "success",
        executionVerified: true,
        filesChanged: ["src/utils.ts"],
      });
    },
  };
  const trial = await runTrial({
    runner,
    tasks: [
      task({
        id: "salvage-candidate",
        taskType: "bugfix",
        difficulty: "easy",
        expectedFiles: ["src/utils.ts"],
      }),
    ],
  });
  assert.equal(calls, 2, "runner should be invoked twice (original + salvage retry)");
  // Retry prompt must be intentionally different from the original.
  assert.notEqual(promptsSeen[0], promptsSeen[1]);
  assert.match(promptsSeen[1], /RETRY|previous attempt modified zero files/);
  assert.match(promptsSeen[1], /src\/utils\.ts/);
  // Final outcome reflects the retry result.
  const result = trial.results[0];
  assert.equal(result.outcome, "success");
  assert.ok(
    result.notes.some((n) => /salvage-retry/.test(n)),
    `notes must record the retry: ${result.notes.join(" | ")}`,
  );
});

test("runTrial (P10.2): retry that also produces empty_diff ends as failure (retry annotated)", async () => {
  const runner: TaskRunner = {
    async run(_t: ReliabilityTask): Promise<RunnerReceipt> {
      return receipt({
        verdict: "success",
        executionVerified: true,
        filesChanged: [],
      });
    },
  };
  const trial = await runTrial({
    runner,
    tasks: [
      task({
        id: "salvage-fail",
        taskType: "bugfix",
        difficulty: "easy",
        expectedFiles: ["src/utils.ts"],
      }),
    ],
  });
  const result = trial.results[0];
  assert.equal(result.outcome, "failure");
  assert.equal(result.errorType, "empty_diff");
  assert.ok(result.notes.some((n) => /salvage-retry/.test(n)));
  assert.ok(result.notes.some((n) => /salvage-first-outcome: failure/.test(n)));
});

test("runTrial (P10.2 edge): retry that touches the wrong file does not become fake success", async () => {
  let calls = 0;
  const runner: TaskRunner = {
    async run(_t: ReliabilityTask): Promise<RunnerReceipt> {
      calls++;
      if (calls === 1) {
        return receipt({
          verdict: "success",
          executionVerified: true,
          filesChanged: [],
        });
      }
      return receipt({
        verdict: "success",
        executionVerified: true,
        filesChanged: ["docs/README.md"],
      });
    },
  };
  const trial = await runTrial({
    runner,
    tasks: [
      task({
        id: "salvage-wrong-file",
        taskType: "bugfix",
        difficulty: "easy",
        expectedFiles: ["src/utils.ts"],
      }),
    ],
  });
  const result = trial.results[0];
  assert.equal(calls, 2);
  assert.equal(result.outcome, "failure");
  assert.equal(result.errorType, "empty_diff");
  assert.ok(result.notes.some((n) => /salvage-retry/.test(n)));
  assert.ok(result.notes.some((n) => /bugfix must-modify/.test(n)));
});

test("runTrial (P10.2 guard): salvage retry does NOT fire for hard difficulty", async () => {
  let calls = 0;
  const runner: TaskRunner = {
    async run(_t: ReliabilityTask): Promise<RunnerReceipt> {
      calls++;
      return receipt({
        verdict: "success",
        executionVerified: true,
        filesChanged: [],
      });
    },
  };
  await runTrial({
    runner,
    tasks: [
      task({
        id: "no-salvage",
        taskType: "refactor",
        difficulty: "hard",
        expectedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      }),
    ],
  });
  assert.equal(calls, 1, "hard/multi-file tasks must not trigger a retry");
});

test("runTrial (P10.2 guard): salvage retry does NOT fire for non-bugfix/feature tasks even when easy", async () => {
  let calls = 0;
  const runner: TaskRunner = {
    async run(_t: ReliabilityTask): Promise<RunnerReceipt> {
      calls++;
      return receipt({
        verdict: "success",
        executionVerified: true,
        filesChanged: [],
      });
    },
  };
  await runTrial({
    runner,
    tasks: [
      task({
        id: "no-salvage-refactor",
        taskType: "refactor",
        difficulty: "easy",
        expectedFiles: ["src/utils.ts"],
      }),
    ],
  });
  assert.equal(calls, 1);
});

test("runTrial (P10.2 guard): salvage retry does NOT fire for ambiguous_prompt (gate refusal stays truthful)", async () => {
  let calls = 0;
  const runner: TaskRunner = {
    async run(_t: ReliabilityTask): Promise<RunnerReceipt> {
      calls++;
      return {
        verdict: "failed",
        executionVerified: false,
        filesChanged: [],
        commitSha: null,
        iterations: 0,
        costUsd: 0,
        verificationConfidence: 0,
        errorType: "ambiguous_prompt",
      };
    },
  };
  const trial = await runTrial({
    runner,
    tasks: [
      task({
        id: "ambig",
        difficulty: "easy",
        expectedFiles: ["src/utils.ts"],
      }),
    ],
  });
  assert.equal(calls, 1, "ambiguous_prompt must not be retried");
  assert.equal(trial.results[0].errorType, "ambiguous_prompt");
});

test("classifyResult (P10.3): simple targeted task that touches files outside expectedFiles → scout-bias note appears", () => {
  const r = classifyResult({
    task: task({
      taskType: "bugfix",
      difficulty: "easy",
      expectedFiles: ["src/utils.ts"],
    }),
    trialId: "T",
    receipt: receipt({
      verdict: "success",
      executionVerified: true,
      // Target WAS touched, plus two unrelated files → warning, not
      // a downgrade. Outcome stays success.
      filesChanged: ["src/utils.ts", "src/a.ts", "src/b.ts"],
    }),
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.equal(r.outcome, "success");
  assert.ok(
    r.notes.some((n) => /scout-bias/.test(n) && /outside declared targets/.test(n)),
    `scout-bias note missing: ${r.notes.join(" | ")}`,
  );
});

test("classifyResult (P10.3 guard): scout-bias note does NOT fire for hard / multi-file tasks", () => {
  const r = classifyResult({
    task: task({
      taskType: "refactor",
      difficulty: "medium",
      expectedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    }),
    trialId: "T",
    receipt: receipt({
      verdict: "success",
      executionVerified: true,
      filesChanged: ["src/a.ts", "src/d.ts"],
    }),
    error: null,
    startedAt: "x",
    finishedAt: "x",
  });
  assert.ok(!r.notes.some((n) => /scout-bias/.test(n)));
});

// ─── End Phase 10 tests ──────────────────────────────────────────────

test("runTrial: batches tasks, collects results, computes metrics", async () => {
  resetClock();
  const tasks: ReliabilityTask[] = [
    task({ id: "t1" }),
    task({ id: "t2", taskType: "feature" }),
    task({ id: "t3", taskType: "refactor" }),
  ];
  const runner = new StubRunner(
    new Map<string, RunnerReceipt | Error>([
      ["t1", receipt()],
      ["t2", receipt({ verdict: "partial", filesChanged: ["a.ts"] })],
      ["t3", new Error("runner crashed")],
    ]),
  );

  const trial = await runTrial({
    runner,
    tasks,
    label: "unit-test",
    now: () => tick(1_000),
  });

  assert.equal(trial.label, "unit-test");
  assert.equal(trial.results.length, 3);
  assert.equal(trial.results[0].outcome, "success");
  assert.equal(trial.results[1].outcome, "weak_success");
  assert.equal(trial.results[2].outcome, "failure");
  assert.equal(trial.results[2].errorType, "runtime_exception");
  assert.ok(trial.trialId.startsWith("trial-"));
  assert.equal(trial.metrics.total, 3);
  assert.equal(trial.metrics.successes, 1);
  assert.equal(trial.metrics.weakSuccesses, 1);
  assert.equal(trial.metrics.failures, 1);
});

test("runTrial: progress callback fires per task in order", async () => {
  const tasks: ReliabilityTask[] = [task({ id: "a" }), task({ id: "b" })];
  const runner = new StubRunner(
    new Map<string, RunnerReceipt | Error>([
      ["a", receipt()],
      ["b", receipt()],
    ]),
  );
  const seen: string[] = [];
  await runTrial({
    runner,
    tasks,
    onProgress: (r, i) => seen.push(`${i}:${r.taskId}`),
  });
  assert.deepEqual(seen, ["0:a", "1:b"]);
});

// ─── computeMetrics ─────────────────────────────────────────────────

test("computeMetrics: aggregates by task type, clusters errors, computes cost per success", () => {
  const base: Omit<
    TaskResult,
    "outcome" | "errorType" | "taskId" | "taskType" | "costUsd"
  > = {
    trialId: "T",
    difficulty: "easy",
    repoPath: "/tmp/fake",
    startedAt: "x",
    finishedAt: "x",
    durationMs: 1,
    verificationConfidence: 0.8,
    iterations: 2,
    commitSha: null,
    filesChanged: [],
    rawVerdict: "success",
    notes: [],
  };
  const results: TaskResult[] = [
    { ...base, taskId: "a", taskType: "bugfix", outcome: "success", errorType: "none", costUsd: 0.1 },
    { ...base, taskId: "b", taskType: "bugfix", outcome: "failure", errorType: "compile_fail", costUsd: 0.2 },
    { ...base, taskId: "c", taskType: "feature", outcome: "failure", errorType: "compile_fail", costUsd: 0.3 },
    { ...base, taskId: "d", taskType: "feature", outcome: "weak_success", errorType: "verification_low", costUsd: 0.1 },
  ];
  const m = computeMetrics(results);
  assert.equal(m.total, 4);
  assert.equal(m.successes, 1);
  assert.equal(m.weakSuccesses, 1);
  assert.equal(m.failures, 2);
  assert.equal(m.strictSuccessRate, 0.25);
  assert.equal(m.successRate, 0.5);
  assert.equal(m.avgIterations, 2);
  // cost per success = total cost / successes = 0.7 / 1
  assert.ok(Math.abs(m.costPerSuccessUsd - 0.7) < 1e-9);

  const bugfix = m.byTaskType["bugfix"];
  assert.equal(bugfix.count, 2);
  assert.equal(bugfix.successRate, 0.5);

  // Error clustering: compile_fail has 2, verification_low has 1
  const topCluster = m.errorClusters[0];
  assert.equal(topCluster.errorType, "compile_fail");
  assert.equal(topCluster.count, 2);
  assert.deepEqual([...topCluster.taskIds].sort(), ["b", "c"]);
});

test("computeMetrics: costPerSuccessUsd is Infinity when zero successes", () => {
  const m = computeMetrics([]);
  assert.equal(m.costPerSuccessUsd, Number.POSITIVE_INFINITY);
});

// ─── detectRegressions ─────────────────────────────────────────────

test("detectRegressions: flags previously-successful task that now fails", () => {
  const prev = makeTrial("prev", [
    makeResult("prev", "shared", "success"),
    makeResult("prev", "stable", "success"),
    makeResult("prev", "dropped", "success"),
  ]);
  const curr = makeTrial("curr", [
    makeResult("curr", "shared", "failure"),
    makeResult("curr", "stable", "success"),
    makeResult("curr", "new", "success"),
  ]);
  const report = detectRegressions(prev, curr);
  assert.equal(report.regressed, 1);
  assert.equal(report.recovered, 0);
  assert.deepEqual(report.newTasks, ["new"]);
  assert.deepEqual(report.droppedTasks, ["dropped"]);
  const entry = report.entries.find((e) => e.taskId === "shared");
  assert.ok(entry);
  assert.equal(entry!.severity, "regression");
  assert.equal(entry!.previousOutcome, "success");
  assert.equal(entry!.currentOutcome, "failure");
});

test("detectRegressions: failure→success counts as recovery, success→weak as degradation", () => {
  const prev = makeTrial("prev", [
    makeResult("prev", "fixed", "failure"),
    makeResult("prev", "degrades", "success"),
  ]);
  const curr = makeTrial("curr", [
    makeResult("curr", "fixed", "success"),
    makeResult("curr", "degrades", "weak_success"),
  ]);
  const report = detectRegressions(prev, curr);
  assert.equal(report.recovered, 1);
  assert.equal(report.degraded, 1);
  assert.equal(report.regressed, 0);
});

// ─── Persistence + round-trip ──────────────────────────────────────

test("persistTrial + listTrials + loadTrial round-trip", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-reliability-"));
  try {
    const trial = makeTrial("round-trip", [
      makeResult("round-trip", "t1", "success"),
    ]);
    await persistTrial(root, trial);

    const loaded = await loadTrial(root, trial.trialId);
    assert.ok(loaded);
    assert.equal(loaded!.trialId, trial.trialId);
    assert.equal(loaded!.results[0].taskId, "t1");

    const listed = await listTrials(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].trialId, trial.trialId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadPreviousTrial picks the most recent prior trial", async () => {
  const root = mkdtempSync(join(tmpdir(), "aedis-reliability-"));
  try {
    const older = makeTrial("older", [makeResult("older", "t1", "success")], "2026-04-19T00:00:00.000Z");
    const newer = makeTrial("newer", [makeResult("newer", "t1", "failure")], "2026-04-20T00:00:00.000Z");
    const current = makeTrial(
      "current",
      [makeResult("current", "t1", "failure")],
      "2026-04-21T00:00:00.000Z",
    );
    await persistTrial(root, older);
    await persistTrial(root, newer);
    await persistTrial(root, current);

    const prev = await loadPreviousTrial(root, current);
    assert.ok(prev);
    assert.equal(prev!.trialId, newer.trialId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Helpers ────────────────────────────────────────────────────────

function makeResult(
  trialId: string,
  taskId: string,
  outcome: TaskResult["outcome"],
): TaskResult {
  return {
    taskId,
    trialId,
    taskType: "bugfix",
    difficulty: "easy",
    repoPath: "/tmp/fake",
    startedAt: "x",
    finishedAt: "x",
    durationMs: 1,
    outcome,
    errorType: outcome === "failure" ? "compile_fail" : "none",
    verificationConfidence: 0.8,
    iterations: 1,
    costUsd: 0.05,
    commitSha: null,
    filesChanged: [],
    rawVerdict: outcome,
    notes: [],
  };
}

function makeTrial(
  id: string,
  results: TaskResult[],
  startedAt = "2026-04-21T00:00:00.000Z",
): Trial {
  return {
    trialId: `trial-${id}`,
    label: id,
    startedAt,
    finishedAt: startedAt,
    aedisVersion: "test",
    results,
    metrics: computeMetrics(results),
  };
}
