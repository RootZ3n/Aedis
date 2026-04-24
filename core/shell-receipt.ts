/**
 * shell-receipt.ts — Receipt type for shell execution results.
 *
 * Every shell command produces exactly one ShellReceipt with:
 *   - The REQUESTED command (original user input)
 *   - The EXECUTED command (validated, sandboxed version)
 *   - The RESULT (stdout, stderr, exit code, duration)
 *
 * This enforces the design principle: requested vs executed vs result,
 * all visible in receipts. No silent execution.
 */

export type ShellStatus =
  | "success"     // Exit code 0
  | "failed"      // Exit code != 0
  | "rejected"    // Command not allowed (blocked by allowlist)
  | "timeout"     // Command exceeded its timeout
  | "sandbox_violation"; // Command attempted to escape projectRoot

export interface ShellReceipt {
  /** Unique ID for this shell execution */
  readonly id: string;
  /** The command as requested by the caller */
  readonly requestedCommand: string;
  /** The command after validation and sanitization */
  readonly executedCommand: string;
  /** Shell status */
  readonly status: ShellStatus;
  /** What was allowed/blocked/rejected — human-readable */
  readonly reason: string;
  /** Standard output (null if not captured / not available) */
  readonly stdout: string | null;
  /** Standard error (null if not captured / not available) */
  readonly stderr: string | null;
  /** Process exit code */
  readonly exitCode: number | null;
  /** Wall-clock duration in milliseconds */
  readonly durationMs: number;
  /** ISO timestamp when execution started */
  readonly startedAt: string;
  /** ISO timestamp when execution completed */
  readonly completedAt: string;
  /** The working directory the command ran in */
  readonly cwd: string;
  /** Environment keys present (not values — no secrets exposed) */
  readonly envKeys: readonly string[];
  /** Blast radius indicator: files/dirs this command touched */
  readonly touchedPaths: readonly string[];
}

export interface ShellExecutionInput {
  /** The raw command string (e.g. "git status") */
  command: string;
  /** Working directory (defaults to projectRoot) */
  cwd?: string;
  /** Environment variables (no API keys — clean env enforced) */
  env?: Record<string, string>;
  /** Maximum time in milliseconds before killing (default 120000) */
  timeoutMs?: number;
}