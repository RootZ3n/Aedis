/**
 * Dry Run Planner — Preflight + Dry Run System v1.
 *
 * Produces a structured plan of what Aedis *would* do for a given
 * request, without dispatching any worker or writing any file.
 * Composes the existing planning primitives:
 *
 *   preflight → CharterGenerator → classifyScope → createChangeSet
 *     → planChangeSet → estimateBlastRadius → cost estimate
 *     → predictive confidence
 *
 * The dry-run is the single source of truth for the user question
 * "what would you do?" — it is deterministic, inspectable, and
 * shares every planning primitive the Coordinator uses at runtime,
 * so the plan the user sees in a dry-run matches what would
 * actually happen if they submitted the same request.
 *
 * No Coordinator refactor: the dry-run instantiates its own
 * CharterGenerator and stitches the exported pure functions
 * together. `core/coordinator.ts` is untouched.
 */

import { randomUUID } from "node:crypto";
import { CharterGenerator } from "./charter.js";
import { createIntent } from "./intent.js";
import { classifyScope, type ScopeClassification } from "./scope-classifier.js";
import { createChangeSet } from "./change-set.js";
import { planChangeSet, type Plan } from "./multi-file-planner.js";
import { estimateBlastRadius, type BlastRadiusEstimate } from "./blast-radius.js";
import { runPreflight, type PreflightReport } from "./preflight.js";
import { scanInput as velumScanInput, type VelumResult } from "./velum-input.js";
import { classifyTask, type ImpactClassification } from "./impact-classifier.js";

// ─── Types ───────────────────────────────────────────────────────────

export type DryRunStage =
  | "preflight"
  | "charter"
  | "scout"
  | "builder"
  | "critic"
  | "verifier"
  | "integrator";

export interface DryRunStep {
  readonly stage: DryRunStage;
  readonly description: string;
  /** Tool / model / subsystem this stage would invoke. */
  readonly tools: readonly string[];
  /** Files this stage would touch. Empty when the stage is global. */
  readonly targetFiles: readonly string[];
}

export interface DryRunCostEstimate {
  /** Cheapest plausible cost in USD. */
  readonly minUsd: number;
  /** Most expensive plausible cost in USD. */
  readonly maxUsd: number;
  /** Human-readable display string, e.g. "$0.02 – $0.08". */
  readonly display: string;
  /** Back-of-envelope token budget used for the estimate. */
  readonly assumedTokens: number;
}

export interface DryRunConfidenceBreakdown {
  /** 0–1 overall confidence in the plan's likely success. */
  readonly overall: number;
  /** Confidence that planning itself is sound. */
  readonly planning: number;
  /** Predictive confidence that the planned changes will land. */
  readonly execution: number;
  /** Predictive confidence that verification will pass. */
  readonly verification: number;
  /** Per-line basis strings, for UI tooltips. */
  readonly basis: readonly string[];
}

export interface DryRunPlan {
  readonly preflight: PreflightReport;
  /** The ordered list of steps Aedis would take. */
  readonly steps: readonly DryRunStep[];
  /** Files Aedis believes it would touch. Best-effort. */
  readonly filesLikelyTouched: readonly string[];
  /** Risk level from the blast radius estimator. */
  readonly riskLevel: "low" | "medium" | "high";
  /** Full blast radius estimate. */
  readonly blastRadius: BlastRadiusEstimate;
  /** Scope classification (type, raw score, decompose flag). */
  readonly scope: ScopeClassification;
  /** Cost estimate range. */
  readonly estimatedCost: DryRunCostEstimate;
  /** Predictive confidence breakdown. */
  readonly confidence: DryRunConfidenceBreakdown;
  /** One-sentence headline suitable for UI display. */
  readonly headline: string;
  /** Multi-sentence narrative in plain English. */
  readonly narrative: string;
  /**
   * True when preflight blocked the plan. `steps`, `filesLikelyTouched`,
   * and `estimatedCost` will still be populated so the UI can show
   * what *would* have been planned, but the request must be fixed
   * before execution.
   */
  readonly blocked: boolean;
  /**
   * True when the plan was generated successfully (charter produced
   * deliverables, changeset was built, planner ran). A dry-run that
   * fails to produce any steps (e.g. empty charter) returns false.
   */
  readonly ok: boolean;
  /**
   * Preview of the Velum input guard decision for this prompt.
   * Marked `estimated` because the runtime Velum scanner may see a
   * slightly different prompt (after prompt normalization + gated
   * memory notes). In practice the preview matches the runtime
   * decision for block/allow/review on untrusted prompts.
   */
  readonly velumPreview: VelumPreview;
  /**
   * Preview of the impact classification and therefore whether
   * runtime execution would require approval. Mirrors the
   * governance gate the Coordinator applies in submit().
   */
  readonly approvalPreview: ApprovalPreview;
}

export interface VelumPreview {
  readonly decision: VelumResult["decision"];
  readonly reasons: readonly string[];
  readonly flags: readonly string[];
  /**
   * True when Velum would stop execution before any worker runs.
   * Lumen / CLI should refuse dispatch when this is true.
   */
  readonly wouldBlock: boolean;
  readonly estimated: true;
}

export interface ApprovalPreview {
  readonly impactLevel: ImpactClassification["level"];
  readonly reasons: readonly string[];
  /** True when impact=high OR scope governance forces approval. */
  readonly approvalRequired: boolean;
  readonly estimated: true;
}

export interface DryRunInput {
  readonly input: string;
  readonly projectRoot: string;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Generate a dry-run plan for a user request. Does not call workers,
 * does not write files, does not hit the network beyond what the
 * existing planning primitives already do (which is nothing — they
 * are all pure functions over strings and file stats).
 *
 * On a blocked preflight the function still returns a partial plan:
 * everything the planner could compute from the inputs is included
 * so the UI can show the user what *would* have happened. The
 * caller is responsible for refusing to dispatch when `blocked`
 * is true.
 */
export function generateDryRun(input: DryRunInput): DryRunPlan {
  const raw = (input.input ?? "").trim();
  const charterGen = new CharterGenerator();

  // Step 0: Velum preview — compute this unconditionally so the
  // caller can see whether the runtime guard would block before
  // any other planning state matters. Does not mutate anything.
  const velumResult = velumScanInput(raw);
  const velumPreview: VelumPreview = {
    decision: velumResult.decision,
    reasons: velumResult.reasons,
    flags: velumResult.flags,
    wouldBlock: velumResult.decision === "block",
    estimated: true,
  };

  // Step 1: charter analysis — cheap, deterministic. Runs even
  // on a likely-blocked request so the UI can show what Aedis
  // parsed out of the prompt.
  const analysis = charterGen.analyzeRequest(raw || "(empty request)");

  // Step 2: preflight — uses the analysis output for ambiguities
  // and targets. Pure function plus stat() probes.
  const preflight = runPreflight({
    input: raw,
    projectRoot: input.projectRoot,
    extractedTargets: analysis.targets,
    ambiguities: analysis.ambiguities,
  });

  // Step 3: charter generation + scope classification. Wrapped
  // in try/catch so a single malformed request does not blow up
  // the whole dry-run pipeline — we downgrade to a skeletal plan
  // and surface the error as a preflight-style block.
  let charter;
  let scope: ScopeClassification;
  let plan: Plan;
  let charterTargets: string[] = [];
  try {
    charter = charterGen.generateCharter(analysis);
    charterTargets = Array.from(
      new Set(charter.deliverables.flatMap((d) => [...d.targetFiles])),
    );
    scope = classifyScope(raw, charterTargets);
    // Intent is only needed to feed createChangeSet, which expects
    // an immutable intent object. We mint one here with a throwaway
    // run id — none of this is persisted.
    const intent = createIntent({
      runId: randomUUID(),
      userRequest: raw,
      charter,
      constraints: charterGen.generateDefaultConstraints(analysis),
    });
    const changeSet = createChangeSet(intent, charterTargets);
    plan = planChangeSet(changeSet, raw);
  } catch (err) {
    // Charter / planner threw. Return a minimal plan with the
    // error surfaced as a block finding so the caller can show
    // the user what went wrong.
    const message = err instanceof Error ? err.message : String(err);
    return minimalBlockedPlan({
      preflight,
      extraBlock: {
        code: "charter-error",
        message: `Charter / planner raised an error: ${message}`,
        suggestion:
          "Rephrase the request with a concrete target (\"in core/foo.ts, add X\").",
      },
      rawTargets: analysis.targets,
      rawPrompt: raw,
      velumPreview,
    });
  }

  // Step 4: blast radius — already grounded in scope classification.
  const blastRadius = estimateBlastRadius({
    scopeClassification: scope,
    charterFileCount: charterTargets.length,
    prompt: raw,
  });

  // Step 5: steps — one per pipeline stage, derived from the plan.
  const steps = buildSteps({
    preflight,
    charter: charter.objective,
    plan,
    charterTargets,
  });

  // Step 6: cost estimate — rough range grounded in the charter's
  // file count and the planner's wave count. Real costs come from
  // the coordinator run; this is a back-of-envelope projection so
  // the user knows the order of magnitude before committing.
  const estimatedCost = estimateCost({
    charterTargets,
    planWaves: plan.waves.length,
    qualityBar: charter.qualityBar,
  });

  // Step 7: predictive confidence — a pre-execution variant of
  // the post-run confidence scoring. Uses the same ranges as the
  // runtime scorer but reads from the planning-time signals only.
  const confidence = predictiveConfidence({
    scope,
    preflight,
    blastRadius,
    planWaves: plan.waves.length,
  });

  // Step 8: narrative + headline for UI display.
  const headline = buildHeadline({
    blocked: preflight.blocked,
    charterTargets,
    steps,
    confidence,
    scope,
  });
  const narrative = buildNarrative({
    preflight,
    charterObjective: charter.objective,
    steps,
    filesLikelyTouched: charterTargets,
    blastRadius,
    estimatedCost,
    confidence,
  });

  // Approval preview — impact classifier output + scope governance.
  // Mirrors the Coordinator gate at runtime so callers can show
  // "would require approval" before submission.
  const impact = classifyTask(raw, charterTargets);
  const approvalPreview: ApprovalPreview = {
    impactLevel: impact.level,
    reasons: impact.reasons,
    approvalRequired: impact.level === "high" || scope.governance.approvalRequired,
    estimated: true,
  };

  return {
    preflight,
    steps,
    filesLikelyTouched: charterTargets,
    riskLevel: blastRadius.level,
    blastRadius,
    scope,
    estimatedCost,
    confidence,
    headline,
    narrative,
    // Velum is authoritative for blocking — if the preview says block,
    // the plan is blocked regardless of preflight verdict.
    blocked: preflight.blocked || velumPreview.wouldBlock,
    ok: !preflight.blocked && !velumPreview.wouldBlock && steps.length > 0,
    velumPreview,
    approvalPreview,
  };
}

// ─── Step assembly ──────────────────────────────────────────────────

function buildSteps(input: {
  preflight: PreflightReport;
  charter: string;
  plan: Plan;
  charterTargets: string[];
}): DryRunStep[] {
  const steps: DryRunStep[] = [];

  steps.push({
    stage: "preflight",
    description:
      input.preflight.blocked
        ? `Preflight would BLOCK: ${input.preflight.summary}`
        : input.preflight.hasWarnings
          ? `Preflight would pass with ${input.preflight.findings.filter((f) => f.severity === "warn").length} warning(s)`
          : "Preflight would pass cleanly",
    tools: ["preflight-validator"],
    targetFiles: [],
  });

  steps.push({
    stage: "charter",
    description: `Lock intent: ${truncate(input.charter, 120)}`,
    tools: ["charter-generator", "intent-builder"],
    targetFiles: input.charterTargets,
  });

  steps.push({
    stage: "scout",
    description:
      input.charterTargets.length > 0
        ? `Scout would read ${input.charterTargets.length} target file(s) and assess risk`
        : "Scout would gather context against the target directory seed",
    tools: ["scout-worker", "repo-index"],
    targetFiles: input.charterTargets,
  });

  if (input.plan.waves.length === 0) {
    steps.push({
      stage: "builder",
      description: "Builder would apply changes in a single pass (no multi-file plan)",
      tools: ["builder-worker", "diff-applier"],
      targetFiles: input.charterTargets,
    });
  } else {
    input.plan.waves.forEach((wave, idx) => {
      steps.push({
        stage: "builder",
        description: `Wave ${wave.id} (${wave.name || `stage ${idx + 1}`}): builder would touch ${wave.files.length} file(s)`,
        tools: ["builder-worker", "diff-applier"],
        targetFiles: wave.files,
      });
    });
  }

  steps.push({
    stage: "critic",
    description: "Critic would review builder output for scope, coherence, and regressions",
    tools: ["critic-worker"],
    targetFiles: input.charterTargets,
  });

  steps.push({
    stage: "verifier",
    description: "Verifier requires real lint + typecheck + test hooks and fails closed if any required check is missing",
    tools: ["verifier-pipeline", "tsc", "lint", "test-runner"],
    targetFiles: input.charterTargets,
  });

  steps.push({
    stage: "integrator",
    description: "Integrator would assemble the merged changeset and evaluate the merge gate",
    tools: ["integrator-worker", "merge-gate", "integration-judge"],
    targetFiles: input.charterTargets,
  });

  return steps;
}

// ─── Cost estimate ──────────────────────────────────────────────────

/**
 * Rough back-of-envelope cost model. Produces a min/max range so
 * users see the order of magnitude, not a single false-precision
 * number. Tuned against real run observations from prior
 * Coordinator runs — small single-file fixes come in under a
 * penny, multi-file refactors sit in the 5–25 cent range, and
 * architectural changes can run to a dollar or more.
 */
function estimateCost(input: {
  charterTargets: readonly string[];
  planWaves: number;
  qualityBar: "minimal" | "standard" | "hardened";
}): DryRunCostEstimate {
  const fileCount = Math.max(1, input.charterTargets.length);
  const waves = Math.max(1, input.planWaves);

  // Rough per-file budgets in tokens. Builder dominates — it
  // reads the file, the model produces a patch, and the critic
  // re-reads. Verification is local and free.
  const tokensPerFile = 3_500;
  const assumedTokens = fileCount * tokensPerFile * Math.max(1, Math.min(waves, 3));

  // Rough price per 1k tokens for the cheap-vs-premium path. The
  // cheap path is qwen3.6-plus via ModelStudio (~$0.001/1k); the
  // premium path is Sonnet / GPT-5 class models (~$0.012/1k
  // blended in/out). These are deliberate under/over-estimates
  // to bracket the real cost.
  const qualityMultiplier =
    input.qualityBar === "hardened" ? 1.6 : input.qualityBar === "minimal" ? 0.5 : 1.0;

  const minUsd = round4((assumedTokens / 1000) * 0.001 * qualityMultiplier);
  const maxUsd = round4((assumedTokens / 1000) * 0.015 * qualityMultiplier);

  return {
    minUsd,
    maxUsd,
    assumedTokens,
    display: formatCostRange(minUsd, maxUsd),
  };
}

function formatCostRange(minUsd: number, maxUsd: number): string {
  const fmt = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
  if (minUsd === maxUsd) return fmt(minUsd);
  return `${fmt(minUsd)} – ${fmt(maxUsd)}`;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ─── Predictive confidence ──────────────────────────────────────────

/**
 * Pre-execution confidence. Reads ONLY the planning signals — no
 * receipt, no gate, no verification. Used to tell the user "this
 * plan looks clean (high confidence)" vs. "this plan is ambiguous
 * and sprawling (low confidence)" before they commit to running.
 */
function predictiveConfidence(input: {
  scope: ScopeClassification;
  preflight: PreflightReport;
  blastRadius: BlastRadiusEstimate;
  planWaves: number;
}): DryRunConfidenceBreakdown {
  const basis: string[] = [];

  let planning = 0.5;
  switch (input.scope.type) {
    case "single-file":
      planning = 0.9;
      basis.push("planning:single-file scope → 0.90");
      break;
    case "small-linked":
      planning = 0.8;
      basis.push("planning:small-linked scope → 0.80");
      break;
    case "multi-file":
      planning = 0.72;
      basis.push("planning:multi-file scope → 0.72");
      break;
    case "architectural":
      planning = 0.42;
      basis.push("planning:architectural scope → 0.42");
      break;
    case "migration":
      planning = 0.38;
      basis.push("planning:migration scope → 0.38");
      break;
    case "cross-cutting-sweep":
      planning = 0.28;
      basis.push("planning:cross-cutting-sweep scope → 0.28");
      break;
  }
  if (input.scope.recommendDecompose) {
    planning = Math.max(0, planning - 0.1);
    basis.push("planning:decompose-recommended → -0.10");
  }
  if (input.preflight.blocked) {
    planning = Math.max(0, planning - 0.4);
    basis.push("planning:preflight-blocked → -0.40");
  } else if (input.preflight.hasWarnings) {
    planning = Math.max(0, planning - 0.08);
    basis.push("planning:preflight-warnings → -0.08");
  }

  // Predictive execution: how likely is the builder to land real
  // changes? Higher for narrow scopes, lower for wide ones.
  let execution = 0.5;
  if (input.scope.type === "single-file") execution = 0.78;
  if (input.scope.type === "small-linked") execution = 0.68;
  if (input.scope.type === "multi-file") execution = 0.6;
  if (input.scope.type === "architectural") execution = 0.38;
  if (input.scope.type === "migration") execution = 0.34;
  if (input.scope.type === "cross-cutting-sweep") execution = 0.24;
  if (input.blastRadius.level === "high") execution = Math.max(0.2, execution - 0.15);
  if (input.preflight.blocked) execution = Math.max(0, execution - 0.4);
  basis.push(`execution:predictive by scope+blast → ${execution.toFixed(2)}`);

  // Predictive verification: rough proxy — single-file changes
  // with clean preflight usually verify cleanly.
  let verification = 0.5;
  if (input.scope.type === "single-file" && !input.preflight.hasWarnings) verification = 0.8;
  else if (input.scope.type === "small-linked" && !input.preflight.hasWarnings) verification = 0.72;
  else if (input.scope.type === "multi-file" && !input.preflight.hasWarnings) verification = 0.65;
  else if (input.scope.type === "architectural") verification = 0.4;
  else if (input.scope.type === "migration") verification = 0.35;
  else if (input.scope.type === "cross-cutting-sweep") verification = 0.28;
  if (input.preflight.blocked) verification = Math.max(0, verification - 0.35);
  basis.push(`verification:predictive by scope+preflight → ${verification.toFixed(2)}`);

  const overall = clamp01(planning * 0.25 + execution * 0.35 + verification * 0.4);
  basis.push(
    `overall = 0.25·plan(${planning.toFixed(2)}) + 0.35·exec(${execution.toFixed(2)}) + 0.4·verify(${verification.toFixed(2)})`,
  );

  return {
    overall,
    planning: clamp01(planning),
    execution: clamp01(execution),
    verification: clamp01(verification),
    basis,
  };
}

// ─── Narrative ──────────────────────────────────────────────────────

function buildHeadline(input: {
  blocked: boolean;
  charterTargets: readonly string[];
  steps: readonly DryRunStep[];
  confidence: DryRunConfidenceBreakdown;
  scope: ScopeClassification;
}): string {
  const percent = Math.round(input.confidence.overall * 100);
  const fileCount = input.charterTargets.length;
  if (input.blocked) {
    return `Preflight blocked — Aedis would refuse to execute. Plan confidence: ${percent}%.`;
  }
  if (fileCount === 0) {
    return `Aedis would plan against ${input.scope.type} scope with no named target files. Confidence: ${percent}%.`;
  }
  return `Aedis would run ${input.steps.length} steps across ${fileCount} file${fileCount === 1 ? "" : "s"} (${input.scope.type} scope). Confidence: ${percent}%.`;
}

function buildNarrative(input: {
  preflight: PreflightReport;
  charterObjective: string;
  steps: readonly DryRunStep[];
  filesLikelyTouched: readonly string[];
  blastRadius: BlastRadiusEstimate;
  estimatedCost: DryRunCostEstimate;
  confidence: DryRunConfidenceBreakdown;
}): string {
  const lines: string[] = [];
  lines.push(`Objective: ${truncate(input.charterObjective, 160)}`);
  if (input.preflight.blocked) {
    lines.push(
      `Preflight would BLOCK this run. ${input.preflight.summary}`,
    );
  } else if (input.preflight.hasWarnings) {
    const warns = input.preflight.findings.filter((f) => f.severity === "warn").length;
    lines.push(`Preflight would surface ${warns} warning${warns === 1 ? "" : "s"} but allow execution.`);
  }
  lines.push(
    `Aedis would run ${input.steps.length} steps: ${input.steps.map((s) => s.stage).join(" → ")}.`,
  );
  if (input.filesLikelyTouched.length > 0) {
    lines.push(
      `Files likely touched: ${input.filesLikelyTouched.slice(0, 5).join(", ")}${input.filesLikelyTouched.length > 5 ? `, +${input.filesLikelyTouched.length - 5} more` : ""}.`,
    );
  } else {
    lines.push("No target files named — scout would infer them from the request.");
  }
  lines.push(
    `Risk level: ${input.blastRadius.level} (${input.blastRadius.rationale}).`,
  );
  lines.push(`Estimated cost: ${input.estimatedCost.display} at ~${input.estimatedCost.assumedTokens} tokens.`);
  lines.push(
    `Predictive confidence: ${Math.round(input.confidence.overall * 100)}%.`,
  );
  return lines.join(" ");
}

// ─── Helpers ─────────────────────────────────────────────────────────

function minimalBlockedPlan(input: {
  preflight: PreflightReport;
  extraBlock: { code: string; message: string; suggestion?: string };
  rawTargets: readonly string[];
  rawPrompt: string;
  velumPreview: VelumPreview;
}): DryRunPlan {
  const preflightWithExtra: PreflightReport = {
    ok: false,
    blocked: true,
    hasWarnings: input.preflight.hasWarnings,
    summary: input.extraBlock.message,
    findings: [
      ...input.preflight.findings,
      {
        code: input.extraBlock.code,
        severity: "block",
        message: input.extraBlock.message,
        suggestion: input.extraBlock.suggestion,
      },
    ],
  };
  const scope: ScopeClassification = {
    type: "single-file",
    blastRadius: 0,
    recommendDecompose: false,
    reason: "charter error — planner did not run",
    governance: {
      decompositionRequired: false,
      approvalRequired: false,
      escalationRecommended: false,
      wavesRequired: false,
    },
  };
  const blastRadius = estimateBlastRadius({
    scopeClassification: scope,
    charterFileCount: input.rawTargets.length,
    prompt: input.rawPrompt,
  });
  return {
    preflight: preflightWithExtra,
    steps: [
      {
        stage: "preflight",
        description: `Preflight would BLOCK: ${input.extraBlock.message}`,
        tools: ["preflight-validator"],
        targetFiles: [...input.rawTargets],
      },
    ],
    filesLikelyTouched: [...input.rawTargets],
    riskLevel: blastRadius.level,
    blastRadius,
    scope,
    estimatedCost: { minUsd: 0, maxUsd: 0, assumedTokens: 0, display: "$0.00" },
    confidence: {
      overall: 0,
      planning: 0,
      execution: 0,
      verification: 0,
      basis: [
        "planning:charter-error → 0.00",
        "execution:charter-error → 0.00",
        "verification:charter-error → 0.00",
        "overall:blocked by charter error → 0.00",
      ],
    },
    headline: `Preflight blocked — ${input.extraBlock.message}`,
    narrative: `Aedis could not plan this request. ${input.extraBlock.message} ${input.extraBlock.suggestion ?? ""}`.trim(),
    blocked: true,
    ok: false,
    velumPreview: input.velumPreview,
    approvalPreview: {
      impactLevel: "low",
      reasons: ["preflight blocked — impact not evaluated"],
      approvalRequired: false,
      estimated: true,
    },
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
