/**
 * Mission Mode — unified high-level workflow for Aedis.
 *
 * User gives one objective → Aedis scouts → proposes plan → user
 * approves → Aedis executes step-by-step → diagnoses/repairs →
 * pauses only for approval/blockers/budgets → summarizes result.
 *
 * Mission Mode composes existing primitives:
 *   - Plan Assist + Scouts → proposal
 *   - TaskPlan → execution tracking
 *   - TaskLoopRunner → step-by-step execution
 *   - RepairDiagnosis → failure intelligence
 *   - Timeline → live visibility
 *
 * Safety:
 *   - Vague prompt → clarify, not mission
 *   - Unsafe prompt → block
 *   - Cloud use → visible before start
 *   - Mission start != approval/promotion
 *   - Approval still required for source changes
 *   - Target repo clean before promotion
 *   - No silent scope expansion
 */

import {
  detectPlanAssistWithScouts,
  type PlanAssistWithScoutsResult,
  type ScoutEvidenceSummary,
} from "./plan-assist-with-scouts.js";
import type { PlanSuggestion, SuggestedSubtask, PlanAssistRisk } from "./plan-assist.js";
import type { ScoutRoutingDecision } from "./scout-routing.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface MissionProposalSubtask {
  readonly title: string;
  readonly prompt: string;
  readonly risk: PlanAssistRisk;
  readonly scope: string;
  readonly reason: string;
}

export interface MissionProposal {
  readonly kind: "mission_proposal";
  readonly objective: string;
  readonly subtasks: readonly MissionProposalSubtask[];
  readonly scoutSummary: MissionScoutSummary | null;
  readonly riskLevel: PlanAssistRisk;
  readonly estimatedCostRange: string;
  readonly modelProfile: string;
  readonly cloudDisclosure: string;
  readonly approvalReminder: string;
  readonly confidence: number;
  readonly signals: readonly string[];
  readonly reason: string;
}

export interface MissionClarify {
  readonly kind: "mission_clarify";
  readonly question: string;
  readonly reason: string;
}

export interface MissionBlock {
  readonly kind: "mission_block";
  readonly reason: string;
}

export interface MissionSkip {
  readonly kind: "mission_skip";
  readonly reason: string;
}

export type MissionProposalResult =
  | MissionProposal
  | MissionClarify
  | MissionBlock
  | MissionSkip;

export interface MissionScoutSummary {
  readonly spawned: boolean;
  readonly reportCount: number;
  readonly recommendedTargets: readonly string[];
  readonly recommendedTests: readonly string[];
  readonly risks: readonly string[];
  readonly routing: readonly { route: string; model: string; provider: string; reason: string; cost: number }[];
  readonly totalCostUsd: number;
}

// ─── Public API ──────────────────────────────────────────────────────

export interface ProposeMissionInput {
  readonly objective: string;
  readonly repoPath: string;
  readonly modelProfile?: string;
  readonly cloudKeysAvailable?: boolean;
}

/**
 * Propose a mission from a high-level objective.
 * Runs scouts, generates subtasks, assesses risk.
 * Does NOT create a TaskPlan or start execution.
 */
export async function proposeMission(
  input: ProposeMissionInput,
): Promise<MissionProposalResult> {
  const { objective, repoPath } = input;
  const trimmed = (objective ?? "").trim();

  if (!trimmed) {
    return { kind: "mission_skip", reason: "empty objective" };
  }

  // Run Plan Assist + Scouts
  const { planResult, scoutEvidence } = await detectPlanAssistWithScouts({
    prompt: trimmed,
    repoPath,
    modelProfile: input.modelProfile,
    cloudKeysAvailable: input.cloudKeysAvailable,
  });

  // Map Plan Assist results to Mission results
  switch (planResult.kind) {
    case "block":
      return {
        kind: "mission_block",
        reason: planResult.reason,
      };

    case "clarify":
      return {
        kind: "mission_clarify",
        question: planResult.question,
        reason: planResult.reason,
      };

    case "skip":
      // Plan Assist says this isn't plan-worthy, but Mission Mode
      // should still try to propose — a single-step mission is valid.
      // Fall through to build a single-subtask proposal.
      return buildSingleStepMission(trimmed, scoutEvidence, input);

    case "plan_suggestion":
      return buildMissionProposal(planResult, scoutEvidence, input);
  }
}

// ─── Proposal Construction ───────────────────────────────────────────

function buildMissionProposal(
  plan: PlanSuggestion,
  evidence: ScoutEvidenceSummary | null,
  input: ProposeMissionInput,
): MissionProposal {
  const scoutSummary = evidence ? buildScoutSummary(evidence) : null;

  // Overall risk: highest subtask risk
  const riskLevel = highestRisk(plan.subtasks);

  // Cost/cloud disclosure
  const profile = input.modelProfile || "default";
  const cloudUsed = evidence?.routing?.some((r) => r.route === "cloud") ?? false;
  const scoutCost = evidence?.totalCostUsd ?? 0;
  const estimatedCostRange = estimateCostRange(plan.subtasks.length, profile, cloudUsed);

  const cloudDisclosure = cloudUsed
    ? `Cloud model used for scout analysis. Provider/cost visible in scout summary.`
    : profile === "local-smoke"
      ? "All processing uses local models (local-smoke profile). No cloud calls."
      : "No cloud models used. All scouts ran locally/deterministically.";

  return {
    kind: "mission_proposal",
    objective: plan.objective,
    subtasks: plan.subtasks.map(toMissionSubtask),
    scoutSummary,
    riskLevel,
    estimatedCostRange,
    modelProfile: profile,
    cloudDisclosure,
    approvalReminder:
      "Starting this mission creates a task plan but does NOT approve or promote any changes. " +
      "Each subtask runs through the full safety pipeline. " +
      "You will be asked to approve before any changes reach your source repo.",
    confidence: plan.confidence,
    signals: [...plan.signals],
    reason: plan.reason,
  };
}

function buildSingleStepMission(
  objective: string,
  evidence: ScoutEvidenceSummary | null,
  input: ProposeMissionInput,
): MissionProposal {
  const scoutSummary = evidence?.spawned ? buildScoutSummary(evidence) : null;
  const profile = input.modelProfile || "default";

  return {
    kind: "mission_proposal",
    objective,
    subtasks: [{
      title: objective.length <= 60 ? objective : objective.slice(0, 57) + "...",
      prompt: objective,
      risk: "low",
      scope: scoutSummary?.recommendedTargets?.[0] ?? "unknown",
      reason: "Single-step mission from direct objective",
    }],
    scoutSummary,
    riskLevel: "low",
    estimatedCostRange: estimateCostRange(1, profile, false),
    modelProfile: profile,
    cloudDisclosure: profile === "local-smoke"
      ? "All processing uses local models (local-smoke profile)."
      : "No cloud models used.",
    approvalReminder:
      "Starting this mission creates a task plan but does NOT approve or promote any changes. " +
      "Approval is required before any changes reach your source repo.",
    confidence: 0.5,
    signals: ["single-step-mission"],
    reason: "Direct objective mapped to single-step mission",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function buildScoutSummary(evidence: ScoutEvidenceSummary): MissionScoutSummary {
  return {
    spawned: evidence.spawned,
    reportCount: evidence.reports.length,
    recommendedTargets: [...evidence.recommendedTargets],
    recommendedTests: [...evidence.recommendedTests],
    risks: [...evidence.risks],
    routing: evidence.routing.map((r) => ({
      route: r.route,
      model: r.model,
      provider: r.provider,
      reason: r.reason,
      cost: r.estimatedCostUsd,
    })),
    totalCostUsd: evidence.totalCostUsd,
  };
}

function toMissionSubtask(sub: SuggestedSubtask): MissionProposalSubtask {
  return {
    title: sub.title,
    prompt: sub.prompt,
    risk: sub.risk,
    scope: sub.scope,
    reason: sub.reason,
  };
}

function highestRisk(subtasks: readonly SuggestedSubtask[]): PlanAssistRisk {
  let max: PlanAssistRisk = "low";
  for (const sub of subtasks) {
    if (sub.risk === "high") return "high";
    if (sub.risk === "medium") max = "medium";
  }
  return max;
}

function estimateCostRange(
  subtaskCount: number,
  profile: string,
  cloudUsed: boolean,
): string {
  if (profile === "local-smoke") return "$0.00 (local models only)";
  // Conservative per-subtask estimate
  const perSubtask = cloudUsed ? 0.02 : 0.005;
  const low = (subtaskCount * perSubtask * 0.5).toFixed(2);
  const high = (subtaskCount * perSubtask * 2).toFixed(2);
  return `$${low} – $${high} estimated`;
}
