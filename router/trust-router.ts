/**
 * TrustRouter — Routes tasks to worker tiers based on complexity,
 * blast radius, and Crucibulum trust scores.
 *
 * Core principle: cheapest acceptable path wins. A trivial rename
 * doesn't need GPT-4 class models. A security-sensitive refactor does.
 * Trust is earned through Crucibulum benchmark performance, not assumed.
 *
 * Routing factors:
 *   1. Task complexity (LOC, dependency depth, pattern novelty)
 *   2. Blast radius (files affected, public API surface, data layer)
 *   3. Risk signals (security, production, destructive operations)
 *   4. Worker trust scores from Crucibulum (historical accuracy)
 *   5. Cost constraints from IntentObject
 */

import type { IntentObject, QualityBar } from "../core/intent.js";
import type { RunTask } from "../core/runstate.js";
import type { WorkerTier, WorkerType, WorkerAssignment } from "../workers/base.js";
import type { AssembledContext } from "../core/context-assembler.js";

// ─── Trust Scores ────────────────────────────────────────────────────

export interface CrucibulumScore {
  /** Worker or model identifier */
  readonly workerId: string;
  /** Overall accuracy score 0-1 */
  readonly accuracy: number;
  /** Accuracy by task category */
  readonly categoryScores: Readonly<Record<string, number>>;
  /** Number of evaluated tasks */
  readonly sampleSize: number;
  /** When this score was last updated */
  readonly lastUpdated: string;
  /** Score trend: improving, stable, or degrading */
  readonly trend: "improving" | "stable" | "degrading";
}

export interface TrustProfile {
  /** Model/worker → Crucibulum scores */
  readonly scores: ReadonlyMap<string, CrucibulumScore>;
  /** Minimum accuracy required per tier */
  readonly tierThresholds: Readonly<Record<WorkerTier, number>>;
}

// ─── Complexity Analysis ─────────────────────────────────────────────

export interface ComplexityAnalysis {
  /** Overall complexity score 0-10 */
  readonly score: number;
  /** Individual factors contributing to score */
  readonly factors: readonly ComplexityFactor[];
  /** Suggested tier based purely on complexity */
  readonly suggestedTier: WorkerTier;
}

export interface ComplexityFactor {
  readonly name: string;
  readonly score: number;    // 0-10
  readonly weight: number;   // 0-1, must sum to 1 across factors
  readonly reasoning: string;
}

// ─── Blast Radius ────────────────────────────────────────────────────

export interface BlastRadiusAnalysis {
  /** Overall blast radius: how far do changes ripple? */
  readonly level: "contained" | "local" | "cross-module" | "system-wide";
  /** Number of files directly affected */
  readonly directFiles: number;
  /** Estimated number of transitively affected files */
  readonly transitiveFiles: number;
  /** Whether public API surface is affected */
  readonly affectsPublicApi: boolean;
  /** Whether data layer is affected */
  readonly affectsDataLayer: boolean;
  /** Risk signals detected */
  readonly riskSignals: readonly string[];
}

// ─── Routing Decision ────────────────────────────────────────────────

export interface RoutingDecision {
  /** The task being routed */
  readonly taskId: string;
  /** Worker type to use */
  readonly workerType: WorkerType;
  /** Tier selected */
  readonly tier: WorkerTier;
  /** Token budget allocated */
  readonly tokenBudget: number;
  /** Why this routing was chosen */
  readonly rationale: string;
  /** Complexity analysis that informed the decision */
  readonly complexity: ComplexityAnalysis;
  /** Blast radius analysis that informed the decision */
  readonly blastRadius: BlastRadiusAnalysis;
  /** Estimated cost */
  readonly estimatedCostUsd: number;
  /** Whether Critic review is required post-execution */
  readonly requiresCriticReview: boolean;
  /** Whether Verifier must run before apply */
  readonly requiresVerification: boolean;
}

// ─── Router Configuration ────────────────────────────────────────────

export interface TrustRouterConfig {
  /** Default tier thresholds (Crucibulum accuracy required per tier) */
  tierThresholds: Record<WorkerTier, number>;
  /** Token budgets per tier */
  tokenBudgets: Record<WorkerTier, number>;
  /** Estimated cost per 1K tokens per tier */
  costPer1kTokens: Record<WorkerTier, number>;
  /** Quality bar → minimum tier mapping */
  qualityBarMinTier: Record<QualityBar, WorkerTier>;
  /** Complexity score thresholds for tier escalation */
  complexityThresholds: { standard: number; premium: number };
  /** Blast radius levels that force tier escalation */
  blastRadiusEscalation: Record<BlastRadiusAnalysis["level"], WorkerTier>;
  /** Always require Critic review above this complexity */
  criticReviewThreshold: number;
}

const DEFAULT_CONFIG: TrustRouterConfig = {
  tierThresholds: { fast: 0.6, standard: 0.75, premium: 0.9 },
  tokenBudgets: { fast: 4_000, standard: 16_000, premium: 64_000 },
  costPer1kTokens: { fast: 0.0005, standard: 0.003, premium: 0.015 },
  qualityBarMinTier: { minimal: "fast", standard: "standard", hardened: "premium" },
  complexityThresholds: { standard: 4, premium: 7 },
  blastRadiusEscalation: {
    contained: "fast",
    local: "fast",
    "cross-module": "standard",
    "system-wide": "premium",
  },
  criticReviewThreshold: 5,
};

// ─── Trust Router ────────────────────────────────────────────────────

export class TrustRouter {
  private config: TrustRouterConfig;
  private trustProfile: TrustProfile;

  constructor(
    trustProfile: TrustProfile,
    config: Partial<TrustRouterConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.trustProfile = trustProfile;
  }

  /**
   * Route a task to the appropriate worker tier.
   * Returns a full RoutingDecision with rationale.
   */
  route(
    task: RunTask,
    intent: IntentObject,
    context: AssembledContext
  ): RoutingDecision {
    const complexity = this.analyzeComplexity(task, context);
    const blastRadius = this.analyzeBlastRadius(task, intent, context);
    const tier = this.selectTier(complexity, blastRadius, intent.charter.qualityBar);
    const tokenBudget = this.config.tokenBudgets[tier];
    const estimatedCostUsd = (tokenBudget / 1000) * this.config.costPer1kTokens[tier];

    const requiresCriticReview =
      complexity.score >= this.config.criticReviewThreshold ||
      blastRadius.affectsPublicApi ||
      blastRadius.riskSignals.length > 0;

    const requiresVerification =
      task.workerType === "builder" || task.workerType === "integrator";

    const rationale = this.buildRationale(
      tier,
      complexity,
      blastRadius,
      intent.charter.qualityBar
    );

    return {
      taskId: task.id,
      workerType: task.workerType as WorkerType,
      tier,
      tokenBudget,
      rationale,
      complexity,
      blastRadius,
      estimatedCostUsd,
      requiresCriticReview,
      requiresVerification,
    };
  }

  /**
   * Route multiple tasks, optimizing for total cost.
   */
  routeBatch(
    tasks: RunTask[],
    intent: IntentObject,
    contexts: Map<string, AssembledContext>
  ): RoutingDecision[] {
    return tasks.map((task) => {
      const context = contexts.get(task.id);
      if (!context) {
        throw new Error(`No context assembled for task ${task.id}`);
      }
      return this.route(task, intent, context);
    });
  }

  /**
   * Build a WorkerAssignment from a RoutingDecision.
   */
  buildAssignment(
    decision: RoutingDecision,
    task: RunTask,
    intent: IntentObject,
    context: AssembledContext,
    upstreamResults: WorkerAssignment["upstreamResults"] = []
  ): WorkerAssignment {
    return {
      task,
      intent,
      context,
      upstreamResults,
      tier: decision.tier,
      tokenBudget: decision.tokenBudget,
    };
  }

  // ─── Complexity Analysis ─────────────────────────────────────────

  analyzeComplexity(task: RunTask, context: AssembledContext): ComplexityAnalysis {
    const factors: ComplexityFactor[] = [];

    // Factor 1: File count
    const fileCount = task.targetFiles.length;
    factors.push({
      name: "file-count",
      score: Math.min(fileCount * 1.5, 10),
      weight: 0.2,
      reasoning: `${fileCount} target file(s)`,
    });

    // Factor 2: Context size (proxy for dependency complexity)
    const contextTokenRatio = context.totalTokens / context.budgetTotal;
    factors.push({
      name: "context-density",
      score: contextTokenRatio * 10,
      weight: 0.2,
      reasoning: `Context uses ${Math.round(contextTokenRatio * 100)}% of budget`,
    });

    // Factor 3: Task type complexity
    const typeComplexity: Record<string, number> = {
      scout: 3,
      builder: 6,
      critic: 5,
      verifier: 4,
      integrator: 7,
    };
    factors.push({
      name: "task-type",
      score: typeComplexity[task.workerType] ?? 5,
      weight: 0.25,
      reasoning: `Worker type "${task.workerType}"`,
    });

    // Factor 4: Description signals
    const desc = task.description.toLowerCase();
    let descScore = 5;
    if (/\b(simple|trivial|rename|typo)\b/.test(desc)) descScore = 2;
    if (/\b(complex|refactor|redesign|migrate)\b/.test(desc)) descScore = 8;
    if (/\b(security|auth|crypto)\b/.test(desc)) descScore = 9;
    factors.push({
      name: "description-signals",
      score: descScore,
      weight: 0.2,
      reasoning: `Task description complexity signals`,
    });

    // Factor 5: Multi-layer context needed
    const layersUsed = context.layers.filter((l) => l.files.length > 0).length;
    factors.push({
      name: "context-layers",
      score: Math.min(layersUsed * 2, 10),
      weight: 0.15,
      reasoning: `${layersUsed} context layers with content`,
    });

    const score = factors.reduce((sum, f) => sum + f.score * f.weight, 0);
    const suggestedTier: WorkerTier =
      score >= this.config.complexityThresholds.premium
        ? "premium"
        : score >= this.config.complexityThresholds.standard
          ? "standard"
          : "fast";

    return { score, factors, suggestedTier };
  }

  // ─── Blast Radius Analysis ───────────────────────────────────────

  analyzeBlastRadius(
    task: RunTask,
    intent: IntentObject,
    context: AssembledContext
  ): BlastRadiusAnalysis {
    const directFiles = task.targetFiles.length;

    // Count transitive files from dependency layer
    const depLayer = context.layers.find((l) => l.name === "dependencies");
    const transitiveFiles = depLayer?.files.length ?? 0;

    // Check for public API signals
    const affectsPublicApi = task.targetFiles.some(
      (f) =>
        f.includes("route") ||
        f.includes("api") ||
        f.includes("handler") ||
        f.includes("endpoint")
    );

    // Check for data layer signals
    const affectsDataLayer = task.targetFiles.some(
      (f) =>
        f.includes("migration") ||
        f.includes("schema") ||
        f.includes("model") ||
        f.includes("database") ||
        f.includes(".sql")
    );

    // Collect risk signals from intent constraints
    const riskSignals = intent.constraints
      .filter((c) => c.kind === "scope" || c.kind === "governance")
      .map((c) => c.description);

    // Determine level
    let level: BlastRadiusAnalysis["level"];
    if (directFiles + transitiveFiles <= 2) level = "contained";
    else if (transitiveFiles <= 5) level = "local";
    else if (transitiveFiles <= 15) level = "cross-module";
    else level = "system-wide";

    return {
      level,
      directFiles,
      transitiveFiles,
      affectsPublicApi,
      affectsDataLayer,
      riskSignals,
    };
  }

  // ─── Tier Selection ──────────────────────────────────────────────

  private selectTier(
    complexity: ComplexityAnalysis,
    blastRadius: BlastRadiusAnalysis,
    qualityBar: QualityBar
  ): WorkerTier {
    // Start with cheapest
    let tier: WorkerTier = "fast";

    // Escalate based on complexity
    if (complexity.score >= this.config.complexityThresholds.premium) {
      tier = "premium";
    } else if (complexity.score >= this.config.complexityThresholds.standard) {
      tier = this.maxTier(tier, "standard");
    }

    // Escalate based on blast radius
    const blastTier = this.config.blastRadiusEscalation[blastRadius.level];
    tier = this.maxTier(tier, blastTier);

    // Escalate based on quality bar minimum
    const qualityMinTier = this.config.qualityBarMinTier[qualityBar];
    tier = this.maxTier(tier, qualityMinTier);

    // Risk signals always escalate to at least standard
    if (blastRadius.riskSignals.length > 0) {
      tier = this.maxTier(tier, "standard");
    }

    // Public API or data layer → at least standard
    if (blastRadius.affectsPublicApi || blastRadius.affectsDataLayer) {
      tier = this.maxTier(tier, "standard");
    }

    return tier;
  }

  private maxTier(a: WorkerTier, b: WorkerTier): WorkerTier {
    const order: WorkerTier[] = ["fast", "standard", "premium"];
    return order[Math.max(order.indexOf(a), order.indexOf(b))];
  }

  private buildRationale(
    tier: WorkerTier,
    complexity: ComplexityAnalysis,
    blastRadius: BlastRadiusAnalysis,
    qualityBar: QualityBar
  ): string {
    const parts: string[] = [];

    parts.push(`Complexity: ${complexity.score.toFixed(1)}/10 → ${complexity.suggestedTier}`);
    parts.push(`Blast radius: ${blastRadius.level} (${blastRadius.directFiles} direct, ${blastRadius.transitiveFiles} transitive)`);
    parts.push(`Quality bar: ${qualityBar} → min tier ${this.config.qualityBarMinTier[qualityBar]}`);

    if (blastRadius.affectsPublicApi) parts.push("Escalated: affects public API");
    if (blastRadius.affectsDataLayer) parts.push("Escalated: affects data layer");
    if (blastRadius.riskSignals.length > 0) parts.push(`Risk signals: ${blastRadius.riskSignals.length}`);

    parts.push(`Final tier: ${tier}`);

    return parts.join(". ");
  }
}
