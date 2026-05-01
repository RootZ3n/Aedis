/**
 * Gauntlet Harness — shared fixture creation, coordinator wiring, and
 * assertion utilities for the Aedis Practical Gauntlet.
 *
 * Every gauntlet test creates a disposable fixture repo under OS temp,
 * runs the Aedis Coordinator against it with stub workers, and asserts
 * real outcomes (diffs, receipts, execution modes, garbage detection).
 *
 * The harness never touches the real source repo.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

import { Coordinator, type RunReceipt, type TaskSubmission } from "../../core/coordinator.js";
import { ReceiptStore } from "../../core/receipt-store.js";
import { WorkerRegistry, AbstractWorker } from "../../workers/base.js";
import type {
  WorkerAssignment,
  WorkerResult,
  WorkerType,
  WorkerOutput,
  BuilderOutput,
  FileChange,
} from "../../workers/base.js";
import type { CostEntry } from "../../core/runstate.js";
import type { TrustProfile } from "../../router/trust-router.js";
import type { AedisEvent, EventBus } from "../../server/websocket.js";
import type { OperatorNarrativeEvent } from "../../core/operator-narrative.js";

// ─── Gauntlet Report Types ───────────────────────────────────────────

export type GauntletStatus = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";

export interface GauntletTaskReport {
  taskId: string;
  description: string;
  category: string;
  fixtureRepo: string;
  executionMode: string | null;
  intendedModel: string;
  actualModel: string | null;
  status: GauntletStatus;
  diffProduced: boolean;
  approvalReached: boolean;
  sourceMutatedBeforeApproval: boolean;
  garbageDetected: boolean;
  receiptPath: string | null;
  durationMs: number;
  failureReason: string | null;
  stageTiming: Record<string, number>;
  workersRan: string[];
  skippedStages: string[];
}

export interface GauntletReport {
  timestamp: string;
  totalTasks: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  tasks: GauntletTaskReport[];
  readiness: {
    practical_gauntlet_green: boolean;
    live_smoke_green: boolean;
  };
  durationMs: number;
}

// ─── Stub Workers ────────────────────────────────────────────────────

export class FixtureBuilderWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "FixtureBuilder";
  constructor(private readonly writes: readonly { path: string; content: string }[]) { super(); }
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    const { writeFile, readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = assignment.projectRoot ?? process.cwd();
    const changes: FileChange[] = [];
    for (const w of this.writes) {
      const abs = resolve(root, w.path);
      const existed = existsSync(abs);
      const originalContent = await readFile(abs, "utf-8").catch(() => "");
      // Idempotency: if a prior builder node already wrote the desired
      // content (coordinator may dispatch multiple builder nodes for
      // a single file), skip the re-write to avoid byte_for_byte_duplicate.
      if (originalContent === w.content) continue;
      await writeFile(abs, w.content, "utf-8");
      changes.push({
        path: w.path,
        operation: existed ? "modify" as const : "create" as const,
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

/** Builder that intentionally produces nothing (simulates model failure). */
export class NoOpBuilderWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "NoOpBuilder";
  async execute(assignment: WorkerAssignment): Promise<WorkerResult> {
    const output: BuilderOutput = { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
    return this.success(assignment, output, {
      cost: this.zeroCost(), confidence: 0.1,
      touchedFiles: [],
      durationMs: 1,
    });
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}

/** Builder that throws (simulates crash). */
export class CrashingBuilderWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "CrashingBuilder";
  async execute(_assignment: WorkerAssignment): Promise<WorkerResult> {
    throw new Error("Simulated builder crash");
  }
  async estimateCost(): Promise<CostEntry> { return this.zeroCost(); }
  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }
}

export class StubScoutWorker extends AbstractWorker {
  readonly type: WorkerType = "scout";
  readonly name = "StubScout";
  async execute(a: WorkerAssignment): Promise<WorkerResult> {
    return this.success(a, {
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

export class StubCriticWorker extends AbstractWorker {
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

export class StubVerifierWorker extends AbstractWorker {
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

export class StubIntegratorWorker extends AbstractWorker {
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

// ─── Harness ─────────────────────────────────────────────────────────

export interface GauntletContext {
  coordinator: Coordinator;
  events: AedisEvent[];
  receiptStore: ReceiptStore;
}

export function buildGauntletCoordinator(repo: string, builder: AbstractWorker): GauntletContext {
  const registry = new WorkerRegistry();
  registry.register(new StubScoutWorker());
  registry.register(builder);
  registry.register(new StubCriticWorker());
  registry.register(new StubVerifierWorker());
  registry.register(new StubIntegratorWorker());

  const trustProfile: TrustProfile = {
    scores: new Map(),
    tierThresholds: { fast: 0, standard: 0, premium: 0 },
  };
  const events: AedisEvent[] = [];
  const eventBus: EventBus = {
    emit(e) { events.push(e); },
    on: () => () => {}, onType: () => () => {},
    addClient: () => {}, removeClient: () => {},
    clientCount: () => 0, recentEvents: () => [],
  };
  const receiptStore = new ReceiptStore(repo);
  const coordinator = new Coordinator(
    {
      projectRoot: repo,
      autoCommit: true,
      requireWorkspace: true,
      requireApproval: true,
      autoPromoteOnSuccess: false,
      allowSourcePromotion: true,
      trustedLocalRepoWrites: true,
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

// ─── Fixture Repos ───────────────────────────────────────────────────

export interface FixtureRepo {
  path: string;
  cleanup: () => void;
}

export function makeFixtureRepo(opts?: { extraFiles?: Record<string, string> }): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), "aedis-gauntlet-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "gauntlet-fixture", version: "0.0.0" }), "utf-8");
  writeFileSync(join(dir, "README.md"), "# Gauntlet Fixture\n\nA tiny repo for Aedis gauntlet tests.\n", "utf-8");
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## v0.0.0\n\n- Initial release.\n", "utf-8");
  writeFileSync(join(dir, "src/util.ts"), "export const VERSION = 1;\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n", "utf-8");
  writeFileSync(join(dir, "src/util.test.ts"), "// existing test file\nimport { add } from './util.js';\n", "utf-8");
  writeFileSync(join(dir, "src/index.ts"), "export { VERSION, add } from './util.js';\n", "utf-8");
  if (opts?.extraFiles) {
    for (const [relPath, content] of Object.entries(opts.extraFiles)) {
      const abs = join(dir, relPath);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    }
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "gauntlet@aedis.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Aedis Gauntlet"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });

  const keepRepos = process.env.AEDIS_GAUNTLET_KEEP === "1";
  return {
    path: dir,
    cleanup: () => { if (!keepRepos) rmSync(dir, { recursive: true, force: true }); },
  };
}

// ─── Assertion Helpers ───────────────────────────────────────────────

export function getNarrative(events: AedisEvent[]): OperatorNarrativeEvent[] {
  return events
    .filter((e) => e.type === "operator_narrative")
    .map((e) => e.payload as unknown as OperatorNarrativeEvent);
}

export function getNarrativeTrail(events: AedisEvent[]): string[] {
  return getNarrative(events).map((e) => e.kind);
}

export function assertReadinessContract(
  receipt: RunReceipt,
  events: AedisEvent[],
  opts: { expectDiff: boolean; expectMode?: string },
): void {
  assert.ok(receipt.runId, "receipt must carry a runId");
  if (opts.expectDiff) {
    assert.ok(receipt.summary.filesModified > 0, "expected at least one file modified");
  }
  // No source promotion without approval.
  assert.ok(!receipt.commitSha, "no source promotion without approval");
  // Narrative trail must include risk + mode + plan.
  const trail = getNarrativeTrail(events);
  const r = trail.indexOf("risk_assessment");
  const m = trail.indexOf("mode_selected");
  const p = trail.indexOf("plan_drafted");
  assert.ok(r >= 0 && m >= 0 && p >= 0, `narrative trail incomplete: ${trail.join(",")}`);
  assert.ok(r < m && m < p, `narrative trail out of order: ${trail.join(",")}`);
  // Check mode if specified.
  if (opts.expectMode) {
    assert.equal(receipt.executionMode, opts.expectMode,
      `expected mode ${opts.expectMode} but got ${receipt.executionMode}`);
  }
}

export function assertSourceUnchanged(repo: string, filePath: string, originalContent: string): void {
  assert.equal(readFileSync(join(repo, filePath), "utf-8"), originalContent,
    `source repo file ${filePath} must not be promoted without approval`);
}

export function assertNoGarbage(receipt: RunReceipt): void {
  if (receipt.garbageCheck) {
    assert.ok(receipt.garbageCheck.ok, `garbage check should be clean but found: ${
      receipt.garbageCheck.findings.map(f => f.kind).join(", ")
    }`);
  }
}

export function assertGarbageBlocked(receipt: RunReceipt, expectedKind?: string): void {
  assert.equal(receipt.verdict, "failed", "garbage output must fail the run");
  assert.ok(receipt.garbageCheck, "garbageCheck must be on receipt");
  assert.equal(receipt.garbageCheck!.ok, false, "garbageCheck.ok must be false");
  if (expectedKind) {
    assert.ok(
      receipt.garbageCheck!.findings.some((f) => f.kind === expectedKind),
      `expected ${expectedKind} finding, got: ${receipt.garbageCheck!.findings.map(f => f.kind).join(",")}`,
    );
  }
}

// ─── Report Builder ──────────────────────────────────────────────────

export function makeTaskReport(
  taskId: string,
  description: string,
  category: string,
  fixtureRepo: string,
  receipt: RunReceipt | null,
  events: AedisEvent[],
  startMs: number,
  status: GauntletStatus,
  failureReason: string | null = null,
): GauntletTaskReport {
  const trail = getNarrativeTrail(events);
  return {
    taskId,
    description,
    category,
    fixtureRepo,
    executionMode: receipt?.executionMode ?? null,
    intendedModel: "stub/fixture",
    actualModel: receipt?.totalCost?.model ?? null,
    status,
    diffProduced: (receipt?.summary?.filesModified ?? 0) > 0,
    approvalReached: trail.includes("approval_pause") || trail.includes("completion_summary"),
    sourceMutatedBeforeApproval: !!receipt?.commitSha,
    garbageDetected: receipt?.garbageCheck ? !receipt.garbageCheck.ok : false,
    receiptPath: null, // filled by runner if persisted
    durationMs: Date.now() - startMs,
    failureReason,
    stageTiming: {},
    workersRan: [...new Set(
      events
        .filter(e => e.type === "worker_start" || e.type === "worker_complete")
        .map(e => (e.payload as Record<string, unknown>)?.workerType as string)
        .filter(Boolean)
    )],
    skippedStages: receipt?.executionModeDetail?.skippedStages as string[] ?? [],
  };
}

export function buildGauntletReport(tasks: GauntletTaskReport[], startMs: number): GauntletReport {
  return {
    timestamp: new Date().toISOString(),
    totalTasks: tasks.length,
    passed: tasks.filter(t => t.status === "PASS").length,
    failed: tasks.filter(t => t.status === "FAIL").length,
    blocked: tasks.filter(t => t.status === "BLOCKED").length,
    skipped: tasks.filter(t => t.status === "SKIPPED").length,
    tasks,
    readiness: {
      practical_gauntlet_green: tasks.every(t => t.status === "PASS" || t.status === "SKIPPED"),
      live_smoke_green: false, // only set by live smoke runner
    },
    durationMs: Date.now() - startMs,
  };
}

export function formatReportText(report: GauntletReport): string {
  const lines: string[] = [];
  lines.push("Aedis Practical Gauntlet Report");
  lines.push("=".repeat(72));
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Duration:  ${report.durationMs}ms`);
  lines.push(`Total:     ${report.totalTasks}  PASS: ${report.passed}  FAIL: ${report.failed}  BLOCKED: ${report.blocked}  SKIPPED: ${report.skipped}`);
  lines.push("");

  const byCategory = new Map<string, GauntletTaskReport[]>();
  for (const t of report.tasks) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }

  for (const [cat, tasks] of byCategory) {
    lines.push(`--- ${cat} ---`);
    for (const t of tasks) {
      const tag = t.status === "PASS" ? "PASS" : t.status === "FAIL" ? "FAIL" : t.status === "BLOCKED" ? "BLKD" : "SKIP";
      lines.push(`  [${tag}] ${t.taskId}: ${t.description}`);
      lines.push(`         mode=${t.executionMode ?? "?"} diff=${t.diffProduced} garbage=${t.garbageDetected} ${t.durationMs}ms`);
      if (t.failureReason) lines.push(`         REASON: ${t.failureReason}`);
    }
    lines.push("");
  }

  lines.push("-".repeat(72));
  lines.push(`practical_gauntlet_green: ${report.readiness.practical_gauntlet_green}`);
  lines.push(`live_smoke_green:        ${report.readiness.live_smoke_green}`);
  return lines.join("\n");
}
