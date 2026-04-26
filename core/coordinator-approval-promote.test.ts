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

// ─── TESTS ──────────────────────────────────────────────────────────

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
    const { coordinator, receiptStore } = buildHarness(repo, { builder, requireApproval: false });

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
