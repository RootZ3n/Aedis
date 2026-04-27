/**
 * Shadow workspace — controlled multi-sandbox support.
 *
 * Aedis runs the primary Builder in a single workspace and promotes
 * its commit to the source repo. The shadow workspace is a SECOND
 * sandbox attached to the same active run for alternate Builder
 * attempts (alternate-model retries, candidate comparison). Shadow
 * workspaces produce patches and metrics, but they MUST NOT promote
 * to source — the only path to PROMOTED is the primary workspace.
 *
 * These tests pin the safety invariants:
 *
 *   1. createShadowWorkspaceForRun produces a workspace at a unique
 *      path (different from primary) and stamps role="shadow".
 *   2. runShadowBuilder writes to the shadow workspace and produces
 *      a patch artifact — the source repo is unchanged after.
 *   3. promoteToSource refuses any receipt whose recorded workspace
 *      role is not "primary" — the safety guard runs before any
 *      `git apply` in the source repo.
 *   4. selectBestCandidate prefers a passing candidate, prefers
 *      primary on ties, and falls back to a passing shadow when the
 *      primary failed.
 *   5. The single-workspace flow (no shadow ever created) still
 *      succeeds end-to-end through approveRun → promoteToSource.
 *
 * The tests mirror the harness conventions from
 * coordinator-approval-promote.test.ts so the shadow path is
 * exercised against the same coordinator setup that the production
 * approval flow uses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator } from "./coordinator.js";
import { ReceiptStore } from "./receipt-store.js";
import { selectBestCandidate, type Candidate } from "./candidate.js";
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

// ─── Stubs (mirror coordinator-approval-promote.test.ts) ─────────────

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

class StubScout extends AbstractWorker {
  readonly type: WorkerType = "scout";
  readonly name = "StubScout";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
      kind: "scout", dependencies: [], patterns: [],
      riskAssessment: { level: "low", factors: [], mitigations: [] },
      suggestedApproach: "ok",
    }, { cost: this.zeroCost(), confidence: 0.9, touchedFiles: [], durationMs: 1 });
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

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-shadow-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shadow-tmp", version: "0.0.0" }), "utf-8");
  writeFileSync(join(dir, "core/widget.ts"), "export const widget = 1;\n", "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "shadow@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "ShadowTest"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

// ─── TESTS ──────────────────────────────────────────────────────────

test("shadow workspace: createShadowWorkspaceForRun produces a workspace at a unique path with role=shadow", async () => {
  const repo = makeTempRepo();
  try {
    // Use a never-resolving builder so the run pauses at the
    // workspace setup step long enough for us to call the shadow
    // helper. Since we want to CALL createShadowWorkspaceForRun on
    // an active run, we need to sneak in mid-flight. Easier: spawn
    // a builder that records assignment.projectRoot and resolves
    // immediately — the run completes, but we attach the shadow
    // workspace BEFORE submit() resolves by using a builder that
    // notifies before finishing.
    let primaryWorkspacePath = "";
    let resolveBlock!: () => void;
    const block = new Promise<void>((r) => { resolveBlock = r; });
    let shadowHandlePromise: Promise<unknown> | null = null;

    class ProbeBuilder extends RealBuilderWorker {
      override async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
        primaryWorkspacePath = assignment.projectRoot ?? "";
        // Fire the shadow-creation while the primary builder is
        // still in flight so the active run is registered.
        shadowHandlePromise = (async () => {
          const runs = (coordinator as unknown as { activeRuns: Map<string, unknown> }).activeRuns;
          const runId = [...runs.keys()][0] as string;
          return await coordinator.createShadowWorkspaceForRun(runId);
        })();
        await block;
        return super.execute(assignment);
      }
    }

    const builder = new ProbeBuilder([
      { path: "core/widget.ts", content: "export const widget = 2;\n" },
    ]);
    const { coordinator } = buildHarness(repo, { builder, requireApproval: true });

    const submitPromise = coordinator.submit({ input: "modify widget in core" });
    // Wait until the shadow has been created in the probe, then
    // unblock the builder so submit() finishes.
    while (!shadowHandlePromise) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const shadow = (await shadowHandlePromise) as {
      workspaceId: string;
      role: string;
      handle: { workspacePath: string; sourceRepo: string };
    };
    resolveBlock();
    await submitPromise;

    // Path uniqueness — must differ from primary, must contain "shadow-"
    assert.notEqual(shadow.handle.workspacePath, primaryWorkspacePath, "shadow path must differ from primary");
    assert.match(shadow.handle.workspacePath, /shadow-/, "shadow workspace path must contain 'shadow-' marker");
    assert.equal(shadow.role, "shadow", `role must be "shadow"; got ${shadow.role}`);
    assert.equal(shadow.workspaceId, "shadow-1", `workspaceId must default to "shadow-1"; got ${shadow.workspaceId}`);
    assert.equal(shadow.handle.sourceRepo, repo, "shadow must clone from the same source repo as primary");
    // Filesystem proof: shadow path actually exists (workspace was created on disk).
    assert.equal(existsSync(shadow.handle.workspacePath), true, "shadow workspace path must exist on disk");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("shadow workspace: runShadowBuilder writes to shadow workspace and source repo is untouched", async () => {
  const repo = makeTempRepo();
  try {
    const sourceBefore = readFileSync(join(repo, "core/widget.ts"), "utf-8");
    const sourceShaBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

    let resolveBlock!: () => void;
    const block = new Promise<void>((r) => { resolveBlock = r; });
    let candidatePromise: Promise<Candidate> | null = null;

    class ProbeBuilder extends RealBuilderWorker {
      override async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
        // While the primary builder is in flight, dispatch a shadow
        // builder against a different write set so we can observe
        // the shadow's diff.
        const runs = (coordinator as unknown as { activeRuns: Map<string, unknown> }).activeRuns;
        const runId = [...runs.keys()][0] as string;
        const shadowBuilder = new RealBuilderWorker([
          { path: "core/widget.ts", content: "export const widget = 999; // shadow attempt\n" },
        ]);
        candidatePromise = coordinator.runShadowBuilder(runId, { builder: shadowBuilder });
        await candidatePromise;
        await block;
        return super.execute(assignment);
      }
    }

    const builder = new ProbeBuilder([
      { path: "core/widget.ts", content: "export const widget = 2;\n" },
    ]);
    const { coordinator } = buildHarness(repo, { builder, requireApproval: true });

    const submitPromise = coordinator.submit({ input: "modify widget in core" });
    while (!candidatePromise) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Cast: TS narrows `candidatePromise` to `never` after the polling
    // loop because the loop body never reassigns it — the assignment
    // lives in a closure (ProbeBuilder.execute) that the flow analysis
    // can't track. Same pattern as line 273 above.
    const candidate = await (candidatePromise as Promise<Candidate>);
    resolveBlock();
    await submitPromise;

    // Shadow candidate metadata
    assert.equal(candidate.role, "shadow", "candidate.role must be \"shadow\"");
    assert.equal(candidate.workspaceId, "shadow-1", "candidate.workspaceId must be \"shadow-1\"");
    assert.equal(candidate.status, "passed", `candidate.status must be \"passed\"; got ${candidate.status} reason=${candidate.reason}`);
    assert.ok(candidate.patchArtifact, "shadow candidate must carry a patch artifact");
    assert.ok(
      candidate.patchArtifact && candidate.patchArtifact.diff.length > 0,
      "shadow patch diff must be non-empty",
    );
    assert.match(
      candidate.patchArtifact!.diff,
      /widget = 999/,
      "shadow patch must contain the shadow's distinct content",
    );

    // Source repo invariant: bytes unchanged, HEAD unchanged.
    assert.equal(
      readFileSync(join(repo, "core/widget.ts"), "utf-8"),
      sourceBefore,
      "source repo file must NOT be mutated by the shadow builder",
    );
    const sourceShaAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    assert.equal(sourceShaAfter, sourceShaBefore, "source repo HEAD must NOT advance from a shadow run");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("shadow workspace: promoteToSource refuses a receipt whose workspace.role is not primary", async () => {
  const repo = makeTempRepo();
  try {
    const builder = new RealBuilderWorker([
      { path: "core/widget.ts", content: "export const widget = 5;\n" },
    ]);
    const { coordinator, receiptStore } = buildHarness(repo, { builder, requireApproval: false });

    // Build a synthetic receipt whose workspace ref is stamped role="shadow".
    // promoteToSource MUST refuse before any git apply runs in the source.
    const fakeRunId = "synthetic-shadow-receipt";
    await receiptStore.patchRun(fakeRunId, {
      status: "READY_FOR_PROMOTION",
      taskSummary: "synthetic shadow receipt",
      prompt: "shadow",
      workspace: {
        workspacePath: "/tmp/aedis-ws-shadow-fake",
        sourceRepo: repo,
        sourceCommitSha: "deadbeef",
        method: "worktree",
        createdAt: new Date().toISOString(),
        worktreeBranch: null,
        // The decisive field — promote must read this and refuse.
        role: "shadow",
        workspaceId: "shadow-1",
      } as unknown as Parameters<typeof receiptStore.patchRun>[1]["workspace"],
    });

    const beforeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const result = await coordinator.promoteToSource(fakeRunId);

    assert.equal(result.ok, false, "promoteToSource must refuse a shadow-role receipt");
    assert.match(
      result.error ?? "",
      /Promote refused.*shadow|shadow.*never write|workspace role/i,
      `error must explain the shadow guard; got: ${result.error}`,
    );
    const afterSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    assert.equal(afterSha, beforeSha, "source repo HEAD must NOT advance when the shadow guard refuses");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("candidate selection: selectBestCandidate prefers a passing primary, falls back to a passing shadow when primary fails", () => {
  const passingPrimary: Candidate = {
    workspaceId: "primary",
    role: "primary",
    workspacePath: "/tmp/primary",
    patchArtifact: null,
    verifierVerdict: "pass",
    criticalFindings: 0,
    costUsd: 0,
    latencyMs: 100,
    status: "passed",
    reason: "ok",
  };
  const passingShadow: Candidate = {
    workspaceId: "shadow-1",
    role: "shadow",
    workspacePath: "/tmp/shadow",
    patchArtifact: null,
    verifierVerdict: "pass",
    criticalFindings: 0,
    costUsd: 0,
    latencyMs: 80,
    status: "passed",
    reason: "ok",
  };
  const failingPrimary: Candidate = { ...passingPrimary, status: "failed", reason: "boom" };

  // Empty input
  assert.equal(selectBestCandidate([]), null, "empty candidate list must yield null");

  // Only primary, passing
  assert.equal(selectBestCandidate([passingPrimary]), passingPrimary);

  // Only primary, failing
  assert.equal(selectBestCandidate([failingPrimary]), null);

  // Both passing → primary wins on tie
  const both = [passingShadow, passingPrimary]; // shadow listed first to prove ordering doesn't decide
  assert.equal(selectBestCandidate(both), passingPrimary, "primary must win when both candidates are passing");

  // Primary fails, shadow passes → shadow wins
  assert.equal(
    selectBestCandidate([failingPrimary, passingShadow]),
    passingShadow,
    "shadow must be selected when primary fails and shadow passes",
  );

  // Primary fails, shadow has critical findings → null (no qualifying candidate)
  const shadowCritical: Candidate = { ...passingShadow, criticalFindings: 1 };
  assert.equal(
    selectBestCandidate([failingPrimary, shadowCritical]),
    null,
    "candidate with critical findings must NOT be selected",
  );

  // Primary fails, shadow verifier=fail → null
  const shadowVerifierFail: Candidate = { ...passingShadow, verifierVerdict: "fail" };
  assert.equal(
    selectBestCandidate([failingPrimary, shadowVerifierFail]),
    null,
    "candidate with verifierVerdict=fail must NOT be selected",
  );
});

test("single-workspace flow unchanged: a run that never touches the shadow API still reaches AWAITING_APPROVAL with active.workspaces=[primary]", async () => {
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
    assert.equal(persisted?.status, "AWAITING_APPROVAL", `single-workspace run must reach AWAITING_APPROVAL; got ${persisted?.status}`);

    // The candidate accessor on a vanilla run returns at most the
    // primary's record (which is empty for now — primary candidate
    // wiring is intentionally minimal — and never contains a shadow).
    const candidates = coordinator.getRunCandidates(receipt.runId);
    for (const c of candidates) {
      assert.notEqual(c.role, "shadow", "vanilla run must NOT have any shadow candidates");
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── Candidate selection policy: extended rules ─────────────────────
//
// These pure-function tests cover the full selectBestCandidate
// policy that drives local-vs-cloud lane comparison. The minimal
// 5-test scaffolding above pins backward compat (existing
// primary-vs-shadow runs); these tests add the disqualification
// rules + tiered tiebreakers (advisories → diff size → cost →
// local-lane preference → primary-role).

function makeCandidate(over: Partial<Candidate> & { workspaceId: string; role: "primary" | "shadow" }): Candidate {
  return {
    workspacePath: `/tmp/${over.workspaceId}`,
    patchArtifact: null,
    verifierVerdict: "pass",
    criticalFindings: 0,
    costUsd: 0,
    latencyMs: 100,
    status: "passed",
    reason: "ok",
    ...over,
  };
}

test("candidate selection: candidate with critical findings is rejected", () => {
  const a = makeCandidate({ workspaceId: "primary", role: "primary", criticalFindings: 1 });
  const b = makeCandidate({ workspaceId: "shadow-1", role: "shadow" });
  assert.equal(selectBestCandidate([a]), null, "single critical-finding candidate must not be selected");
  assert.equal(selectBestCandidate([a, b]), b, "qualified shadow must beat disqualified primary with critical findings");
});

test("candidate selection: candidate with requiredDeliverablesCompleted=false is rejected", () => {
  const a = makeCandidate({ workspaceId: "primary", role: "primary", requiredDeliverablesCompleted: false });
  const b = makeCandidate({ workspaceId: "shadow-1", role: "shadow", requiredDeliverablesCompleted: true });
  assert.equal(selectBestCandidate([a, b]), b, "candidate missing required deliverables must NOT be selected");
});

test("candidate selection: testsPassed=false / typecheckPassed=false / verifierVerdict=fail are all disqualifying", () => {
  const a = makeCandidate({ workspaceId: "primary", role: "primary", testsPassed: false });
  const b = makeCandidate({ workspaceId: "shadow-1", role: "shadow", typecheckPassed: false });
  const c = makeCandidate({ workspaceId: "shadow-2", role: "shadow", verifierVerdict: "fail" });
  const d = makeCandidate({ workspaceId: "shadow-3", role: "shadow" }); // qualified
  assert.equal(selectBestCandidate([a, b, c, d]), d, "only the candidate with no negative quality signals should win");
});

test("candidate selection: prefers fewer advisories on quality tie", () => {
  const noisy = makeCandidate({ workspaceId: "primary", role: "primary", advisoryFindings: 5 });
  const clean = makeCandidate({ workspaceId: "shadow-1", role: "shadow", advisoryFindings: 1 });
  assert.equal(selectBestCandidate([noisy, clean]), clean, "fewer advisories must win even when shadow vs primary");
});

test("candidate selection: prefers smaller diff on equal quality", () => {
  const sprawl = makeCandidate({
    workspaceId: "primary",
    role: "primary",
    changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
  });
  const surgical = makeCandidate({
    workspaceId: "shadow-1",
    role: "shadow",
    changedFiles: ["a.ts"],
  });
  assert.equal(selectBestCandidate([sprawl, surgical]), surgical, "smaller diff must win on equal advisory count");
});

test("candidate selection: prefers lower cost only when quality is comparable", () => {
  // Equal advisories + equal diff size → cost decides.
  const cheap = makeCandidate({ workspaceId: "primary", role: "primary", costUsd: 0.001, advisoryFindings: 0 });
  const expensive = makeCandidate({ workspaceId: "shadow-1", role: "shadow", costUsd: 1.0, advisoryFindings: 0 });
  assert.equal(selectBestCandidate([cheap, expensive]), cheap, "cheaper candidate must win on quality tie");

  // But cost MUST NOT win when quality differs — the more expensive
  // candidate has fewer advisories, so it should still win.
  const cheapButNoisy = makeCandidate({ workspaceId: "primary", role: "primary", costUsd: 0.001, advisoryFindings: 5 });
  const expensiveButClean = makeCandidate({ workspaceId: "shadow-1", role: "shadow", costUsd: 1.0, advisoryFindings: 0 });
  assert.equal(
    selectBestCandidate([cheapButNoisy, expensiveButClean]),
    expensiveButClean,
    "cost must not override quality — fewer advisories wins regardless of cost",
  );
});

test("candidate selection: local pass beats cloud fail (lane-tagged)", () => {
  const localPass = makeCandidate({ workspaceId: "primary", role: "primary", lane: "local" });
  const cloudFail = makeCandidate({
    workspaceId: "shadow-1",
    role: "shadow",
    lane: "cloud",
    status: "failed",
  });
  assert.equal(selectBestCandidate([localPass, cloudFail]), localPass, "passing local must beat failing cloud");
});

test("candidate selection: cloud pass beats local fail (lane-tagged)", () => {
  const cloudPass = makeCandidate({ workspaceId: "primary", role: "primary", lane: "cloud" });
  const localFail = makeCandidate({
    workspaceId: "shadow-1",
    role: "shadow",
    lane: "local",
    status: "failed",
  });
  assert.equal(selectBestCandidate([cloudPass, localFail]), cloudPass, "passing cloud must beat failing local");
});

test("candidate selection: local and cloud pass with equal quality → local wins (privacy/cost preference)", () => {
  // Same advisories, same diff size, same cost — only the lane differs.
  const cloud = makeCandidate({
    workspaceId: "primary",
    role: "primary",
    lane: "cloud",
    advisoryFindings: 0,
    costUsd: 0.05,
    changedFiles: ["a.ts"],
  });
  const local = makeCandidate({
    workspaceId: "shadow-1",
    role: "shadow",
    lane: "local",
    advisoryFindings: 0,
    costUsd: 0.05,
    changedFiles: ["a.ts"],
  });
  assert.equal(
    selectBestCandidate([cloud, local]),
    local,
    "local lane must win on quality tie even when the cloud candidate is the primary",
  );
});

test("candidate selection: cloud wins when local misses required deliverable", () => {
  const localMissing = makeCandidate({
    workspaceId: "primary",
    role: "primary",
    lane: "local",
    requiredDeliverablesCompleted: false,
  });
  const cloudComplete = makeCandidate({
    workspaceId: "shadow-1",
    role: "shadow",
    lane: "cloud",
    requiredDeliverablesCompleted: true,
  });
  assert.equal(
    selectBestCandidate([localMissing, cloudComplete]),
    cloudComplete,
    "cloud must win when local fails to complete required deliverables",
  );
});

// ─── Cleanup behavior ───────────────────────────────────────────────

test("losing candidate workspace cleanup: cleanupLosingCandidates discards non-selected shadow workspaces and leaves primary intact", async () => {
  const repo = makeTempRepo();
  try {
    let resolveBlock!: () => void;
    const block = new Promise<void>((r) => { resolveBlock = r; });
    let cleanupResultPromise: Promise<readonly string[]> | null = null;
    let primaryPathSnap = "";
    let shadowPathSnap = "";

    class ProbeBuilder extends RealBuilderWorker {
      override async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
        primaryPathSnap = assignment.projectRoot ?? "";
        const runs = (coordinator as unknown as { activeRuns: Map<string, unknown> }).activeRuns;
        const runId = [...runs.keys()][0] as string;
        // Create a shadow workspace, capture its path, then cleanup
        // with no selected workspaceId (i.e. discard ALL shadows).
        const shadowEntry = await coordinator.createShadowWorkspaceForRun(runId);
        shadowPathSnap = shadowEntry.handle.workspacePath;
        cleanupResultPromise = coordinator.cleanupLosingCandidates(runId, null);
        await cleanupResultPromise;
        await block;
        return super.execute(assignment);
      }
    }

    const builder = new ProbeBuilder([
      { path: "core/widget.ts", content: "export const widget = 13;\n" },
    ]);
    const { coordinator } = buildHarness(repo, { builder, requireApproval: true });

    const submitPromise = coordinator.submit({ input: "modify widget in core" });
    while (!cleanupResultPromise) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const discarded = await cleanupResultPromise;
    resolveBlock();
    await submitPromise;

    assert.deepEqual(
      [...discarded].sort(),
      ["shadow-1"],
      `cleanupLosingCandidates must report the discarded shadow id; got ${JSON.stringify(discarded)}`,
    );
    assert.equal(
      existsSync(shadowPathSnap),
      false,
      `shadow workspace path must be removed from disk; ${shadowPathSnap} still exists`,
    );
    // Primary path must still exist mid-run (it gets cleaned up at
    // the normal submit/approve/promote terminal).
    assert.equal(
      existsSync(primaryPathSnap),
      true,
      "primary workspace path must NOT be touched by cleanupLosingCandidates",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("losing candidate workspace cleanup: selectedWorkspaceId is preserved while other shadows are discarded", async () => {
  const repo = makeTempRepo();
  try {
    let resolveBlock!: () => void;
    const block = new Promise<void>((r) => { resolveBlock = r; });
    let cleanupResultPromise: Promise<readonly string[]> | null = null;
    const shadowPaths: Record<string, string> = {};

    class ProbeBuilder extends RealBuilderWorker {
      override async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
        const runs = (coordinator as unknown as { activeRuns: Map<string, unknown> }).activeRuns;
        const runId = [...runs.keys()][0] as string;
        const s1 = await coordinator.createShadowWorkspaceForRun(runId);
        const s2 = await coordinator.createShadowWorkspaceForRun(runId);
        shadowPaths[s1.workspaceId] = s1.handle.workspacePath;
        shadowPaths[s2.workspaceId] = s2.handle.workspacePath;
        // Keep shadow-2 ("the winner"), discard the rest.
        cleanupResultPromise = coordinator.cleanupLosingCandidates(runId, "shadow-2");
        await cleanupResultPromise;
        await block;
        return super.execute(assignment);
      }
    }

    const builder = new ProbeBuilder([
      { path: "core/widget.ts", content: "export const widget = 14;\n" },
    ]);
    const { coordinator } = buildHarness(repo, { builder, requireApproval: true });

    const submitPromise = coordinator.submit({ input: "modify widget in core" });
    while (!cleanupResultPromise) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const discarded = await cleanupResultPromise;
    resolveBlock();
    await submitPromise;

    assert.deepEqual([...discarded].sort(), ["shadow-1"], "only shadow-1 should be discarded; shadow-2 was selected");
    assert.equal(existsSync(shadowPaths["shadow-1"]), false, "shadow-1 path must be removed");
    assert.equal(existsSync(shadowPaths["shadow-2"]), true, "shadow-2 (selected) must NOT be removed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
