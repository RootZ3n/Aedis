/**
 * PostRunEvaluator — optional post-run evaluation via Crucibulum.
 *
 * After an Aedis build run reaches a terminal state, this module
 * optionally triggers Crucibulum evaluation tasks, collects the
 * results, and produces a structured EvaluationAttachment that
 * gets stored on the RunReceipt.
 *
 * Design principles:
 *   - Evaluation is optional and non-blocking
 *   - Crucibulum failures never corrupt the Aedis run
 *   - Results are stored as a receipt attachment, not inline
 *   - Disagreement between Aedis confidence and Crucibulum
 *     scores is explicitly surfaced
 *   - The evaluator does NOT modify code or trigger re-runs
 */

import {
  CrucibulumClient,
  type CrucibulumConfig,
  type CrucibulumBundleSummary,
  type TriggerOutcome,
  DEFAULT_CRUCIBULUM_CONFIG,
} from "./crucibulum-client.js";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * The evaluation attachment stored on the RunReceipt. Contains
 * everything a human reviewer needs to understand how the run
 * was evaluated externally.
 */
export interface EvaluationAttachment {
  /** Schema version for forward compatibility. */
  readonly schema: "aedis.evaluation.v1";
  /** Whether evaluation was attempted. */
  readonly attempted: boolean;
  /** Whether evaluation completed successfully. */
  readonly completed: boolean;
  /** Why evaluation was not attempted or did not complete. */
  readonly reason: string;
  /** Timestamp when evaluation started. */
  readonly startedAt: string;
  /** Timestamp when evaluation completed (or failed). */
  readonly completedAt: string;
  /** Total evaluation duration in ms. */
  readonly durationMs: number;
  /** Per-task results from Crucibulum. */
  readonly taskResults: readonly EvaluationTaskResult[];
  /** Aggregate evaluation summary. */
  readonly aggregate: EvaluationAggregate | null;
  /** Disagreement analysis between Aedis confidence and Crucibulum scores. */
  readonly disagreement: DisagreementAnalysis | null;
  /** Confidence adjustment recommended by the evaluation. */
  readonly confidenceAdjustment: ConfidenceAdjustment | null;
}

export interface EvaluationTaskResult {
  readonly taskId: string;
  readonly crucibulumRunId: string | null;
  readonly bundleId: string | null;
  readonly status: "passed" | "failed" | "error" | "timeout" | "skipped";
  readonly score: number | null;
  readonly scoreBreakdown: {
    readonly correctness: number;
    readonly regression: number;
    readonly integrity: number;
    readonly efficiency: number;
  } | null;
  readonly pass: boolean | null;
  readonly failureMode: string | null;
  readonly durationMs: number;
}

export interface EvaluationAggregate {
  readonly tasksAttempted: number;
  readonly tasksPassed: number;
  readonly tasksFailed: number;
  readonly tasksErrored: number;
  readonly averageScore: number;
  readonly overallPass: boolean;
  /** One-line summary for receipts. */
  readonly summary: string;
}

/**
 * Disagreement analysis: compares Aedis's internal confidence
 * with Crucibulum's external evaluation scores.
 */
export interface DisagreementAnalysis {
  readonly aedisConfidence: number;
  readonly crucibulumScore: number;
  /**
   * The gap between Aedis confidence and Crucibulum score.
   * Positive = Aedis was more confident than Crucibulum scored.
   * Negative = Crucibulum scored higher than Aedis expected.
   */
  readonly gap: number;
  readonly severity: "none" | "minor" | "significant" | "critical";
  readonly direction: "aligned" | "aedis-overconfident" | "aedis-underconfident";
  readonly summary: string;
  /**
   * Whether this disagreement should trigger an escalation
   * (require human review even if governance didn't demand it).
   */
  readonly escalate: boolean;
}

export interface ConfidenceAdjustment {
  /** Direction of the adjustment. */
  readonly direction: "none" | "downgrade" | "upgrade";
  /** Suggested confidence delta (-1 to +1). */
  readonly delta: number;
  /** Reason for the adjustment. */
  readonly reason: string;
}

/** Input from the Aedis run for the evaluator. */
export interface EvaluationInput {
  readonly runId: string;
  readonly verdict: string;
  readonly aedisConfidence: number;
  readonly scopeType: string;
  readonly filesChanged: readonly string[];
  readonly commitSha: string | null;
  readonly taskSummary: string;
}

// ─── Evaluator ──────────────────────────────────────────────────────

export class PostRunEvaluator {
  private client: CrucibulumClient;
  private config: CrucibulumConfig;

  constructor(config: Partial<CrucibulumConfig> = {}) {
    this.config = { ...DEFAULT_CRUCIBULUM_CONFIG, ...config };
    this.client = new CrucibulumClient(this.config);
  }

  /**
   * Check if evaluation should run for the given outcome.
   */
  shouldEvaluate(verdict: string): boolean {
    if (!this.config.enabled) return false;
    return this.config.triggerOnOutcome.includes(verdict as TriggerOutcome);
  }

  /**
   * Run post-build evaluation. Returns the attachment to store
   * on the RunReceipt. Never throws — all failures are contained
   * in the returned attachment.
   */
  async evaluate(input: EvaluationInput): Promise<EvaluationAttachment> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    // Guard: should we evaluate?
    if (!this.shouldEvaluate(input.verdict)) {
      return this.skipped(
        startedAt,
        `Evaluation not triggered for outcome "${input.verdict}"`,
      );
    }

    // Health check
    const health = await this.client.healthCheck();
    if (!health.ok) {
      return this.unavailable(
        startedAt,
        `Crucibulum unavailable: ${health.reason}`,
      );
    }

    // Run each configured task
    const tasks = this.config.tasks.length > 0
      ? this.config.tasks
      : ["spec-001"];

    const taskResults: EvaluationTaskResult[] = [];

    for (const taskId of tasks) {
      const taskStart = Date.now();
      console.log(`[evaluator] submitting task ${taskId} to Crucibulum`);

      try {
        const bundle = await this.client.submitAndWait(taskId);
        if (bundle) {
          taskResults.push(this.bundleToResult(taskId, bundle, Date.now() - taskStart));
        } else {
          taskResults.push({
            taskId,
            crucibulumRunId: null,
            bundleId: null,
            status: "timeout",
            score: null,
            scoreBreakdown: null,
            pass: null,
            failureMode: "evaluation timed out or failed",
            durationMs: Date.now() - taskStart,
          });
        }
      } catch (err) {
        taskResults.push({
          taskId,
          crucibulumRunId: null,
          bundleId: null,
          status: "error",
          score: null,
          scoreBreakdown: null,
          pass: null,
          failureMode: String(err),
          durationMs: Date.now() - taskStart,
        });
      }
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;
    const completed = taskResults.some((r) => r.status === "passed" || r.status === "failed");
    const aggregate = this.computeAggregate(taskResults);
    const disagreement = aggregate
      ? this.analyzeDisagreement(input.aedisConfidence, aggregate.averageScore / 100)
      : null;
    const confidenceAdjustment = disagreement
      ? this.computeConfidenceAdjustment(disagreement)
      : null;

    return {
      schema: "aedis.evaluation.v1",
      attempted: true,
      completed,
      reason: completed ? "Evaluation completed" : "All tasks failed or timed out",
      startedAt,
      completedAt,
      durationMs,
      taskResults,
      aggregate,
      disagreement,
      confidenceAdjustment,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private bundleToResult(
    taskId: string,
    bundle: CrucibulumBundleSummary,
    durationMs: number,
  ): EvaluationTaskResult {
    return {
      taskId,
      crucibulumRunId: null,
      bundleId: bundle.bundle_id,
      status: bundle.score.pass ? "passed" : "failed",
      score: bundle.score.total_percent,
      scoreBreakdown: bundle.score.breakdown_percent,
      pass: bundle.score.pass,
      failureMode: bundle.diagnosis.failure_mode,
      durationMs,
    };
  }

  private computeAggregate(results: readonly EvaluationTaskResult[]): EvaluationAggregate | null {
    const scored = results.filter((r) => r.score !== null);
    if (scored.length === 0) return null;

    const passed = results.filter((r) => r.status === "passed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const errored = results.filter((r) => r.status === "error" || r.status === "timeout").length;
    const avgScore = scored.reduce((sum, r) => sum + r.score!, 0) / scored.length;
    const overallPass = failed === 0 && errored === 0 && passed > 0;

    const parts: string[] = [];
    parts.push(`${passed}/${results.length} tasks passed`);
    parts.push(`avg score ${avgScore.toFixed(0)}%`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (errored > 0) parts.push(`${errored} errored`);

    return {
      tasksAttempted: results.length,
      tasksPassed: passed,
      tasksFailed: failed,
      tasksErrored: errored,
      averageScore: Math.round(avgScore),
      overallPass,
      summary: parts.join(", "),
    };
  }

  /**
   * Analyze the gap between Aedis's internal confidence (0-1) and
   * Crucibulum's external score (0-1).
   *
   * Thresholds:
   *   gap < 0.10 → "none" (aligned)
   *   gap 0.10-0.20 → "minor"
   *   gap 0.20-0.35 → "significant"
   *   gap > 0.35 → "critical"
   *
   * Direction: positive gap = Aedis overconfident
   */
  private analyzeDisagreement(
    aedisConfidence: number,
    crucibulumScore: number,
  ): DisagreementAnalysis {
    const gap = aedisConfidence - crucibulumScore;
    const absGap = Math.abs(gap);

    let severity: DisagreementAnalysis["severity"];
    if (absGap < 0.10) severity = "none";
    else if (absGap < 0.20) severity = "minor";
    else if (absGap < 0.35) severity = "significant";
    else severity = "critical";

    let direction: DisagreementAnalysis["direction"];
    if (absGap < 0.10) direction = "aligned";
    else if (gap > 0) direction = "aedis-overconfident";
    else direction = "aedis-underconfident";

    const escalate = direction === "aedis-overconfident" && severity !== "none" && severity !== "minor";

    const pctAedis = Math.round(aedisConfidence * 100);
    const pctCrucibulum = Math.round(crucibulumScore * 100);

    let summary: string;
    switch (severity) {
      case "none":
        summary = `Aligned — Aedis ${pctAedis}% ≈ Crucibulum ${pctCrucibulum}%`;
        break;
      case "minor":
        summary = `Minor gap — Aedis ${pctAedis}% vs Crucibulum ${pctCrucibulum}% (${direction})`;
        break;
      case "significant":
        summary = `Significant gap — Aedis ${pctAedis}% vs Crucibulum ${pctCrucibulum}% (${direction})`;
        break;
      case "critical":
        summary = `Critical gap — Aedis ${pctAedis}% vs Crucibulum ${pctCrucibulum}% (${direction}). Review required.`;
        break;
    }

    return {
      aedisConfidence,
      crucibulumScore,
      gap: Math.round(gap * 100) / 100,
      severity,
      direction,
      summary,
      escalate,
    };
  }

  /**
   * Compute a confidence adjustment based on disagreement analysis.
   *
   * Rules:
   *   - Aedis overconfident + significant/critical → downgrade
   *   - Aedis underconfident + significant/critical → small upgrade
   *   - Aligned or minor → no adjustment
   *
   * The adjustment is a suggestion — the coordinator decides
   * whether to apply it.
   */
  private computeConfidenceAdjustment(
    disagreement: DisagreementAnalysis,
  ): ConfidenceAdjustment {
    if (disagreement.severity === "none" || disagreement.severity === "minor") {
      return { direction: "none", delta: 0, reason: "Aedis and Crucibulum are aligned" };
    }

    if (disagreement.direction === "aedis-overconfident") {
      const delta = disagreement.severity === "critical" ? -0.20 : -0.10;
      return {
        direction: "downgrade",
        delta,
        reason: `Aedis confidence ${Math.round(disagreement.aedisConfidence * 100)}% exceeds Crucibulum score ${Math.round(disagreement.crucibulumScore * 100)}% — downgrading trust`,
      };
    }

    if (disagreement.direction === "aedis-underconfident") {
      const delta = disagreement.severity === "critical" ? 0.05 : 0.03;
      return {
        direction: "upgrade",
        delta,
        reason: `Crucibulum score ${Math.round(disagreement.crucibulumScore * 100)}% exceeds Aedis confidence ${Math.round(disagreement.aedisConfidence * 100)}% — modest trust boost (governance not overridden)`,
      };
    }

    return { direction: "none", delta: 0, reason: "No adjustment needed" };
  }

  // ─── Terminal-state factories ─────────────────────────────────────

  private skipped(startedAt: string, reason: string): EvaluationAttachment {
    return {
      schema: "aedis.evaluation.v1",
      attempted: false,
      completed: false,
      reason,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: 0,
      taskResults: [],
      aggregate: null,
      disagreement: null,
      confidenceAdjustment: null,
    };
  }

  private unavailable(startedAt: string, reason: string): EvaluationAttachment {
    return {
      schema: "aedis.evaluation.v1",
      attempted: true,
      completed: false,
      reason,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      taskResults: [],
      aggregate: null,
      disagreement: null,
      confidenceAdjustment: null,
    };
  }
}
