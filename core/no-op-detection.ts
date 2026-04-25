/**
 * NO_OP early-detection helper.
 *
 * Run d3524769 (commit 5838aad on absent-pianist, since reverted) cost
 * ~9 minutes and ~4Gi peak swap before the execution-gate finally
 * classified it as content-identical. The Builder produced two
 * "modify" FileChange entries whose post-apply content was byte-equal
 * (or whitespace-normalized equal) to the original, so the run reached
 * Verifier and Integrator before the gate caught it.
 *
 * This helper concentrates the same content-identity check that the
 * execution-gate uses (`detectContentIdentity` from adversarial-guard)
 * and surfaces a tiny ergonomic API for callers that need a clean
 * boolean + reason. The Builder's per-target guard at
 * workers/builder.ts:1656 consumes this so any byte- or
 * whitespace-identical Builder output is rejected at the Builder
 * boundary, before downstream phases spend Verifier/Integrator effort.
 *
 * The reason string mirrors detectContentIdentity's wording so log
 * lines and receipt error messages stay consistent across layers.
 */

import { detectContentIdentity } from "./adversarial-guard.js";

export interface NoOpDetectionResult {
  /** True when the updated content carries no real source change. */
  readonly noOp: boolean;
  /** Human-readable explanation suitable for error messages and logs. */
  readonly reason: string;
}

/**
 * Decide whether a Builder's proposed update is effectively a no-op.
 * Returns `noOp: true` when:
 *   - originalContent === updatedContent (byte-identical), or
 *   - normalizing both via the canonical whitespace rules collapses
 *     them to the same string (e.g. trailing-space-only or CRLF/LF
 *     line-ending differences).
 */
export function detectNoOpUpdate(
  originalContent: string,
  updatedContent: string,
): NoOpDetectionResult {
  const identity = detectContentIdentity(originalContent, updatedContent);
  if (identity.identical || identity.normalizedIdentical) {
    return { noOp: true, reason: identity.reason };
  }
  return { noOp: false, reason: identity.reason };
}
