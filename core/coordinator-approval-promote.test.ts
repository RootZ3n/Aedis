/**
 * Coordinator: AWAITING_APPROVAL → approveRun → promoteToSource regression.
 *
 * Run 4b3ec065 surfaced this gap on a real multi-file edit against
 * /home/zen/absent-pianist:
 *   - Builder produced a clean 2-file diff
 *   - Verifier ran 6 stages (including 98% cross-file coherence)
 *   - Run paused at AWAITING_APPROVAL
 *   - approveRun created workspace commit 9763642a
 *   - finalReceipt.patchArtifact stayed empty ({} with no diff/commitSha)
 *   - workspace was cleaned up
 *   - promoteToSource later failed with "No commit SHA — nothing to promote"
 *
 * The auto-promote path captured patchArtifact via generatePatch() at
 * submit() ~line 2015; the approval path missed it entirely. These tests
 * pin the post-fix invariants:
 *
 *   1. AWAITING_APPROVAL persists the full awaitReceipt into finalReceipt
 *      (otherwise approveRun has no shape to merge into).
 *   2. approveRun captures patchArtifact + commitSha into the persisted
 *      finalReceipt before workspace cleanup runs.
 *   3. promoteToSource succeeds on an approved run (round-trip).
 *   4. The auto-promote path remains unchanged — patchArtifact still
 *      gets captured during submit() for runs that don't pause.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator } from "./coordinator.js";
import { ReceiptStore } from "./receipt-store.js";
import { taskRoutes } from "../server/routes/tasks.js";
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

// ─── Stubs (mirror coordinator-integration.test.ts) ─────────────────

class RealBuilderWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "RealBuilder";
  constructor(private readonly writes: readonly { path: string; content: string }[]) { super(); }
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    const { writeFile, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = assignment.projectRoot ?? process.cwd();
    const changes = [];
    for (const w of this.writes) {
      // Read original BEFORE writing so the change carries originalContent.
      // The integration judge's rollback-safety check requires either
      // originalContent or diff on every modify — without it the merge
      // gate blocks with CRITICAL "modified without original content or
      // diff — cannot rollback" and PHASE 10 never reaches the approval
      // gate, which makes this whole test bypass the path it's testing.
      const abs = resolve(root, w.path);
      const originalContent = await readFile(abs, "utf-8").catch(() => "");
      await writeFile(abs, w.content, "utf-8");
      changes.push({
        path: w.path,
        operation: "modify" as const,
        content: w.content,
        originalContent,
      });
    }
    const output: BuilderOutput = { kind: "builder", changes, decisions: [], needsCriticReview: false };
    return this.success(assignment, output, {
      cost: this.zeroCost(), confidence: 0.9,
      touchedFiles: changes.map((c) => ({ path: c.path, operation: c.operation })),
      durationMs: 1,
    });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}

class BlockingBuilderWorker extends RealBuilderWorker {
  private releaseBlock!: () => void;
  readonly ready: Promise<void>;
  private readyResolve!: () => void;
  readonly release: Promise<void>;

  constructor(writes: readonly { path: string; content: string }[]) {
    super(writes);
    this.ready = new Promise((resolve) => { this.readyResolve = resolve; });
    this.release = new Promise((resolve) => { this.releaseBlock = resolve; });
  }

  override async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    this.readyResolve();
    await this.release;
    return super.execute(assignment);
  }

  unblock(): void {
    this.releaseBlock();
  }
}

class StubScoutWorker extends AbstractWorker {
  readonly type: WorkerType = "scout";
  readonly name = "StubScout";
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(assignment, {
      kind: "scout", dependencies: [], patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "no-op",
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "scout", dependencies: [], patterns: [], riskAssessment: { level: "low", factors: [], mitigations: [] }, suggestedApproach: "" };
  }
}

class StubCriticWorker extends AbstractWorker {
  readonly type: WorkerType = "critic";
  readonly name = "StubCritic";
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(assignment, {
      kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 0.9,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "critic", verdict: "approve", comments: [], suggestedChanges: [], intentAlignment: 1 };
  }
}

class StubVerifierWorker extends AbstractWorker {
  readonly type: WorkerType = "verifier";
  readonly name = "StubVerifier";
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    return this.success(assignment, {
      kind: "verifier", testResults: [],
      typeCheckPassed: true, lintPassed: true, buildPassed: true, passed: true,
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "verifier", testResults: [], typeCheckPassed: true, lintPassed: true, buildPassed: true, passed: true };
  }
}

class StubIntegratorWorker extends AbstractWorker {
  readonly type: WorkerType = "integrator";
  readonly name = "StubIntegrator";
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    const finalChanges = [...(assignment.changes ?? [])];
    return this.success(assignment, {
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
  requireApproval: boolean;
  autoPromoteOnSuccess?: boolean;
  stateRoot?: string;
}) {
  const registry = new WorkerRegistry();
  registry.register(new StubScoutWorker());
  registry.register(opts.builder);
  registry.register(new StubCriticWorker());
  registry.register(new StubVerifierWorker());
  registry.register(new StubIntegratorWorker());

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

  const receiptStore = new ReceiptStore(opts.stateRoot ?? projectRoot);
  const coordinator = new Coordinator(
    {
      projectRoot,
      autoCommit: true,
      requireWorkspace: true,
      requireApproval: opts.requireApproval,
      autoPromoteOnSuccess: opts.autoPromoteOnSuccess ?? false,
      // Drop required checks AND register a stub passing hook so the
      // run gets a real "verification signal." Production gates
      // typecheck/tests by default; this harness exercises the
      // approval → promote flow with stub workers, not a real
      // toolchain. Without requiredChecks=[] the merge-gate blocks
      // CRITICAL "typecheck hook not configured." Without a passing
      // hook the merge-gate ALSO blocks CRITICAL "no verification
      // signal available." A single always-pass typecheck hook
      // satisfies both gates so the run can reach PHASE 10 and pause.
      verificationConfig: {
        requiredChecks: [],
        hooks: [{
          name: "stub-typecheck",
          stage: "typecheck",
          kind: "typecheck",
          execute: async () => ({
            passed: true,
            issues: [],
            stdout: "",
            stderr: "",
            exitCode: 0,
            durationMs: 0,
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

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-approval-promote-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "approval-tmp", version: "0.0.0" }), "utf-8");
  writeFileSync(join(dir, "core/widget.ts"), "export const widget = 1;\n", "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

async function waitFor<T>(
  probe: () => Promise<T | null> | T | null,
  message: string,
  timeoutMs = 3000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

// ─── TESTS ──────────────────────────────────────────────────────────

test("approval flow: cancelling awaiting-approval clears pending/active state, aborts receipt, cleans workspace, and leaves source unchanged", async () => {
  const repo = makeTempRepo();
  try {
    const original = readFileSync(join(repo, "core/widget.ts"), "utf-8");
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 500;\n" },
    ]);
    const { coordinator, receiptStore } = buildHarness(repo, { builder, requireApproval: true });

    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const awaiting = await receiptStore.getRun(receipt.runId);
    const workspacePath = awaiting?.workspace?.workspacePath;
    assert.ok(workspacePath, "approval run must persist workspace path before cancellation");
    assert.equal(coordinator.getPendingApprovals().length, 1);
    assert.deepEqual(coordinator.listActiveRunIds(), [receipt.runId]);

    assert.equal(coordinator.cancel(receipt.runId), true);

    assert.equal(coordinator.getPendingApprovals().length, 0, "pendingApproval must be cleared synchronously");
    assert.deepEqual(coordinator.listActiveRunIds(), [], "activeRuns must be cleared synchronously");
    assert.equal(coordinator.getRunStatus(receipt.runId), null, "cancelled approval run must not report active status");

    const persisted = await waitFor(async () => {
      const current = await receiptStore.getRun(receipt.runId);
      return current?.workspace?.cleanedUp === true ? current : null;
    }, "approval cancellation should persist workspace cleanup");

    assert.equal(persisted.status, "INTERRUPTED");
    assert.equal(persisted.phase, "aborted");
    assert.equal((persisted.runSummary as any)?.phase, "aborted");
    assert.equal(persisted.finalReceipt?.summary.phase, "aborted", "finalReceipt.summary.phase must not remain awaiting_approval");
    assert.equal(persisted.finalReceipt?.verdict, "aborted");
    assert.equal(existsSync(workspacePath), false, "approval workspace must be removed after cancellation");
    assert.equal(readFileSync(join(repo, "core/widget.ts"), "utf-8"), original, "source repo must not be mutated by approval cancellation");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: rejecting awaiting-approval run produces consistent terminal receipt state", async () => {
  // Symmetric with the cancel-during-approval test above. Pre-fix,
  // rejectRun set status: "REJECTED" but did NOT update phase,
  // runSummary, or finalReceipt — so the persisted receipt kept
  // phase: "awaiting_approval", finalReceipt.verdict: "partial",
  // and finalReceipt.summary.phase: "awaiting_approval" even after
  // a clean rejection. The fix mirrors cancelPendingApprovalRun's
  // shape so anyone reading the persisted receipt sees the rejected
  // terminal state.
  const repo = makeTempRepo();
  try {
    const original = readFileSync(join(repo, "core/widget.ts"), "utf-8");
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 600;\n" },
    ]);
    const { coordinator, receiptStore } = buildHarness(repo, { builder, requireApproval: true });

    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const awaiting = await receiptStore.getRun(receipt.runId);
    const workspacePath = awaiting?.workspace?.workspacePath;
    assert.ok(workspacePath, "approval run must persist workspace path before rejection");
    assert.equal(coordinator.getPendingApprovals().length, 1);

    const result = await coordinator.rejectRun(receipt.runId);
    assert.equal(result.ok, true, `rejectRun must succeed; got error=${result.error}`);

    assert.equal(coordinator.getPendingApprovals().length, 0, "pendingApproval must be cleared after rejection");

    const persisted = await waitFor(async () => {
      const current = await receiptStore.getRun(receipt.runId);
      return current?.workspace?.cleanedUp === true ? current : null;
    }, "rejection should persist workspace cleanup");

    assert.equal(persisted.status, "REJECTED");
    assert.equal(persisted.phase, "rejected", "persisted phase must be rejected, not stale awaiting_approval");
    assert.equal((persisted.runSummary as any)?.phase, "rejected");
    assert.equal(
      persisted.finalReceipt?.summary.phase,
      "rejected",
      "finalReceipt.summary.phase must not remain awaiting_approval after rejection",
    );
    assert.equal(persisted.finalReceipt?.verdict, "failed");
    assert.equal(existsSync(workspacePath), false, "approval workspace must be removed after rejection");
    assert.equal(
      readFileSync(join(repo, "core/widget.ts"), "utf-8"),
      original,
      "source repo must not be mutated by rejection",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: task route reports active_run=false after approval-stage cancel", async () => {
  const fastify = (await import("fastify")).default;
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 501;\n" },
    ]);
    const { coordinator, receiptStore, events } = buildHarness(repo, { builder, requireApproval: true });
    const receipt = await coordinator.submit({ input: "modify widget in core" });

    await receiptStore.registerTask({
      taskId: "task-approval-cancel",
      runId: receipt.runId,
      prompt: "modify widget in core",
      submittedAt: new Date().toISOString(),
    });

    assert.equal(coordinator.cancel(receipt.runId), true);
    await waitFor(async () => {
      const current = await receiptStore.getRun(receipt.runId);
      return current?.status === "INTERRUPTED" ? current : null;
    }, "approval cancellation should persist interrupted run");
    await receiptStore.updateTask("task-approval-cancel", {
      status: "cancelled",
      completedAt: new Date().toISOString(),
      error: "Cancelled by user",
    });

    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore,
      coordinator,
      eventBus: {
        emit: (event: AedisEvent) => { events.push(event); },
        recentEvents: () => events,
      },
      config: { projectRoot: repo },
    });
    await app.register(taskRoutes);

    const res = await app.inject({ method: "GET", url: "/task-approval-cancel" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "cancelled");
    assert.equal(body.active_run, false);
    assert.equal(body.progress.phase, "aborted");

    await app.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: normal in-flight cancellation remains active until submit unwinds", async () => {
  const repo = makeTempRepo();
  try {
    const builder = new BlockingBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 502;\n" },
    ]);
    const { coordinator } = buildHarness(repo, { builder, requireApproval: false });

    const submit = coordinator.submit({ input: "modify widget in core" });
    const runId = await waitFor(() => coordinator.listActiveRunIds()[0] ?? null, "run should become active");
    assert.equal(coordinator.cancel(runId), true);
    assert.deepEqual(coordinator.listActiveRunIds(), [runId], "ordinary in-flight cancellation should remain active until finally cleanup");

    builder.unblock();
    await submit;
    await waitFor(() => coordinator.listActiveRunIds().length === 0 ? true : null, "normal cancellation should clear active run after submit unwinds");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: AWAITING_APPROVAL persists the full awaitReceipt into finalReceipt", async () => {
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 2;\n" },
    ]);
    const { coordinator, receiptStore } = buildHarness(repo, { builder, requireApproval: true });

    const receipt = await coordinator.submit({ input: "modify widget in core" });
    // The submit returns the awaitReceipt directly; phase records the pause.
    assert.ok(receipt, "submit must return a receipt even when pausing for approval");

    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted, "persisted receipt must exist");
    assert.equal(persisted.status, "AWAITING_APPROVAL", `status must be AWAITING_APPROVAL, got ${persisted.status}`);
    assert.ok(
      persisted.finalReceipt,
      "finalReceipt must be persisted at AWAITING_APPROVAL — without it approveRun has nothing to merge patchArtifact into (run 4b3ec065 regression)",
    );
    // patchArtifact is still null at this point — the workspace hasn't
    // committed yet. The check that it FILLS IN after approveRun is the
    // next test.
    assert.equal(persisted.finalReceipt.patchArtifact, null, "patchArtifact must be null pre-approval (workspace uncommitted)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: autoPromote=false creates pending approval after successful verification", async () => {
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 7;\n" },
    ]);
    const { coordinator, receiptStore } = buildHarness(repo, {
      builder,
      requireApproval: false,
      autoPromoteOnSuccess: false,
    });

    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const persisted = await receiptStore.getRun(receipt.runId);

    assert.equal(persisted?.status, "AWAITING_APPROVAL");
    assert.equal(persisted?.finalReceipt?.summary.phase, "awaiting_approval");
    assert.equal(coordinator.getPendingApprovals().length, 1);
    assert.deepEqual(coordinator.listActiveRunIds(), [receipt.runId]);
    assert.equal(readFileSync(join(repo, "core/widget.ts"), "utf-8"), "export const widget = 1;\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: task route exposes pending approval as active until cancel clears it", async () => {
  const fastify = (await import("fastify")).default;
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 8;\n" },
    ]);
    const { coordinator, receiptStore, events } = buildHarness(repo, {
      builder,
      requireApproval: false,
      autoPromoteOnSuccess: false,
    });

    const receipt = await coordinator.submit({ input: "modify widget in core" });
    await receiptStore.registerTask({
      taskId: "task-auto-promote-disabled",
      runId: receipt.runId,
      prompt: "modify widget in core",
      submittedAt: new Date().toISOString(),
    });

    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore,
      coordinator,
      eventBus: {
        emit: (event: AedisEvent) => { events.push(event); },
        recentEvents: () => events,
      },
      config: { projectRoot: repo },
    });
    await app.register(taskRoutes);

    const before = (await app.inject({ method: "GET", url: "/task-auto-promote-disabled" })).json();
    assert.equal(before.status, "running");
    assert.equal(before.active_run, true);
    assert.equal(before.progress.phase, "awaiting_approval");

    const cancel = await app.inject({ method: "POST", url: "/task-auto-promote-disabled/cancel" });
    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().status, "cancelled");

    await waitFor(async () => {
      const current = await receiptStore.getRun(receipt.runId);
      return current?.phase === "aborted" ? current : null;
    }, "approval cancellation should persist aborted phase");

    const after = (await app.inject({ method: "GET", url: "/task-auto-promote-disabled" })).json();
    assert.equal(after.active_run, false);
    assert.equal(after.progress.phase, "aborted");
    assert.equal(coordinator.getPendingApprovals().length, 0);

    await app.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: approveRun captures patchArtifact + commitSha into finalReceipt before workspace cleanup", async () => {
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 3;\n" },
    ]);
    const { coordinator, receiptStore } = buildHarness(repo, { builder, requireApproval: true });

    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const result = await coordinator.approveRun(receipt.runId);
    assert.equal(result.ok, true, `approveRun must succeed; got error=${result.error}`);
    assert.ok(result.commitSha, "approveRun must return commitSha");

    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted, "persisted receipt must exist after approveRun");
    assert.equal(persisted.status, "READY_FOR_PROMOTION", `status must be READY_FOR_PROMOTION, got ${persisted.status}`);

    const pa = persisted.finalReceipt?.patchArtifact;
    assert.ok(pa, "finalReceipt.patchArtifact must be populated after approveRun (this is the 4b3ec065 fix)");
    assert.ok((pa as any).diff && (pa as any).diff.length > 0, "patchArtifact.diff must be non-empty");
    assert.ok(Array.isArray((pa as any).changedFiles) && (pa as any).changedFiles.length === 1, "changedFiles must include the modified file");
    assert.equal((pa as any).changedFiles[0], "core/widget.ts");
    assert.equal((pa as any).commitSha, result.commitSha, "patchArtifact.commitSha must equal the approval commit SHA");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: promoteToSource succeeds end-to-end after approveRun (round-trip)", async () => {
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 42; // approved\n" },
    ]);
    const { coordinator } = buildHarness(repo, { builder, requireApproval: true });

    const beforeSourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const receipt = await coordinator.submit({ input: "modify widget in core" });
    const approve = await coordinator.approveRun(receipt.runId);
    assert.equal(approve.ok, true);

    // promote — this is the call that returned "No commit SHA" pre-fix
    const promote = await coordinator.promoteToSource(receipt.runId);
    assert.equal(promote.ok, true, `promoteToSource must succeed; got error=${promote.error}`);
    assert.ok(promote.commitSha, "promoteToSource must return the source-repo commit SHA");

    // Confirm the source repo actually advanced and contains the change
    const afterSourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    assert.notEqual(afterSourceSha, beforeSourceSha, "source repo HEAD must move forward after promotion");
    assert.equal(afterSourceSha, promote.commitSha, "source HEAD must match the SHA promoteToSource reported");

    const widgetContent = readFileSync(join(repo, "core/widget.ts"), "utf-8");
    assert.match(widgetContent, /widget = 42/, "promoted file content must contain the approved change");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: auto-promote path (requireApproval=false) still captures patchArtifact during submit()", async () => {
  // Defense: the fix must not regress the auto-promote path. A run that
  // never pauses must still produce the same patchArtifact shape that
  // promoteToSource consumes.
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 99;\n" },
    ]);
    const { coordinator, receiptStore } = buildHarness(repo, {
      builder,
      requireApproval: false,
      autoPromoteOnSuccess: true,
    });

    const receipt = await coordinator.submit({ input: "modify widget in core" });

    const persisted = await receiptStore.getRun(receipt.runId);
    assert.ok(persisted?.finalReceipt, "auto-promote path must still persist finalReceipt");
    const pa = persisted.finalReceipt?.patchArtifact;
    assert.ok(pa, "auto-promote path must still populate patchArtifact (regression backstop)");
    assert.ok((pa as any).diff && (pa as any).diff.length > 0);
    assert.ok(Array.isArray((pa as any).changedFiles) && (pa as any).changedFiles.length >= 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: promoteToSource resolves source repo from finalReceipt when body omits source_repo (run 6bf45418 regression)", async () => {
  // Run 6bf45418: POST /tasks/:id/promote with no body fell straight
  // through to this.config.projectRoot (/mnt/ai/aedis) and tried to
  // git-apply an absent-pianist patch there, failing with
  //   error: app.py: does not exist in index
  //   error: generate.py: does not exist in index
  // The fix walks a longer fallback chain so finalReceipt.sourceRepo
  // wins before this.config.projectRoot. Reproduce the shape: the
  // coordinator's projectRoot points at a DIFFERENT repo than the
  // one the submission targeted. Without the fix, promote applies to
  // the wrong repo and fails.
  const coordRoot = makeTempRepo();        // coordinator's config.projectRoot
  const targetRepo = makeTempRepo();       // the submission's actual target
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 17; // approved\n" },
    ]);
    const { coordinator } = buildHarness(coordRoot, { builder, requireApproval: true });

    const beforeTargetSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRepo }).toString().trim();
    const beforeCoordSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: coordRoot }).toString().trim();

    const receipt = await coordinator.submit({
      input: "modify widget in core",
      projectRoot: targetRepo,           // submission targets a DIFFERENT repo than coordRoot
    });
    const approve = await coordinator.approveRun(receipt.runId);
    assert.equal(approve.ok, true, `approveRun must succeed; got error=${approve.error}`);

    // Promote with NO body — must NOT default to coordRoot. Pre-fix
    // this would try `git apply` inside coordRoot and fail because the
    // patch's files don't exist in coordRoot's index.
    const promote = await coordinator.promoteToSource(receipt.runId);
    assert.equal(
      promote.ok,
      true,
      `promoteToSource (no body) must resolve sourceRepo from finalReceipt; got error=${promote.error}`,
    );
    assert.ok(promote.commitSha, "promoteToSource must return a source-repo commit SHA");

    // The TARGET repo must have advanced; coordRoot must NOT have been touched.
    const afterTargetSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRepo }).toString().trim();
    const afterCoordSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: coordRoot }).toString().trim();
    assert.notEqual(afterTargetSha, beforeTargetSha, "target repo HEAD must move forward");
    assert.equal(afterTargetSha, promote.commitSha, "target HEAD must equal the promote SHA");
    assert.equal(afterCoordSha, beforeCoordSha, "coordinator's projectRoot must NOT be mutated by a promote that targets a different repo");

    // Cross-check the file actually landed in the target, not coord.
    const widgetInTarget = readFileSync(join(targetRepo, "core/widget.ts"), "utf-8");
    assert.match(widgetInTarget, /widget = 17/, "promoted change must land in target repo");
  } finally {
    rmSync(coordRoot, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  }
});

test("approval flow: explicit source_repo body still wins over inferred sourceRepo", async () => {
  // Defense: the body override is the highest-priority resolution and
  // must keep working. Without that, callers that explicitly pass
  // source_repo (e.g. anyone who'd worked around the run 6bf45418 bug
  // by always supplying it) would silently route to a different repo.
  const coordRoot = makeTempRepo();
  const inferredRepo = makeTempRepo();
  const explicitRepo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 99; // explicit-route\n" },
    ]);
    const { coordinator } = buildHarness(coordRoot, { builder, requireApproval: true });

    const beforeInferred = execFileSync("git", ["rev-parse", "HEAD"], { cwd: inferredRepo }).toString().trim();
    const beforeExplicit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: explicitRepo }).toString().trim();

    const receipt = await coordinator.submit({
      input: "modify widget in core",
      projectRoot: inferredRepo,         // receipt's finalReceipt.sourceRepo = inferredRepo
    });
    const approve = await coordinator.approveRun(receipt.runId);
    assert.equal(approve.ok, true);

    // Explicit body override targets explicitRepo. Body must beat inferred.
    const promote = await coordinator.promoteToSource(receipt.runId, explicitRepo);
    assert.equal(promote.ok, true, `promoteToSource (explicit) must succeed; got error=${promote.error}`);

    const afterInferred = execFileSync("git", ["rev-parse", "HEAD"], { cwd: inferredRepo }).toString().trim();
    const afterExplicit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: explicitRepo }).toString().trim();
    assert.equal(afterInferred, beforeInferred, "inferred repo must NOT move when an explicit body override is supplied");
    assert.notEqual(afterExplicit, beforeExplicit, "explicit repo must move forward");
    assert.equal(afterExplicit, promote.commitSha, "explicit HEAD must match promote SHA");
  } finally {
    rmSync(coordRoot, { recursive: true, force: true });
    rmSync(inferredRepo, { recursive: true, force: true });
    rmSync(explicitRepo, { recursive: true, force: true });
  }
});

// ─── Promote-time typecheck gate ─────────────────────────────────────
//
// Run b7109c0b's regression: receipt.runOutcome did not exist on
// RunReceipt; the verifier-time typecheck hook ran in the source-repo
// cwd (not the workspace), so the workspace modification was invisible
// at verifier time and the merge gate let the change through with 12
// advisory findings. Once promoted, npx tsc --noEmit failed on main.
//
// The fix: a hard typecheck gate at promoteToSource time. AFTER
// `git apply` and BEFORE `git commit`, run tsc against the source
// repo's would-be-promoted state; if any new error appeared compared
// to the pre-apply baseline, refuse the promote and `git checkout
// HEAD --` the candidate paths so the source repo is left clean.
//
// This regression test stages the exact incident shape: a TypeScript
// source repo, a Builder that writes a property reference to a
// non-existent field on a typed object (TS2339), then attempts the
// full submit → approve → promote round-trip. The promote MUST refuse
// and leave the source repo unmoved.
//
// Test requires the typescript binary to be resolvable via `npx tsc`
// from the tmp repo. We symlink the host's node_modules tree so npx
// finds it without re-installing, and skip the test when the host's
// /mnt/ai/aedis/node_modules is missing (CI without npm install).

function makeTempTypescriptRepo(): string | null {
  const dir = mkdtempSync(join(tmpdir(), "aedis-promote-tsc-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  // Symlink node_modules so `npx tsc` resolves the typescript binary.
  // process.cwd() at test time is the Aedis repo root.
  const hostNodeModules = join(process.cwd(), "node_modules");
  if (!existsSync(hostNodeModules)) {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  try {
    symlinkSync(hostNodeModules, join(dir, "node_modules"), "dir");
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "promote-tsc-tmp", version: "0.0.0" }),
    "utf-8",
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
      },
      include: ["core/**/*"],
    }),
    "utf-8",
  );
  // The typed object is the pattern that the runOutcome regression
  // shipped against — a typed interface with a fixed shape, then a
  // function that dereferences a non-existent property. The original
  // file compiles clean; the Builder will rewrite it to add the bad
  // reference.
  writeFileSync(
    join(dir, "core/widget.ts"),
    [
      "export interface Widget {",
      "  readonly id: string;",
      "  readonly value: number;",
      "}",
      "",
      "export function describe(w: Widget): string {",
      "  return `widget ${w.id}: ${w.value}`;",
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "ts@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "PromoteTsc"], { cwd: dir });
  // Don't commit the symlinked node_modules dir.
  writeFileSync(join(dir, ".gitignore"), "node_modules\n", "utf-8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("promote-time typecheck gate: refuses to commit a tsc-breaking patch and leaves the source repo unmoved", async () => {
  const repo = makeTempTypescriptRepo();
  if (!repo) {
    // node_modules unavailable — skip rather than report a false failure.
    return;
  }
  try {
    const beforeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const originalSource = readFileSync(join(repo, "core/widget.ts"), "utf-8");

    // Builder rewrites describe() to read a property that does not
    // exist on Widget — the runOutcome incident, generalized. Compiles
    // would fail with TS2339: Property 'runOutcome' does not exist on
    // type 'Widget'.
    const breakingContent = [
      "export interface Widget {",
      "  readonly id: string;",
      "  readonly value: number;",
      "}",
      "",
      "export function describe(w: Widget): string {",
      "  // TS2339-shaped error — runOutcome is not on Widget.",
      "  return `widget ${w.id}: ${w.value} ${(w as any).runOutcome ?? \"\"} ${w.runOutcome ?? \"\"}`;",
      "}",
      "",
    ].join("\n");
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: breakingContent },
    ]);
    const { coordinator } = buildHarness(repo, { builder, requireApproval: true });

    const submitReceipt = await coordinator.submit({ input: "modify widget in core", projectRoot: repo });
    const approve = await coordinator.approveRun(submitReceipt.runId);
    assert.equal(approve.ok, true, `approveRun must succeed; got error=${approve.error}`);

    const promote = await coordinator.promoteToSource(submitReceipt.runId);
    assert.equal(
      promote.ok,
      false,
      `promoteToSource must REFUSE a tsc-breaking patch; got ok=true commitSha=${promote.commitSha}`,
    );
    assert.match(
      promote.error ?? "",
      /Promote refused.*new TypeScript error/i,
      `promote.error must explicitly mention new TypeScript errors; got: ${promote.error}`,
    );

    // Source repo HEAD must NOT have moved — no commit happened.
    const afterSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    assert.equal(afterSha, beforeSha, "source repo HEAD must NOT advance when the typecheck gate refuses the promote");

    // Working tree must be clean — the gate's git-checkout rollback
    // restores the candidate paths so a subsequent run is unblocked.
    const widgetAfter = readFileSync(join(repo, "core/widget.ts"), "utf-8");
    assert.equal(
      widgetAfter,
      originalSource,
      "core/widget.ts must be reverted to the pre-apply state after the gate refuses",
    );

    // The .aedis-promote-patch.tmp file must not be left behind.
    assert.equal(
      existsSync(join(repo, ".aedis-promote-patch.tmp")),
      false,
      "promote temp patch file must be cleaned up regardless of gate outcome",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("approval flow: promoteToSource fails honestly when finalReceipt is missing (legacy receipt)", async () => {
  // Defense: if a receipt was persisted by an older Aedis version with
  // no finalReceipt, promoteToSource must NOT fabricate a commit. It
  // must surface "No commit SHA — nothing to promote" so the operator
  // sees the truth and re-runs.
  const repo = makeTempRepo();
  try {
    const stateRoot = mkdtempSync(join(tmpdir(), "aedis-state-legacy-"));
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 7;\n" },
    ]);
    const { coordinator, receiptStore } = buildHarness(repo, { builder, requireApproval: false, stateRoot });

    // Synthesise a legacy-shaped receipt: status READY_FOR_PROMOTION,
    // no finalReceipt, no patchArtifact, and no live workspace path.
    const fakeRunId = "legacy-runid-0001";
    await receiptStore.patchRun(fakeRunId, {
      status: "READY_FOR_PROMOTION",
      taskSummary: "legacy receipt missing finalReceipt",
      prompt: "legacy",
    });

    const promote = await coordinator.promoteToSource(fakeRunId);
    assert.equal(promote.ok, false, "promoteToSource must refuse a legacy receipt with no patchArtifact");
    assert.match(
      promote.error ?? "",
      /No commit SHA|No patch artifact|Workspace not found/i,
      `error must surface the missing data honestly; got: ${promote.error}`,
    );
    rmSync(stateRoot, { recursive: true, force: true });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
