/**
 * VerificationPipeline — Post-apply repo-level verification.
 *
 * RESPONSIBILITY: The Verifier evaluates the REPO STATE after changes
 * are applied. It answers "is the repo healthy after this change?"
 *
 * This is distinct from the Critic, which evaluates the PROPOSED DIFF
 * before apply. The Critic answers "is this diff good?" — the Verifier
 * answers "did applying it break anything?"
 *
 * Stages:
 *   1. Diff check — validate change structure and format
 *   2. Contract check — verify interface/type contracts
 *   3. Cross-file check — delegate to IntegrationJudge
 *   4. Lint/typecheck hooks — run external tooling
 *   5. Test baseline comparison — detect new test failures
 *   6. Confidence scoring — aggregate results into a score
 *   7. Receipt generation — produce pass/fail audit receipt
 *
 * Baseline test snapshots:
 *   captureBaseline() runs tests BEFORE execution and stores results.
 *   After execution, verify() runs tests again and compares:
 *     - New failures → FAIL (the change broke something)
 *     - Same failures → IGNORE (pre-existing, not our fault)
 *     - Fewer failures → POSITIVE SIGNAL (change fixed something)
 */

import { randomUUID } from "crypto";
import type { IntentObject } from "./intent.js";
import type { RunState } from "./runstate.js";
import type { FileChange, WorkerResult } from "../workers/base.js";
import {
  IntegrationJudge,
  type JudgmentReport,
  type IntegrationJudgeConfig,
} from "./integration-judge.js";
import type { ChangeSet } from "./change-set.js";
import type { PlanWave } from "./multi-file-planner.js";

// ─── Stage Types ─────────────────────────────────────────────────────

export type VerificationStage =
  | "diff-check"
  | "contract-check"
  | "cross-file-check"
  | "lint"
  | "typecheck"
  | "custom-hook"
  | "confidence-scoring";

export interface StageResult {
  readonly stage: VerificationStage;
  readonly name: string;
  readonly passed: boolean;
  readonly score: number; // 0-1
  readonly issues: readonly VerificationIssue[];
  readonly durationMs: number;
  readonly details: string;
}

export interface VerificationIssue {
  readonly stage: VerificationStage;
  readonly severity: "info" | "warning" | "error" | "blocker";
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly rule?: string;
}

// ─── Verification Receipt ────────────────────────────────────────────

/**
 * Verification depth levels for per-file coverage.
 *
 * "checked" = structural/syntactic examination only (diff-check,
 *   contract-check). These verify the change is well-formed but
 *   don't execute external tools against the file.
 *
 * "validated" = active tool-based verification (typecheck, lint,
 *   tests, custom hooks). These run real compilers/linters against
 *   the file and provide much stronger trust signal.
 *
 * The confidence scorer should penalize files that were only
 * "checked" but not "validated" — passive checks alone don't
 * catch runtime or semantic errors.
 */
export type VerificationDepth = "none" | "checked" | "validated";

/** Stages that provide passive/structural checks only. */
const PASSIVE_STAGES: ReadonlySet<VerificationStage> = new Set([
  "diff-check", "contract-check", "cross-file-check",
]);

/** Stages that provide active/tool-based validation. */
const ACTIVE_STAGES: ReadonlySet<VerificationStage> = new Set([
  "lint", "typecheck", "custom-hook",
]);

/**
 * Per-file verification coverage: tracks which verification stages
 * actually examined each file. Enables the confidence scorer to
 * penalize runs where verification was shallow relative to the
 * change manifest.
 */
export interface FileVerificationCoverage {
  readonly path: string;
  /** Stages that produced at least one issue (pass or fail) for this file. */
  readonly verifiedByStages: readonly VerificationStage[];
  /** True if the file was examined by at least one substantive stage. */
  readonly verified: boolean;
  /**
   * Depth of verification for this file:
   *   - "none"      — no stage examined this file
   *   - "checked"   — only structural/passive stages (diff, contract, cross-file)
   *   - "validated"  — at least one active stage (lint, typecheck, tests)
   */
  readonly depth: VerificationDepth;
  /**
   * True if this file had errors in any active validation stage.
   * Used by confidence scoring to mark specific files as failing.
   */
  readonly hasActiveErrors: boolean;
}

export interface VerificationReceipt {
  readonly id: string;
  readonly runId: string;
  readonly intentId: string;
  readonly timestamp: string;

  /** Overall verdict */
  readonly verdict: "pass" | "fail" | "pass-with-warnings";
  /** Aggregate confidence score 0-1 */
  readonly confidenceScore: number;
  /** Results from each stage */
  readonly stages: readonly StageResult[];
  /** IntegrationJudge report (cross-file check) */
  readonly judgmentReport: JudgmentReport | null;
  /** All issues across all stages */
  readonly allIssues: readonly VerificationIssue[];
  /** Blocking issues only */
  readonly blockers: readonly VerificationIssue[];
  /** Required verification checks expected for this run. */
  readonly requiredChecks: readonly VerificationCheckKind[];
  /** Checks that actually executed or were missing. */
  readonly checks: readonly VerificationCheckResult[];
  /** Summary for logging/UI */
  readonly summary: string;
  /** Total verification time */
  readonly totalDurationMs: number;
  /**
   * Optional scope tag describing what slice of the change-set this
   * receipt verified:
   *   - undefined → legacy/full verification (all changes, single pass)
   *   - `{kind: "change-set"}` → the entire accepted change-set
   *   - `{kind: "wave", waveId}` → one wave of the multi-file plan
   * The Coordinator uses this so a failure can be attributed back to
   * the wave that produced it.
   */
  readonly scope?:
    | { readonly kind: "change-set"; readonly fileCount: number }
    | { readonly kind: "wave"; readonly waveId: number; readonly waveName: string; readonly fileCount: number };
  /**
   * Per-file verification coverage matrix. Shows which files were
   * actually examined by which stages. Null for legacy runs that
   * pre-date this field. The confidence scorer uses the coverage
   * ratio to penalize shallow verification.
   */
  readonly fileCoverage: readonly FileVerificationCoverage[] | null;
  /**
   * Ratio of changed files that were verified by at least one
   * substantive stage. 0-1. Null for legacy runs.
   */
  readonly coverageRatio: number | null;
  /**
   * Ratio of changed files that were actively validated (lint,
   * typecheck, tests) vs only passively checked (diff, contract).
   * A high coverageRatio but low validatedRatio means verification
   * was shallow — structural checks passed but no tooling confirmed
   * correctness. Null for legacy runs.
   */
  readonly validatedRatio: number | null;
  /**
   * Verification authority level:
   *   - "final" — this is the authoritative verification for the run.
   *     Only one receipt per run should be "final". The merge gate
   *     uses this as the primary verification signal.
   *   - "intermediate" — per-wave or checkpoint verification. Findings
   *     are supplementary — they feed into the merge gate as additional
   *     findings but cannot override the final receipt's verdict.
   * Defaults to "final" for backwards compatibility.
   */
  readonly authority?: "final" | "intermediate";
}

// ─── Hook Types ──────────────────────────────────────────────────────

export type VerificationCheckKind = "lint" | "typecheck" | "tests";

export interface VerificationCheckResult {
  readonly kind: VerificationCheckKind;
  readonly name: string;
  readonly required: boolean;
  readonly executed: boolean;
  readonly passed: boolean;
  readonly details: string;
}

// ─── Baseline Test Snapshot ──────────────────────────────────────────

/**
 * Snapshot of test results captured BEFORE execution begins.
 * Used by verify() to distinguish pre-existing failures from
 * new regressions introduced by the builder.
 */
export interface TestBaseline {
  readonly capturedAt: string;
  readonly totalTests: number;
  readonly failedTests: number;
  /** Names/identifiers of tests that were already failing. */
  readonly failingTestNames: readonly string[];
  /** Raw hook result for audit trail. */
  readonly hookResult: ToolHookResult | null;
}

export interface BaselineComparison {
  readonly newFailures: readonly string[];
  readonly fixedTests: readonly string[];
  readonly preExistingFailures: readonly string[];
  readonly signal: "positive" | "neutral" | "negative";
}

/**
 * A ToolHook runs an external tool (lint, typecheck, test) against
 * the changeset and returns structured results.
 */
export interface ToolHook {
  readonly name: string;
  readonly stage: VerificationStage;
  readonly kind?: VerificationCheckKind;
  /** Execute the hook. Receives changed file paths. */
  execute(changedFiles: string[]): Promise<ToolHookResult>;
}

export interface ToolHookResult {
  readonly passed: boolean;
  readonly issues: readonly VerificationIssue[];
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

// ─── Configuration ───────────────────────────────────────────────────

export interface VerificationPipelineConfig {
  /** Minimum confidence score to pass */
  minimumConfidence: number;
  /** Whether to run all stages even if an early one fails */
  runAllStages: boolean;
  /** Maximum total time for verification (ms) */
  timeoutMs: number;
  /** Registered tool hooks (lint, typecheck, etc.) */
  hooks: ToolHook[];
  /** Checks that must exist and execute before verification can pass. */
  requiredChecks: VerificationCheckKind[];
  /** Strict mode requires full changed-file verification and validation. */
  strictMode: boolean;
  /** IntegrationJudge configuration */
  judgeConfig: Partial<IntegrationJudgeConfig>;
  /** Stage weights for confidence scoring */
  stageWeights: Partial<Record<VerificationStage, number>>;
}

const DEFAULT_CONFIG: VerificationPipelineConfig = {
  minimumConfidence: 0.75,
  runAllStages: true,
  timeoutMs: 120_000,
  hooks: [],
  requiredChecks: ["typecheck", "tests"],
  strictMode: false,
  judgeConfig: {},
  stageWeights: {
    "diff-check": 1.0,
    "contract-check": 1.2,
    "cross-file-check": 1.5,
    "lint": 0.8,
    "typecheck": 1.3,
    "custom-hook": 0.7,
    "confidence-scoring": 0,
  },
};

// ─── Verification Pipeline ───────────────────────────────────────────

export class VerificationPipeline {
  private config: VerificationPipelineConfig;
  private judge: IntegrationJudge;

  constructor(config: Partial<VerificationPipelineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.judge = new IntegrationJudge(this.config.judgeConfig);
  }

  /**
   * Verify the full accepted ChangeSet before final apply/commit.
   *
   * This is the Phase 9 entry point in multi-file runs: every wave has
   * completed, the IntegrationJudge has approved cross-file coherence,
   * and the Coordinator wants one last sanity pass against the entire
   * change-set as a unit — not just an ad-hoc bag of FileChange records.
   *
   * The receipt is tagged with `scope: {kind: "change-set"}` so the
   * MergeGate can distinguish change-set-level failures from file-level
   * ones when building blocking reasons.
   */
  async verifyChangeSet(
    intent: IntentObject,
    runState: RunState,
    changeSet: ChangeSet,
    changes: readonly FileChange[],
    workerResults: readonly WorkerResult[],
    baseline?: TestBaseline | null,
  ): Promise<VerificationReceipt> {
    const scopedFiles = new Set(
      changeSet.filesInScope.map((f) => f.path),
    );
    const scopedChanges =
      scopedFiles.size === 0
        ? changes
        : changes.filter((c) => scopedFiles.has(c.path));

    const receipt = await this.verify(intent, runState, scopedChanges, workerResults, changeSet, baseline);
    return {
      ...receipt,
      scope: { kind: "change-set", fileCount: scopedChanges.length },
      summary: `[change-set] ${receipt.summary}`,
    };
  }

  /**
   * Verify a single wave of a multi-file plan after its builders have
   * completed. The pipeline runs only against the wave's files and
   * attaches the wave id to the receipt so the Coordinator can block
   * downstream waves on the failing one.
   *
   * Contract:
   *   - If the wave contains no changed files, returns a synthetic
   *     "pass" receipt with zero stages (nothing to verify).
   *   - Otherwise the full pipeline runs against the filtered change
   *     set; the IntegrationJudge still sees only the wave's files,
   *     which keeps cross-wave noise out of per-wave findings.
   */
  async verifyWave(
    intent: IntentObject,
    runState: RunState,
    wave: PlanWave,
    changes: readonly FileChange[],
    workerResults: readonly WorkerResult[],
  ): Promise<VerificationReceipt> {
    const waveFiles = new Set(wave.files);
    const waveChanges =
      waveFiles.size === 0
        ? []
        : changes.filter((c) => waveFiles.has(c.path));

    if (waveChanges.length === 0) {
      const now = new Date().toISOString();
      return {
        id: randomUUID(),
        runId: runState.id,
        intentId: intent.id,
        timestamp: now,
        verdict: "pass",
        confidenceScore: 1,
        stages: [],
        judgmentReport: null,
        allIssues: [],
        blockers: [],
        requiredChecks: [],
        checks: [],
        summary: `[wave ${wave.id} ${wave.name}] PASS — no changes to verify`,
        totalDurationMs: 0,
        scope: {
          kind: "wave",
          waveId: wave.id,
          waveName: wave.name,
          fileCount: 0,
        },
        fileCoverage: [],
        coverageRatio: 1,
        validatedRatio: 1,
      };
    }

    const receipt = await this.verify(intent, runState, waveChanges, workerResults);
    return {
      ...receipt,
      scope: {
        kind: "wave",
        waveId: wave.id,
        waveName: wave.name,
        fileCount: waveChanges.length,
      },
      summary: `[wave ${wave.id} ${wave.name}] ${receipt.summary}`,
      authority: "intermediate" as const,
    };
  }

  /**
   * Run the full post-apply verification pipeline against a changeset.
   *
   * RESPONSIBILITY: Evaluates REPO STATE after changes are applied.
   * This is NOT the Critic — the Critic evaluates the proposed diff.
   * The Verifier answers: "did applying this diff break the repo?"
   *
   * When a baseline is provided, test results are compared against it:
   *   - New failures → blocker (change introduced regression)
   *   - Same failures → ignored (pre-existing, not our fault)
   *   - Fewer failures → positive signal logged on receipt
   */
  async verify(
    intent: IntentObject,
    runState: RunState,
    changes: readonly FileChange[],
    workerResults: readonly WorkerResult[],
    changeSet?: ChangeSet | null,
    baseline?: TestBaseline | null,
  ): Promise<VerificationReceipt> {
    const startTime = Date.now();
    const stages: StageResult[] = [];
    const checks: VerificationCheckResult[] = [];
    let aborted = false;

    // Stage 1: Diff check
    const diffResult = this.runDiffCheck(changes);
    stages.push(diffResult);
    if (!diffResult.passed && !this.config.runAllStages) aborted = true;

    // Stage 2: Contract check
    if (!aborted) {
      const contractResult = this.runContractCheck(changes, workerResults);
      stages.push(contractResult);
      if (!contractResult.passed && !this.config.runAllStages) aborted = true;
    }

    // Stage 3: Cross-file check (IntegrationJudge)
    let judgmentReport: JudgmentReport | null = null;
    if (!aborted) {
      const crossFileStart = Date.now();
      judgmentReport = this.judge.judge(intent, runState, changes, workerResults, "pre-apply", changeSet);
      stages.push({
        stage: "cross-file-check",
        name: "Cross-File Coherence",
        passed: judgmentReport.passed,
        score: judgmentReport.coherenceScore,
        issues: [
          ...judgmentReport.blockers.map((b) => ({
            stage: "cross-file-check" as const,
            severity: "blocker" as const,
            message: b.message,
            file: b.files[0],
          })),
          ...judgmentReport.warnings.map((w) => ({
            stage: "cross-file-check" as const,
            severity: "warning" as const,
            message: w.message,
            file: w.files[0],
          })),
        ],
        durationMs: Date.now() - crossFileStart,
        details: judgmentReport.summary,
      });
      if (!judgmentReport.passed && !this.config.runAllStages) aborted = true;
    }

    // Stage 4+: Tool hooks (lint, typecheck, custom)
    if (!aborted) {
      const changedFiles = changes.map((c) => c.path);
      const configuredKinds = new Set(
        this.config.hooks
          .map((hook) => hook.kind)
          .filter((kind): kind is VerificationCheckKind => Boolean(kind)),
      );
      for (const kind of this.config.requiredChecks) {
        if (!configuredKinds.has(kind)) {
          // Required checks fail closed. If a required hook is not
          // configured, verification must block rather than silently
          // degrading into a warning-only path.
          checks.push({
            kind,
            name: this.labelForCheck(kind),
            required: true,
            executed: false,
            passed: false,
            details: `${kind} hook not configured — skipped`,
          });
          stages.push({
            stage: this.stageForCheck(kind),
            name: this.labelForCheck(kind),
            passed: false,
            score: 0,
            issues: [{
              stage: this.stageForCheck(kind),
              severity: "blocker",
              message: `${kind} hook not configured — required verification cannot run`,
            }],
            durationMs: 0,
            details: `${kind} hook not configured — required verification cannot run`,
          });
        }
      }

      for (const hook of this.config.hooks) {
        if (Date.now() - startTime > this.config.timeoutMs) {
          if (hook.kind) {
            checks.push({
              kind: hook.kind,
              name: hook.name,
              required: this.config.requiredChecks.includes(hook.kind),
              executed: true,
              passed: false,
              details: `Verification timed out after ${this.config.timeoutMs}ms`,
            });
          }
          stages.push({
            stage: hook.stage,
            name: hook.name,
            passed: false,
            score: 0,
            issues: [{
              stage: hook.stage,
              severity: "blocker",
              message: `Verification timed out after ${this.config.timeoutMs}ms`,
            }],
            durationMs: 0,
            details: "Timed out",
          });
          break;
        }

        try {
          const hookResult = await hook.execute(changedFiles);
          if (hook.kind) {
            checks.push({
              kind: hook.kind,
              name: hook.name,
              required: this.config.requiredChecks.includes(hook.kind),
              executed: true,
              passed: hookResult.passed,
              details: hookResult.passed
                ? `${hook.name} passed`
                : `${hook.name} failed (exit ${hookResult.exitCode})`,
            });
          }
          stages.push({
            stage: hook.stage,
            name: hook.name,
            passed: hookResult.passed,
            score: hookResult.passed ? 1 : 0,
            issues: hookResult.issues,
            durationMs: hookResult.durationMs,
            details: hookResult.passed
              ? `${hook.name} passed`
              : `${hook.name} failed (exit ${hookResult.exitCode})`,
          });

          if (!hookResult.passed && !this.config.runAllStages) {
            aborted = true;
            break;
          }
        } catch (err) {
          if (hook.kind) {
            checks.push({
              kind: hook.kind,
              name: hook.name,
              required: this.config.requiredChecks.includes(hook.kind),
              executed: true,
              passed: false,
              details: `${hook.name} threw an exception`,
            });
          }
          stages.push({
            stage: hook.stage,
            name: hook.name,
            passed: false,
            score: 0,
            issues: [{
              stage: hook.stage,
              severity: "blocker",
              message: `Hook threw: ${err instanceof Error ? err.message : String(err)}`,
            }],
            durationMs: 0,
            details: `${hook.name} threw an exception`,
          });
          if (!this.config.runAllStages) {
            aborted = true;
            break;
          }
        }
      }
    }

    // ─── Baseline comparison ────────────────────────────────────────
    // Compare post-execution test results against the pre-execution
    // baseline. New failures are blockers; pre-existing failures are
    // ignored; fewer failures are a positive signal.
    let baselineComparison: BaselineComparison | null = null;
    if (baseline && !aborted) {
      baselineComparison = this.compareWithBaseline(baseline, stages);
      console.log(
        `[verification] baseline comparison: signal=${baselineComparison.signal} ` +
        `new=${baselineComparison.newFailures.length} fixed=${baselineComparison.fixedTests.length} ` +
        `preExisting=${baselineComparison.preExistingFailures.length}`,
      );
      // New failures are blockers — the change introduced regressions
      for (const failure of baselineComparison.newFailures) {
        stages.push({
          stage: "custom-hook",
          name: "Baseline Regression",
          passed: false,
          score: 0,
          issues: [{
            stage: "custom-hook",
            severity: "blocker",
            message: `New test failure (not in baseline): ${failure}`,
          }],
          durationMs: 0,
          details: `Regression: ${failure}`,
        });
      }
      // Fixed tests are a positive signal — log but don't affect verdict
      if (baselineComparison.fixedTests.length > 0) {
        console.log(
          `[verification] positive: ${baselineComparison.fixedTests.length} previously-failing test(s) now pass`,
        );
      }
      // Pre-existing failures: downgrade any blockers from test hooks
      // that match baseline failures to INFO (not warnings) so they
      // don't push the verdict from PASS to PASS-WITH-WARNINGS. A
      // baseline-ignored failure is, by definition, not our fault and
      // shouldn't degrade the user-facing verdict — we surface it in
      // the summary line instead.
      for (const stage of stages) {
        if (stage.stage !== "custom-hook") continue;
        const downgraded = stage.issues.map((issue) => {
          if (
            (issue.severity === "blocker" || issue.severity === "error" || issue.severity === "warning") &&
            baseline.failingTestNames.includes(issue.message)
          ) {
            return { ...issue, severity: "info" as const };
          }
          return issue;
        });
        if (downgraded.some((d, i) => d !== stage.issues[i])) {
          // Replace the stage with downgraded issues
          const idx = stages.indexOf(stage);
          if (idx !== -1) {
            (stages as StageResult[])[idx] = {
              ...stage,
              issues: downgraded,
              passed: !downgraded.some((i) => i.severity === "blocker"),
              score: downgraded.some((i) => i.severity === "blocker") ? 0 : 0.8,
            };
          }
        }
      }
    }

    // No-signal fail-closed: when the run produced file changes but
    // zero active-validation stages executed AND no hooks were
    // configured AND no required checks are set, the pipeline has
    // literally nothing to say. A verdict of "pass" under those
    // conditions would be misleading. Emit an explicit blocker so
    // the MergeGate blocks and the trust explanation surfaces
    // "no verification signal" clearly. Must run BEFORE aggregation
    // below so the synthesized blocker counts toward the verdict.
    const activeStagesRan = stages.some(
      (s) => (s.stage === "lint" || s.stage === "typecheck" || s.stage === "custom-hook") && s.passed,
    );
    const anyCheckExecuted = checks.some((c) => c.executed);
    if (
      changes.length > 0 &&
      !activeStagesRan &&
      !anyCheckExecuted &&
      this.config.requiredChecks.length === 0 &&
      this.config.hooks.length === 0
    ) {
      stages.push({
        stage: "custom-hook",
        name: "No-signal guard",
        passed: false,
        score: 0,
        issues: [{
          stage: "custom-hook",
          severity: "blocker",
          message:
            "No verification signal available — no lint/typecheck/tests/custom hooks configured for this repo. " +
            "Configure required checks or opt in explicitly before treating the run as verified.",
        }],
        durationMs: 0,
        details: "no-signal guard",
      });
    }

    // Aggregate
    const totalDurationMs = Date.now() - startTime;
    const allIssues = stages.flatMap((s) => s.issues);
    const blockers = allIssues.filter((i) => i.severity === "blocker");
    const confidenceScore = this.computeConfidence(stages);
    // Required checks fail closed. A check that never ran is itself a
    // verification failure because the run lacks the promised evidence.
    const missingChecks = this.config.requiredChecks.filter(
      (kind) => !checks.some((check) => check.kind === kind && check.executed),
    );

    // ─── File coverage matrix ──────────────────────────────────────
    const changedFilePaths = changes.map((c) => c.path);
    const fileCoverage = this.computeFileCoverage(changedFilePaths, stages);
    const verifiedCount = fileCoverage.filter((fc) => fc.verified).length;
    const validatedCount = fileCoverage.filter((fc) => fc.depth === "validated").length;
    const coverageRatio = changedFilePaths.length > 0
      ? verifiedCount / changedFilePaths.length
      : 1;
    const validatedRatio = changedFilePaths.length > 0
      ? validatedCount / changedFilePaths.length
      : 1;
    const strictFailures = this.strictModeFailures(changedFilePaths, fileCoverage, validatedRatio);
    const verdict: VerificationReceipt["verdict"] =
      blockers.length > 0 || missingChecks.length > 0 || strictFailures.length > 0 || confidenceScore < this.config.minimumConfidence
        ? "fail"
        : allIssues.some((i) => i.severity === "warning")
          ? "pass-with-warnings"
          : "pass";

    const passedStages = stages.filter((s) => s.passed).length;
    const summaryParts = [
      `${verdict.toUpperCase()} — ${passedStages}/${stages.length} stages passed`,
      `confidence ${(confidenceScore * 100).toFixed(0)}%`,
      `${blockers.length} blockers`,
    ];
    if (checks.length > 0) {
      const executedChecks = checks
        .filter((check) => check.executed)
        .map((check) => `${check.kind}:${check.passed ? "pass" : "fail"}`);
      if (executedChecks.length > 0) {
        summaryParts.push(`checks ${executedChecks.join(", ")}`);
      }
    }
    if (missingChecks.length > 0) {
      summaryParts.push(`missing required checks: ${missingChecks.join(", ")}`);
    }

    if (coverageRatio < 1) {
      summaryParts.push(`file coverage ${(coverageRatio * 100).toFixed(0)}%`);
    }
    if (validatedRatio < coverageRatio) {
      summaryParts.push(`active validation ${(validatedRatio * 100).toFixed(0)}%`);
    }

    // Surface files that were changed but only passively checked
    const checkedOnly = fileCoverage.filter((fc) => fc.depth === "checked");
    if (checkedOnly.length > 0 && changedFilePaths.length > 1) {
      summaryParts.push(`${checkedOnly.length} file(s) only structurally checked`);
    }
    if (strictFailures.length > 0) {
      summaryParts.push(`strict mode: ${strictFailures.join("; ")}`);
    }
    if (baselineComparison) {
      if (baselineComparison.signal === "negative") {
        summaryParts.push(`baseline: ${baselineComparison.newFailures.length} new regression(s)`);
      } else if (baselineComparison.signal === "positive") {
        summaryParts.push(`baseline: ${baselineComparison.fixedTests.length} test(s) fixed`);
      } else if (baselineComparison.preExistingFailures.length > 0) {
        summaryParts.push(`baseline: ${baselineComparison.preExistingFailures.length} pre-existing failure(s) ignored`);
      }
    }

    return {
      id: randomUUID(),
      runId: runState.id,
      intentId: intent.id,
      timestamp: new Date().toISOString(),
      verdict,
      confidenceScore,
      stages,
      judgmentReport,
      allIssues,
      blockers,
      requiredChecks: [...this.config.requiredChecks],
      checks,
      summary: summaryParts.join(", "),
      totalDurationMs,
      fileCoverage,
      coverageRatio,
      validatedRatio,
    };
  }

  private labelForCheck(kind: VerificationCheckKind): string {
    switch (kind) {
      case "lint":
        return "Lint";
      case "typecheck":
        return "Typecheck";
      case "tests":
        return "Tests";
    }
  }

  private strictModeFailures(
    changedFiles: readonly string[],
    fileCoverage: readonly FileVerificationCoverage[],
    validatedRatio: number,
  ): string[] {
    if (!this.config.strictMode) return [];
    const failures: string[] = [];
    const unchecked = fileCoverage.filter((file) => !file.verified).map((file) => file.path);
    const checkedOnly = fileCoverage.filter((file) => file.depth === "checked").map((file) => file.path);

    if (unchecked.length > 0) {
      failures.push(`${unchecked.length} file(s) unverified`);
    }
    if (checkedOnly.length > 0) {
      failures.push(`${checkedOnly.length} file(s) only checked`);
    }
    if (changedFiles.length > 0 && validatedRatio < 1) {
      failures.push(`validation depth ${Math.round(validatedRatio * 100)}%`);
    }

    return failures;
  }

  private stageForCheck(kind: VerificationCheckKind): VerificationStage {
    switch (kind) {
      case "lint":
        return "lint";
      case "typecheck":
        return "typecheck";
      case "tests":
        return "custom-hook";
    }
  }

  // ─── File Coverage Matrix ──────────────────────────────────────────

  /**
   * Build per-file verification coverage from stage results. A file
   * is "verified" if at least one substantive stage (diff-check,
   * contract-check, cross-file-check, lint, typecheck) produced an
   * issue referencing it, OR if the stage passed and the file was in
   * the change set (implicit coverage).
   *
   * The confidence scorer uses the resulting coverageRatio to penalize
   * runs where verification was shallow relative to the change manifest.
   */
  private computeFileCoverage(
    changedFiles: readonly string[],
    stages: readonly StageResult[],
  ): FileVerificationCoverage[] {
    const substantiveStages: ReadonlySet<VerificationStage> = new Set([
      "diff-check", "contract-check", "cross-file-check", "lint", "typecheck",
    ]);

    // Build maps: file → set of stages, file → has errors in active stages
    const coverageMap = new Map<string, Set<VerificationStage>>();
    const errorMap = new Map<string, boolean>();
    for (const file of changedFiles) {
      coverageMap.set(file, new Set());
      errorMap.set(file, false);
    }

    for (const stage of stages) {
      if (!substantiveStages.has(stage.stage)) continue;

      // Files explicitly referenced in issues
      for (const issue of stage.issues) {
        if (issue.file && coverageMap.has(issue.file)) {
          coverageMap.get(issue.file)!.add(stage.stage);
          // Track errors in active stages (lint, typecheck, tests)
          if (ACTIVE_STAGES.has(stage.stage) &&
              (issue.severity === "error" || issue.severity === "blocker")) {
            errorMap.set(issue.file, true);
          }
        }
      }

      // If the stage passed, it implicitly verified all files in scope
      // (e.g. diff-check validates every change, typecheck covers the
      // whole project). Baseline-ignored warnings or advisory issues
      // about OTHER files must not deny coverage for the files the
      // Builder actually touched — otherwise a stray warning in an
      // unrelated test file blocks strict-mode validation and the
      // run fails verdict despite all required checks passing.
      if (stage.passed) {
        const hasErrorOnChangedFile = stage.issues.some(
          (i) =>
            (i.severity === "error" || i.severity === "blocker") &&
            i.file && coverageMap.has(i.file),
        );
        if (!hasErrorOnChangedFile) {
          for (const file of changedFiles) {
            coverageMap.get(file)!.add(stage.stage);
          }
        }
      }
    }

    return changedFiles.map((path) => {
      const stageSet = coverageMap.get(path) ?? new Set();
      const hasPassive = [...stageSet].some((s) => PASSIVE_STAGES.has(s));
      const hasActive = [...stageSet].some((s) => ACTIVE_STAGES.has(s));

      let depth: VerificationDepth;
      if (hasActive) {
        depth = "validated";
      } else if (hasPassive) {
        depth = "checked";
      } else {
        depth = "none";
      }

      return {
        path,
        verifiedByStages: [...stageSet],
        verified: stageSet.size > 0,
        depth,
        hasActiveErrors: errorMap.get(path) ?? false,
      };
    });
  }

  // ─── Stage Implementations ────────────────────────────────────────

  /**
   * Diff check: validate change structure and format.
   * - Every modify has a diff or content
   * - Every create has content
   * - No empty diffs
   * - File paths are reasonable
   */
  private runDiffCheck(changes: readonly FileChange[]): StageResult {
    const start = Date.now();
    const issues: VerificationIssue[] = [];

    for (const change of changes) {
      // Structural validation
      if (change.operation === "create" && !change.content) {
        issues.push({
          stage: "diff-check",
          severity: "blocker",
          message: `Create operation for "${change.path}" has no content`,
          file: change.path,
        });
      }

      if (change.operation === "modify" && !change.diff && !change.content) {
        issues.push({
          stage: "diff-check",
          severity: "blocker",
          message: `Modify operation for "${change.path}" has neither diff nor content`,
          file: change.path,
        });
      }

      if (change.operation === "modify" && change.diff && change.diff.trim().length === 0) {
        issues.push({
          stage: "diff-check",
          severity: "warning",
          message: `Empty diff for "${change.path}"`,
          file: change.path,
        });
      }

      // Path validation
      if (change.path.includes("..")) {
        issues.push({
          stage: "diff-check",
          severity: "blocker",
          message: `Path traversal in "${change.path}"`,
          file: change.path,
        });
      }

      if (/\.(env|pem|key|secret|credential)($|\.)/.test(change.path)) {
        issues.push({
          stage: "diff-check",
          severity: "blocker",
          message: `Sensitive file pattern: "${change.path}"`,
          file: change.path,
        });
      }

      // Content checks
      const content = change.content ?? "";
      if (content.includes("<<<<<<< ") && content.includes(">>>>>>> ")) {
        issues.push({
          stage: "diff-check",
          severity: "blocker",
          message: `Unresolved merge conflict markers in "${change.path}"`,
          file: change.path,
        });
      }

      if (content.includes("TODO: FIXME") || content.includes("HACK: ")) {
        issues.push({
          stage: "diff-check",
          severity: "warning",
          message: `Suspicious markers in "${change.path}"`,
          file: change.path,
        });
      }
    }

    const passed = !issues.some((i) => i.severity === "blocker");
    return {
      stage: "diff-check",
      name: "Diff Validation",
      passed,
      score: passed ? (issues.length === 0 ? 1 : 0.8) : 0,
      issues,
      durationMs: Date.now() - start,
      details: passed
        ? `${changes.length} changes validated`
        : `${issues.filter((i) => i.severity === "blocker").length} blocking issues in diff`,
    };
  }

  /**
   * Contract check: verify that worker outputs satisfy their declared contracts.
   * - Builder results have changes
   * - Critic results have verdicts
   * - All results have cost entries
   * - Confidence scores are within bounds
   */
  private runContractCheck(
    changes: readonly FileChange[],
    workerResults: readonly WorkerResult[]
  ): StageResult {
    const start = Date.now();
    const issues: VerificationIssue[] = [];

    // Workers that legitimately run locally with no token spend (scout,
    // verifier, integrator) should never trip the "zero cost" warning —
    // that check was intended to catch a Builder/Critic that silently
    // produced nothing, not to flag expected-zero-cost infra workers.
    const ZERO_COST_BY_DESIGN = new Set(["scout", "verifier", "integrator"]);
    // Workers that legitimately don't modify files (scout reads, critic
    // reviews, verifier inspects) should never trip the "no touched files"
    // warning. Only Builder and Integrator are contractually required to
    // touch files.
    const MUST_TOUCH_FILES = new Set(["builder", "integrator"]);

    for (const result of workerResults) {
      if (
        result.cost.inputTokens === 0 &&
        result.cost.outputTokens === 0 &&
        !ZERO_COST_BY_DESIGN.has(result.workerType)
      ) {
        issues.push({
          stage: "contract-check",
          severity: "warning",
          message: `Worker "${result.workerType}" (task ${result.taskId}) reported zero cost`,
        });
      }

      // Confidence must be 0-1
      if (result.confidence < 0 || result.confidence > 1) {
        issues.push({
          stage: "contract-check",
          severity: "blocker",
          message: `Worker "${result.workerType}" reported invalid confidence: ${result.confidence}`,
        });
      }

      // Builder must produce changes
      if (result.workerType === "builder" && result.success) {
        const output = result.output;
        if (output.kind === "builder" && output.changes.length === 0) {
          issues.push({
            stage: "contract-check",
            severity: "warning",
            message: `Builder (task ${result.taskId}) succeeded but produced no changes`,
          });
        }
      }

      // Critic must have a verdict
      if (result.workerType === "critic" && result.success) {
        const output = result.output;
        if (output.kind === "critic" && !output.verdict) {
          issues.push({
            stage: "contract-check",
            severity: "blocker",
            message: `Critic (task ${result.taskId}) has no verdict`,
          });
        }
      }

      if (
        result.success &&
        result.touchedFiles.length === 0 &&
        MUST_TOUCH_FILES.has(result.workerType)
      ) {
        issues.push({
          stage: "contract-check",
          severity: "warning",
          message: `Worker "${result.workerType}" (task ${result.taskId}) reported no touched files`,
        });
      }
    }

    const passed = !issues.some((i) => i.severity === "blocker");
    return {
      stage: "contract-check",
      name: "Worker Contract Validation",
      passed,
      score: passed ? (issues.length === 0 ? 1 : 0.85) : 0.3,
      issues,
      durationMs: Date.now() - start,
      details: passed
        ? `${workerResults.length} worker results validated`
        : `Contract violations in ${issues.filter((i) => i.severity === "blocker").length} results`,
    };
  }

  // ─── Confidence Scoring ────────────────────────────────────────────

  private computeConfidence(stages: readonly StageResult[]): number {
    const scorableStages = stages.filter(
      (s) => s.stage !== "confidence-scoring"
    );
    if (scorableStages.length === 0) return 1;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const stage of scorableStages) {
      const weight = this.config.stageWeights[stage.stage] ?? 1;
      weightedSum += stage.score * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 1;
  }

  // ─── Baseline Test Snapshot ──────────────────────────────────────────

  /**
   * Capture test results BEFORE execution begins. Runs all configured
   * test hooks (kind === "tests") against the current repo state and
   * stores the failing test names. Returns null if no test hooks are
   * configured.
   *
   * Receipt: verification.baseline
   */
  async captureBaseline(changedFiles: string[]): Promise<TestBaseline | null> {
    const testHooks = this.config.hooks.filter((h) => h.kind === "tests");
    if (testHooks.length === 0) return null;

    const failingTestNames: string[] = [];
    let totalTests = 0;
    let failedTests = 0;
    let hookResult: ToolHookResult | null = null;

    for (const hook of testHooks) {
      try {
        const result = await hook.execute(changedFiles);
        hookResult = result;
        // Extract failing test names from issues
        for (const issue of result.issues) {
          if (issue.severity === "error" || issue.severity === "blocker") {
            failingTestNames.push(issue.message);
            failedTests++;
          }
          totalTests++;
        }
        // If no issues but passed, count as 1 passing test suite
        if (result.issues.length === 0 && result.passed) {
          totalTests++;
        }
      } catch (err) {
        console.warn(
          `[verification] baseline capture failed for hook "${hook.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      capturedAt: new Date().toISOString(),
      totalTests,
      failedTests,
      failingTestNames,
      hookResult,
    };
  }

  /**
   * Compare post-execution test results against a baseline snapshot.
   * Returns a structured comparison:
   *   - newFailures: tests that fail now but passed before → NEGATIVE
   *   - fixedTests: tests that passed now but failed before → POSITIVE
   *   - preExistingFailures: tests that failed both times → NEUTRAL
   */
  compareWithBaseline(
    baseline: TestBaseline,
    postStages: readonly StageResult[],
  ): BaselineComparison {
    const baselineSet = new Set(baseline.failingTestNames);

    // Collect current failures from test-related stages
    const currentFailures = new Set<string>();
    for (const stage of postStages) {
      if (stage.stage !== "custom-hook") continue;
      for (const issue of stage.issues) {
        if (issue.severity === "error" || issue.severity === "blocker") {
          currentFailures.add(issue.message);
        }
      }
    }

    const newFailures: string[] = [];
    const fixedTests: string[] = [];
    const preExistingFailures: string[] = [];

    for (const failure of currentFailures) {
      if (baselineSet.has(failure)) {
        preExistingFailures.push(failure);
      } else {
        newFailures.push(failure);
      }
    }

    for (const baseline of baselineSet) {
      if (!currentFailures.has(baseline)) {
        fixedTests.push(baseline);
      }
    }

    const signal: BaselineComparison["signal"] =
      newFailures.length > 0 ? "negative" :
      fixedTests.length > 0 ? "positive" :
      "neutral";

    return { newFailures, fixedTests, preExistingFailures, signal };
  }
}

// ─── Hook Factories ──────────────────────────────────────────────────

/**
 * Detect whether a package.json at `dir` has a "lint" script.
 */
async function hasLintScript(dir: string): Promise<boolean> {
  try {
    const { readFile: rf } = await import("fs/promises");
    const { join } = await import("path");
    const raw = await rf(join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.["lint"]);
  } catch {
    return false;
  }
}

/**
 * Detect pnpm workspace: if pnpm-workspace.yaml exists at `root`,
 * find the closest package directory for one of the changed files.
 * Returns the package dir to run lint from, or null if not a workspace.
 */
async function findPnpmWorkspacePackageDir(
  root: string,
  changedFiles: string[],
): Promise<string | null> {
  try {
    const { access } = await import("fs/promises");
    const { join, dirname } = await import("path");
    await access(join(root, "pnpm-workspace.yaml"));

    // Walk up from the first changed file to find the nearest
    // package.json that isn't the root's.
    for (const file of changedFiles) {
      let dir = dirname(join(root, file));
      while (dir.length >= root.length) {
        if (dir === root) break;
        try {
          await access(join(dir, "package.json"));
          return dir;
        } catch {
          dir = dirname(dir);
        }
      }
    }
  } catch {
    // No pnpm-workspace.yaml — not a workspace
  }
  return null;
}

/**
 * Check if an error message indicates a missing npm script rather
 * than an actual lint failure.
 */
function isMissingScriptError(stderr: string, stdout: string): boolean {
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  return (
    combined.includes("missing script") ||
    combined.includes('npm err! missing script: "lint"') ||
    combined.includes("error: script \"lint\" not found") ||
    combined.includes('npm error missing script: "lint"')
  );
}

/**
 * Create a lint hook that shells out to a linter.
 *
 * Workspace-aware:
 *   - If pnpm-workspace.yaml exists, finds the nearest package dir
 *     for the changed files and runs lint there.
 *   - If no lint script exists in the target package.json, returns
 *     a passing result with an advisory skip (not a blocker).
 *   - If the lint command fails with "Missing script", treats it
 *     as a skip rather than a failure.
 */
export function createLintHook(config: {
  name?: string;
  command: string;
  args?: string[];
  projectRoot?: string;
  parseOutput?: (stdout: string) => VerificationIssue[];
}): ToolHook {
  return {
    name: config.name ?? "Lint",
    stage: "lint",
    kind: "lint",
    async execute(changedFiles: string[]): Promise<ToolHookResult> {
      const start = Date.now();
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const exec = promisify(execFile);

      // Resolve the directory to run lint from.
      const root = config.projectRoot ?? process.cwd();
      let cwd = root;

      // Check for pnpm workspace — run from the package dir, not root.
      const workspacePkgDir = await findPnpmWorkspacePackageDir(root, changedFiles);
      if (workspacePkgDir) {
        cwd = workspacePkgDir;
        console.log(`[lint] pnpm workspace detected — running from ${cwd}`);
      }

      // If the target directory has no lint script, skip gracefully.
      if (!(await hasLintScript(cwd))) {
        // Also check root as fallback (monorepo root may have the script)
        if (cwd !== root && (await hasLintScript(root))) {
          cwd = root;
          console.log(`[lint] no lint script in workspace package, using root`);
        } else {
          console.log(`[lint] no lint script found in ${cwd} — skipping`);
          return {
            passed: true,
            issues: [{
              stage: "lint",
              severity: "info",
              message: `No lint script in package.json — skipped`,
            }],
            stdout: "",
            stderr: "",
            exitCode: 0,
            durationMs: Date.now() - start,
          };
        }
      }

      try {
        const args = [...(config.args ?? []), ...changedFiles];
        const result = await exec(config.command, args, { timeout: 30_000, cwd });

        return {
          passed: true,
          issues: [],
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: 0,
          durationMs: Date.now() - start,
        };
      } catch (err: any) {
        const stderr: string = err.stderr ?? "";
        const stdout: string = err.stdout ?? "";

        // "Missing script" is a config issue, not a lint failure.
        if (isMissingScriptError(stderr, stdout)) {
          console.log(`[lint] lint script missing at runtime — treating as skip`);
          return {
            passed: true,
            issues: [{
              stage: "lint",
              severity: "info",
              message: `Lint script not found — skipped`,
            }],
            stdout,
            stderr,
            exitCode: 0,
            durationMs: Date.now() - start,
          };
        }

        const issues: VerificationIssue[] = config.parseOutput
          ? config.parseOutput(stdout)
          : [{
              stage: "lint",
              severity: "error",
              message: stderr || err.message || "Lint failed",
            }];

        return {
          passed: false,
          issues,
          stdout,
          stderr,
          exitCode: err.code ?? 1,
          durationMs: Date.now() - start,
        };
      }
    },
  };
}

/**
 * Parse tsc output into structured per-file errors.
 * Exported so other modules can reuse the parser.
 */
export function parseTscOutput(stdout: string): VerificationIssue[] {
  return stdout
    .split("\n")
    .filter((line: string) => /\.tsx?\(\d+,\d+\):\s*error/.test(line))
    .map((line: string) => {
      const match = line.match(/(.+?)\((\d+),\d+\):\s*error\s+(\w+):\s*(.+)/);
      return {
        stage: "typecheck" as const,
        severity: "error" as const,
        message: match?.[4] ?? line,
        file: match?.[1],
        line: match?.[2] ? parseInt(match[2]) : undefined,
        rule: match?.[3],
      };
    });
}

/**
 * Create a typecheck hook that shells out to tsc.
 *
 * Enhanced to:
 *   - Parse all tsc errors into structured VerificationIssue objects
 *   - Separate issues into "changed-file errors" vs "pre-existing errors"
 *   - Only fail the hook if changed files have type errors
 *   - Report pre-existing errors as warnings (not blockers)
 *   - Produce a summary that distinguishes introduced vs inherited errors
 */
export function createTypecheckHook(config: {
  tscPath?: string;
  project?: string;
  projectRoot?: string;
}): ToolHook {
  return {
    name: "TypeScript Check",
    stage: "typecheck",
    kind: "typecheck",
    async execute(changedFiles: string[]): Promise<ToolHookResult> {
      const start = Date.now();
      try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const exec = promisify(execFile);

        const tsc = config.tscPath ?? "npx";
        const args = config.tscPath
          ? ["--noEmit", ...(config.project ? ["-p", config.project] : [])]
          : ["tsc", "--noEmit", ...(config.project ? ["-p", config.project] : [])];

        const cwd = config.projectRoot ?? process.cwd();
        const result = await exec(tsc, args, { timeout: 60_000, cwd });

        // tsc succeeded — all changed files pass type check
        const issues: VerificationIssue[] = changedFiles.map((file) => ({
          stage: "typecheck" as const,
          severity: "info" as const,
          message: `Type check passed`,
          file,
        }));

        return {
          passed: true,
          issues,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: 0,
          durationMs: Date.now() - start,
        };
      } catch (err: any) {
        const stdout: string = err.stdout ?? "";
        const allIssues = parseTscOutput(stdout);

        // Separate errors in changed files from pre-existing ones
        const changedFileSet = new Set(changedFiles.map((f) => f.toLowerCase()));
        const inScopeIssues: VerificationIssue[] = [];
        const preExistingIssues: VerificationIssue[] = [];

        for (const issue of allIssues) {
          const issueFile = issue.file?.toLowerCase() ?? "";
          const isChanged = changedFileSet.has(issueFile) ||
            [...changedFileSet].some((cf) => issueFile.endsWith(cf) || cf.endsWith(issueFile));

          if (isChanged) {
            inScopeIssues.push(issue);
          } else {
            // Downgrade pre-existing errors to warnings — they're
            // not the builder's fault
            preExistingIssues.push({
              ...issue,
              severity: "warning",
              message: `[pre-existing] ${issue.message}`,
            });
          }
        }

        // Only fail if changed files have errors
        const passed = inScopeIssues.length === 0;
        const issues = [...inScopeIssues, ...preExistingIssues];

        return {
          passed,
          issues,
          stdout,
          stderr: err.stderr,
          exitCode: err.code ?? 1,
          durationMs: Date.now() - start,
        };
      }
    },
  };
}

/**
 * Create a custom hook from a shell command.
 */
export function createCustomHook(config: {
  name: string;
  command: string;
  args?: string[];
  passFiles?: boolean;
  kind?: VerificationCheckKind;
}): ToolHook {
  return {
    name: config.name,
    stage: "custom-hook",
    kind: config.kind,
    async execute(changedFiles: string[]): Promise<ToolHookResult> {
      const start = Date.now();
      try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const exec = promisify(execFile);

        const args = [
          ...(config.args ?? []),
          ...(config.passFiles ? changedFiles : []),
        ];
        const result = await exec(config.command, args, { timeout: 60_000 });

        return {
          passed: true,
          issues: [],
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: 0,
          durationMs: Date.now() - start,
        };
      } catch (err: any) {
        return {
          passed: false,
          issues: [{
            stage: "custom-hook",
            severity: "error",
            message: err.stderr ?? err.message ?? `${config.name} failed`,
          }],
          stdout: err.stdout,
          stderr: err.stderr,
          exitCode: err.code ?? 1,
          durationMs: Date.now() - start,
        };
      }
    },
  };
}
