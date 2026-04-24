/**
 * Session coordinator — runs one autonomous task across multiple cycles.
 *
 * Loop:
 *   1. Load session state
 *   2. Check stop conditions (maxCycles, maxDurationMs, repeated failure)
 *   3. Run one build cycle (Scout → Builder → Critic → Verifier)
 *   4. Evaluate result
 *   5. Store cycle result + update session
 *   6. Decide: next cycle or stop
 *
 * The session is written to disk after every cycle so crashes are recoverable.
 */

import { randomUUID } from "crypto";
import {
  AedisSession,
  CycleResult,
  CycleError,
  StopDecision,
  Intent,
  CycleOutcome,
  errorDigest,
} from "../types/session.js";
import {
  createSession,
  loadSession,
  saveSession,
  appendCycleResult,
  transitionSession,
  listAllSessions,
} from "./session-store.js";
import { Coordinator, BuildResult } from "./coordinator.js";

// ─── Default limits ────────────────────────────────────────────────────

const DEFAULT_MAX_CYCLES = 3;
const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours TTL for stale sessions
const REPEATED_FAILURE_THRESHOLD = 2;             // stop after 2 cycles with same root cause
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;      // run cleanup every 30 min

// ─── Cleanup ─────────────────────────────────────────────────────────

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic stale-session cleanup timer.
 * Call once at startup. Idempotent — won't start multiple timers.
 */
export function startCleanupTimer(coordinator: Coordinator, maxAgeMs = DEFAULT_MAX_AGE_MS): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    try {
      await removeStaleSessions(maxAgeMs);
    } catch (err) {
      console.error(`[session-coordinator] cleanup error: ${err}`);
    }
  }, CLEANUP_INTERVAL_MS);
  console.log(`[session-coordinator] cleanup timer started (interval=${CLEANUP_INTERVAL_MS}ms, maxAge=${maxAgeMs}ms)`);
}

export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Remove sessions older than maxAgeMs. Called by the cleanup timer
 * and can also be called manually.
 */
export async function removeStaleSessions(maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<number> {
  const allSessions = await listAllSessions();
  const now = Date.now();
  let removed = 0;
  for (const session of allSessions) {
    if (session.status !== "active") continue;
    if (now - session.updatedAt > maxAgeMs) {
      await transitionSession(session.id, "failed", `Stale — no activity for ${maxAgeMs}ms`);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[session-coordinator] removed ${removed} stale session(s)`);
  }
  return removed;
}

// ─── Public entry point ───────────────────────────────────────────────

export interface RunSessionOptions {
  coordinator: Coordinator;
  intent: Intent;
  maxCycles?: number;
  maxDurationMs?: number;
}

/**
 * Run a full autonomous session. Returns the terminal session state.
 * Handles all cycles, persistence, learning, and stop decision.
 */
export async function runSession(options: RunSessionOptions): Promise<AedisSession> {
  const { coordinator, intent, maxCycles = DEFAULT_MAX_CYCLES, maxDurationMs = DEFAULT_MAX_DURATION_MS } = options;

  // Create session
  const session: AedisSession = {
    id: randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "active",
    intent,
    maxCycles,
    maxDurationMs,
    cycleCount: 0,
    workingArtifacts: {},
    lastError: null,
    failureDigest: "",
    repeatedFailureCount: 0,
    cycleHistory: [],
    terminalReason: null,
  };

  await createSession(session);

  // Context carried between cycles — starts with nothing, each cycle
  // can append hints that inform the next buildCycle call.
  let cycleContext: string | null = null;

  // Main loop
  while (session.status === "active") {
    const stopDecision = evaluateStopConditions(session);
    if (stopDecision.stop) {
      return await terminateSession(session.id, stopDecision.reason, stopDecision.terminalReason);
    }

    const cycleResult = await runOneCycle(session, coordinator, cycleContext);
    await appendCycleResult(session.id, cycleResult);

    // Reload to get updated history
    const updated = await loadSession(session.id);
    if (!updated) throw new Error(`Session gone after append: ${session.id}`);
    Object.assign(session, updated);

    // Update working artifacts with current file state hashes
    await updateWorkingArtifacts(session, cycleResult);

    // Carry nextCycleHint into the next buildCycle call
    cycleContext = cycleResult.nextCycleHint ?? null;

    // Evaluate next move
    const decision = decideNextMove(session, cycleResult);
    if (decision.stop) {
      return await terminateSession(session.id, decision.reason, decision.terminalReason);
    }

    // No stop — loop continues with incremented cycle count
    session.cycleCount++;
    await saveSession(session);
  }

  return session;
}

/**
 * Run one additional cycle on an existing session (used by POST /sessions/:id/cycles).
 * Returns the updated session.
 */
export async function runOneMoreCycle(
  sessionId: string,
  coordinator: Coordinator,
): Promise<AedisSession> {
  const session = await loadSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status !== "active") {
    throw new Error(`Session is not active (status=${session.status})`);
  }

  const cycleContext: string | null = session.lastError?.hint ?? null;

  const cycleResult = await runOneCycle(session, coordinator, cycleContext);
  await appendCycleResult(sessionId, cycleResult);

  const updated = await loadSession(sessionId);
  if (!updated) throw new Error(`Session gone after append: ${sessionId}`);

  await updateWorkingArtifacts(updated, cycleResult);

  // Carry hint forward
  const cycleContextNext = cycleResult.nextCycleHint ?? null;

  const decision = decideNextMove(updated, cycleResult);
  if (decision.stop) {
    return await terminateSession(updated.id, decision.reason, decision.terminalReason);
  }

  updated.cycleCount++;
  await saveSession(updated);
  return updated;
}

// ─── Stop condition evaluation ────────────────────────────────────────

function evaluateStopConditions(session: AedisSession): StopDecision {
  const now = Date.now();

  // Hard: max cycles
  if (session.cycleCount >= session.maxCycles) {
    return {
      stop: true,
      reason: "failed",
      terminalReason: `maxCycles (${session.maxCycles}) reached — task not completed`,
    };
  }

  // Hard: max duration
  if (now - session.createdAt > session.maxDurationMs) {
    return {
      stop: true,
      reason: "failed",
      terminalReason: `maxDurationMs (${session.maxDurationMs}ms) exceeded after ${session.cycleCount} cycle(s)`,
    };
  }

  // Hard: repeated failure digest (stuck on same root cause)
  if (session.repeatedFailureCount >= REPEATED_FAILURE_THRESHOLD) {
    return {
      stop: true,
      reason: "failed",
      terminalReason: `repeated failure (${session.repeatedFailureCount}x): same root cause across consecutive cycles`,
    };
  }

  return { stop: false, reason: "active", terminalReason: "" };
}

// ─── One cycle ─────────────────────────────────────────────────────────

async function runOneCycle(
  session: AedisSession,
  coordinator: Coordinator,
  cycleContext: string | null,
): Promise<CycleResult> {
  const startedAt = Date.now();
  const cycleNumber = session.cycleCount + 1; // cycles are 1-indexed

  try {
    // Build the task intent string — prepend cycle context if we have a hint
    const taskIntent = cycleContext
      ? `${cycleContext}\n\nTask: ${session.intent.userRequest}`
      : session.intent.userRequest;

    // coordinator.buildCycle runs the full Scout→Builder→Critic→Verifier pipeline.
    const result: BuildResult = await coordinator.buildCycle(
      taskIntent,
      session.intent.projectRoot,
    );

    const completedAt = Date.now();

    // Determine outcome from build result using the error type mapping
    const outcome = mapBuildResultToOutcome(result);
    const verificationResult: VerificationResult | null = result.verificationPassed
      ? { passed: true, checks: [], summary: "Verification passed" }
      : result.success
        ? { passed: false, checks: [], summary: "Verification did not pass" }
        : null;

    const cycleResult: CycleResult = {
      cycleNumber,
      startedAt,
      completedAt,
      outcome,
      action: "build",
      verificationResult,
      error: null,
      artifactsProduced: result.touchedFiles ?? [],
      artifactsVerified: result.verificationPassed ? (result.touchedFiles ?? []) : [],
      learnedFrom: buildLearnedFrom(result, session.lastError),
      nextCycleHint: buildNextHint(result, session.lastError),
    };

    return cycleResult;
  } catch (err) {
    const completedAt = Date.now();
    const error = buildCycleError(err);

    return {
      cycleNumber,
      startedAt,
      completedAt,
      outcome: error.recoverable ? "retryable_failure" : "fatal_failure",
      action: "build",
      verificationResult: null,
      error,
      artifactsProduced: [],
      artifactsVerified: [],
      learnedFrom: `Caught exception: ${error.message}`,
      nextCycleHint: error.hint,
    };
  }
}

// ─── BuildResult → CycleOutcome mapping ──────────────────────────────

function mapBuildResultToOutcome(result: BuildResult): CycleOutcome {
  // Success: verification passed → immediate success
  if (result.verificationPassed) {
    return "success";
  }

  // Build failed — determine error type for classification
  if (!result.success) {
    const errorType = result.errorType ?? "unknown";

    // context_overflow: errorMessage includes context/token/overflow
    if (
      errorType === "context_overflow" ||
      (result.errorMessage &&
        /context|token|overflow|budget/i.test(result.errorMessage))
    ) {
      return "fatal_failure";
    }

    // compile error: errorType === "compile" OR errorMessage contains SyntaxError/TypeError
    if (
      errorType === "compile" ||
      (result.errorMessage &&
        /SyntaxError|TypeError|compile/i.test(result.errorMessage))
    ) {
      return "retryable_failure";
    }

    // runtime error: errorType === "runtime" OR specific OS-level errors
    if (
      errorType === "runtime" ||
      (result.errorMessage &&
        /EISDIR|ENOENT|ENOTDIR|EBUSY|EACCES/i.test(result.errorMessage))
    ) {
      return "retryable_failure";
    }

    // verification failure (verificationPassed === false but success still true)
    if (result.verificationPassed === false && result.success) {
      return "partial"; // made progress but verification didn't pass
    }

    // Unknown error — treat as fatal to avoid infinite loops
    return "fatal_failure";
  }

  // success === true but verification didn't pass — partial progress
  return "partial";
}

// ─── Error construction ─────────────────────────────────────────────────

function buildCycleError(err: unknown): CycleError {
  if (err instanceof Error) {
    const msg = err.message;
    const type = categorizeErrorType(msg);
    return {
      message: msg,
      type,
      recoverable: type === "compile" || type === "runtime",
      hint: buildHintFromError(msg, type),
      stack: err.stack,
    };
  }
  return {
    message: String(err),
    type: "unknown",
    recoverable: false,
    hint: null,
  };
}

function categorizeErrorType(msg: string): CycleError["type"] {
  if (msg.includes("EISDIR")) return "runtime";
  if (msg.includes("ENOENT")) return "runtime";
  if (msg.includes("SyntaxError") || msg.includes("TypeError")) return "compile";
  if (msg.includes("verify") || msg.includes("check") || msg.includes("assert")) return "verification";
  if (msg.includes("context") || msg.includes("overflow") || msg.includes("budget")) return "context_overflow";
  return "unknown";
}

function buildHintFromError(msg: string, type: CycleError["type"]): string | null {
  if (type === "compile") return "Fix compilation errors before retrying";
  if (type === "runtime") return "Runtime error — check file path resolution";
  if (type === "context_overflow") return "Reduce context size or simplify task";
  return null;
}

// ─── Learning ──────────────────────────────────────────────────────────

function buildLearnedFrom(
  result: BuildResult,
  lastError: CycleError | null
): string {
  if (!result.success) {
    return `Build attempt failed: ${result.errorMessage ?? "unknown error"}`;
  }
  if (lastError) {
    return `Recovered from previous error: ${lastError.message}`;
  }
  return "Build completed successfully";
}

function buildNextHint(
  result: BuildResult,
  lastError: CycleError | null
): string | null {
  if (!result.success && lastError?.hint) {
    return lastError.hint;
  }
  return null;
}

interface VerificationResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; message: string }>;
  summary: string;
}

// ─── Next-move decision ─────────────────────────────────────────────────

function decideNextMove(session: AedisSession, result: CycleResult): StopDecision {
  // Success: stop immediately (verificationPassed already handled in mapBuildResultToOutcome,
  // but we handle it here too for completeness when called from runOneMoreCycle)
  if (result.outcome === "success") {
    return {
      stop: true,
      reason: "success",
      terminalReason: `Goal achieved in ${session.cycleCount + 1} cycle(s)`,
    };
  }

  // Fatal failure: stop immediately
  if (result.outcome === "fatal_failure") {
    return {
      stop: true,
      reason: "failed",
      terminalReason: `Fatal error: ${result.error?.message ?? "unknown"}`,
    };
  }

  // Retryable failure: update failure digest, loop continues
  if (result.outcome === "retryable_failure" && result.error) {
    const digest = errorDigest(result.error);
    if (digest === session.failureDigest) {
      session.repeatedFailureCount++;
    } else {
      session.failureDigest = digest;
      session.repeatedFailureCount = 1;
    }
  }

  // Partial: keep going (made some progress)
  // Loop will re-evaluate stop conditions next iteration
  return { stop: false, reason: "active", terminalReason: "" };
}

// ─── Working artifacts ─────────────────────────────────────────────────

async function updateWorkingArtifacts(
  session: AedisSession,
  result: CycleResult
): Promise<void> {
  // Store content hashes for continuity verification
  // We don't store full content — just record what files were touched
  // so we can detect if they changed between cycles
  for (const path of result.artifactsProduced) {
    // Hash placeholder — actual hash would require reading the file
    // Store path as marker; hash computed on-demand from file system
    session.workingArtifacts[path] = "pending";
  }
}

// ─── Termination ────────────────────────────────────────────────────────

async function terminateSession(
  sessionId: string,
  reason: AedisSession["status"],
  terminalReason: string
): Promise<AedisSession> {
  return await transitionSession(sessionId, reason, terminalReason);
}

// ─── API helpers ───────────────────────────────────────────────────────

export async function getSession(id: string): Promise<AedisSession | null> {
  return await loadSession(id);
}

export async function cancelSession(id: string): Promise<AedisSession> {
  return await transitionSession(id, "cancelled", "User cancelled");
}