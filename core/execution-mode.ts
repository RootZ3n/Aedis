/**
 * Execution-Mode Classifier — picks the supervised pipeline tier for a
 * task BEFORE the Builder runs.
 *
 *   fast_review     — clearly low-risk single-file doc/comment/typo
 *                     edits. Same supervised pipeline (Scout → Builder
 *                     → heuristic Critic → Verifier), plus a strict
 *                     deterministic post-Builder diff check, and full
 *                     approval before promotion.
 *   standard_review — the default supervised pipeline. Anything that
 *                     isn't clearly trivial AND isn't sensitive lands
 *                     here. Critic + Verifier + rehearsal + merge gate.
 *   strict_review   — high-impact, multi-file, security/auth/config/
 *                     migration/test/package surfaces, or anything the
 *                     classifier couldn't pin down. Full pipeline +
 *                     forced approval + strict verification + no
 *                     auto-promotion.
 *
 * What the modes never change:
 *   - safe-path containment (always)
 *   - approval before promotion (always — fast_review still needs it)
 *   - rollback dominance (always)
 *   - provider/model truth (always)
 *   - receipts (always)
 *   - no source write without approval (always)
 *
 * The classifier is a PURE function. No LLM, no I/O, no env reads.
 * Default behavior is conservative: when in doubt, route to
 * strict_review. Only an explicit allow-set + zero blockers downgrade
 * a task to fast_review.
 */

import type { ImpactClassification } from "./impact-classifier.js";

// ─── Types ───────────────────────────────────────────────────────────

export type ExecutionMode =
  | "fast_review"
  | "standard_review"
  | "strict_review";

export type RiskLevel = "low" | "medium" | "high";

export type TaskCategory =
  | "docs"
  | "comment"
  | "typo"
  | "code"
  | "config"
  | "security"
  | "test"
  | "build"
  | "mixed"
  | "unknown";

export type TargetType =
  | "doc"
  | "code"
  | "config"
  | "security"
  | "test"
  | "build"
  | "mixed"
  | "unknown";

export interface ExecutionModeClassification {
  readonly riskLevel: RiskLevel;
  readonly taskCategory: TaskCategory;
  readonly targetType: TargetType;
  readonly explicitTarget: boolean;
  readonly multiFile: boolean;
  /** `true` only when EVERY fast-path precondition is satisfied. */
  readonly allowedFastPath: boolean;
}

export interface ExecutionModeResult {
  readonly mode: ExecutionMode;
  /** Short machine-readable code for the rule that fired. */
  readonly reasonCode: string;
  /** Human-readable one-line reason suitable for UI / receipts. */
  readonly reason: string;
  /** Every signal that contributed to the decision. */
  readonly factors: readonly string[];
  /** Detailed classification breakdown. */
  readonly classification: ExecutionModeClassification;
  /**
   * Stages that may be skipped or substituted when this mode runs.
   * Persisted in the receipt so reviewers see what governance was
   * traded away. Empty for standard/strict.
   */
  readonly skippedStages: readonly string[];
}

// ─── Pattern Tables ──────────────────────────────────────────────────
//
// These are intentionally narrow. Adding a new pattern to the doc
// allowlist must match the spirit of "the file's content is NOT
// executed by the build/runtime." When in doubt, leave it out and
// the task falls through to standard_review.

const DOC_FILE_PATTERNS: readonly RegExp[] = [
  /\.md$/i,
  /\.markdown$/i,
  /\.mdx$/i,
  /\.rst$/i,
  /\.adoc$/i,
  /\.txt$/i,
  /(^|\/)README(\.[A-Za-z]+)?$/,
  /(^|\/)CHANGELOG(\.[A-Za-z]+)?$/,
  /(^|\/)CONTRIBUTING(\.[A-Za-z]+)?$/,
  /(^|\/)LICENSE(\.[A-Za-z]+)?$/,
  /(^|\/)CODE_OF_CONDUCT(\.[A-Za-z]+)?$/,
  /(^|\/)AUTHORS(\.[A-Za-z]+)?$/,
  /(^|\/)NOTICE(\.[A-Za-z]+)?$/,
];

// Files that are NEVER eligible for fast_review even if the prompt
// looks like a comment edit. Order matters in spirit: package files,
// build/CI, env, secrets, then anything in security-critical paths.
const NEVER_FAST_PATH_PATTERNS: readonly RegExp[] = [
  // Package / dependency files
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.ya?ml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.(toml|lock)$/,
  /(^|\/)go\.(mod|sum)$/,
  /(^|\/)Pipfile(\.lock)?$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)requirements(\.|-).*\.txt$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)Gemfile(\.lock)?$/,
  /(^|\/)composer\.(json|lock)$/,
  // TS/JS/Babel/build configs
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)\.babelrc/,
  /(^|\/)babel\.config\./,
  /(^|\/)vite\.config\./,
  /(^|\/)webpack\.config\./,
  /(^|\/)rollup\.config\./,
  /(^|\/)esbuild\.config\./,
  /(^|\/)jest\.config\./,
  /(^|\/)vitest\.config\./,
  /(^|\/)playwright\.config\./,
  /(^|\/)next\.config\./,
  /(^|\/)nuxt\.config\./,
  /(^|\/)svelte\.config\./,
  /(^|\/)astro\.config\./,
  // CI / containers / infra
  /(^|\/)\.github\//,
  /(^|\/)\.gitlab-ci\.ya?ml$/,
  /(^|\/)\.circleci\//,
  /(^|\/)Dockerfile(\.|$)/,
  /(^|\/)docker-compose(\.|$)/,
  /(^|\/)compose\.ya?ml$/,
  /(^|\/)Makefile$/,
  /(^|\/)\.dockerignore$/,
  /(^|\/)kustomization\.ya?ml$/,
  // Env / secrets
  /(^|\/)\.env(\.|$)/,
  /(^|\/)secrets?(\.|\/)/i,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pnpmrc$/,
  // Auth / security paths
  /(^|\/)auth\//i,
  /(^|\/)security\//i,
  /(^|\/)middleware\/.*auth/i,
  /(^|\/)policies\//i,
  // Migrations
  /(^|\/)migrations?\//i,
  /\.(sql|prisma)$/i,
  // Tests (need their own gates)
  /\.(test|spec)\.[a-z]+$/i,
  /(^|\/)tests?\//i,
  /(^|\/)__tests__\//,
  // Generated code (often regenerated, fast edits would be lost)
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)out\//,
  /\.generated\.[a-z]+$/i,
  // Aedis-internal state
  /(^|\/)\.aedis\//,
  /(^|\/)\.git\//,
];

// Prompt patterns indicating a docs/comment/typo task. Mirrors the
// existing trivial-task-detector but more specific (each maps to a
// taskCategory rather than a binary "trivial").
const DOCS_PROMPT_PATTERNS: readonly RegExp[] = [
  /\b(readme|changelog|docs?\b|documentation|markdown|\.md\b)/i,
  /\b(license|copyright)\s+(header|notice|banner)/i,
];
const COMMENT_PROMPT_PATTERNS: readonly RegExp[] = [
  /\b(add|update|fix|change|edit|modify|insert|remove|tweak|improve|reword|rewrite|reformat)\s+(a\s+|the\s+|some\s+)?(comment|comments|jsdoc|tsdoc|docstring|annotation)\b/i,
  /\b(comment|uncomment|jsdoc|tsdoc|docstring|annotation)[- ]only\b/i,
];
const TYPO_PROMPT_PATTERNS: readonly RegExp[] = [
  /\b(typo|misspell|misspelt|spelling|grammatical|grammar|punctuation|wording)\b/i,
];

// Prompt patterns that DISQUALIFY fast_review even if everything else
// looks docs-shaped. These are specifically things that imply real
// code changes or new structure ("rewrite the auth flow in the
// README") and shouldn't slip into fast_review.
const NEVER_FAST_PROMPT_PATTERNS: readonly RegExp[] = [
  /\b(refactor|redesign|rewrite|implement|add\s+(a\s+)?(test|spec|feature|endpoint|route|migration|schema|table|column))\b/i,
  /\b(security|auth|authentication|authorization|oauth|jwt|password|secret|credential|api.?key)\b/i,
  /\b(install|upgrade|downgrade|bump|pin)\b[^.]*\b(package|dep|dependency|version|module|lib|library)\b/i,
  /\b(env|environment)\s+(var|variable)\b/i,
  /\b(ci|pipeline|workflow|action)\b/i,
];

// Test-requirement detection (from the existing trivial detector,
// preserved here so the new module has all its inputs in one place).
const TEST_REQUIREMENT_PATTERNS: readonly RegExp[] = [
  /\badd\s+test/i,
  /\bwrite\s+test/i,
  /\btest\s+(coverage|case|suite)/i,
  /\bunit\s+test/i,
  /\bintegration\s+test/i,
  /\b(spec|\.test\.|\.spec\.)\b/i,
];

// ─── Helpers ─────────────────────────────────────────────────────────

function classifyTargetType(target: string): TargetType {
  if (DOC_FILE_PATTERNS.some((rx) => rx.test(target))) return "doc";
  if (/(^|\/)tests?\//i.test(target) || /\.(test|spec)\.[a-z]+$/i.test(target)) return "test";
  if (/(^|\/)auth\//i.test(target) || /(^|\/)security\//i.test(target) || /\.env(\.|$)/.test(target)) return "security";
  if (/\.(json|ya?ml|toml|ini|conf|config|env)$/i.test(target)) return "config";
  if (/(^|\/)dist\//.test(target) || /(^|\/)build\//.test(target) || /\.generated\.[a-z]+$/i.test(target)) return "build";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|lua|sh|bash|gd|tscn|tres|gdshader|vue|svelte|css|scss|sass|less|html)$/i.test(target)) return "code";
  return "unknown";
}

function aggregateTargetType(targets: readonly string[]): TargetType {
  if (targets.length === 0) return "unknown";
  const types = new Set<TargetType>(targets.map(classifyTargetType));
  if (types.size === 1) return [...types][0]!;
  return "mixed";
}

function classifyTaskCategory(prompt: string, targets: readonly string[]): TaskCategory {
  const targetType = aggregateTargetType(targets);
  if (targetType === "doc" || DOCS_PROMPT_PATTERNS.some((rx) => rx.test(prompt))) return "docs";
  if (COMMENT_PROMPT_PATTERNS.some((rx) => rx.test(prompt))) return "comment";
  if (TYPO_PROMPT_PATTERNS.some((rx) => rx.test(prompt))) return "typo";
  if (targetType === "security") return "security";
  if (targetType === "config") return "config";
  if (targetType === "test") return "test";
  if (targetType === "build") return "build";
  if (targetType === "code") return "code";
  if (targetType === "mixed") return "mixed";
  return "unknown";
}

// ─── Public API ──────────────────────────────────────────────────────

export interface ClassifyExecutionModeInput {
  readonly prompt: string;
  readonly charterTargets: readonly string[];
  readonly riskSignals: readonly string[];
  readonly scopeEstimate: string;
  readonly impact: ImpactClassification;
  /**
   * When true, the prompt was flagged as ambiguous upstream. Ambiguous
   * prompts NEVER take the fast path — the operator's intent is too
   * loosely specified to trust a deterministic-only review.
   */
  readonly ambiguous?: boolean;
  /**
   * Operator-supplied override. When present, overrides the classifier's
   * choice. The override is logged in `factors` so receipts show that
   * a human chose the mode rather than the classifier.
   */
  readonly override?: ExecutionMode;
}

export function classifyExecutionMode(
  input: ClassifyExecutionModeInput,
): ExecutionModeResult {
  const { prompt, charterTargets, riskSignals, scopeEstimate, impact, ambiguous } = input;

  const factors: string[] = [];
  factors.push(`impact:${impact.level}`);
  factors.push(`scope:${scopeEstimate}`);
  factors.push(`targets:${charterTargets.length}`);
  factors.push(`risk-signals:${riskSignals.length}`);
  if (ambiguous) factors.push("ambiguous:true");

  const targetType = aggregateTargetType(charterTargets);
  const taskCategory = classifyTaskCategory(prompt, charterTargets);
  factors.push(`targetType:${targetType}`);
  factors.push(`taskCategory:${taskCategory}`);

  // ── Operator override path ──────────────────────────────────────
  if (input.override) {
    factors.push(`override:${input.override}`);
    return {
      mode: input.override,
      reasonCode: "operator-override",
      reason: `Operator selected ${input.override} explicitly`,
      factors,
      classification: {
        riskLevel: impact.level,
        taskCategory,
        targetType,
        explicitTarget: charterTargets.length === 1,
        multiFile: charterTargets.length > 1,
        allowedFastPath: false,
      },
      skippedStages: input.override === "fast_review"
        ? ["critic-llm-review", "rehearsal-loop", "integrator"]
        : [],
    };
  }

  // ── Strict-review forcing conditions ────────────────────────────
  // Anything that implies real code surface / security / multi-file /
  // ambiguity → strict_review. This is the *upgrade* path.
  //
  // NOTE: `riskSignals` from the scope-classifier (e.g.
  // "public-interface") are NOT a strict-trigger here. They legitimately
  // disqualify fast_review (handled below) but firing strict on every
  // public-interface edit would push routine bugfixes into the
  // approval-required + strict-verification tier and cause false
  // governance fatigue. Strict is reserved for the explicit
  // sensitive-surface / multi-file / high-impact / ambiguous cases.
  const strictReasons: string[] = [];
  if (impact.level === "high") strictReasons.push("impact=high");
  if (charterTargets.length > 1) strictReasons.push(`multi-file (${charterTargets.length})`);
  if (ambiguous) strictReasons.push("ambiguous-prompt");
  if (charterTargets.some((t) => NEVER_FAST_PATH_PATTERNS.some((rx) => rx.test(t)))) {
    const matched = charterTargets.find((t) => NEVER_FAST_PATH_PATTERNS.some((rx) => rx.test(t)))!;
    strictReasons.push(`sensitive-path:${matched}`);
  }
  if (NEVER_FAST_PROMPT_PATTERNS.some((rx) => rx.test(prompt))) {
    strictReasons.push("prompt-implies-real-code-or-security-change");
  }
  if (TEST_REQUIREMENT_PATTERNS.some((rx) => rx.test(prompt))) {
    strictReasons.push("prompt-implies-tests");
  }

  if (strictReasons.length > 0) {
    factors.push(...strictReasons.map((r) => `strict:${r}`));
    return {
      mode: "strict_review",
      reasonCode: "strict-required",
      reason: `Strict review required: ${strictReasons.join("; ")}`,
      factors,
      classification: {
        riskLevel: impact.level,
        taskCategory,
        targetType,
        explicitTarget: charterTargets.length === 1,
        multiFile: charterTargets.length > 1,
        allowedFastPath: false,
      },
      skippedStages: [],
    };
  }

  // ── Fast-review eligibility ─────────────────────────────────────
  // ALL of these must be true:
  //   1. exactly one target file
  //   2. that file is in the doc allowlist (or the prompt is clearly
  //      comment-only AND the file isn't in the never-fast denylist)
  //   3. impact is low
  //   4. scope is small or simple
  //   5. prompt matches a docs/comment/typo pattern
  //   6. ambiguity flag is false
  //   7. zero risk signals
  //
  // If any condition fails, we fall through to standard_review.

  const fastReasons: string[] = [];
  let fastEligible = true;

  if (charterTargets.length !== 1) {
    fastEligible = false;
    fastReasons.push("not-single-file");
  }
  if (impact.level !== "low") {
    fastEligible = false;
    fastReasons.push(`impact-not-low:${impact.level}`);
  }
  if (scopeEstimate !== "simple" && scopeEstimate !== "small") {
    fastEligible = false;
    fastReasons.push(`scope-not-small:${scopeEstimate}`);
  }
  if (riskSignals.length > 0) {
    fastEligible = false;
    fastReasons.push("risk-signals-present");
  }
  if (ambiguous) {
    fastEligible = false;
    fastReasons.push("ambiguous-prompt");
  }

  // Prompt category check: must be docs/comment/typo.
  const promptIsDocsLike =
    DOCS_PROMPT_PATTERNS.some((rx) => rx.test(prompt)) ||
    COMMENT_PROMPT_PATTERNS.some((rx) => rx.test(prompt)) ||
    TYPO_PROMPT_PATTERNS.some((rx) => rx.test(prompt));
  if (!promptIsDocsLike) {
    fastEligible = false;
    fastReasons.push("prompt-not-docs-or-comment-shaped");
  }

  // Target file class:
  //   - If target type is "doc": fast_review allowed.
  //   - If target type is anything else: fast_review only when prompt
  //     is unambiguously comment-only (the post-Builder diff check
  //     enforces actual comment-only).
  if (charterTargets.length === 1) {
    const t = charterTargets[0]!;
    const isDoc = DOC_FILE_PATTERNS.some((rx) => rx.test(t));
    const isCommentOnly = COMMENT_PROMPT_PATTERNS.some((rx) => rx.test(prompt));
    if (!isDoc && !isCommentOnly) {
      fastEligible = false;
      fastReasons.push("target-not-doc-and-not-comment-only");
    }
  }

  if (fastEligible) {
    factors.push("fast:eligible");
    return {
      mode: "fast_review",
      reasonCode: "fast-eligible",
      reason:
        `Fast review: single-file ${taskCategory} change to ${targetType} target with low impact`,
      factors,
      classification: {
        riskLevel: impact.level,
        taskCategory,
        targetType,
        explicitTarget: true,
        multiFile: false,
        allowedFastPath: true,
      },
      // What the fast path trades away vs standard. Critic still runs
      // in heuristic-only mode (existing fast-path graph), but the
      // LLM-driven critic review and rehearsal loop are dropped. The
      // post-Builder deterministic diff check is added.
      skippedStages: ["critic-llm-review", "rehearsal-loop", "integrator"],
    };
  }

  // ── Default: standard_review ────────────────────────────────────
  factors.push(...fastReasons.map((r) => `standard:${r}`));
  return {
    mode: "standard_review",
    reasonCode: "default-standard",
    reason: `Standard review (fast not eligible: ${fastReasons.join(", ")})`,
    factors,
    classification: {
      riskLevel: impact.level,
      taskCategory,
      targetType,
      explicitTarget: charterTargets.length === 1,
      multiFile: charterTargets.length > 1,
      allowedFastPath: false,
    },
    skippedStages: [],
  };
}

/**
 * Convenience predicate. True when the mode is fast_review and the
 * post-Builder deterministic diff check should run.
 */
export function modeRequiresFastDiffCheck(mode: ExecutionMode): boolean {
  return mode === "fast_review";
}

/**
 * Convenience predicate. True when the mode forces the human-approval
 * gate regardless of the operator's `requireApproval` config.
 *
 * No mode currently force-approves. The existing impact-classifier
 * (impact=high) and the operator's `requireApproval` config remain
 * authoritative. strict_review's contribution is *strict verification*,
 * not approval-forcing — escalating every multi-file edit to mandatory
 * approval would create review fatigue and break legitimate auto-
 * promote workflows on medium-impact scaffolds. Reviewers who want
 * approval everywhere can set `requireApproval: true` on the server.
 */
export function modeForcesApproval(_mode: ExecutionMode): boolean {
  return false;
}

/**
 * Convenience predicate. True when the mode forces strict verification.
 */
export function modeForcesStrictVerification(mode: ExecutionMode): boolean {
  return mode === "strict_review";
}
