/**
 * Run Summary — Human-Readable Execution + Trust Layer v1.
 *
 * Composes a single structured summary of a completed run that
 * the UI can render instead of asking the user to read logs.
 *
 *   classification   — one of VERIFIED_SUCCESS / PARTIAL_SUCCESS /
 *                       NO_OP / FAILED, computed by execution-
 *                       classification.ts.
 *   headline         — one short plain-English sentence.
 *   narrative        — a longer paragraph in the same tone as the
 *                       product brief ("Aedis updated 3 files to
 *                       implement a capability registry...").
 *   whatWasAttempted — the user's original request.
 *   whatChanged      — a concrete list of file ops.
 *   blastRadius      — the planning-time estimate (for after-run
 *                       comparison).
 *   confidence       — the full confidence breakdown.
 *   cost             — a rounded dollar number and token counts.
 *   failureExplanation — populated only when classification !=
 *                       VERIFIED_SUCCESS.
 *
 * The summary is a pure function of the RunReceipt and the
 * conversational inputs (prompt, blast radius). It is attached
 * to the RunReceipt as `summary` so receipts remain the single
 * source of truth.
// burn-in: comment-swap probe.
 */

import type { RunReceipt } from "./coordinator.js";
import type { ScopeClassification } from "./scope-classifier.js";
import type { ExecutionReceipt, ExecutionEvidence } from "./execution-gate.js";
import {
  classifyExecution,
  type ExecutionClassification,
  type ExecutionClassificationResult,
} from "./execution-classification.js";
import {
  estimateBlastRadius,
  type BlastRadiusEstimate,
} from "./blast-radius.js";
import {
  scoreRunConfidence,
  type ConfidenceBreakdown,
} from "./confidence-scoring.js";
import { explainFailure, type FailureExplanation } from "./failure-explainer.js";
import type { GitDiffResult } from "./git-diff-verifier.js";
import { assessRepoReadiness, type RepoReadinessAssessment } from "./repo-readiness.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface FileChangeSummary {
  readonly path: string;
  readonly operation: "create" | "modify" | "delete";
}

export interface RunCostSummary {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  /** Rounded-to-2-decimal dollars for display. */
  readonly displayUsd: string;
}

export interface RunSummary {
  readonly classification: ExecutionClassification;
  readonly classificationReason: string;
  readonly classificationReasonCode: string;
  readonly headline: string;
  readonly narrative: string;
  readonly whatWasAttempted: string;
  readonly whatChanged: readonly FileChangeSummary[];
  readonly filesTouchedCount: number;
  readonly verification: "pass" | "fail" | "pass-with-warnings" | "not-run";
  readonly verificationChecks: readonly {
    kind: string;
    name: string;
    executed: boolean;
    passed: boolean;
    required: boolean;
  }[];
  readonly explanationLines: readonly string[];
  readonly explanationDetails: {
    readonly filesByRole: Readonly<Record<"types" | "implementation" | "integration" | "tests", readonly string[]>>;
    readonly requiredFilesModified: boolean;
    readonly missingRequiredFiles: readonly string[];
    readonly undeclaredFiles: readonly string[];
    readonly verificationCoverageRatio: number | null;
    readonly validatedRatio: number | null;
    readonly typeScriptErrors: number;
    readonly waveSummary: string | null;
    readonly gitDiffConsistency: string;
    readonly repoReadiness: RepoReadinessAssessment;
    readonly patternWarnings: readonly string[];
  };
  readonly blastRadius: BlastRadiusEstimate;
  readonly confidence: ConfidenceBreakdown;
  readonly cost: RunCostSummary;
  readonly failureExplanation: FailureExplanation | null;
  /**
   * Raw classification factors — same as
   * ExecutionClassificationResult.factors — exposed so the UI
   * can render them as audit tooltips without repeating the rule.
   */
  readonly factors: readonly string[];

  // ─── First-class trust instrumentation ────────────────────────────
  // These replace heuristic extraction in the trust dashboard.
  // Each field is computed once during summary generation and stored
  // directly so downstream consumers never parse strings.

  /** Exact git diff confirmation ratio (0-1). Null when git diff didn't run. */
  readonly gitDiffConfirmationRatio: number | null;
  /** Whether strict mode was active for this run. */
  readonly strictModeEnabled: boolean;
  /** Confidence dampening factor applied from pattern history (0.8-1.0). 1.0 = no dampening. */
  readonly confidenceDampeningApplied: number;
  /** Historical reliability tier for the matched task archetype. Null when no pattern matched. */
  readonly historicalReliabilityTier: "reliable" | "risky" | "caution" | "unknown" | null;
  /**
   * Evaluation alignment status — direct from Crucibulum disagreement analysis.
   * Null when no evaluation ran.
   */
  readonly evaluationAlignmentStatus: "aligned" | "aedis-overconfident" | "aedis-underconfident" | null;
  /** True when Aedis confidence >= 0.7 and evaluation failed. */
  readonly overconfidenceFlag: boolean;
  /** Human-readable list of positive trust signals for this run. */
  readonly trustExplanation: readonly string[];
  /** Context gate inclusion log — why each file/context item was shown to the worker. */
  readonly contextInclusionLog: readonly string[];
  /**
   * Calibration lifecycle state at the time this run was scored.
   * Surfaced so users can distinguish "calibrated thresholds are active"
   * from "still collecting data" — calibration only engages after ≥5
   * evaluated runs AND at least one threshold diverges from defaults.
   */
  readonly calibrationState: "insufficient_data" | "warming" | "active";
  /** Number of evaluated runs backing calibration at scoring time. */
  readonly calibrationEvaluatedRuns: number;
  /**
   * True when verification produced no usable signal (no required
   * hooks configured and nothing was actively validated). Runs in this
   * state must not be treated as "pass" regardless of verdict.
   */
  readonly verificationNoSignal: boolean;
  /**
   * Trust-regression alert snapshot for this run. Populated only when
   * the coordinator's detector fired on this or a recent run; null
   * otherwise. Persisted on the receipt so UIs can render a durable
   * banner rather than relying on a transient WebSocket event.
   */
  readonly trustRegressionAlert: TrustRegressionAlert | null;
}

/**
 * Structured snapshot of the trust-regression alert lifecycle. The
 * coordinator emits a `trust_regression` event whenever signals fire;
 * this field carries the same snapshot on the receipt so late
 * subscribers (and reload-from-history UI) see the same thing.
 */
export interface TrustRegressionAlert {
  /** Severity tier — "mild" (one signal) or "significant" (two+). */
  readonly severity: "mild" | "significant";
  /** Individual signals that tripped. */
  readonly signals: readonly string[];
  /** When the alert fired. */
  readonly at: string;
  /** True when this run itself triggered the detector. */
  readonly firedOnThisRun: boolean;
}

export interface RunSummaryInput {
  readonly receipt: RunReceipt;
  /** The original user prompt, used for "what was attempted" + blast radius. */
  readonly userPrompt: string;
  /**
   * Best-effort scope classification from the coordinator at
   * planning time. When absent the summary degrades gracefully
   * to "unknown" blast radius.
   */
  readonly scopeClassification?: ScopeClassification | null;
  /**
   * File changes pulled from the active run (not always present
   * on the RunReceipt itself). When absent we fall back to the
   * executionEvidence on the receipt — both paths converge to
   * the same thing in practice.
   */
  readonly changes?: readonly { path: string; operation: "create" | "modify" | "delete" }[];
  /**
   * Average worker confidence from active.workerResults. The
   * coordinator passes it in so confidence scoring can boost/
   * penalize based on worker self-reports.
   */
  readonly averageWorkerConfidence?: number;
  /**
   * Git diff confirmation ratio (0-1). Passed from the coordinator's
   * GitDiffVerifier result. Feeds into confidence scoring to penalize
   * manifest/disk divergence.
   */
  readonly gitDiffConfirmationRatio?: number;
  readonly gitDiffResult?: GitDiffResult | null;
  readonly requiredFiles?: readonly string[];
  readonly projectRoot?: string;
  readonly patternWarnings?: readonly string[];
  /** Historical insights from pattern memory for the explanation layer. */
  readonly historicalInsights?: readonly string[];
  /**
   * Confidence dampening factor from historical pattern accuracy (0.8-1.0).
   * Applied as a multiplier to the final confidence score.
   */
  readonly confidenceDampening?: number;
  readonly strictMode?: boolean;
  /** Historical reliability tier for the matched task archetype. */
  readonly historicalReliabilityTier?: "reliable" | "risky" | "caution" | "unknown" | null;
  /** Calibrated thresholds from trust dashboard. */
  readonly calibratedThresholds?: import("./confidence-scoring.js").CalibratedThresholds;
  /** Context gate inclusion log from the active run. */
  readonly contextInclusionLog?: readonly string[];
  /**
   * Trust-regression alert snapshot from the coordinator detector.
   * Pass null when no alert is active. The coordinator passes this
   * in so the receipt carries the same snapshot as the WebSocket
   * event and survives page reloads / process restarts.
   */
  readonly trustRegressionAlert?: TrustRegressionAlert | null;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Build a human-readable summary for a completed run. Pure
 * function — every input comes from the receipt or the
 * coordinator's immediate context.
 */
export function generateRunSummary(input: RunSummaryInput): RunSummary {
  const { receipt, userPrompt } = input;

  const classificationResult = classifyExecution(receipt);

  // Extract real verification/execution signals from the receipt to
  // feed into confidence scoring. Without this, the scorer falls back
  // to generic baseline values and confidence is systematically
  // overstated for multi-file runs.
  const vReceipt = receipt.verificationReceipt;
  const changedFiles = resolveChangesList(input);
  const verificationCoverageRatio = vReceipt?.coverageRatio ?? undefined;
  const validationDepthRatio = vReceipt?.validatedRatio ?? undefined;
  const filesWithActiveErrors = vReceipt?.fileCoverage
    ? vReceipt.fileCoverage.filter((f) => f.hasActiveErrors).length
    : undefined;

  // Wave completion: count waves that passed vs total
  const waveReceipts = receipt.waveVerifications ?? [];
  const waveCompletionRatio = waveReceipts.length > 0
    ? waveReceipts.filter((w) => w.verdict === "pass" || w.verdict === "pass-with-warnings").length / waveReceipts.length
    : undefined;
  const wavesHalted = waveReceipts.some((w) => w.verdict === "fail");

  // Manifest completion: use git diff confirmation ratio when available
  // (it measures actual file-level truth), otherwise fall back to graph
  // node completion (weaker signal — counts task nodes, not files).
  let manifestCompletionRatio: number | undefined;
  if (typeof input.gitDiffConfirmationRatio === "number") {
    // Git diff confirmation is the most trustworthy manifest signal —
    // it measures which declared files actually changed on disk.
    manifestCompletionRatio = input.gitDiffConfirmationRatio;
  } else {
    const graphSummary = receipt.graphSummary;
    const totalNodes = graphSummary?.totalNodes ?? 0;
    const completedNodes = graphSummary?.completed ?? 0;
    manifestCompletionRatio = totalNodes > 0 ? completedNodes / totalNodes : undefined;
  }

  // Sensitive/critical file counts from evidence
  const filesTouched = changedFiles.length;
  const repoReadiness = assessRepoReadiness({
    projectRoot: input.projectRoot ?? process.cwd(),
    changedFiles: changedFiles.map((change) => change.path),
    verificationReceipt: vReceipt ?? null,
  });

  const rawConfidence = scoreRunConfidence({
    receipt,
    scopeClassification: input.scopeClassification ?? null,
    averageWorkerConfidence: input.averageWorkerConfidence,
    filesTouched,
    verificationCoverageRatio,
    waveCompletionRatio,
    manifestCompletionRatio,
    wavesHalted,
    validationDepthRatio,
    filesWithActiveErrors,
    gitDiffConfirmationRatio: input.gitDiffConfirmationRatio,
    undeclaredChangesCount: input.gitDiffResult?.undeclaredChanges.length,
    expectedButUnchangedCount: input.gitDiffResult?.expectedButUnchanged.length,
    repoReadinessPenalty: repoReadiness.confidencePenalty,
    evaluation: receipt.evaluation,
    strictMode: input.strictMode,
    calibratedThresholds: input.calibratedThresholds,
  });

  // Apply historical confidence dampening from pattern memory.
  // When a task type has been repeatedly overconfident, dampen the
  // score so future runs for the same pattern are more conservative.
  const dampening = input.confidenceDampening ?? 1.0;
  const confidence: ConfidenceBreakdown = dampening < 1.0
    ? applyDampening(rawConfidence, dampening)
    : rawConfidence;

  const whatChanged = changedFiles;
  const blastRadius = estimateBlastRadius({
    scopeClassification: input.scopeClassification ?? null,
    charterFileCount: input.changes?.length ?? receipt.executionEvidence?.filter((e) => isFileEvidence(e.kind)).length ?? 0,
    prompt: userPrompt,
  });

  const cost = resolveCost(receipt);
  const verification = receipt.verificationReceipt?.verdict ?? "not-run";

  // verificationChecks: prefer receipt.verificationReceipt.checks (the
  // rich VerificationCheckResult[] populated when explicit lint/
  // typecheck/tests hooks ran). Fall back to a derivation from
  // receipt.verificationReceipt.stages when checks is empty so the
  // summary reflects passive stages too (diff-check, contract-check,
  // cross-file-check, typecheck, custom-hook). Pre-fix the summary
  // showed "Checks run: " for runs that had stages but no hooks
  // configured. f2ee019 attempted this but reached for
  // receipt.verificationResults.final.stages, which only exists on
  // PersistentRunReceipt, not the in-memory RunReceipt — the fallback
  // compiled (tsc emits despite TS2339) but the field was always
  // undefined at runtime so the fallback never fired. Stages live on
  // the same VerificationReceipt the existing `checks` field comes
  // from, so the corrected lookup is one level shallower.
  const receiptChecks = receipt.verificationReceipt?.checks ?? [];
  const verificationChecks = receiptChecks.length > 0
    ? receiptChecks
    : (receipt.verificationReceipt?.stages ?? []).map((stage) => ({
        kind: stage.stage,
        name: stage.name,
        // A stage with a recorded result HAS run — that's the contract
        // of StageResult. Map to the operator-visible "executed" flag.
        executed: true,
        passed: stage.passed,
        // Stage-derived rows aren't part of the requiredChecks contract;
        // VerificationReceipt.requiredChecks lives on the receipt itself
        // (different list, indexed by VerificationCheckKind not stage).
        required: false,
      }));

  // "No verification signal" is a distinct state from pass/fail: the
  // pipeline ran but produced no real evidence — no required checks
  // were configured AND no file was actively validated. Without this
  // distinction a bare repo without lint/typecheck/tests can look
  // like a clean pass.
  const verificationNoSignal = computeVerificationNoSignal(receipt.verificationReceipt ?? null);
  const requiredFiles = unique(input.requiredFiles ?? []);
  const touchedFiles = new Set(changedFiles.map((change) => change.path));
  const missingRequiredFiles = requiredFiles.filter((file) => !touchedFiles.has(file));
  const filesByRole = groupFilesByRole(changedFiles.map((change) => change.path));
  const typeScriptErrors = countTypeScriptErrors(vReceipt);
  const waveSummary = summarizeWaves(receipt);
  const gitDiffConsistency = summarizeGitDiff(input.gitDiffResult);
  const explanationLines = buildExplanationLines({
    filesByRole,
    requiredFiles,
    missingRequiredFiles,
    undeclaredFiles: input.gitDiffResult?.undeclaredChanges ?? [],
    verificationReceipt: vReceipt ?? null,
    typeScriptErrors,
    waveSummary,
    gitDiffConsistency,
    repoReadiness,
    patternWarnings: input.patternWarnings ?? [],
    historicalInsights: input.historicalInsights ?? [],
    strictMode: input.strictMode ?? false,
    confidence,
  });

  const needsExplanation = classificationResult.classification !== "VERIFIED_SUCCESS";
  const failureExplanation = needsExplanation ? explainFailure(receipt) : null;

  const headline = buildHeadline({
    classification: classificationResult.classification,
    whatChanged,
    confidence,
    receipt,
  });

  const narrative = buildNarrative({
    classificationResult,
    whatChanged,
    confidence,
    verification,
    verificationChecks,
    blastRadius,
    cost,
    failureExplanation,
    receipt,
  });

  // Build trust explanation — positive signals that explain WHY this
  // result can be trusted (or why it shouldn't be).
  const trustExplanation: string[] = [];
  if (confidence.overall >= 0.85) trustExplanation.push("High overall confidence (" + Math.round(confidence.overall * 100) + "%)");
  if (verification === "pass" && !verificationNoSignal) trustExplanation.push("All verification checks passed");
  if (verificationNoSignal) trustExplanation.push("NO VERIFICATION SIGNAL — no required checks or active validation ran; do not treat as a clean pass");
  if (vReceipt?.coverageRatio != null && vReceipt.coverageRatio >= 0.8) trustExplanation.push("Broad verification coverage (" + Math.round(vReceipt.coverageRatio * 100) + "%)");
  if (vReceipt?.validatedRatio != null && vReceipt.validatedRatio >= 0.6) trustExplanation.push("Deep validation (" + Math.round(vReceipt.validatedRatio * 100) + "% of files actively checked)");
  if (input.gitDiffConfirmationRatio != null && input.gitDiffConfirmationRatio >= 0.9) trustExplanation.push("Git diff fully confirms manifest");
  if (input.strictMode) trustExplanation.push("Strict mode active — extra verification");
  if (input.confidenceDampening != null && input.confidenceDampening < 1.0) trustExplanation.push("Historical dampening applied (" + Math.round(input.confidenceDampening * 100) + "%) — adjusted for past overconfidence");
  if (input.historicalReliabilityTier === "reliable") trustExplanation.push("Task archetype historically reliable");
  if (repoReadiness.level === "normal") trustExplanation.push("Repo in normal state — no readiness issues");
  if (confidence.overall < 0.5) trustExplanation.push("LOW confidence — manual review strongly recommended");
  if (verification === "fail") trustExplanation.push("VERIFICATION FAILED — do not trust without review");
  if (receipt.evaluation?.disagreement?.direction === "aedis-overconfident") trustExplanation.push("Crucibulum disagrees — Aedis was overconfident");
  if (receipt.evaluation?.aggregate?.overallPass === true) trustExplanation.push("External evaluation passed (Crucibulum)");

  return {
    classification: classificationResult.classification,
    classificationReason: classificationResult.reason,
    classificationReasonCode: classificationResult.reasonCode,
    headline,
    narrative,
    whatWasAttempted: userPrompt.trim() || "(no prompt recorded)",
    whatChanged,
    filesTouchedCount: whatChanged.length,
    verification,
    verificationChecks,
    explanationLines,
    explanationDetails: {
      filesByRole,
      requiredFilesModified: missingRequiredFiles.length === 0,
      missingRequiredFiles,
      undeclaredFiles: input.gitDiffResult?.undeclaredChanges ?? [],
      verificationCoverageRatio: vReceipt?.coverageRatio ?? null,
      validatedRatio: vReceipt?.validatedRatio ?? null,
      typeScriptErrors,
      waveSummary,
      gitDiffConsistency,
      repoReadiness,
      patternWarnings: [...(input.patternWarnings ?? [])],
    },
    blastRadius,
    confidence,
    cost,
    failureExplanation,
    factors: classificationResult.factors,

    // First-class trust instrumentation — no heuristic extraction needed
    gitDiffConfirmationRatio: input.gitDiffConfirmationRatio ?? null,
    strictModeEnabled: input.strictMode ?? false,
    confidenceDampeningApplied: dampening,
    historicalReliabilityTier: input.historicalReliabilityTier ?? null,
    evaluationAlignmentStatus: receipt.evaluation?.disagreement?.direction ?? null,
    overconfidenceFlag: (
      confidence.overall >= 0.7 &&
      receipt.evaluation?.aggregate?.overallPass === false
    ),
    trustExplanation,
    contextInclusionLog: input.contextInclusionLog ?? [],
    calibrationState: input.calibratedThresholds?.state ?? "insufficient_data",
    calibrationEvaluatedRuns: input.calibratedThresholds?.evaluatedRuns ?? 0,
    verificationNoSignal,
    trustRegressionAlert: input.trustRegressionAlert ?? null,
  };
}

// ─── Narrative assembly ─────────────────────────────────────────────

function buildHeadline(input: {
  classification: ExecutionClassification;
  whatChanged: readonly FileChangeSummary[];
  confidence: ConfidenceBreakdown;
  receipt: RunReceipt;
}): string {
  const { classification, whatChanged, confidence } = input;
  const fileCount = whatChanged.length;
  const percent = Math.round(confidence.overall * 100);
  const sha = input.receipt.commitSha ? ` (${input.receipt.commitSha.slice(0, 8)})` : "";

  switch (classification) {
    case "VERIFIED_SUCCESS":
      return `Aedis updated ${fileCount} file${plural(fileCount)} and all changes passed verification. Confidence: ${percent}%${sha}.`;
    case "PARTIAL_SUCCESS":
      return `Aedis updated ${fileCount} file${plural(fileCount)} but some checks raised warnings. Confidence: ${percent}%${sha}.`;
    case "NO_OP":
      return `Aedis did not change any files. Confidence: ${percent}%.`;
    case "FAILED":
      return `Aedis failed to complete the task. Confidence: ${percent}%.`;
  }
}

function buildNarrative(input: {
  classificationResult: ExecutionClassificationResult;
  whatChanged: readonly FileChangeSummary[];
  confidence: ConfidenceBreakdown;
  verification: "pass" | "fail" | "pass-with-warnings" | "not-run";
  verificationChecks: readonly {
    kind: string;
    executed: boolean;
    passed: boolean;
  }[];
  blastRadius: BlastRadiusEstimate;
  cost: RunCostSummary;
  failureExplanation: FailureExplanation | null;
  receipt: RunReceipt;
}): string {
  const {
    classificationResult,
    whatChanged,
    confidence,
    verification,
    verificationChecks,
    blastRadius,
    cost,
    failureExplanation,
  } = input;

  const percent = Math.round(confidence.overall * 100);
  const lines: string[] = [];

  switch (classificationResult.classification) {
    case "VERIFIED_SUCCESS": {
      const created = whatChanged.filter((c) => c.operation === "create");
      const modified = whatChanged.filter((c) => c.operation === "modify");
      const deleted = whatChanged.filter((c) => c.operation === "delete");
      const parts: string[] = [];
      if (created.length > 0) parts.push(`created ${listFiles(created, 3)}`);
      if (modified.length > 0) parts.push(`modified ${listFiles(modified, 3)}`);
      if (deleted.length > 0) parts.push(`deleted ${listFiles(deleted, 3)}`);
      const changeSentence = parts.length > 0
        ? `Aedis ${parts.join(", ")}.`
        : `Aedis produced ${whatChanged.length} change(s).`;
      lines.push(changeSentence);
      if (verification === "pass") {
        lines.push("All changes passed verification.");
      } else if (verification === "pass-with-warnings") {
        lines.push("Verification passed with advisory warnings.");
      }
      if (verificationChecks.length > 0) {
        lines.push(`Checks run: ${verificationChecks.map((check) => `${check.kind}=${check.executed ? (check.passed ? "pass" : "fail") : "missing"}`).join(", ")}.`);
      }
      lines.push(`Blast radius was ${blastRadius.level} (${blastRadius.rationale}).`);
      lines.push(`Cost: ${cost.displayUsd} across ${cost.inputTokens + cost.outputTokens} tokens.`);
      lines.push(`Confidence: ${percent}%.`);
      break;
    }

    case "PARTIAL_SUCCESS": {
      lines.push(`Aedis applied ${whatChanged.length} change${plural(whatChanged.length)} but not every gate was clean.`);
      lines.push(classificationResult.reason + ".");
      if (failureExplanation) {
        lines.push(`Most likely cause: ${failureExplanation.rootCause}`);
        lines.push(`Suggested next step: ${failureExplanation.suggestedFix}`);
      }
      if (verificationChecks.length > 0) {
        lines.push(`Checks run: ${verificationChecks.map((check) => `${check.kind}=${check.executed ? (check.passed ? "pass" : "fail") : "missing"}`).join(", ")}.`);
      }
      lines.push(`Blast radius was ${blastRadius.level}. Cost: ${cost.displayUsd}. Confidence: ${percent}%.`);
      break;
    }

    case "NO_OP": {
      lines.push("Aedis finished without producing any real changes.");
      lines.push(classificationResult.reason + ".");
      if (failureExplanation) {
        lines.push(`Most likely cause: ${failureExplanation.rootCause}`);
        lines.push(`Suggested next step: ${failureExplanation.suggestedFix}`);
      }
      if (verificationChecks.length > 0) {
        lines.push(`Checks run: ${verificationChecks.map((check) => `${check.kind}=${check.executed ? (check.passed ? "pass" : "fail") : "missing"}`).join(", ")}.`);
      }
      lines.push(`Blast radius was projected as ${blastRadius.level}. Cost: ${cost.displayUsd}. Confidence: ${percent}%.`);
      break;
    }

    case "FAILED": {
      lines.push(`Aedis failed the task. ${classificationResult.reason}.`);
      if (failureExplanation) {
        lines.push(`Root cause (${failureExplanation.stage} stage): ${failureExplanation.rootCause}`);
        lines.push(`Suggested next step: ${failureExplanation.suggestedFix}`);
      }
      if (verificationChecks.length > 0) {
        lines.push(`Checks run: ${verificationChecks.map((check) => `${check.kind}=${check.executed ? (check.passed ? "pass" : "fail") : "missing"}`).join(", ")}.`);
      }
      lines.push(`Projected blast radius was ${blastRadius.level}. Cost: ${cost.displayUsd}. Confidence: ${percent}%.`);
      break;
    }
  }

  return lines.join(" ");
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * A verification receipt has "no signal" when:
 *   - no required checks are configured, AND
 *   - no file reached "validated" depth (active tool-based checks).
 *
 * In that state the run must not be labeled as a clean pass — the
 * verification pipeline had nothing of substance to evaluate.
 */
function computeVerificationNoSignal(
  vr: { checks?: readonly { executed: boolean; passed: boolean; required: boolean }[]; validatedRatio?: number | null } | null,
): boolean {
  if (!vr) return true;
  const hasRequired = (vr.checks ?? []).some((c) => c.required);
  const hasActiveValidation = typeof vr.validatedRatio === "number" && vr.validatedRatio > 0;
  const anyCheckExecuted = (vr.checks ?? []).some((c) => c.executed);
  return !hasRequired && !hasActiveValidation && !anyCheckExecuted;
}

function resolveChangesList(input: RunSummaryInput): FileChangeSummary[] {
  if (input.changes && input.changes.length > 0) {
    return input.changes.map((c) => ({ path: c.path, operation: c.operation }));
  }
  // Fall back to executionEvidence — each file_* evidence item has
  // a ref=path. We reconstruct the operation from the evidence kind.
  const fromEvidence: FileChangeSummary[] = [];
  const seen = new Set<string>();
  for (const e of input.receipt.executionEvidence ?? []) {
    if (!isFileEvidence(e.kind)) continue;
    const op: FileChangeSummary["operation"] =
      e.kind === "file_created"
        ? "create"
        : e.kind === "file_deleted"
          ? "delete"
          : "modify";
    const key = `${op}:${e.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fromEvidence.push({ path: e.ref, operation: op });
  }
  // Also fall back to executionReceipts if evidence is sparse
  if (fromEvidence.length === 0) {
    for (const r of input.receipt.executionReceipts ?? []) {
      for (const tf of r.filesTouched) {
        if (tf.operation === "read") continue;
        const key = `${tf.operation}:${tf.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fromEvidence.push({ path: tf.path, operation: tf.operation });
      }
    }
  }
  return fromEvidence;
}

function groupFilesByRole(files: readonly string[]): Readonly<Record<"types" | "implementation" | "integration" | "tests", readonly string[]>> {
  const groups = {
    types: [] as string[],
    implementation: [] as string[],
    integration: [] as string[],
    tests: [] as string[],
  };

  for (const file of files) {
    if (/\.(test|spec)\.[jt]sx?$/.test(file) || /__tests__/.test(file)) {
      groups.tests.push(file);
    } else if (/\.d\.ts$/.test(file) || /\/types?\//.test(file)) {
      groups.types.push(file);
    } else if (/^package\.json$|^tsconfig.*\.json$|^jest\.config|^vite\.config|^next\.config|\/index\.[jt]sx?$|\/routes?\//.test(file)) {
      groups.integration.push(file);
    } else {
      groups.implementation.push(file);
    }
  }

  return groups;
}

function countTypeScriptErrors(receipt: RunReceipt["verificationReceipt"]): number {
  if (!receipt) return 0;
  return receipt.allIssues.filter((issue) =>
    issue.stage === "typecheck" && (issue.severity === "error" || issue.severity === "blocker"),
  ).length;
}

function summarizeWaves(receipt: RunReceipt): string | null {
  if (!receipt.waveVerifications || receipt.waveVerifications.length === 0) return null;
  const total = receipt.waveVerifications.length;
  const passed = receipt.waveVerifications.filter((w) => w.verdict !== "fail").length;
  const failed = total - passed;
  const halted = receipt.waveVerifications.some((w) => w.verdict === "fail");
  // Check ordering — intermediate-authority receipts imply per-wave execution happened in order
  const ordered = receipt.waveVerifications.every((w) => w.authority === "intermediate" || !w.authority);
  const parts: string[] = [`${passed}/${total} completed`];
  if (halted) parts.push(`${failed} halted`);
  else parts.push("no halts");
  if (ordered) parts.push("ordering respected");
  return parts.join(", ");
}

function summarizeGitDiff(result?: GitDiffResult | null): string {
  if (!result) return "not verified";
  if (result.passed) return `fully matched manifest`;
  const parts: string[] = [];
  if (result.expectedButUnchanged.length > 0) {
    parts.push(`${result.expectedButUnchanged.length} expected but unchanged`);
  }
  if (result.undeclaredChanges.length > 0) {
    parts.push(`${result.undeclaredChanges.length} undeclared`);
  }
  return `mismatch detected — ${parts.join(", ")}`;
}

function buildExplanationLines(input: {
  filesByRole: Readonly<Record<"types" | "implementation" | "integration" | "tests", readonly string[]>>;
  requiredFiles: readonly string[];
  missingRequiredFiles: readonly string[];
  undeclaredFiles: readonly string[];
  verificationReceipt: RunReceipt["verificationReceipt"];
  typeScriptErrors: number;
  waveSummary: string | null;
  gitDiffConsistency: string;
  repoReadiness: RepoReadinessAssessment;
  patternWarnings: readonly string[];
  historicalInsights: readonly string[];
  strictMode: boolean;
  confidence?: ConfidenceBreakdown;
}): string[] {
  const lines: string[] = [];

  // Line 1 — Scope: total files + role breakdown
  const totalFiles =
    input.filesByRole.types.length +
    input.filesByRole.implementation.length +
    input.filesByRole.integration.length +
    input.filesByRole.tests.length;
  const roleParts = ([
    ["types", input.filesByRole.types],
    ["implementation", input.filesByRole.implementation],
    ["integration", input.filesByRole.integration],
    ["tests", input.filesByRole.tests],
  ] as const)
    .filter(([, files]) => files.length > 0)
    .map(([label]) => label);
  lines.push(
    totalFiles > 0
      ? `Updated ${totalFiles} file${plural(totalFiles)} across ${roleParts.join(", ")}`
      : "No file changes recorded",
  );

  // Line 2 — Manifest: required + undeclared
  const requiredOk = input.requiredFiles.length === 0 || input.missingRequiredFiles.length === 0;
  const undeclaredOk = input.undeclaredFiles.length === 0;
  if (requiredOk && undeclaredOk) {
    lines.push(
      input.requiredFiles.length > 0
        ? `All ${input.requiredFiles.length} required files completed; no undeclared changes`
        : "No undeclared changes",
    );
  } else {
    const parts: string[] = [];
    if (!requiredOk) parts.push(`${input.missingRequiredFiles.length}/${input.requiredFiles.length} required files missing`);
    if (!undeclaredOk) parts.push(`${input.undeclaredFiles.length} undeclared change${plural(input.undeclaredFiles.length)}`);
    lines.push(parts.join("; "));
  }

  // Line 3 — Verification: coverage, validated, TS errors
  const coverage = input.verificationReceipt?.coverageRatio;
  const validated = input.verificationReceipt?.validatedRatio;
  const fileCovCount = input.verificationReceipt?.fileCoverage?.length ?? 0;
  const validatedCount = input.verificationReceipt?.fileCoverage?.filter((f) => f.depth === "validated").length ?? 0;
  const coveragePart = typeof coverage === "number" && fileCovCount > 0
    ? `${fileCovCount}/${fileCovCount} covered`
    : `coverage ${formatPct(coverage)}`;
  const validatedPart = typeof validated === "number" && fileCovCount > 0
    ? `${validatedCount} validated`
    : `validated ${formatPct(validated)}`;
  const tsErrorPart = input.typeScriptErrors > 0
    ? `${input.typeScriptErrors} type error${plural(input.typeScriptErrors)}`
    : "no type errors";
  lines.push(`Verification: ${coveragePart}, ${validatedPart}, ${tsErrorPart}`);

  // Line 4 — Waves (if applicable)
  if (input.waveSummary) {
    lines.push(`Waves: ${input.waveSummary}`);
  }

  // Line 5 — Git diff
  lines.push(`Git diff: ${input.gitDiffConsistency}`);

  // Line 6 — Final verdict
  if (input.confidence) {
    const decision = input.confidence.decision;
    const coherenceLabel =
      decision === "apply" || decision === "review" ? "coherent change" :
      decision === "escalate" ? "partial coherence" :
      "blocked";
    const actionLabel =
      decision === "apply" ? "safe for apply" :
      decision === "review" ? "review required" :
      decision === "escalate" ? "escalation recommended" :
      "not safe for apply";
    lines.push(`Result: ${coherenceLabel} — ${actionLabel}`);
  }

  // Historical insights and warnings — inject the most relevant
  // signals as compact note lines. Historical insights take priority
  // over generic warnings because they carry real outcome data.
  const notes: string[] = [
    ...input.historicalInsights.slice(0, 1),
    ...(input.strictMode ? ["strict mode active"] : []),
    ...input.repoReadiness.warnings.slice(0, 1),
    ...input.patternWarnings.slice(0, 1),
  ];
  // Only add notes if we have room (cap at 6 lines total)
  for (const note of notes) {
    if (lines.length >= 6) break;
    lines.push(`Note: ${note}`);
  }

  return lines.slice(0, 6);
}

function formatPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function resolveCost(receipt: RunReceipt): RunCostSummary {
  const c = receipt.totalCost ?? { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const estimatedCostUsd = Number(c.estimatedCostUsd || 0);
  const displayUsd = `$${estimatedCostUsd.toFixed(estimatedCostUsd < 0.01 ? 4 : 2)}`;
  return {
    model: String(c.model || "unknown"),
    inputTokens: Number(c.inputTokens || 0),
    outputTokens: Number(c.outputTokens || 0),
    estimatedCostUsd,
    displayUsd,
  };
}

function isFileEvidence(kind: ExecutionEvidence["kind"]): boolean {
  return kind === "file_created" || kind === "file_modified" || kind === "file_deleted";
}

function listFiles(items: readonly FileChangeSummary[], max: number): string {
  const slice = items.slice(0, max).map((i) => i.path);
  if (items.length > max) slice.push(`+${items.length - max} more`);
  return slice.join(", ");
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/**
 * Apply historical confidence dampening. Creates a new breakdown with
 * the overall score reduced by the dampening factor, re-derives the
 * decision, and appends a basis entry explaining the adjustment.
 */
function applyDampening(
  base: ConfidenceBreakdown,
  factor: number,
): ConfidenceBreakdown {
  const dampened = Math.max(0, Math.min(1, base.overall * factor));
  const delta = base.overall - dampened;
  if (delta < 0.005) return base; // negligible — skip

  const decision: ConfidenceBreakdown["decision"] =
    dampened >= 0.85 ? "apply" :
    dampened >= 0.70 ? "review" :
    dampened >= 0.50 ? "escalate" :
    "reject";
  const pct = (dampened * 100).toFixed(0);
  const reason =
    decision === "apply" ? `High confidence (${pct}%) — apply candidate` :
    decision === "review" ? `Moderate confidence (${pct}%) — human review recommended (history-dampened)` :
    decision === "escalate" ? `Low confidence (${pct}%) — escalation recommended (history-dampened)` :
    `Very low confidence (${pct}%) — reject (history-dampened)`;

  return {
    ...base,
    overall: dampened,
    decision,
    reason,
    penalties: [...base.penalties, `historical overconfidence dampening (×${factor.toFixed(2)}) → -${delta.toFixed(2)}`],
    basis: [...base.basis, `learning:history dampening ×${factor.toFixed(2)} → overall ${base.overall.toFixed(2)} → ${dampened.toFixed(2)}`],
  };
}

// Re-export so coordinator only imports this module.
export type { ExecutionClassification, ExecutionReceipt, FailureExplanation, BlastRadiusEstimate, ConfidenceBreakdown };
