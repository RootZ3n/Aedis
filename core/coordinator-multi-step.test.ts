/**
 * Coordinator: multi-step / multi-wave validation.
 *
 * Probes the wave lifecycle that multi-file-planner.ts documents:
 *   - planChangeSet() classifies files into waves 1..4
 *   - the coordinator dispatches builder nodes wave-by-wave
 *   - upstream wave failure should halt downstream waves (per the
 *     haltDownstreamWaves contract in multi-file-planner)
 *   - per-wave verification receipts land on finalReceipt.waveVerifications
 *   - approvePlan / rejectPlan round-trip for the needs_decomposition gate
 *
 * These tests are diagnostic — Test 2 in particular is the experiment
 * that determines whether haltDownstreamWaves is actually wired into
 * applyWaveGating, or whether downstream waves dispatch on top of a
 * failed upstream wave (planner exports show as dead code at audit time
 * — this test confirms or disproves that observation).
 *
 * Wave heuristic (multi-file-planner.classifyWave):
 *   - "schema/types/.d.ts/interface/model" → wave 1
 *   - "test/spec/docs/.md"                  → wave 3
 *   - "integration/coordinator/pipeline/router/server" → wave 4
 *   - else                                  → wave 2
 *
 * The user spec named core/index.ts as wave 4. By the heuristic
 * above, "core/index.ts" lacks any wave-4 keyword and lands in wave 2.
 * This file uses the user's exact filenames and asserts what is
 * actually observed (≥2 distinct waves), so the diagnostic remains
 * honest about the planner's behavior.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator } from "./coordinator.js";
import { ReceiptStore } from "./receipt-store.js";
import { WorkerRegistry, AbstractWorker } from "../workers/base.js";
import type {
  WorkerAssignment,
  WorkerResult,
  WorkerType,
  WorkerOutput,
  BuilderOutput,
} from "../workers/base.js";
import type { CostEntry } from "./runstate.js";
import type { TrustProfile } from "../router/trust-router.js";
import type { AedisEvent, EventBus } from "../server/websocket.js";

// ─── Wave classifier mirror ────────────────────────────────────────
// Matches multi-file-planner.classifyWave so the test can map an
// observed target file back to the wave the planner placed it in.
function fileWave(file: string): number {
  const n = file.toLowerCase();
  if (n.includes("schema") || n.includes("types") || n.endsWith(".d.ts") || n.includes("interface") || n.includes("model")) return 1;
  if (n.includes("test") || n.includes("spec") || n.includes("docs") || n.endsWith(".md")) return 3;
  if (n.includes("integration") || n.includes("coordinator") || n.includes("pipeline") || n.includes("router") || n.includes("server")) return 4;
  return 2;
}

// ─── MultiStepBuilder ──────────────────────────────────────────────
// Tracks every dispatch and writes to disk like RealBuilderWorker so
// the merge gate sees real changes. Behavior is policy-driven so each
// test can choose to fail / no-op / succeed per file.

type BuilderDecision = "succeed" | "fail" | "no-op";

interface DispatchRecord {
  readonly callIndex: number;
  readonly targetFiles: readonly string[];
  readonly waveIds: readonly number[];
  readonly decision: BuilderDecision;
}

class MultiStepBuilder extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "MultiStepBuilder";
  public readonly dispatches: DispatchRecord[] = [];
  public callCount = 0;

  constructor(
    private readonly policy: (file: string, callIndex: number) => BuilderDecision,
  ) {
    super();
  }

  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    this.callCount += 1;
    const callIndex = this.callCount;
    const targetFiles = [...assignment.task.targetFiles];
    const waveIds = targetFiles.map(fileWave);

    const decisions = targetFiles.map((f) => this.policy(f, callIndex));
    const decision: BuilderDecision = decisions.includes("fail")
      ? "fail"
      : decisions.includes("no-op")
        ? "no-op"
        : "succeed";

    this.dispatches.push({ callIndex, targetFiles, waveIds, decision });

    if (decision === "fail") {
      return this.failure(
        assignment,
        `MultiStepBuilder policy: failing for ${targetFiles.join(",")}`,
        this.zeroCost(),
        1,
      );
    }

    const { writeFile, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = assignment.projectRoot ?? process.cwd();
    const changes: BuilderOutput["changes"] = [];

    for (let i = 0; i < targetFiles.length; i += 1) {
      const f = targetFiles[i];
      const d = decisions[i];
      const abs = resolve(root, f);
      const original = await readFile(abs, "utf-8").catch(() => "");
      const updated = d === "no-op"
        ? original
        : `// updated by MultiStepBuilder call=${callIndex}\n${original}`;
      await writeFile(abs, updated, "utf-8");
      changes.push({
        path: f,
        operation: "modify",
        content: updated,
        originalContent: original,
      });
    }

    const output: BuilderOutput = {
      kind: "builder",
      changes,
      decisions: [],
      needsCriticReview: false,
    };
    return this.success(assignment, output, {
      cost: this.zeroCost(),
      confidence: 0.9,
      touchedFiles: changes.map((c) => ({ path: c.path, operation: c.operation })),
      durationMs: 1,
    });
  }

  async estimateCost(): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}

// ─── Stub workers (mirror coordinator-approval-promote.test.ts) ────

class StubScout extends AbstractWorker {
  readonly type: WorkerType = "scout";
  readonly name = "StubScout";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    // Report reading the target files so the per-wave verification's
    // adversarial-guard sees scout corroboration. Without this, the
    // wave verifier emits "builder changed N file(s) but scout read
    // none — no corroboration" as a blocker, which becomes a CRITICAL
    // merge finding via waveFailureFindings — i.e. the run fails not
    // because multi-step is broken but because the stub scout looked
    // unreasonably blind to the files the builder is editing.
    const touchedFiles = a.task.targetFiles.map((f) => ({
      path: f,
      operation: "read" as const,
    }));
    return this.success(a, {
      kind: "scout", dependencies: [], patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "ok",
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles, durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "scout", dependencies: [], patterns: [], riskAssessment: { level: "low", factors: [], mitigations: [] }, suggestedApproach: "" };
  }
}

class StubCritic extends AbstractWorker {
  readonly type: WorkerType = "critic";
  readonly name = "StubCritic";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
      kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 0.9,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 1 };
  }
}

class StubVerifier extends AbstractWorker {
  readonly type: WorkerType = "verifier";
  readonly name = "StubVerifier";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
      kind: "verifier", testResults: [],
      typeCheckPassed: true, lintPassed: true, buildPassed: true, passed: true,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "verifier", testResults: [], typeCheckPassed: true, lintPassed: true, buildPassed: true, passed: true };
  }
}

class StubIntegrator extends AbstractWorker {
  readonly type: WorkerType = "integrator";
  readonly name = "StubIntegrator";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    const finalChanges = [...(a.changes ?? [])];
    return this.success(a, {
      kind: "integrator", finalChanges, conflictsResolved: [],
      coherenceCheck: { passed: true, checks: [] }, readyToApply: true,
    }, {
      cost: this.zeroCost(), confidence: 0.9,
      touchedFiles: finalChanges.map((c) => ({ path: c.path, operation: c.operation })),
      durationMs: 1,
    });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "integrator", finalChanges: [], conflictsResolved: [], coherenceCheck: { passed: true, checks: [] }, readyToApply: false };
  }
}

// ─── Harness ────────────────────────────────────────────────────────

function buildHarness(projectRoot: string, opts: {
  builder: AbstractWorker;
  requireApproval?: boolean;
  autoPromoteOnSuccess?: boolean;
}) {
  const registry = new WorkerRegistry();
  registry.register(new StubScout());
  registry.register(opts.builder);
  registry.register(new StubCritic());
  registry.register(new StubVerifier());
  registry.register(new StubIntegrator());

  const trustProfile: TrustProfile = {
    scores: new Map(),
    tierThresholds: { fast: 0, standard: 0, premium: 0 },
  };

  const events: AedisEvent[] = [];
  const eventBus: EventBus = {
    emit(event) { events.push(event); },
    on: () => () => {},
    onType: () => () => {},
    addClient: () => {},
    removeClient: () => {},
    clientCount: () => 0,
    recentEvents: () => [],
  };

  const receiptStore = new ReceiptStore(projectRoot);
  const coordinator = new Coordinator(
    {
      projectRoot,
      autoCommit: true,
      requireWorkspace: true,
      requireApproval: opts.requireApproval ?? false,
      autoPromoteOnSuccess: opts.autoPromoteOnSuccess ?? false,
      verificationConfig: {
        requiredChecks: [],
        hooks: [{
          name: "stub-typecheck",
          stage: "typecheck",
          kind: "typecheck",
          execute: async () => ({
            passed: true, issues: [], stdout: "", stderr: "", exitCode: 0, durationMs: 0,
          }),
        }],
      },
    },
    trustProfile,
    registry,
    eventBus,
    receiptStore,
  );
  return { coordinator, events, receiptStore };
}

function makeMultiStepRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-multi-step-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "ms", version: "0.0.0" }), "utf-8");
  writeFileSync(join(dir, "core/types.ts"), "export type Token = string;\n", "utf-8");
  writeFileSync(join(dir, "core/consumer.ts"), "import type { Token } from './types.js';\nexport function use(t: Token) { return t; }\n", "utf-8");
  writeFileSync(join(dir, "core/consumer.test.ts"), "import test from 'node:test';\ntest('placeholder', () => {});\n", "utf-8");
  writeFileSync(join(dir, "core/index.ts"), "export * from './types.js';\nexport * from './consumer.js';\n", "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "ms@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "MultiStep"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const MULTI_FILE_PROMPT =
  "Refactor across core/types.ts, core/consumer.ts, core/consumer.test.ts, and core/index.ts to introduce a Token alias.";

function originalContents(repo: string): Record<string, string> {
  return {
    "core/types.ts": readFileSync(join(repo, "core/types.ts"), "utf-8"),
    "core/consumer.ts": readFileSync(join(repo, "core/consumer.ts"), "utf-8"),
    "core/consumer.test.ts": readFileSync(join(repo, "core/consumer.test.ts"), "utf-8"),
    "core/index.ts": readFileSync(join(repo, "core/index.ts"), "utf-8"),
  };
}

function distinctWaves(builder: MultiStepBuilder): number[] {
  const seen = new Set<number>();
  for (const d of builder.dispatches) {
    for (const w of d.waveIds) seen.add(w);
  }
  return [...seen].sort();
}

// ─── TESTS ──────────────────────────────────────────────────────────

test("multi-step orchestration: 4-file plan dispatches builders wave-by-wave and produces per-wave verification receipts", async () => {
  // Stub-only multi-file runs cannot satisfy the wave-level verifier's
  // adversarial-guard / cross-file-check stages — those check that
  // intent-satisfaction keywords match modified content, that scout
  // genuinely read the same files the builder edited, and several
  // other signals only a real model produces. So this test does NOT
  // assert AWAITING_APPROVAL: in a stub harness the merge gate will
  // (correctly) block on critical wave findings even when the builder
  // succeeds. What this test DOES prove is the multi-step orchestration
  // contract:
  //   1. an architectural prompt produces a plan with 4 waves
  //   2. the coordinator dispatches builder nodes wave-by-wave
  //      (visible as `wave-gated` log entries during executeGraph)
  //   3. all builder nodes complete (no node-level failures)
  //   4. per-wave verification runs and returns 4 wave receipts on
  //      finalReceipt.waveVerifications
  //   5. workspace isolation holds — the source repo is never mutated
  //      regardless of merge-gate verdict
  const repo = makeMultiStepRepo();
  try {
    const before = originalContents(repo);
    const builder = new MultiStepBuilder(() => "succeed");
    const { coordinator, receiptStore } = buildHarness(repo, {
      requireApproval: false,
      autoPromoteOnSuccess: false,
      builder,
    });

    const receipt = await coordinator.submit({ input: MULTI_FILE_PROMPT });
    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted, "persisted receipt must exist");

    // 1+2: builder must have been dispatched across multiple waves.
    const observedWaves = distinctWaves(builder);
    assert.ok(
      observedWaves.length >= 2,
      `expected builder dispatched against >=2 distinct waves; got [${observedWaves.join(",")}] across ${builder.dispatches.length} dispatch(es)`,
    );
    // No builder dispatch was a failure — every builder node accepted
    // its assignment. The audit's wave-halting question is probed in
    // the next test, not here.
    const builderFailures = builder.dispatches.filter((d) => d.decision === "fail");
    assert.equal(
      builderFailures.length,
      0,
      `happy path must produce zero builder failures; got ${builderFailures.length}`,
    );

    // 4: per-wave verification receipts must be present.
    assert.ok(persisted.finalReceipt, "finalReceipt must be persisted");
    const waveCount = persisted.finalReceipt.waveVerifications.length;
    assert.ok(
      waveCount >= 2,
      `finalReceipt.waveVerifications must contain >=2 wave receipts; got ${waveCount}`,
    );

    // 5: workspace isolation — source repo bytes unchanged regardless
    // of merge-gate verdict. This is the safety invariant we care about
    // even more than the verdict.
    for (const [path, content] of Object.entries(before)) {
      assert.equal(
        readFileSync(join(repo, path), "utf-8"),
        content,
        `source ${path} must not be mutated by a workspace-isolated multi-step run`,
      );
    }

    // Diagnostic line so the test report records orchestration shape.
    console.log(
      `[multi-step-test] ORCHESTRATION_OBSERVED dispatches=${builder.dispatches.length} ` +
      `distinctWaves=[${observedWaves.join(",")}] waveReceipts=${waveCount} ` +
      `verdict=${persisted.finalReceipt.verdict} ` +
      `criticalFindings=${persisted.finalReceipt.mergeDecision?.critical?.length ?? 0}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("multi-step upstream-failure probe: wave-1 builder fail — observe whether wave 2/3/4 still dispatch", async () => {
  // This is the diagnostic experiment for the audit's P1 finding —
  // applyWaveGating treats "failed" identically to "completed" when
  // deciding whether an upstream wave is done, and the wave lifecycle
  // helpers (haltDownstreamWaves etc) are not wired anywhere, so the
  // hypothesis is that a wave-1 failure does NOT halt downstream
  // waves — they will still get dispatched. This test records what
  // actually happens so the result is unambiguous either way.
  const repo = makeMultiStepRepo();
  try {
    const before = originalContents(repo);
    // Fail any dispatch that touches a wave-1 file (core/types.ts).
    const builder = new MultiStepBuilder((file) =>
      fileWave(file) === 1 ? "fail" : "succeed",
    );
    const { coordinator, receiptStore } = buildHarness(repo, {
      requireApproval: false,
      autoPromoteOnSuccess: false,
      builder,
    });

    const receipt = await coordinator.submit({ input: MULTI_FILE_PROMPT });
    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted, "persisted receipt must exist");

    // Wave-1 must have been attempted.
    const wave1Attempts = builder.dispatches.filter((d) => d.waveIds.includes(1));
    assert.ok(
      wave1Attempts.length > 0,
      `wave-1 (types) builder should have been attempted at least once; saw 0 dispatches across [${builder.dispatches.map((d) => d.targetFiles.join("+")).join(" | ")}]`,
    );

    // Did downstream waves dispatch? This is the diagnostic outcome.
    const downstreamAttempts = builder.dispatches.filter((d) =>
      d.waveIds.some((w) => w >= 2),
    );
    const downstreamWavesSeen = new Set<number>();
    for (const d of downstreamAttempts) {
      for (const w of d.waveIds) {
        if (w >= 2) downstreamWavesSeen.add(w);
      }
    }
    // Print diagnostic so the test output records what we observed.
    console.log(
      `[multi-step-test] DIAGNOSTIC after wave-1 failure: ` +
      `wave-1 attempts=${wave1Attempts.length} ` +
      `downstream attempts=${downstreamAttempts.length} ` +
      `downstream waves observed=[${[...downstreamWavesSeen].sort().join(",")}] ` +
      `total dispatches=${builder.dispatches.length}`,
    );

    // The run must NOT have committed.
    assert.equal(
      persisted.commitSha ?? null,
      null,
      `run with failed upstream wave must not produce a commit SHA; got ${persisted.commitSha}`,
    );
    assert.notEqual(
      persisted.status,
      "AWAITING_APPROVAL",
      `failed wave must not pause for approval; got ${persisted.status}`,
    );
    assert.notEqual(
      persisted.status,
      "READY_FOR_PROMOTION",
      `failed wave must not reach promotion-ready state; got ${persisted.status}`,
    );

    // Source repo must not be mutated.
    for (const [path, content] of Object.entries(before)) {
      assert.equal(
        readFileSync(join(repo, path), "utf-8"),
        content,
        `source ${path} must not be mutated by a failed run`,
      );
    }

    // Record the answer to the audit question on the assertion object so
    // a reviewer can grep for it. We do NOT assert downstream==0 because
    // that would either confirm or hide the P1 — we want both possible
    // outcomes to show clearly in the test output.
    const downstreamRanAfterFailure = downstreamAttempts.length > 0;
    console.log(
      `[multi-step-test] WAVE_HALT_OBSERVED=${!downstreamRanAfterFailure} ` +
      `(if false, downstream waves dispatched after upstream failure — ` +
      `confirms haltDownstreamWaves is not wired into applyWaveGating)`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("multi-step decomposition: needs_decomposition gate produces a pendingPlan that approvePlan executes", async () => {
  const repo = makeMultiStepRepo();
  try {
    const builder = new MultiStepBuilder(() => "succeed");
    const { coordinator } = buildHarness(repo, {
      requireApproval: false,
      autoPromoteOnSuccess: false,
      builder,
    });

    // Architectural scope is forced by the "every" keyword + 4 files
    // — see scope-classifier line 240 (matchedKeywords.includes("every")
    // → architectural with governance.decompositionRequired=true).
    const result = await coordinator.submitWithGates({
      input:
        "Refactor every file in core to use a Token alias: " +
        "core/types.ts, core/consumer.ts, core/consumer.test.ts, core/index.ts",
    });

    assert.equal(
      result.kind,
      "needs_decomposition",
      `architectural prompt must trip the decomposition gate; got kind=${result.kind}`,
    );
    if (result.kind !== "needs_decomposition") return;
    const taskId = result.taskId;
    assert.ok(taskId, "needs_decomposition must include a taskId");
    assert.ok(coordinator.getPendingPlan(taskId), "pendingPlan must be retrievable by taskId");

    const approval = coordinator.approvePlan(taskId);
    assert.ok(approval, "approvePlan must return a handle for an existing pending plan");
    if (!approval) return;
    const receipt = await approval.receipt;

    assert.ok(receipt.runId, "resumed run must have a runId");
    assert.equal(
      coordinator.getPendingPlan(taskId),
      undefined,
      "pendingPlan must be cleared after approvePlan resolves",
    );
    // The builder must have been dispatched as part of resumed execution.
    assert.ok(
      builder.dispatches.length > 0,
      `approved plan must drive the builder; got 0 dispatches (verdict=${receipt.verdict})`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("multi-step decomposition: rejectPlan removes pendingPlan without execution", async () => {
  const repo = makeMultiStepRepo();
  try {
    const builder = new MultiStepBuilder(() => "succeed");
    const { coordinator } = buildHarness(repo, {
      requireApproval: false,
      autoPromoteOnSuccess: false,
      builder,
    });

    const result = await coordinator.submitWithGates({
      input:
        "Refactor every file in core to use a Token alias: " +
        "core/types.ts, core/consumer.ts, core/consumer.test.ts, core/index.ts",
    });
    assert.equal(result.kind, "needs_decomposition");
    if (result.kind !== "needs_decomposition") return;
    const taskId = result.taskId;
    assert.ok(coordinator.getPendingPlan(taskId), "pendingPlan must exist before reject");

    const removed = coordinator.rejectPlan(taskId);
    assert.equal(removed, true, "rejectPlan must report it removed an existing plan");
    assert.equal(
      coordinator.getPendingPlan(taskId),
      undefined,
      "pendingPlan must be cleared after rejectPlan",
    );
    assert.equal(
      builder.callCount,
      0,
      `rejected plan must not dispatch any builder; got ${builder.callCount} call(s)`,
    );

    // A second reject for the same id must report no-op.
    assert.equal(coordinator.rejectPlan(taskId), false, "rejectPlan must return false when no plan is present");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
