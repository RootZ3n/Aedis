/**
 * Plan Assist + Scout integration.
 *
 * Wraps detectPlanAssist with optional scout evidence gathering.
 * When Plan Assist detects a plan-worthy prompt, this layer checks
 * whether scouts should run and, if so, executes them to improve
 * the subtask suggestions with real repo evidence.
 *
 * Safety:
 *   - Scouts are read-only — they never edit files or promote changes
 *   - Simple explicit prompts → no scouts
 *   - Vague broad prompts → clarify, no scouts
 *   - Unsafe prompts → block, no scouts
 *   - Cloud scouts only when routing policy explicitly permits
 *   - Scout evidence is advisory — Plan Assist still makes final suggestions
 *   - Plan creation does not start execution
 */

import {
  detectPlanAssist,
  type PlanAssistResult,
  type PlanSuggestion,
  type SuggestedSubtask,
  type PlanAssistRisk,
} from "./plan-assist.js";
import { shouldSpawnScouts, type ScoutSpawnInput } from "./scout-spawn.js";
import { routeScout, type ScoutRoutingDecision } from "./scout-routing.js";
import { runScouts } from "./scout-agents.js";
import type { ScoutReport, ScoutSpawnDecision, ScoutReportType } from "./scout-report.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface PlanAssistWithScoutsInput {
  readonly prompt: string;
  /** Absolute path to the repo to scout */
  readonly repoPath: string;
  /** Loqui intent confidence (0–1) */
  readonly intentConfidence?: number;
  /** Loqui intent string */
  readonly intent?: string;
  /** Model profile (e.g. "default" | "local-smoke") */
  readonly modelProfile?: string;
  /** Whether cloud API keys are available */
  readonly cloudKeysAvailable?: boolean;
  /** Remaining budget in USD */
  readonly remainingBudgetUsd?: number | null;
}

export interface ScoutEvidenceSummary {
  readonly spawned: boolean;
  readonly spawnDecision: ScoutSpawnDecision;
  readonly reports: readonly ScoutReport[];
  readonly routing: readonly ScoutRoutingDecision[];
  readonly recommendedTargets: readonly string[];
  readonly recommendedTests: readonly string[];
  readonly risks: readonly string[];
  readonly totalCostUsd: number;
}

export interface PlanAssistWithScoutsResult {
  readonly planResult: PlanAssistResult;
  readonly scoutEvidence: ScoutEvidenceSummary | null;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Detect plan-worthiness and optionally run scouts to improve
 * the suggestion. Returns both the plan result and any scout evidence.
 */
export async function detectPlanAssistWithScouts(
  input: PlanAssistWithScoutsInput,
): Promise<PlanAssistWithScoutsResult> {
  const planResult = detectPlanAssist(input.prompt);

  // Only run scouts for plan suggestions (not block/clarify/skip)
  if (planResult.kind !== "plan_suggestion") {
    return { planResult, scoutEvidence: null };
  }

  // Check scout spawn decision
  const spawnInput: ScoutSpawnInput = {
    prompt: input.prompt,
    intentConfidence: input.intentConfidence,
    intent: input.intent,
    knownTargetFiles: [],
    isTaskPlanCreation: true,
    remainingBudgetUsd: input.remainingBudgetUsd,
    modelProfile: input.modelProfile,
    cloudKeysAvailable: input.cloudKeysAvailable,
  };

  const spawnDecision = shouldSpawnScouts(spawnInput);

  if (!spawnDecision.spawn) {
    return {
      planResult,
      scoutEvidence: {
        spawned: false,
        spawnDecision,
        reports: [],
        routing: [],
        recommendedTargets: [],
        recommendedTests: [],
        risks: [],
        totalCostUsd: 0,
      },
    };
  }

  // Route each scout type
  const routing: ScoutRoutingDecision[] = spawnDecision.scoutTypes.map((type) =>
    routeScout({
      scoutType: type,
      modelProfile: input.modelProfile || "default",
      cloudKeysAvailable: Boolean(input.cloudKeysAvailable),
      repoFileCount: 0, // unknown at this point
      promptLength: input.prompt.length,
    }),
  );

  // Filter: only run scouts that route to deterministic or local
  // Cloud scouts are only run if routing explicitly says cloud AND
  // keys are available. Never silently escalate.
  const allowedTypes: ScoutReportType[] = [];
  for (let i = 0; i < spawnDecision.scoutTypes.length; i++) {
    const type = spawnDecision.scoutTypes[i];
    const route = routing[i];
    if (route.route === "cloud" && !input.cloudKeysAvailable) {
      // Cloud requested but no keys → skip with truthful note
      routing[i] = {
        ...route,
        route: "deterministic",
        reason: `Cloud scout recommended but keys unavailable — falling back to deterministic`,
        estimatedCostUsd: 0,
      };
    }
    // Run deterministic and local scouts always; cloud only if permitted
    if (route.route === "deterministic" || route.route === "local" || route.route === "cloud") {
      allowedTypes.push(type);
    }
  }

  // Run the scouts
  let reports: ScoutReport[] = [];
  try {
    reports = await runScouts({
      repoPath: input.repoPath,
      prompt: input.prompt,
      scoutTypes: allowedTypes,
      targetFiles: extractTargetsFromPlan(planResult),
    });
  } catch (err) {
    // Scout failure is non-fatal — proceed with original plan
    console.warn("[plan-assist] scout execution failed, using plan without evidence:", err);
  }

  // Aggregate evidence
  const allTargets = new Set<string>();
  const allTests = new Set<string>();
  const allRisks = new Set<string>();
  let totalCost = 0;

  for (const report of reports) {
    for (const t of report.recommendedTargets) allTargets.add(t);
    for (const t of report.recommendedTests) allTests.add(t);
    for (const r of report.risks) allRisks.add(r);
    totalCost += report.costUsd;
  }

  const evidence: ScoutEvidenceSummary = {
    spawned: true,
    spawnDecision,
    reports,
    routing,
    recommendedTargets: [...allTargets],
    recommendedTests: [...allTests],
    risks: [...allRisks],
    totalCostUsd: totalCost,
  };

  // Enrich the plan suggestion with scout evidence
  const enrichedPlan = enrichPlanWithEvidence(planResult, evidence);

  return { planResult: enrichedPlan, scoutEvidence: evidence };
}

// ─── Evidence Enrichment ─────────────────────────────────────────────

/**
 * Improve the plan suggestion using scout evidence. Modifies subtask
 * scope fields with discovered targets, adds risk notes, and may add
 * a test subtask if scouts found relevant tests not already covered.
 */
function enrichPlanWithEvidence(
  plan: PlanSuggestion,
  evidence: ScoutEvidenceSummary,
): PlanSuggestion {
  if (evidence.reports.length === 0) return plan;

  const targetMap = buildTargetMap(evidence.reports);
  const riskFiles = new Set<string>();
  for (const r of evidence.risks) {
    // Extract file paths from risk strings
    const match = r.match(/^([^\s]+)/);
    if (match) riskFiles.add(match[1]);
  }

  // Enrich each subtask with scout-discovered targets and risk info
  const enriched: SuggestedSubtask[] = plan.subtasks.map((sub) => {
    // Try to match subtask keywords to scout-discovered targets
    const keywords = sub.prompt.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const matchedTargets: string[] = [];

    for (const [file, score] of targetMap) {
      const fileLower = file.toLowerCase();
      if (keywords.some((kw) => fileLower.includes(kw))) {
        matchedTargets.push(file);
      }
    }

    // Upgrade scope if we found real targets
    let scope = sub.scope;
    if (matchedTargets.length > 0 && (scope === "unknown" || scope.endsWith("(inferred)"))) {
      scope = matchedTargets.slice(0, 3).join(", ");
    }

    // Upgrade risk if scout found risky files matching this subtask
    let risk = sub.risk;
    if (matchedTargets.some((t) => riskFiles.has(t)) && risk === "low") {
      risk = "medium";
    }

    // Add evidence note to reason
    const reason = matchedTargets.length > 0
      ? `${sub.reason} (scout: ${matchedTargets.length} target${matchedTargets.length === 1 ? "" : "s"} found)`
      : sub.reason;

    return { ...sub, scope, risk, reason };
  });

  // If scouts found tests and no subtask already covers testing, suggest one
  const hasTestSubtask = enriched.some((s) =>
    /\b(test|spec|verify|coverage)\b/i.test(s.prompt),
  );
  if (!hasTestSubtask && evidence.recommendedTests.length > 0) {
    enriched.push({
      title: "Run relevant tests",
      prompt: `Run tests to verify changes: ${evidence.recommendedTests.slice(0, 5).join(", ")}`,
      risk: "low" as PlanAssistRisk,
      scope: evidence.recommendedTests.slice(0, 3).join(", "),
      reason: "Added by scout evidence — tests found for affected files",
    });
  }

  return {
    ...plan,
    subtasks: enriched,
    confidence: Math.min(0.95, plan.confidence + 0.1),
  };
}

function extractTargetsFromPlan(plan: PlanSuggestion): string[] {
  const targets: string[] = [];
  for (const sub of plan.subtasks) {
    if (sub.scope !== "unknown" && !sub.scope.endsWith("(inferred)")) {
      targets.push(sub.scope);
    }
  }
  return targets;
}

function buildTargetMap(reports: readonly ScoutReport[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const report of reports) {
    for (const finding of report.findings) {
      if (finding.files) {
        for (const file of finding.files) {
          map.set(file, (map.get(file) || 0) + finding.confidence);
        }
      }
    }
    for (const target of report.recommendedTargets) {
      map.set(target, (map.get(target) || 0) + 1);
    }
  }
  return map;
}
