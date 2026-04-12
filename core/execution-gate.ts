/**
 * Execution Truth Enforcement v1
 *
 * The single authority on whether a run actually *did* anything. Prior
 * to this module, determineVerdict() would return "success" whenever
 * nothing explicitly failed — which is not the same as "the run
 * produced real work." An empty task graph, a builder that silently
 * skipped every file, or a pipeline that fell through every phase
 * without writing to disk all got marked success.
 *
 * The execution gate fixes that by requiring positive evidence of
 * work before any non-failed verdict is allowed. Evidence is any of:
 *
 *   - file_diff       — a FileChange with a diff against original
 *   - file_created    — a FileChange with operation "create"
 *   - file_deleted    — a FileChange with operation "delete"
 *   - file_modified   — a FileChange with operation "modify"
 *   - commit_sha      — a real git commit SHA produced by phase 10
 *   - read_only       — an explicit read-only result (opt-in, e.g. Loqui)
 *   - verifier_pass   — the verifier pipeline passed with positive signal
 *
 * If the gate cannot collect at least one evidence item, it blocks:
 * the run is forced to "failed" with reason "No-op execution detected"
 * and Lumen is told "Execution failed — no real output".
 *
 * The gate runs at the very end of submit() and is also consulted on
 * the exception path so caught errors cannot be silently swallowed.
 */

import { existsSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { FileChange, TouchedFile, WorkerResult, WorkerType } from "../workers/base.js";
import type { VerificationReceipt } from "./verification-pipeline.js";

// ─── Types ───────────────────────────────────────────────────────────

export type EvidenceKind =
  | "file_created"
  | "file_modified"
  | "file_deleted"
  | "file_diff"
  | "file_exists"
  | "commit_sha"
  | "verifier_pass"
  | "read_only"
  | "worker_output";

export interface ExecutionEvidence {
  readonly kind: EvidenceKind;
  /** File path, commit SHA, or logical ref. */
  readonly ref: string;
  /** Optional short, human-readable detail (never raw diffs). */
  readonly detail?: string;
  /** Which worker produced this evidence, if any. */
  readonly producedBy?: WorkerType;
  /**
   * True if the gate was able to directly observe the evidence at
   * gate time (file on disk, commit SHA in git). False for in-memory
   * claims from workers that the gate could not independently verify.
   */
  readonly verifiedOnDisk: boolean;
}

export interface ExecutionReceipt {
  readonly workerType: WorkerType;
  readonly taskId: string;
  readonly filesTouched: readonly TouchedFile[];
  readonly changesMade: string;
  readonly verification: "pass" | "fail" | "not-applicable";
  readonly evidence: readonly ExecutionEvidence[];
}

export interface ExecutionGateInput {
  readonly runId: string;
  readonly projectRoot: string;
  readonly workerResults: readonly WorkerResult[];
  readonly changes: readonly FileChange[];
  readonly commitSha: string | null;
  readonly verificationReceipt: VerificationReceipt | null;
  readonly graphNodeCount: number;
  readonly cancelled: boolean;
  readonly thrownError?: Error | null;
  /**
   * Explicit opt-in for tasks that legitimately produce no file
   * changes (e.g. Loqui Q&A, pure inspection). When true the gate
   * accepts a bare worker-output evidence item as sufficient. Left
   * false for the normal build path.
   */
  readonly readOnlyOk?: boolean;
}

export interface ExecutionGateDecision {
  /** "verified" means at least one evidence item exists. */
  readonly verdict: "verified" | "no_op" | "errored";
  /** True when the gate accepted the run — never true for no_op / errored. */
  readonly executionVerified: boolean;
  /** Every evidence item the gate was able to collect. */
  readonly evidence: readonly ExecutionEvidence[];
  /** Per-worker synthesized receipts (one per worker result). */
  readonly workerReceipts: readonly ExecutionReceipt[];
  /** Human-readable reason — always populated, not just on failure. */
  readonly reason: string;
  /** When errored: the error message captured at gate time. */
  readonly errorMessage?: string;
  /** Counts used for logging and UI display. */
  readonly counts: {
    readonly filesCreated: number;
    readonly filesModified: number;
    readonly filesDeleted: number;
    readonly evidenceItems: number;
    readonly workerReceipts: number;
  };
}

// ─── Gate ────────────────────────────────────────────────────────────

/**
 * Evaluate the execution gate. Returns a decision without mutating
 * anything — the coordinator owns downstream handling (verdict
 * override, event emission, UI broadcast).
 *
 * The gate is deterministic: same inputs → same decision. No model
 * calls, no network, no side effects besides `statSync` / `existsSync`
 * to verify files on disk.
 */
export function evaluateExecutionGate(input: ExecutionGateInput): ExecutionGateDecision {
  // Exception path short-circuit — an uncaught error is never a
  // silent success, regardless of what other evidence exists.
  if (input.thrownError) {
    const evidence = collectEvidence(input);
    return {
      verdict: "errored",
      executionVerified: false,
      evidence,
      workerReceipts: synthesizeWorkerReceipts(input, evidence),
      reason: `Execution errored: ${input.thrownError.message}`,
      errorMessage: input.thrownError.message,
      counts: countEvidence(evidence),
    };
  }

  // Cancelled runs are never "verified" — they may have partial
  // evidence but the user aborted before completion.
  if (input.cancelled) {
    const evidence = collectEvidence(input);
    return {
      verdict: "no_op",
      executionVerified: false,
      evidence,
      workerReceipts: synthesizeWorkerReceipts(input, evidence),
      reason: "Execution cancelled by user before completion",
      counts: countEvidence(evidence),
    };
  }

  // Empty task graph — the buildTaskGraph early-exit bug. Always
  // failed, no exceptions.
  if (input.graphNodeCount === 0) {
    return {
      verdict: "no_op",
      executionVerified: false,
      evidence: [],
      workerReceipts: [],
      reason:
        "No-op execution detected: task graph produced zero nodes — the planner could not identify any actionable work",
      counts: countEvidence([]),
    };
  }

  const evidence = collectEvidence(input);
  const counts = countEvidence(evidence);
  const workerReceipts = synthesizeWorkerReceipts(input, evidence);

  if (evidence.length === 0) {
    return {
      verdict: "no_op",
      executionVerified: false,
      evidence,
      workerReceipts,
      reason:
        "No-op execution detected: no files were created, modified, or deleted, no commit was produced, and no read-only output was returned",
      counts,
    };
  }

  // At least one evidence item — the run is verified. Build a
  // specific reason that actually says what was verified.
  const parts: string[] = [];
  if (counts.filesCreated > 0) parts.push(`${counts.filesCreated} file(s) created`);
  if (counts.filesModified > 0) parts.push(`${counts.filesModified} file(s) modified`);
  if (counts.filesDeleted > 0) parts.push(`${counts.filesDeleted} file(s) deleted`);
  if (input.commitSha) parts.push(`commit ${input.commitSha.slice(0, 8)}`);
  if (input.readOnlyOk && parts.length === 0) parts.push("read-only output returned");
  if (parts.length === 0) parts.push(`${evidence.length} evidence item(s) captured`);

  return {
    verdict: "verified",
    executionVerified: true,
    evidence,
    workerReceipts,
    reason: `Execution verified: ${parts.join(", ")}`,
    counts,
  };
}

// ─── Evidence Collection ────────────────────────────────────────────

/**
 * Walk the run state and collect every verifiable piece of evidence.
 * Order is stable: file changes first (verified on disk), then commit
 * SHA, then verifier signals, then worker-reported reads.
 */
function collectEvidence(input: ExecutionGateInput): ExecutionEvidence[] {
  const evidence: ExecutionEvidence[] = [];
  const seen = new Set<string>();

  for (const change of input.changes) {
    const absPath = resolveSafe(input.projectRoot, change.path);
    const onDisk = absPath ? fileExistsOnDisk(absPath) : false;

    if (change.operation === "create") {
      // A create is only real evidence if the file actually exists on
      // disk — otherwise the builder claimed to create it but never
      // wrote it, which is exactly the fake-success path we're closing.
      if (onDisk) {
        pushEvidence(evidence, seen, {
          kind: "file_created",
          ref: change.path,
          detail: describeSize(absPath!),
          producedBy: "builder",
          verifiedOnDisk: true,
        });
      }
    } else if (change.operation === "modify") {
      if (onDisk) {
        pushEvidence(evidence, seen, {
          kind: "file_modified",
          ref: change.path,
          detail: describeSize(absPath!),
          producedBy: "builder",
          verifiedOnDisk: true,
        });
      }
      if (change.diff && change.diff.length > 0) {
        pushEvidence(evidence, seen, {
          kind: "file_diff",
          ref: change.path,
          detail: `${change.diff.split("\n").length} diff line(s)`,
          producedBy: "builder",
          verifiedOnDisk: onDisk,
        });
      }
    } else if (change.operation === "delete") {
      // A delete is real evidence if the file is no longer on disk.
      const stillThere = onDisk;
      if (!stillThere) {
        pushEvidence(evidence, seen, {
          kind: "file_deleted",
          ref: change.path,
          producedBy: "builder",
          verifiedOnDisk: true,
        });
      }
    }
  }

  if (input.commitSha && input.commitSha.length > 0) {
    pushEvidence(evidence, seen, {
      kind: "commit_sha",
      ref: input.commitSha,
      detail: input.commitSha.slice(0, 8),
      verifiedOnDisk: true,
    });
  }

  if (
    input.verificationReceipt &&
    input.verificationReceipt.verdict === "pass" &&
    input.changes.length > 0
  ) {
    pushEvidence(evidence, seen, {
      kind: "verifier_pass",
      ref: input.verificationReceipt.id,
      detail: input.verificationReceipt.summary ?? "verifier pipeline passed",
      verifiedOnDisk: false,
    });
  }

  // Read-only evidence — only admitted when the caller opted in.
  // This is how Loqui / pure Q&A runs can pass the gate without
  // writing to disk. Build-mode submits never set readOnlyOk=true.
  if (input.readOnlyOk) {
    const firstOutput = input.workerResults.find((r) => r.success);
    if (firstOutput) {
      pushEvidence(evidence, seen, {
        kind: "read_only",
        ref: `worker:${firstOutput.workerType}:${firstOutput.taskId}`,
        detail: `${firstOutput.workerType} returned structured output`,
        producedBy: firstOutput.workerType,
        verifiedOnDisk: false,
      });
    }
  }

  return evidence;
}

/**
 * Synthesize a per-worker ExecutionReceipt from each WorkerResult.
 * Workers are free to self-populate `result.executionReceipt` in the
 * future; until they do, the gate builds one from their `touchedFiles`
 * and output kind so Lumen has a uniform shape to display.
 */
function synthesizeWorkerReceipts(
  input: ExecutionGateInput,
  allEvidence: readonly ExecutionEvidence[],
): ExecutionReceipt[] {
  const receipts: ExecutionReceipt[] = [];

  for (const result of input.workerResults) {
    const self = result.executionReceipt;
    if (self) {
      receipts.push(self);
      continue;
    }

    const filesFromEvidence = allEvidence
      .filter((e) => e.producedBy === result.workerType)
      .map((e) => e.ref);
    const changesMade = describeWorkerWork(result, filesFromEvidence);
    const verification = pickVerification(result);
    const evidenceForWorker = allEvidence.filter(
      (e) => !e.producedBy || e.producedBy === result.workerType,
    );

    receipts.push({
      workerType: result.workerType,
      taskId: result.taskId,
      filesTouched: result.touchedFiles,
      changesMade,
      verification,
      evidence: evidenceForWorker,
    });
  }

  return receipts;
}

function describeWorkerWork(result: WorkerResult, filesFromEvidence: readonly string[]): string {
  if (!result.success) {
    const msg = result.issues[0]?.message ?? "no message";
    return `FAILED: ${msg}`;
  }
  switch (result.output.kind) {
    case "builder": {
      const changes = result.output.changes;
      if (changes.length === 0) return "Builder produced zero changes";
      const labels = changes
        .map((c) => `${c.operation}:${c.path}`)
        .slice(0, 4)
        .join(", ");
      return `Builder wrote ${changes.length} change(s) — ${labels}`;
    }
    case "scout":
      return `Scout assessed risk=${result.output.riskAssessment.level}`;
    case "critic":
      return `Critic verdict=${result.output.verdict}`;
    case "verifier":
      return `Verifier passed=${result.output.passed}`;
    case "integrator":
      return `Integrator merged ${result.output.finalChanges.length} change(s)`;
    default: {
      const touched = filesFromEvidence.join(", ") || "no files";
      return `${result.workerType} completed (${touched})`;
    }
  }
}

function pickVerification(result: WorkerResult): "pass" | "fail" | "not-applicable" {
  if (!result.success) return "fail";
  if (result.output.kind === "verifier") return result.output.passed ? "pass" : "fail";
  if (result.output.kind === "critic") {
    return result.output.verdict === "approve" ? "pass" : "fail";
  }
  return "not-applicable";
}

// ─── Helpers ─────────────────────────────────────────────────────────

function pushEvidence(
  out: ExecutionEvidence[],
  seen: Set<string>,
  item: ExecutionEvidence,
): void {
  const key = `${item.kind}:${item.ref}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(item);
}

function countEvidence(evidence: readonly ExecutionEvidence[]): ExecutionGateDecision["counts"] {
  let filesCreated = 0;
  let filesModified = 0;
  let filesDeleted = 0;
  for (const e of evidence) {
    if (e.kind === "file_created") filesCreated += 1;
    else if (e.kind === "file_modified") filesModified += 1;
    else if (e.kind === "file_deleted") filesDeleted += 1;
  }
  return {
    filesCreated,
    filesModified,
    filesDeleted,
    evidenceItems: evidence.length,
    workerReceipts: 0, // filled in by caller if needed
  };
}

function resolveSafe(projectRoot: string, relOrAbs: string): string | null {
  try {
    const abs = isAbsolute(relOrAbs) ? relOrAbs : resolve(projectRoot, relOrAbs);
    return abs;
  } catch {
    return null;
  }
}

function fileExistsOnDisk(absPath: string): boolean {
  try {
    return existsSync(absPath);
  } catch {
    return false;
  }
}

function describeSize(absPath: string): string {
  try {
    const s = statSync(absPath);
    return `${s.size} bytes`;
  } catch {
    return "size unknown";
  }
}
