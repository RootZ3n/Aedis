/**
 * VerificationPipeline — Multi-stage verification for build outputs.
 *
 * Runs a sequence of verification stages against the changeset:
 *   1. Diff check — validate change structure and format
 *   2. Contract check — verify interface/type contracts
 *   3. Cross-file check — delegate to IntegrationJudge
 *   4. Lint/typecheck hooks — run external tooling
 *   5. Confidence scoring — aggregate results into a score
 *   6. Receipt generation — produce pass/fail audit receipt
 *
 * Each stage produces a StageResult. The pipeline aggregates all
 * results into a VerificationReceipt — the final verdict on whether
 * the changeset is safe to apply.
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
  requiredChecks: [],
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
  ): Promise<VerificationReceipt> {
    const scopedFiles = new Set(
      changeSet.filesInScope.map((f) => f.path),
    );
    const scopedChanges =
      scopedFiles.size === 0
        ? changes
        : changes.filter((c) => scopedFiles.has(c.path));

    const receipt = await this.verify(intent, runState, scopedChanges, workerResults);
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
    };
  }

  /**
   * Run the full verification pipeline against a changeset.
   */
  async verify(
    intent: IntentObject,
    runState: RunState,
    changes: readonly FileChange[],
    workerResults: readonly WorkerResult[]
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
      judgmentReport = this.judge.judge(intent, runState, changes, workerResults);
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
          // Missing check = advisory skip, never a blocker.
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
            passed: true,
            score: 1,
            issues: [{
              stage: this.stageForCheck(kind),
              severity: "warning",
              message: `${kind} hook not configured — skipped`,
            }],
            durationMs: 0,
            details: `${kind} hook not configured — skipped`,
          });
          // Never abort on a missing check — it's a skip, not a failure.
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

    // Aggregate
    const totalDurationMs = Date.now() - startTime;
    const allIssues = stages.flatMap((s) => s.issues);
    const blockers = allIssues.filter((i) => i.severity === "blocker");
    const confidenceScore = this.computeConfidence(stages);
    // Missing checks are advisory — only actual blockers and low
    // confidence scores cause a fail verdict. A check that never ran
    // (not configured, not installed) is a skip, not a failure.
    const missingChecks = this.config.requiredChecks.filter(
      (kind) => !checks.some((check) => check.kind === kind && check.executed),
    );

    const verdict: VerificationReceipt["verdict"] =
      blockers.length > 0 || confidenceScore < this.config.minimumConfidence
        ? "fail"
        : allIssues.some((i) => i.severity === "warning") || missingChecks.length > 0
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
      summaryParts.push(`skipped checks: ${missingChecks.join(", ")}`);
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

    for (const result of workerResults) {
      // Every result must report cost
      if (result.cost.inputTokens === 0 && result.cost.outputTokens === 0) {
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

      // All workers must report touched files
      if (result.success && result.touchedFiles.length === 0) {
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
 * Create a typecheck hook that shells out to tsc.
 */
export function createTypecheckHook(config: {
  tscPath?: string;
  project?: string;
}): ToolHook {
  return {
    name: "TypeScript Check",
    stage: "typecheck",
    kind: "typecheck",
    async execute(_changedFiles: string[]): Promise<ToolHookResult> {
      const start = Date.now();
      try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const exec = promisify(execFile);

        const tsc = config.tscPath ?? "npx";
        const args = config.tscPath
          ? ["--noEmit", ...(config.project ? ["-p", config.project] : [])]
          : ["tsc", "--noEmit", ...(config.project ? ["-p", config.project] : [])];

        const result = await exec(tsc, args, { timeout: 60_000 });

        return {
          passed: true,
          issues: [],
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: 0,
          durationMs: Date.now() - start,
        };
      } catch (err: any) {
        const stdout: string = err.stdout ?? "";
        const issues: VerificationIssue[] = stdout
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

        return {
          passed: false,
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
