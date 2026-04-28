/**
 * Phase B execution wiring — local_then_cloud fallback.
 *
 * These tests pin down the dispatch policy at the coordinator-method
 * layer (recordPrimaryCandidate / maybeRunFallbackShadow /
 * buildCandidateManifest) without driving a full submit() — the goal
 * is to lock down the *decision* (who wins, what gets recorded, what
 * cleanup runs) without doubling pipeline cost. End-to-end loader
 * tests live in this same file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator } from "./coordinator.js";
import { ReceiptStore } from "./receipt-store.js";
import { selectBestCandidate, type Candidate } from "./candidate.js";
import { loadLaneConfigFromDisk, DEFAULT_LANE_CONFIG } from "./lane-config.js";
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
import type { MergeDecision } from "./merge-gate.js";

// ─── Test harness ───────────────────────────────────────────────────

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
      changes.push({ path: w.path, operation: "modify" as const, content: w.content, originalContent });
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
  readonly type: WorkerType = "critic"; readonly name = "StubCritic";
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
  readonly type: WorkerType = "verifier"; readonly name = "StubVerifier";
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
  readonly type: WorkerType = "integrator"; readonly name = "StubIntegrator";
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

function buildHarness(projectRoot: string, builder: AbstractWorker) {
  const registry = new WorkerRegistry();
  registry.register(new StubScout());
  registry.register(builder);
  registry.register(new StubCritic());
  registry.register(new StubVerifier());
  registry.register(new StubIntegrator());
  const trustProfile: TrustProfile = {
    scores: new Map(),
    tierThresholds: { fast: 0, standard: 0, premium: 0 },
  };
  const events: AedisEvent[] = [];
  const eventBus: EventBus = {
    emit(event) { events.push(event); }, on: () => () => {},
    onType: () => () => {}, addClient: () => {},
    removeClient: () => {}, clientCount: () => 0, recentEvents: () => [],
  };
  const receiptStore = new ReceiptStore(projectRoot);
  const coordinator = new Coordinator(
    {
      projectRoot, autoCommit: true, requireWorkspace: true,
      requireApproval: false, autoPromoteOnSuccess: false,
      // Force the shadow lane to fall back to the registered stub
      // Builder. Phase D made `maybeRunFallbackShadow` construct a
      // real BuilderWorker via `createBuilderForLane` — leaving that
      // path active would let these tests reach OpenRouter for real.
      // Returning null disables the lane-pinned builder
      // and drops back to the registry default (the stubs above),
      // which is exactly what these tests want to exercise.
      laneBuilderFactory: () => null,
      verificationConfig: {
        requiredChecks: [],
        hooks: [{
          name: "stub-typecheck", stage: "typecheck", kind: "typecheck",
          execute: async () => ({ passed: true, issues: [], stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
        }],
      },
    },
    trustProfile, registry, eventBus, receiptStore,
  );
  return { coordinator, events, receiptStore };
}

function makeTempRepo(extraInit?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-laneexec-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tmp", version: "0.0.0" }), "utf-8");
  writeFileSync(join(dir, "core/widget.ts"), "export const widget = 1;\n", "utf-8");
  extraInit?.(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "lane@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "LaneTest"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

function writeLaneConfig(dir: string, payload: unknown): void {
  mkdirSync(join(dir, ".aedis"), { recursive: true });
  writeFileSync(join(dir, ".aedis/lane-config.json"), JSON.stringify(payload, null, 2), "utf-8");
}

// ─── Loader tests ────────────────────────────────────────────────────

test("loadLaneConfigFromDisk returns DEFAULT_LANE_CONFIG when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-lane-noconfig-"));
  try {
    const config = loadLaneConfigFromDisk(dir);
    assert.equal(config, DEFAULT_LANE_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLaneConfigFromDisk parses .aedis/lane-config.json when valid", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-lane-loader-"));
  try {
    writeLaneConfig(dir, {
      mode: "local_then_cloud",
      primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
      shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    });
    const config = loadLaneConfigFromDisk(dir);
    assert.equal(config.mode, "local_then_cloud");
    assert.equal(config.primary.lane, "local");
    assert.equal(config.shadow?.lane, "cloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLaneConfigFromDisk falls back when the JSON is malformed and surfaces the error", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-lane-bad-"));
  const errors: string[] = [];
  try {
    mkdirSync(join(dir, ".aedis"), { recursive: true });
    writeFileSync(join(dir, ".aedis/lane-config.json"), "{ not valid json", "utf-8");
    const config = loadLaneConfigFromDisk(dir, { onError: (m) => errors.push(m) });
    assert.equal(config, DEFAULT_LANE_CONFIG);
    assert.ok(errors.some((e) => /failed to read\/parse/.test(e)), `expected parse error; got ${JSON.stringify(errors)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLaneConfigFromDisk falls back when validation fails (e.g. shadow missing)", () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-lane-validate-"));
  const errors: string[] = [];
  try {
    writeLaneConfig(dir, {
      mode: "local_then_cloud",
      primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
      // shadow intentionally absent — validator must reject
    });
    const config = loadLaneConfigFromDisk(dir, { onError: (m) => errors.push(m) });
    assert.equal(config, DEFAULT_LANE_CONFIG);
    assert.ok(errors.some((e) => /failed validation/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Helper: synthesize a primary-only success run, then drive the
//     Phase B helpers manually. We want to cover the policy decisions
//     without relying on a forced verifier failure inside submit().

interface ActiveRunSnap {
  active: any;
  coordinator: Coordinator;
}

async function runPrimaryAndCapture(
  dir: string,
  laneConfigPayload: unknown,
): Promise<ActiveRunSnap> {
  writeLaneConfig(dir, laneConfigPayload);
  let resolveBlock!: () => void;
  const block = new Promise<void>((r) => { resolveBlock = r; });
  let captured: any = null;
  let coordinatorRef: Coordinator;

  class ProbeBuilder extends RealBuilderWorker {
    override async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
      const runs = (coordinatorRef as unknown as { activeRuns: Map<string, any> }).activeRuns;
      captured = [...runs.values()][0];
      // Don't return until the probe captured a reference.
      await block;
      return super.execute(assignment);
    }
  }
  const builder = new ProbeBuilder([
    { path: "core/widget.ts", content: "export const widget = 2;\n" },
  ]);
  const harness = buildHarness(dir, builder);
  coordinatorRef = harness.coordinator;
  const submit = harness.coordinator.submit({ input: "modify widget in core" });
  while (!captured) await new Promise((r) => setTimeout(r, 10));
  // Snapshot the active run while the builder is still suspended so
  // we can mutate / observe it without races.
  const snap: ActiveRunSnap = { active: captured, coordinator: harness.coordinator };
  resolveBlock();
  await submit;
  return snap;
}

// ─── Policy unit tests on the Phase B helpers ───────────────────────

const APPLY_DECISION: MergeDecision = {
  action: "apply",
  summary: "merge approved",
  primaryBlockReason: "",
  findings: [], critical: [], advisory: [],
};
const BLOCK_DECISION: MergeDecision = {
  action: "block",
  summary: "merge blocked",
  primaryBlockReason: "tests failed",
  findings: [],
  critical: [{
    source: "verification-pipeline" as const,
    severity: "critical" as const,
    code: "verification:tests-failed",
    message: "test stage failed",
  }],
  advisory: [],
};

test("recordPrimaryCandidate stamps lane/provider/model and is idempotent", async () => {
  const dir = makeTempRepo();
  try {
    const snap = await runPrimaryAndCapture(dir, {
      mode: "local_then_cloud",
      primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
      shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    });
    // The primary candidate may have already been recorded by submit's
    // own wiring — confirm it's the right shape and that re-recording
    // replaces rather than duplicates.
    const before = snap.active.candidates.length;
    snap.coordinator.recordPrimaryCandidate(snap.active, {
      mergeDecision: APPLY_DECISION,
      verificationReceipt: null,
      lane: "local",
      provider: "ollama",
      model: "qwen3.5:9b",
    });
    const after = snap.active.candidates.filter((c: Candidate) => c.workspaceId === "primary");
    assert.equal(after.length, 1, "only one primary candidate should ever exist");
    assert.equal(after[0].lane, "local");
    assert.equal(after[0].provider, "ollama");
    assert.equal(after[0].model, "qwen3.5:9b");
    assert.equal(snap.active.candidates.length, Math.max(before, 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("primary passes → maybeRunFallbackShadow does NOT run shadow (local_then_cloud)", async () => {
  const dir = makeTempRepo();
  try {
    const snap = await runPrimaryAndCapture(dir, {
      mode: "local_then_cloud",
      primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
      shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    });
    // Mark the primary as PASSED.
    snap.coordinator.recordPrimaryCandidate(snap.active, {
      mergeDecision: APPLY_DECISION,
      verificationReceipt: null,
      lane: "local",
    });
    // Drop any shadow candidates the submit() flow may have appended;
    // we want a clean slate for the policy assertion.
    snap.active.candidates = snap.active.candidates.filter((c: Candidate) => c.role === "primary");
    const shadowResult = await snap.coordinator.maybeRunFallbackShadow(snap.active);
    assert.equal(shadowResult, null, "fallback shadow must not run when primary qualifies");
    assert.equal(
      snap.active.candidates.filter((c: Candidate) => c.role === "shadow").length,
      0,
      "no shadow candidate should be appended",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("primary fails → maybeRunFallbackShadow runs shadow with config.shadow lane/provider/model", async () => {
  const dir = makeTempRepo();
  try {
    const snap = await runPrimaryAndCapture(dir, {
      mode: "local_then_cloud",
      primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
      shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    });
    snap.active.candidates = snap.active.candidates.filter((c: Candidate) => c.role === "primary");
    snap.coordinator.recordPrimaryCandidate(snap.active, {
      mergeDecision: BLOCK_DECISION,
      verificationReceipt: null,
      lane: "local",
    });
    const shadow = await snap.coordinator.maybeRunFallbackShadow(snap.active);
    assert.ok(shadow, "fallback shadow must run when primary disqualifies");
    assert.equal(shadow!.role, "shadow");
    assert.equal(shadow!.lane, "cloud", "shadow must adopt config.shadow.lane");
    assert.equal(shadow!.provider, "openrouter");
    assert.equal(shadow!.model, "xiaomi/mimo-v2.5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("primary_only → maybeRunFallbackShadow never runs shadow", async () => {
  const dir = makeTempRepo();
  try {
    const snap = await runPrimaryAndCapture(dir, {
      mode: "primary_only",
      primary: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    });
    snap.active.candidates = snap.active.candidates.filter((c: Candidate) => c.role === "primary");
    snap.coordinator.recordPrimaryCandidate(snap.active, {
      mergeDecision: BLOCK_DECISION,
      verificationReceipt: null,
    });
    const shadow = await snap.coordinator.maybeRunFallbackShadow(snap.active);
    assert.equal(shadow, null, "primary_only must never run a shadow lane");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectBestCandidate picks shadow when primary disqualifies and shadow qualifies", async () => {
  const dir = makeTempRepo();
  try {
    const snap = await runPrimaryAndCapture(dir, {
      mode: "local_then_cloud",
      primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
      shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    });
    snap.active.candidates = snap.active.candidates.filter((c: Candidate) => c.role === "primary");
    snap.coordinator.recordPrimaryCandidate(snap.active, {
      mergeDecision: BLOCK_DECISION,
      verificationReceipt: null,
      lane: "local",
    });
    await snap.coordinator.maybeRunFallbackShadow(snap.active);
    const winner = selectBestCandidate(snap.active.candidates);
    assert.ok(winner, "selection must produce a winner when shadow qualifies");
    assert.equal(winner!.role, "shadow", "shadow must beat disqualified primary");
    assert.equal(winner!.lane, "cloud");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectBestCandidate picks primary when primary qualifies (shadow ignored)", async () => {
  const dir = makeTempRepo();
  try {
    const snap = await runPrimaryAndCapture(dir, {
      mode: "local_then_cloud",
      primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
      shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    });
    snap.active.candidates = snap.active.candidates.filter((c: Candidate) => c.role === "primary");
    snap.coordinator.recordPrimaryCandidate(snap.active, {
      mergeDecision: APPLY_DECISION,
      verificationReceipt: null,
      lane: "local",
    });
    const shadow = await snap.coordinator.maybeRunFallbackShadow(snap.active);
    assert.equal(shadow, null, "shadow lane must not run when primary qualifies");
    const winner = selectBestCandidate(snap.active.candidates);
    assert.equal(winner?.role, "primary");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildCandidateManifest projects fields and disqualification reason", async () => {
  const dir = makeTempRepo();
  try {
    const snap = await runPrimaryAndCapture(dir, {
      mode: "local_then_cloud",
      primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
      shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    });
    snap.active.candidates = snap.active.candidates.filter((c: Candidate) => c.role === "primary");
    snap.coordinator.recordPrimaryCandidate(snap.active, {
      mergeDecision: BLOCK_DECISION,
      verificationReceipt: null,
      lane: "local",
    });
    await snap.coordinator.maybeRunFallbackShadow(snap.active);
    const manifest = snap.coordinator.buildCandidateManifest(snap.active);
    assert.equal(manifest.length, 2, `expected 2 manifest entries; got ${manifest.length}`);
    const primary = manifest.find((m) => m.workspaceId === "primary")!;
    const shadow = manifest.find((m) => m.role === "shadow")!;
    assert.equal(primary.lane, "local");
    // candidateDisqualification short-circuits at the first failed
    // rule. Status is checked before criticalFindings, so a failed
    // primary with critical findings still reports `status=failed`.
    assert.equal(primary.disqualification, "status=failed", `primary should report disqualification reason; got ${primary.disqualification}`);
    assert.equal(shadow.lane, "cloud");
    // No workspacePath / patchArtifact leak in the manifest:
    assert.equal((primary as any).workspacePath, undefined);
    assert.equal((primary as any).patchArtifact, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Promote safety + cleanup (integration-shaped) ──────────────────

test("shadow candidate from local_then_cloud never directly promotes (role guard still wins)", async () => {
  const dir = makeTempRepo();
  try {
    const snap = await runPrimaryAndCapture(dir, {
      mode: "local_then_cloud",
      primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
      shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    });
    snap.active.candidates = snap.active.candidates.filter((c: Candidate) => c.role === "primary");
    snap.coordinator.recordPrimaryCandidate(snap.active, {
      mergeDecision: BLOCK_DECISION,
      verificationReceipt: null,
      lane: "local",
    });
    const shadow = await snap.coordinator.maybeRunFallbackShadow(snap.active);
    assert.ok(shadow);
    // Synthesize a receipt stamped with the shadow's workspace shape
    // and confirm promoteToSource still refuses it. This is the
    // safety contract Phase C will rely on.
    const receiptStore = (snap.coordinator as unknown as { receiptStore: ReceiptStore }).receiptStore;
    const fakeRunId = "phase-b-shadow-promote-attempt";
    await receiptStore.patchRun(fakeRunId, {
      status: "READY_FOR_PROMOTION",
      taskSummary: "phase-b shadow promote",
      prompt: "shadow",
      workspace: {
        workspacePath: shadow!.workspacePath,
        sourceRepo: dir,
        sourceCommitSha: "deadbeef",
        method: "worktree",
        createdAt: new Date().toISOString(),
        worktreeBranch: null,
        role: "shadow",
        workspaceId: shadow!.workspaceId,
      } as any,
    });
    const result = await snap.coordinator.promoteToSource(fakeRunId);
    assert.equal(result.ok, false, "shadow workspace must never promote");
    assert.match(result.error ?? "", /shadow|workspace role/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("losing shadow workspace gets cleaned up after fallback selection", async () => {
  const dir = makeTempRepo();
  try {
    const snap = await runPrimaryAndCapture(dir, {
      mode: "local_then_cloud",
      primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
      shadow: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    });
    snap.active.candidates = snap.active.candidates.filter((c: Candidate) => c.role === "primary");
    snap.coordinator.recordPrimaryCandidate(snap.active, {
      mergeDecision: BLOCK_DECISION,
      verificationReceipt: null,
      lane: "local",
    });
    const shadow = await snap.coordinator.maybeRunFallbackShadow(snap.active);
    assert.ok(shadow);
    // Re-fetch the active run via the public-ish runId — the captured
    // ref still points at the same Map entry, but cleanup deletes
    // entries from active.workspaces, so we operate on the live ref.
    const runId = snap.active.run.id;
    // Simulate "primary won" cleanup path: discard ALL shadow workspaces.
    const discarded = await snap.coordinator.cleanupLosingCandidates(runId, null);
    assert.deepEqual([...discarded], [shadow!.workspaceId], "shadow id must be reported as discarded");
    assert.equal(
      existsSync(shadow!.workspacePath), false,
      "shadow workspace path must be removed from disk",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
