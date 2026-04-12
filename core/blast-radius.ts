/**
 * Blast Radius Estimator — Human-Readable Execution + Trust Layer v1.
 *
 * Wraps the numeric blast-radius score from `ScopeClassification`
 * (computed in core/scope-classifier.ts) into a user-facing
 * estimate with a risk level and a rationale the UI can render
 * before execution begins.
 *
 * Why this is a separate module: ScopeClassification.blastRadius
 * is an internal coordination number (file count + dependency
 * pressure + keyword weight). It's fine for trust-routing but
 * opaque to users. This module translates it into the three-bucket
 * "low / medium / high" model the Lumen UI renders in the blast
 * radius chip, and adds a one-line rationale grounded in the
 * signals we already compute.
 *
 * The estimate is produced before execution begins (during Phase 1
 * of the Coordinator's submit() pipeline) and is included in the
 * final run summary for after-run comparison.
 */

import type { ScopeClassification } from "./scope-classifier.js";

// ─── Types ───────────────────────────────────────────────────────────

export type BlastRadiusLevel = "low" | "medium" | "high";

export interface BlastRadiusEstimate {
  readonly level: BlastRadiusLevel;
  /** Scope label from the classifier, passed through for the UI. */
  readonly scopeType: ScopeClassification["type"] | "unknown";
  /**
   * Best-guess number of files likely to be touched. Rounded and
   * capped — this is a human display number, not a load-bearing
   * planning input.
   */
  readonly estimatedFiles: number;
  /** Raw numeric score from ScopeClassification for inspection. */
  readonly rawScore: number;
  /**
   * True when the scope classifier recommends decomposing the
   * change into smaller waves. Forwarded so the UI can show a
   * "consider splitting" hint.
   */
  readonly recommendDecompose: boolean;
  /** One-line human-readable rationale. */
  readonly rationale: string;
  /**
   * Short list of signals that contributed to the level. Useful
   * for tooltips ("high because: migration keyword, 8+ files").
   */
  readonly signals: readonly string[];
}

export interface BlastRadiusInput {
  readonly scopeClassification?: ScopeClassification | null;
  /** Number of target files in the charter (post-dedup). */
  readonly charterFileCount?: number;
  /** Optional prompt — lets us surface destructive verbs. */
  readonly prompt?: string;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Compute a human-readable blast radius estimate from the signals
 * the Coordinator already has at planning time. Pure function.
 */
export function estimateBlastRadius(input: BlastRadiusInput): BlastRadiusEstimate {
  const scope = input.scopeClassification ?? null;
  const signals: string[] = [];

  const rawScore = scope?.blastRadius ?? 0;
  const scopeType = scope?.type ?? "unknown";
  const recommendDecompose = scope?.recommendDecompose ?? false;
  const fileCount = input.charterFileCount ?? 0;

  if (scope) signals.push(`scope:${scope.type}`);
  if (fileCount > 0) signals.push(`files:${fileCount}`);
  if (recommendDecompose) signals.push("decompose-recommended");

  // Destructive-verb detection on the prompt. These boost the
  // level even when the file count is low — a "delete the auth
  // module" task is high-risk regardless of file count.
  const lower = (input.prompt ?? "").toLowerCase();
  const destructive = /\b(delete|drop|remove|rewrite|migrate|rename)\b/.test(lower);
  if (destructive) signals.push("destructive-verb");
  const security = /\b(auth|token|secret|credential|password|permission)\b/.test(lower);
  if (security) signals.push("security-sensitive");

  const level = chooseLevel({
    rawScore,
    scopeType,
    recommendDecompose,
    destructive,
    security,
  });

  const estimatedFiles = estimateFileCount({ rawScore, fileCount, scopeType });

  const rationale = buildRationale({
    level,
    scopeType,
    estimatedFiles,
    rawScore,
    recommendDecompose,
    destructive,
    security,
  });

  return {
    level,
    scopeType,
    estimatedFiles,
    rawScore,
    recommendDecompose,
    rationale,
    signals,
  };
}

// ─── Internals ───────────────────────────────────────────────────────

function chooseLevel(input: {
  rawScore: number;
  scopeType: BlastRadiusEstimate["scopeType"];
  recommendDecompose: boolean;
  destructive: boolean;
  security: boolean;
}): BlastRadiusLevel {
  // Architectural / migration scopes are high by definition.
  if (input.scopeType === "architectural" || input.scopeType === "migration") {
    return "high";
  }
  // Destructive verbs + security-sensitive surface → high even at
  // low raw score.
  if (input.destructive && input.security) return "high";
  // Raw score buckets, tuned to match the scope-classifier's own
  // thresholds (see classifyScope: blast=file+deps+2*keywords).
  if (input.rawScore >= 10) return "high";
  if (input.rawScore >= 4 || input.recommendDecompose) return "medium";
  if (input.destructive) return "medium";
  return "low";
}

function estimateFileCount(input: {
  rawScore: number;
  fileCount: number;
  scopeType: BlastRadiusEstimate["scopeType"];
}): number {
  // When the charter already names N files, trust it. Otherwise
  // fall back to a rough projection from the raw score.
  if (input.fileCount > 0) return input.fileCount;
  if (input.scopeType === "architectural") return Math.max(8, input.rawScore);
  if (input.scopeType === "migration") return Math.max(5, input.rawScore);
  if (input.scopeType === "multi-file") return Math.max(3, Math.ceil(input.rawScore / 2));
  if (input.scopeType === "single-file") return 1;
  return Math.max(1, Math.ceil(input.rawScore / 2));
}

function buildRationale(input: {
  level: BlastRadiusLevel;
  scopeType: BlastRadiusEstimate["scopeType"];
  estimatedFiles: number;
  rawScore: number;
  recommendDecompose: boolean;
  destructive: boolean;
  security: boolean;
}): string {
  const parts: string[] = [];
  parts.push(`~${input.estimatedFiles} file(s)`);

  switch (input.scopeType) {
    case "single-file":
      parts.push("contained within one file");
      break;
    case "multi-file":
      parts.push("spans multiple files");
      break;
    case "architectural":
      parts.push("architectural change");
      break;
    case "migration":
      parts.push("migration scope");
      break;
    default:
      parts.push("scope unknown");
  }

  if (input.destructive) parts.push("destructive verbs");
  if (input.security) parts.push("touches security-sensitive surface");
  if (input.recommendDecompose) parts.push("planner recommends decomposing");

  return parts.join(" · ") +
    ` (level=${input.level}, raw=${input.rawScore})`;
}
