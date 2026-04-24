/**
 * AedisSession types — persistent state for one autonomous task session.
 * A session spans multiple cycles and persists until a terminal state.
 */

export type SessionStatus = "active" | "success" | "failed" | "cancelled";
export type CycleOutcome = "success" | "retryable_failure" | "fatal_failure" | "partial";
export type ErrorType = "runtime" | "compile" | "verification" | "context_overflow" | "unknown";

export interface Intent {
  userRequest: string;
  goal: string;
  projectRoot: string;
  model?: string;
  constraints?: Record<string, string>;
}

export interface CycleError {
  message: string;
  type: ErrorType;
  recoverable: boolean;        // true = retryable, false = fatal
  hint: string | null;        // what to try differently next cycle
  stack?: string;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
  summary: string;
}

export interface CycleResult {
  cycleNumber: number;
  startedAt: number;
  completedAt: number;
  outcome: CycleOutcome;

  // What was attempted this cycle
  action: string;   // "build", "repair", "verify"

  // What happened
  verificationResult: VerificationResult | null;
  error: CycleError | null;

  // What changed
  artifactsProduced: string[];
  artifactsVerified: string[];

  // Learning
  learnedFrom: string;
  nextCycleHint: string | null;
}

export interface StopDecision {
  stop: boolean;
  reason: SessionStatus;
  terminalReason: string;
}

/**
 * The full persistent session state. Written to disk after every cycle
 * so a restart doesn't lose in-progress work.
 */
export interface AedisSession {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;

  // Goal
  intent: Intent;

  // Limits
  maxCycles: number;
  maxDurationMs: number;

  // Counters
  cycleCount: number;

  // Working state
  workingArtifacts: Record<string, string>;   // path → content hash (continuity check)
  lastError: CycleError | null;
  failureDigest: string;                      // hash of last failure root cause
  repeatedFailureCount: number;              // consecutive cycles with same digest

  // History — one entry per cycle
  cycleHistory: CycleResult[];

  // Terminal
  terminalReason: string | null;
}

/**
 * Build a short digest from an error's root cause — used to detect
 * when we're stuck retrying the same broken thing repeatedly.
 */
export function errorDigest(error: CycleError): string {
  const normalized = `${error.type}:${error.message.replace(/\s+/g, " ").trim()}`;
  return normalized.slice(0, 120);
}
