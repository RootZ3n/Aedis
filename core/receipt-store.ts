import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import type { RunReceipt } from "./coordinator.js";
import type { CostEntry } from "./runstate.js";
import { redactForReceipt } from "./redaction.js";
import { withRepoLock, writeJsonAtomicLocked } from "./file-lock.js";

const exec = promisify(execFile);

/**
 * Workspace reference persisted on the run receipt. Used by startup
 * recovery to locate and clean up orphaned worktrees after a crash.
 * `cleanedUp=true` means the coordinator has already discarded the
 * workspace during normal shutdown — recovery should skip it.
 */
export interface PersistedWorkspaceRef {
  readonly workspacePath: string;
  readonly sourceRepo: string;
  readonly sourceCommitSha: string;
  readonly method: "worktree" | "clone" | "copy";
  readonly createdAt: string;
  readonly worktreeBranch: string | null;
  readonly cleanedUp: boolean;
}

/**
 * Canonical run status language. These statuses are the ONLY labels
 * that should appear in receipts, API payloads, and UI displays.
 *
 * Truth rules:
 *   - "PROPOSED" is the initial state before execution starts
 *   - "EXECUTING_IN_WORKSPACE" replaces "RUNNING" — makes it clear
 *     execution is happening in an isolated workspace, not applied
 *   - "VERIFICATION_PENDING" means build finished but tests/checks
 *     haven't run yet — must NOT be shown as "success"
 *   - "VERIFIED_PASS" means verification completed and passed
 *   - "VERIFIED_FAIL" means verification completed and failed
 *   - "CRUCIBULUM_FAIL" means the Crucibulum evaluator disagreed
 *     with the Aedis verdict — this is a FAILURE, not advisory
 *   - "DISAGREEMENT_HOLD" means Crucibulum and Aedis disagree
 *     but the run is held for human review — treated as BLOCKED
 *   - "EXECUTION_ERROR" replaces "CRASHED" — explicit error state
 *   - "CLEANUP_ERROR" means workspace cleanup failed — SEVERE
 *   - "UNSUPPORTED_CONFIG" means provider/model/lane config failed
 *     closed before execution; no alternate provider was run
 *   - "READY_FOR_PROMOTION" means all gates passed and the run
 *     is ready to be applied to the source branch — does NOT
 *     imply already applied
 *
 * "success" must NEVER be shown before verification completes.
 * Advisory confidence must NOT override Crucibulum verdict.
 */
export type PersistentRunStatus =
  | "PROPOSED"
  | "EXECUTING_IN_WORKSPACE"
  | "VERIFICATION_PENDING"
  | "VERIFIED_PASS"
  | "VERIFIED_FAIL"
  | "CRUCIBULUM_FAIL"
  | "DISAGREEMENT_HOLD"
  | "EXECUTION_ERROR"
  | "CLEANUP_ERROR"
  | "UNSUPPORTED_CONFIG"
  | "ROLLBACK_FAILED"
  | "ROLLBACK_INCOMPLETE"
  | "UNSAFE_STATE"
  | "READY_FOR_PROMOTION"
  | "ABORTED"
  | "INTERRUPTED"
  | "AWAITING_APPROVAL"
  | "REJECTED"
  | "PROMOTED"
  // Legacy aliases — still accepted for reading old receipts.
  // New code should never WRITE these.
  | "RUNNING"
  | "COMPLETE"
  | "FAILED"
  | "CRASHED";

export interface ReceiptCheckpoint {
  readonly at: string;
  readonly type:
    | "run_started"
    | "planner_finished"
    | "worker_step"
    | "verification_result"
    | "failure_occurred"
    | "run_completed"
    | "startup_recovery";
  readonly status: PersistentRunStatus;
  readonly phase: string | null;
  readonly summary: string;
  readonly details?: Record<string, unknown>;
}

export interface ReceiptWorkerEvent {
  readonly at: string;
  readonly workerType: string;
  readonly taskId: string;
  readonly status: "started" | "completed" | "failed";
  readonly summary: string;
  readonly confidence: number | null;
  readonly costUsd: number;
  readonly filesTouched: readonly string[];
  readonly issues: readonly string[];
}

/**
 * Persisted snapshot of a TrustRouter routing decision. One entry is
 * written per dispatchNode call, with escalations appended in-place
 * when capability-floor or weak-output retry forces a tier change.
 *
 * Why this lives in the receipt: TrustRouter computes complexity score,
 * blast radius, and a rationale string per task — none of which
 * survived past the run before. Without persistence, post-run review
 * can't tell whether a verdict came from a fast-tier model on a
 * "system-wide" task (likely under-resourced) or a premium-tier model
 * on a "contained" task (likely over-billed).
 */
export interface ReceiptRoutingDecision {
  readonly at: string;
  readonly taskId: string;
  readonly workerType: string;
  /** "fast" | "standard" | "premium" — matches WorkerTier in router/trust-router.ts */
  readonly tier: string;
  readonly rationale: string;
  /** Computed complexity 0–10 from TrustRouter.analyzeComplexity. */
  readonly complexityScore: number;
  /** Blast radius level: contained | local | cross-module | system-wide. */
  readonly blastRadiusLevel: string;
  readonly riskSignals: readonly string[];
  readonly estimatedCostUsd: number;
  readonly tokenBudget: number;
  readonly criticReviewRequired: boolean;
  /** Tier escalations applied in order (capability-floor, weak-output retry). */
  escalations: ReceiptRoutingEscalation[];
}

export interface ReceiptRoutingEscalation {
  readonly at: string;
  readonly from: string;
  readonly to: string;
  /** "capability-floor" | "weak-output-retry" | "escalation-boundary" | other. */
  readonly reason: string;
  readonly detail?: string;
}

/**
 * Per-attempt log of a provider call. Mirrors InvokeAttempt from
 * model-invoker.ts but carries the taskId so multiple workers'
 * attempts can be sorted/filtered in receipts. One entry per chain
 * step (success, error, or skip).
 */
export interface ReceiptProviderAttempt {
  readonly at: string;
  readonly taskId: string;
  readonly attemptIndex: number;
  readonly provider: string;
  readonly model: string;
  /** "ok" | "skipped_blacklist" | "skipped_circuit_breaker" | InvokerErrorKind */
  readonly outcome: string;
  readonly durationMs: number;
  readonly costUsd: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly errorMsg?: string;
}

/**
 * One row per circuit-breaker skip in the run. Derivable from
 * providerAttempts[] (outcome === "skipped_circuit_breaker") but
 * promoted to a top-level field for fast UI scanning.
 */
export interface ReceiptCircuitBreakerSkip {
  readonly at: string;
  readonly taskId: string;
  readonly provider: string;
  readonly model: string;
}

export interface PersistentRunReceipt {
  readonly version: 1;
  readonly runId: string;
  readonly intentId: string | null;
  readonly createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  prompt: string;
  taskSummary: string;
  status: PersistentRunStatus;
  phase: string | null;
  finalClassification: string | null;
  totalCost: CostEntry;
  confidence: {
    overall: number | null;
    planning: number | null;
    execution: number | null;
    verification: number | null;
  };
  workerEvents: ReceiptWorkerEvent[];
  checkpoints: ReceiptCheckpoint[];
  filesTouched: Array<{
    path: string;
    operation: string;
    taskId?: string;
    timestamp?: string;
  }>;
  changesSummary: Array<{
    path: string;
    operation: string;
  }>;
  verificationResults: {
    final: unknown | null;
    waves: unknown[];
  };
  errors: string[];
  graphSummary: unknown | null;
  runSummary: unknown | null;
  humanSummary: unknown | null;
  finalReceipt: RunReceipt | null;
  /**
   * Workspace reference — persisted as soon as the workspace is
   * created so startup recovery can reconcile orphans after a crash.
   * Null for runs that never created a workspace (e.g. early-exit
   * paths) or for legacy receipts written before this field existed.
   */
  workspace: PersistedWorkspaceRef | null;
  /**
   * Implementation Brief — engineer-grade work order built by the
   * Coordinator before Builder dispatch. Contains selected files,
   * rejected candidates, staged plan, non-goals, verification commands,
   * fallback plan, and retry attempts. Stored as a plain JSON object
   * so older tooling can read it without importing the TS types.
   */
  implementationBrief: unknown | null;
  /**
   * Per-attempt Builder diagnostics — one entry per model attempt
   * across all Builder dispatches in the run (initial call, repair
   * retries, weak-output retries). Carries cost/model/tokens, patch
   * mode, export-diff for code files, guard-rejection details, and a
   * stale flag for attempts whose results were superseded.
   */
  builderAttempts: unknown[];
  /**
   * TrustRouter routing decisions per dispatched task. Built fresh
   * from RoutingDecision at dispatch time; escalations append in-place
   * as the task progresses. Empty for legacy receipts.
   */
  routing: ReceiptRoutingDecision[];
  /**
   * Per-attempt provider call log. One entry per chain step (success,
   * error, or skip) across every worker in the run. Lets post-run
   * review see real fallback behavior, circuit-breaker skips, and
   * empty-response retries that weren't visible before.
   */
  providerAttempts: ReceiptProviderAttempt[];
  /**
   * Promoted view: every provider call that was skipped because the
   * cross-run circuit breaker was open. Subset of providerAttempts.
   */
  circuitBreakerSkips: ReceiptCircuitBreakerSkip[];
}

/**
 * Result of a single orphan workspace cleanup attempt during startup
 * recovery. One entry is produced per crashed run that had a
 * persisted workspace reference.
 */
export interface OrphanWorkspaceResult {
  readonly workspacePath: string;
  readonly removed: boolean;
  readonly error: string | null;
  /** Updated workspace ref that the receipt should be patched with. */
  readonly nextRef: PersistedWorkspaceRef;
}

/**
 * Summary of what startup recovery did. `runsRecovered` is the number
 * of non-terminal runs that were marked INTERRUPTED; `orphanWorkspaces`
 * lists the cleanup attempt for each of their workspaces.
 */
export interface StartupRecoveryReport {
  readonly runsRecovered: number;
  readonly orphanWorkspaces: readonly OrphanWorkspaceResult[];
}

export interface ReceiptIndexEntry {
  runId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  status: PersistentRunStatus;
  prompt: string;
  summary: string;
  costUsd: number;
  confidence: number | null;
  finalClassification: string | null;
}

interface ReceiptIndexFile {
  readonly version: 1;
  updatedAt: string;
  runs: ReceiptIndexEntry[];
}

export interface TaskRunMapping {
  taskId: string;
  runId: string;
  prompt: string;
  submittedAt: string;
  completedAt: string | null;
  status: "queued" | "running" | "complete" | "partial" | "failed" | "cancelled";
  error: string | null;
}

interface TaskIndexFile {
  readonly version: 1;
  updatedAt: string;
  tasks: TaskRunMapping[];
}

export interface ReceiptPatch {
  readonly intentId?: string | null;
  readonly prompt?: string;
  readonly taskSummary?: string;
  readonly status?: PersistentRunStatus;
  readonly phase?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly finalClassification?: string | null;
  readonly totalCost?: CostEntry;
  readonly confidence?: Partial<PersistentRunReceipt["confidence"]>;
  readonly filesTouched?: Array<{
    path: string;
    operation: string;
    taskId?: string;
    timestamp?: string;
  }>;
  readonly changesSummary?: Array<{
    path: string;
    operation: string;
  }>;
  readonly verificationResults?: {
    final?: unknown | null;
    waves?: unknown[];
  };
  readonly graphSummary?: unknown | null;
  readonly runSummary?: unknown | null;
  readonly humanSummary?: unknown | null;
  readonly finalReceipt?: RunReceipt | null;
  readonly appendErrors?: readonly string[];
  readonly appendCheckpoints?: readonly ReceiptCheckpoint[];
  readonly appendWorkerEvents?: readonly ReceiptWorkerEvent[];
  /**
   * Persist the workspace reference as soon as the workspace is
   * created. Pass `null` to clear (e.g. after successful cleanup)
   * or omit to leave the current value unchanged.
   */
  readonly workspace?: PersistedWorkspaceRef | null;
  /**
   * Implementation Brief payload to persist with the receipt. Pass a
   * plain JSON object produced by briefToReceiptJson. Undefined = leave
   * unchanged; null = clear.
   */
  readonly implementationBrief?: unknown | null;
  /**
   * Append builder attempt records produced by this dispatch. Records
   * are concatenated to the persisted list — never replace it — so the
   * full history of attempts across the run is preserved.
   */
  readonly appendBuilderAttempts?: readonly unknown[];
  /**
   * Append TrustRouter routing decisions. New entries are appended; if
   * a routing entry for the same taskId already exists, its
   * escalations[] are merged (existing + new) so capability-floor and
   * weak-output retries can be added incrementally.
   */
  readonly appendRouting?: readonly ReceiptRoutingDecision[];
  /**
   * Append provider-attempt records (one row per fallback-chain step,
   * including skipped entries). Records are concatenated; the receipt
   * is the source of truth for post-run "which providers did we
   * actually try and why" questions.
   */
  readonly appendProviderAttempts?: readonly ReceiptProviderAttempt[];
  /**
   * Append circuit-breaker skip records. Concatenated, not deduped —
   * a provider being skipped twice in one run is itself a signal.
   */
  readonly appendCircuitBreakerSkips?: readonly ReceiptCircuitBreakerSkip[];
}

// ─── Receipt Integrity ──────────────────────────────────────────────

export interface ReceiptSignature {
  readonly sha256: string;
  readonly ts: number;
}

/**
 * Canonicalize a value to a deterministic JSON string. Object keys are
 * sorted recursively so that serialization order never affects the
 * digest. Arrays preserve order (they are ordered data).
 */
export function canonicalizeReceiptJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Compute a hex SHA-256 over the canonical JSON of a value. Two values
 * that differ only in key order produce the same hash.
 */
export function computeReceiptHash(value: unknown): string {
  const canonical = canonicalizeReceiptJson(value);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

function sortKeysDeep(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

const INDEX_FILE = "index.json";
const TASK_INDEX_FILE = "tasks.json";

export class ReceiptStore {
  readonly rootDir: string;
  readonly runsDir: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.rootDir = join(projectRoot, "state", "receipts");
    this.runsDir = join(this.rootDir, "runs");
  }

  async beginRun(input: {
    runId: string;
    intentId: string;
    prompt: string;
    taskSummary: string;
    startedAt: string;
    phase: string;
  }): Promise<PersistentRunReceipt> {
    return this.patchRun(input.runId, {
      intentId: input.intentId,
      prompt: input.prompt,
      taskSummary: input.taskSummary,
      startedAt: input.startedAt,
      phase: input.phase,
      status: "EXECUTING_IN_WORKSPACE",
      appendCheckpoints: [
        {
          at: input.startedAt,
          type: "run_started",
          status: "EXECUTING_IN_WORKSPACE",
          phase: input.phase,
          summary: input.taskSummary,
        },
      ],
    });
  }

  async patchRun(runId: string, patch: ReceiptPatch): Promise<PersistentRunReceipt> {
    return this.enqueue(async () => {
      await this.ensureDirs();
      const runPath = this.runPath(runId);
      const next = await withRepoLock(runPath, async () => {
        const current = await this.readRunFile(runId);
        const now = new Date().toISOString();
        const updated = this.applyPatch(current ?? this.emptyReceipt(runId, now), patch, now);
        const redacted = redactForReceipt(updated);
        await writeJsonAtomicLocked(runPath, redacted);
        // Write the integrity sidecar.
        const sig: ReceiptSignature = {
          sha256: computeReceiptHash(redacted),
          ts: Date.now(),
        };
        writeFileSync(`${runPath}.sig`, JSON.stringify(sig), "utf-8");
        return updated;
      });
      await this.writeIndexEntry(this.toIndexEntry(next));
      return next;
    });
  }

  async getRun(runId: string): Promise<PersistentRunReceipt | null> {
    await this.ensureDirs();
    return this.readRunFile(runId);
  }

  async verifyReceiptIntegrity(runId: string): Promise<{ valid: boolean; reason?: string }> {
    const runPath = this.runPath(runId);
    if (!existsSync(runPath)) return { valid: false, reason: "receipt not found" };
    const sigPath = `${runPath}.sig`;
    if (!existsSync(sigPath)) return { valid: false, reason: "signature sidecar not found" };
    try {
      const receiptRaw = readFileSync(runPath, "utf-8");
      const sigRaw = readFileSync(sigPath, "utf-8");
      const sig = JSON.parse(sigRaw) as Record<string, unknown>;
      if (typeof sig.sha256 !== "string") return { valid: false, reason: "missing sha256 in sidecar" };
      const receipt = JSON.parse(receiptRaw);
      const recomputed = computeReceiptHash(receipt);
      if (recomputed !== sig.sha256) return { valid: false, reason: `hash mismatch: expected ${sig.sha256}, got ${recomputed}` };
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: `verification error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async listRuns(limit: number = 20, status?: string): Promise<ReceiptIndexEntry[]> {
    await this.ensureDirs();
    const index = await this.readIndexFile();
    const filtered = status
      ? index.runs.filter(
          (entry) =>
            entry.status === status ||
            entry.finalClassification === status,
        )
      : index.runs;
    return filtered.slice(0, limit);
  }

  async registerTask(input: {
    taskId: string;
    runId: string;
    prompt: string;
    submittedAt: string;
  }): Promise<TaskRunMapping> {
    return this.enqueue(async () => {
      await this.ensureDirs();
      return withRepoLock(this.taskIndexPath(), async () => {
        const index = await this.readTaskIndexFile();
        const next: TaskRunMapping = {
          taskId: input.taskId,
          runId: input.runId,
          prompt: input.prompt,
          submittedAt: input.submittedAt,
          completedAt: null,
          status: "queued",
          error: null,
        };
        const existing = index.tasks.findIndex((entry) => entry.taskId === input.taskId);
        if (existing >= 0) {
          index.tasks[existing] = next;
        } else {
          index.tasks.push(next);
        }
        index.updatedAt = new Date().toISOString();
        index.tasks.sort((a, b) => compareDesc(a.submittedAt, b.submittedAt));
        await writeJsonAtomicLocked(this.taskIndexPath(), index);
        return next;
      });
    });
  }

  async updateTask(
    taskId: string,
    patch: Partial<Omit<TaskRunMapping, "taskId">>,
  ): Promise<TaskRunMapping | null> {
    return this.enqueue(async () => {
      await this.ensureDirs();
      return withRepoLock(this.taskIndexPath(), async () => {
        const index = await this.readTaskIndexFile();
        const existingIndex = index.tasks.findIndex((entry) => entry.taskId === taskId);
        if (existingIndex < 0) return null;
        const existing = index.tasks[existingIndex];
        const at = new Date().toISOString();
        const next: TaskRunMapping = {
          ...existing,
          ...patch,
          completedAt:
            patch.completedAt !== undefined
              ? patch.completedAt
              : patch.status === "complete" || patch.status === "failed" || patch.status === "cancelled"
                ? existing.completedAt ?? at
                : existing.completedAt,
        };
        index.tasks[existingIndex] = next;
        index.updatedAt = at;
        index.tasks.sort((a, b) => compareDesc(a.submittedAt, b.submittedAt));
        await writeJsonAtomicLocked(this.taskIndexPath(), index);
        return next;
      });
    });
  }

  async getTask(taskId: string): Promise<TaskRunMapping | null> {
    await this.ensureDirs();
    const index = await this.readTaskIndexFile();
    return index.tasks.find((entry) => entry.taskId === taskId) ?? null;
  }

  async getTaskByRunId(runId: string): Promise<TaskRunMapping | null> {
    await this.ensureDirs();
    const index = await this.readTaskIndexFile();
    return index.tasks.find((entry) => entry.runId === runId) ?? null;
  }

  async markIncompleteRunsCrashed(reason: string): Promise<StartupRecoveryReport> {
    return this.enqueue(async () => {
      await this.ensureDirs();
      const index = await this.readIndexFile();
      let changed = 0;
      const orphanWorkspaces: OrphanWorkspaceResult[] = [];
      for (const entry of index.runs) {
        // Recover any non-terminal run — not just RUNNING/EXECUTING.
        // AWAITING_APPROVAL has its own dedicated coordinator path, so
        // leave it alone here.
        if (
          entry.status !== "RUNNING" &&
          entry.status !== "EXECUTING_IN_WORKSPACE" &&
          entry.status !== "PROPOSED" &&
          entry.status !== "VERIFICATION_PENDING"
        ) continue;
        const run = await this.readRunFile(entry.runId);
        if (
          !run ||
          (run.status !== "RUNNING" &&
           run.status !== "EXECUTING_IN_WORKSPACE" &&
           run.status !== "PROPOSED" &&
           run.status !== "VERIFICATION_PENDING")
        ) continue;
        const now = new Date().toISOString();
        const orphan = await this.cleanupOrphanWorkspace(run);
        if (orphan) orphanWorkspaces.push(orphan);
        const errorLines = [reason];
        if (orphan) {
          errorLines.push(
            orphan.removed
              ? `Orphan workspace removed: ${orphan.workspacePath}`
              : `Orphan workspace cleanup FAILED: ${orphan.workspacePath} — ${orphan.error ?? "unknown"}`,
          );
        }
        const next = this.applyPatch(
          run,
          {
            status: "INTERRUPTED",
            completedAt: now,
            appendErrors: errorLines,
            workspace: orphan?.nextRef ?? run.workspace,
            appendCheckpoints: [
              {
                at: now,
                type: "startup_recovery",
                status: "INTERRUPTED",
                phase: run.phase,
                summary: reason,
                details: orphan ? {
                  orphanWorkspacePath: orphan.workspacePath,
                  orphanRemoved: orphan.removed,
                  orphanError: orphan.error,
                } : undefined,
              },
            ],
          },
          now,
        );
        await this.writeRunFile(next);
        entry.status = "INTERRUPTED";
        entry.completedAt = now;
        entry.updatedAt = now;
        entry.summary = next.humanSummary && typeof next.humanSummary === "object" && "headline" in next.humanSummary
          ? String((next.humanSummary as { headline?: unknown }).headline ?? next.taskSummary)
          : next.taskSummary;
        changed += 1;
      }
      if (changed > 0) {
        index.updatedAt = new Date().toISOString();
        index.runs.sort((a, b) => compareDesc(a.updatedAt, b.updatedAt));
        await this.writeIndexFile(index);
      }
      return { runsRecovered: changed, orphanWorkspaces };
    });
  }

  /**
   * Remove an orphan worktree/clone/copy left behind by a crashed run.
   * Returns an OrphanWorkspaceResult describing what happened, or null
   * if the run has no workspace reference or the workspace was already
   * cleaned up during normal shutdown.
   *
   * SAFETY: only paths with the Aedis workspace marker ("/aedis-ws-")
   * are ever removed here — we refuse to rm anything else so a
   * corrupted receipt can never point the recovery loop at a user
   * directory.
   */
  private async cleanupOrphanWorkspace(
    run: PersistentRunReceipt,
  ): Promise<OrphanWorkspaceResult | null> {
    const ws = run.workspace;
    if (!ws) return null;
    if (ws.cleanedUp) return null;
    // Defensive path-guard — refuse to remove anything that is not a
    // well-formed Aedis workspace path under the OS temp dir.
    if (!ws.workspacePath || !ws.workspacePath.includes("aedis-ws-")) {
      return {
        workspacePath: ws.workspacePath,
        removed: false,
        error: "refused: workspace path does not match Aedis marker",
        nextRef: { ...ws, cleanedUp: false },
      };
    }
    try {
      if (existsSync(ws.workspacePath)) {
        if (ws.method === "worktree" && ws.sourceRepo && existsSync(ws.sourceRepo)) {
          await exec("git", ["worktree", "remove", "--force", ws.workspacePath], {
            cwd: ws.sourceRepo,
            timeout: 30_000,
          });
          if (ws.worktreeBranch) {
            await exec("git", ["branch", "-D", ws.worktreeBranch], {
              cwd: ws.sourceRepo,
              timeout: 10_000,
            }).catch(() => undefined);
          }
        } else {
          await rm(ws.workspacePath, { recursive: true, force: true });
        }
      }
      return {
        workspacePath: ws.workspacePath,
        removed: true,
        error: null,
        nextRef: { ...ws, cleanedUp: true },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        workspacePath: ws.workspacePath,
        removed: false,
        error: msg,
        nextRef: { ...ws, cleanedUp: false },
      };
    }
  }

  private applyPatch(
    current: PersistentRunReceipt,
    patch: ReceiptPatch,
    now: string,
  ): PersistentRunReceipt {
    const next: PersistentRunReceipt = {
      ...current,
      updatedAt: now,
      intentId: patch.intentId !== undefined ? patch.intentId : current.intentId,
      prompt: patch.prompt ?? current.prompt,
      taskSummary: patch.taskSummary ?? current.taskSummary,
      status: patch.status ?? current.status,
      phase: patch.phase !== undefined ? patch.phase : current.phase,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : current.startedAt,
      completedAt: patch.completedAt !== undefined ? patch.completedAt : current.completedAt,
      finalClassification:
        patch.finalClassification !== undefined ? patch.finalClassification : current.finalClassification,
      totalCost: patch.totalCost ?? current.totalCost,
      confidence: {
        ...current.confidence,
        ...(patch.confidence ?? {}),
      },
      workerEvents: [
        ...current.workerEvents,
        ...dedupeWorkerEvents(patch.appendWorkerEvents ?? []),
      ],
      checkpoints: [
        ...current.checkpoints,
        ...dedupeCheckpoints(patch.appendCheckpoints ?? []),
      ],
      filesTouched: patch.filesTouched ? dedupeFileTouches(patch.filesTouched) : current.filesTouched,
      changesSummary: patch.changesSummary ? dedupeChanges(patch.changesSummary) : current.changesSummary,
      verificationResults: {
        final:
          patch.verificationResults && "final" in patch.verificationResults
            ? patch.verificationResults.final ?? null
            : current.verificationResults.final,
        waves:
          patch.verificationResults?.waves !== undefined
            ? [...patch.verificationResults.waves]
            : [...current.verificationResults.waves],
      },
      errors: dedupeStrings([...current.errors, ...(patch.appendErrors ?? [])]),
      graphSummary: patch.graphSummary !== undefined ? patch.graphSummary : current.graphSummary,
      runSummary: patch.runSummary !== undefined ? patch.runSummary : current.runSummary,
      humanSummary: patch.humanSummary !== undefined ? patch.humanSummary : current.humanSummary,
      finalReceipt: patch.finalReceipt !== undefined ? patch.finalReceipt : current.finalReceipt,
      workspace: patch.workspace !== undefined ? patch.workspace : current.workspace,
      implementationBrief:
        patch.implementationBrief !== undefined ? patch.implementationBrief : current.implementationBrief,
      builderAttempts: patch.appendBuilderAttempts && patch.appendBuilderAttempts.length > 0
        ? [...(current.builderAttempts ?? []), ...patch.appendBuilderAttempts]
        : (current.builderAttempts ?? []),
      routing: mergeRoutingDecisions(current.routing ?? [], patch.appendRouting ?? []),
      providerAttempts:
        patch.appendProviderAttempts && patch.appendProviderAttempts.length > 0
          ? [...(current.providerAttempts ?? []), ...patch.appendProviderAttempts]
          : (current.providerAttempts ?? []),
      circuitBreakerSkips:
        patch.appendCircuitBreakerSkips && patch.appendCircuitBreakerSkips.length > 0
          ? [...(current.circuitBreakerSkips ?? []), ...patch.appendCircuitBreakerSkips]
          : (current.circuitBreakerSkips ?? []),
    };
    return next;
  }

  private emptyReceipt(runId: string, now: string): PersistentRunReceipt {
    return {
      version: 1,
      runId,
      intentId: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      prompt: "",
      taskSummary: "",
      status: "PROPOSED",
      phase: null,
      finalClassification: null,
      totalCost: { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      confidence: {
        overall: null,
        planning: null,
        execution: null,
        verification: null,
      },
      workerEvents: [],
      checkpoints: [],
      filesTouched: [],
      changesSummary: [],
      verificationResults: { final: null, waves: [] },
      errors: [],
      graphSummary: null,
      runSummary: null,
      humanSummary: null,
      finalReceipt: null,
      workspace: null,
      implementationBrief: null,
      builderAttempts: [],
      routing: [],
      providerAttempts: [],
      circuitBreakerSkips: [],
    };
  }

  private toIndexEntry(run: PersistentRunReceipt): ReceiptIndexEntry {
    const humanSummary = run.humanSummary as { headline?: unknown; confidence?: { overall?: unknown } } | null;
    return {
      runId: run.runId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      status: run.status,
      prompt: run.prompt,
      summary:
        (humanSummary && typeof humanSummary.headline === "string" && humanSummary.headline) ||
        run.taskSummary ||
        run.prompt ||
        "Run",
      costUsd: Number(run.totalCost?.estimatedCostUsd ?? 0),
      confidence:
        humanSummary && typeof humanSummary.confidence?.overall === "number"
          ? humanSummary.confidence.overall
          : run.confidence.overall,
      finalClassification: run.finalClassification,
    };
  }

  private async writeIndexEntry(entry: ReceiptIndexEntry): Promise<void> {
    await withRepoLock(this.indexPath(), async () => {
      const index = await this.readIndexFile();
      const existing = index.runs.findIndex((run) => run.runId === entry.runId);
      if (existing >= 0) {
        index.runs[existing] = entry;
      } else {
        index.runs.push(entry);
      }
      index.updatedAt = new Date().toISOString();
      index.runs.sort((a, b) => compareDesc(a.updatedAt, b.updatedAt));
      await writeJsonAtomicLocked(this.indexPath(), index);
    });
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
  }

  private runPath(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private indexPath(): string {
    return join(this.rootDir, INDEX_FILE);
  }

  private taskIndexPath(): string {
    return join(this.rootDir, TASK_INDEX_FILE);
  }

  private async readRunFile(runId: string): Promise<PersistentRunReceipt | null> {
    const path = this.runPath(runId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, "utf-8")) as PersistentRunReceipt;
    } catch {
      return null;
    }
  }

  private async writeRunFile(run: PersistentRunReceipt): Promise<void> {
    await writeJsonAtomic(this.runPath(run.runId), redactForReceipt(run));
  }

  private async readIndexFile(): Promise<ReceiptIndexFile> {
    const path = this.indexPath();
    if (!existsSync(path)) {
      return { version: 1, updatedAt: new Date().toISOString(), runs: [] };
    }
    try {
      return JSON.parse(await readFile(path, "utf-8")) as ReceiptIndexFile;
    } catch {
      return { version: 1, updatedAt: new Date().toISOString(), runs: [] };
    }
  }

  private async writeIndexFile(index: ReceiptIndexFile): Promise<void> {
    await writeJsonAtomic(this.indexPath(), index);
  }

  private async readTaskIndexFile(): Promise<TaskIndexFile> {
    const path = this.taskIndexPath();
    if (!existsSync(path)) {
      return { version: 1, updatedAt: new Date().toISOString(), tasks: [] };
    }
    try {
      return JSON.parse(await readFile(path, "utf-8")) as TaskIndexFile;
    } catch {
      return { version: 1, updatedAt: new Date().toISOString(), tasks: [] };
    }
  }

  private async writeTaskIndexFile(index: TaskIndexFile): Promise<void> {
    await writeJsonAtomic(this.taskIndexPath(), index);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp.${process.pid}.${randomSuffix()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await rename(tempPath, path);
  if (existsSync(`${path}.bak`)) {
    await rm(`${path}.bak`, { force: true }).catch(() => undefined);
  }
}

function randomSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function dedupeChanges(
  changes: readonly { path: string; operation: string }[],
): Array<{ path: string; operation: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; operation: string }> = [];
  for (const change of changes) {
    const key = `${change.operation}:${change.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: change.path, operation: change.operation });
  }
  return out;
}

function dedupeFileTouches(
  touches: readonly { path: string; operation: string; taskId?: string; timestamp?: string }[],
): Array<{ path: string; operation: string; taskId?: string; timestamp?: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; operation: string; taskId?: string; timestamp?: string }> = [];
  for (const touch of touches) {
    const key = `${touch.path}:${touch.operation}:${touch.taskId ?? ""}:${touch.timestamp ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...touch });
  }
  return out;
}

function dedupeCheckpoints(checkpoints: readonly ReceiptCheckpoint[]): ReceiptCheckpoint[] {
  const seen = new Set<string>();
  const out: ReceiptCheckpoint[] = [];
  for (const checkpoint of checkpoints) {
    const key = `${checkpoint.type}:${checkpoint.at}:${checkpoint.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(checkpoint);
  }
  return out;
}

function dedupeWorkerEvents(events: readonly ReceiptWorkerEvent[]): ReceiptWorkerEvent[] {
  const seen = new Set<string>();
  const out: ReceiptWorkerEvent[] = [];
  for (const event of events) {
    const key = `${event.taskId}:${event.status}:${event.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

function compareDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * Merge a stream of incoming routing decisions into the persisted
 * list. Rules:
 *   - First time we see a taskId: append the new entry.
 *   - Subsequent times: keep the original initial decision and append
 *     the new entry's escalations[] to the existing entry's
 *     escalations[]. Tier on the original is left as the *initial*
 *     tier — the latest tier is implied by the last escalation.
 *
 * This shape lets callers either pass a fresh decision (initial
 * dispatch) or a partial update with only new escalations (capability
 * floor or weak-output retry), without the receipt accumulating
 * duplicate decision rows for the same task.
 */
function mergeRoutingDecisions(
  current: readonly ReceiptRoutingDecision[],
  incoming: readonly ReceiptRoutingDecision[],
): ReceiptRoutingDecision[] {
  if (incoming.length === 0) return [...current];
  const out = current.map((d) => ({ ...d, escalations: [...d.escalations] }));
  const indexByTask = new Map<string, number>();
  out.forEach((d, i) => indexByTask.set(d.taskId, i));
  for (const next of incoming) {
    const existingIdx = indexByTask.get(next.taskId);
    if (existingIdx === undefined) {
      out.push({ ...next, escalations: [...next.escalations] });
      indexByTask.set(next.taskId, out.length - 1);
    } else {
      const existing = out[existingIdx]!;
      existing.escalations = [...existing.escalations, ...next.escalations];
    }
  }
  return out;
}
