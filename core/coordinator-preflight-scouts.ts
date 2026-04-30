/**
 * Coordinator Preflight Scouts — run read-only scouts before
 * coordinator.submit() when evidence would improve target discovery.
 *
 * This is ADVISORY ONLY. The coordinator still validates paths,
 * scope violation detection still runs, and approval is still required.
 * If scout evidence conflicts with safety gates, safety wins.
 *
 * When to run:
 *   - Target discovery confidence is low
 *   - Prompt is large/multi-system
 *   - Loqui confidence is medium
 *   - Budget/profile permits
 *
 * When NOT to run:
 *   - Simple explicit task
 *   - Budget exhausted
 *   - local-smoke with deterministic-only allowed
 *   - Prompt is unsafe/vague (already blocked upstream)
 */

import { shouldSpawnScouts, type ScoutSpawnInput } from "./scout-spawn.js";
import { routeScout, type ScoutRoutingDecision } from "./scout-routing.js";
import { runScouts } from "./scout-agents.js";
import type { ScoutReport, ScoutSpawnDecision, ScoutReportType } from "./scout-report.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface PreflightScoutInput {
  /** The prompt being submitted to the coordinator */
  readonly prompt: string;
  /** Absolute repo path */
  readonly repoPath: string;
  /** Target files from initial target discovery (may be empty) */
  readonly discoveredTargets: readonly string[];
  /** Confidence of the initial target discovery (0–1) */
  readonly targetDiscoveryConfidence: number;
  /** Loqui intent confidence (0–1) */
  readonly intentConfidence?: number;
  /** Model profile */
  readonly modelProfile?: string;
  /** Whether cloud keys are available */
  readonly cloudKeysAvailable?: boolean;
  /** Remaining budget in USD */
  readonly remainingBudgetUsd?: number | null;
}

export interface PreflightScoutResult {
  /** Whether scouts were run */
  readonly scouted: boolean;
  /** Why scouts were or were not run */
  readonly reason: string;
  /** Scout-discovered advisory targets (append to existing targets) */
  readonly advisoryTargets: readonly string[];
  /** Scout-discovered advisory test files */
  readonly advisoryTests: readonly string[];
  /** Risks identified by scouts */
  readonly risks: readonly string[];
  /** Scout report IDs for receipt inclusion */
  readonly scoutReportIds: readonly string[];
  /** Routing decisions for transparency */
  readonly routing: readonly ScoutRoutingDecision[];
  /** Total scout cost */
  readonly costUsd: number;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Run preflight scouts if evidence would improve the build.
 * Returns advisory targets and risk signals for the coordinator
 * to consider alongside its own target discovery.
 */
export async function runPreflightScouts(
  input: PreflightScoutInput,
): Promise<PreflightScoutResult> {
  const {
    prompt,
    repoPath,
    discoveredTargets,
    targetDiscoveryConfidence,
  } = input;

  // Check if scouts should run
  const spawnInput: ScoutSpawnInput = {
    prompt,
    intentConfidence: input.intentConfidence,
    intent: "build",
    knownTargetFiles: discoveredTargets,
    isTaskPlanCreation: false,
    remainingBudgetUsd: input.remainingBudgetUsd,
    modelProfile: input.modelProfile,
    cloudKeysAvailable: input.cloudKeysAvailable,
  };

  const spawn = shouldSpawnScouts(spawnInput);

  // If spawn says no due to safety (unsafe/vague/budget), respect that —
  // never override a safety-motivated no-spawn with a low-confidence trigger.
  const safetyBlock =
    spawn.reason.includes("unsafe") ||
    spawn.reason.includes("vague") ||
    spawn.reason.includes("Budget");
  if (!spawn.spawn && safetyBlock) {
    return noScout(spawn.reason);
  }

  // Additional preflight-specific trigger: low target discovery confidence
  const lowConfidence = targetDiscoveryConfidence < 0.5 && discoveredTargets.length <= 1;
  if (!spawn.spawn && !lowConfidence) {
    return noScout(spawn.reason);
  }

  // If spawn didn't trigger but low confidence did, only run target_discovery
  const scoutTypes: ScoutReportType[] = spawn.spawn
    ? [...spawn.scoutTypes]
    : ["target_discovery"];

  // Route each type
  const routing: ScoutRoutingDecision[] = scoutTypes.map((type) =>
    routeScout({
      scoutType: type,
      modelProfile: input.modelProfile || "default",
      cloudKeysAvailable: Boolean(input.cloudKeysAvailable),
      repoFileCount: 0,
      promptLength: prompt.length,
    }),
  );

  // Only run deterministic/local scouts in preflight (cloud is too slow)
  const allowedTypes = scoutTypes.filter((_, i) => {
    const route = routing[i];
    return route.route === "deterministic" || route.route === "local";
  });

  if (allowedTypes.length === 0) {
    return noScout("No deterministic/local scouts available for preflight");
  }

  // Run scouts
  let reports: ScoutReport[] = [];
  try {
    reports = await runScouts({
      repoPath,
      prompt,
      scoutTypes: allowedTypes,
      targetFiles: discoveredTargets as string[],
    });
  } catch (err) {
    return noScout(`Scout execution failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Aggregate results
  const advisoryTargets = new Set<string>();
  const advisoryTests = new Set<string>();
  const risks = new Set<string>();
  const reportIds: string[] = [];
  let cost = 0;

  for (const report of reports) {
    reportIds.push(report.scoutId);
    cost += report.costUsd;
    for (const t of report.recommendedTargets) advisoryTargets.add(t);
    for (const t of report.recommendedTests) advisoryTests.add(t);
    for (const r of report.risks) risks.add(r);
  }

  return {
    scouted: true,
    reason: spawn.spawn ? spawn.reason : "low target discovery confidence",
    advisoryTargets: [...advisoryTargets],
    advisoryTests: [...advisoryTests],
    risks: [...risks],
    scoutReportIds: reportIds,
    routing,
    costUsd: cost,
  };
}

function noScout(reason: string): PreflightScoutResult {
  return {
    scouted: false,
    reason,
    advisoryTargets: [],
    advisoryTests: [],
    risks: [],
    scoutReportIds: [],
    routing: [],
    costUsd: 0,
  };
}
