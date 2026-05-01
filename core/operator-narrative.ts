/**
 * Operator Narrative — typed milestone events that explain WHY Aedis is
 * doing what it's doing, in language that maps to real coordinator state.
 *
 * The narrative layer DOES NOT generate prose. Each event is a typed
 * milestone tied to a specific state transition: charter built,
 * execution-mode selected, scout produced reads, Builder about to
 * dispatch, merge-gate blocked, run paused for approval, run finished.
 *
 * Truthfulness contract:
 *   - Every emission is paired with a real action that already happened
 *     or is about to happen on the next pipeline step.
 *   - No "files inspected" event without a real Scout/preflight read.
 *   - No "before edit" event before Builder dispatch.
 *   - No "awaiting approval" without an actual approval pause.
 *   - No "safety block" without a real gate decision.
 *
 * Storage:
 *   - Each event is emitted on the EventBus as `{type:"operator_narrative",payload}`.
 *   - Each event is persisted as a receipt checkpoint with
 *     `type: "operator_narrative"` so reviewers can read the run's
 *     reasoning trail without listening to the live socket.
 *   - The full ordered list is also pinned on the RunReceipt as
 *     `narrative: readonly OperatorNarrativeEvent[]` so receipts
 *     remain self-describing (no joining checkpoints + events).
 */

import type { ExecutionMode } from "./execution-mode.js";

// ─── Event Kinds ─────────────────────────────────────────────────────

export type OperatorNarrativeKind =
  | "risk_assessment"
  | "mode_selected"
  | "plan_drafted"
  | "inspecting_files"
  | "before_edit"
  | "safety_block"
  | "awaiting_approval"
  | "run_completed_summary";

interface BaseEvent {
  readonly kind: OperatorNarrativeKind;
  readonly runId: string;
  /** ISO timestamp of when the milestone was reached. */
  readonly at: string;
  /** Human-readable headline for UI display. */
  readonly headline: string;
  /** One-line operator-facing rationale. */
  readonly detail: string;
}

/** Emitted right after charter analysis + impact classification. */
export interface RiskAssessmentEvent extends BaseEvent {
  readonly kind: "risk_assessment";
  readonly level: "low" | "medium" | "high";
  readonly reasons: readonly string[];
  readonly targets: readonly string[];
  readonly scope: string;
  readonly blastRadius: number;
}

/** Emitted after the deterministic execution-mode classifier runs. */
export interface ModeSelectedEvent extends BaseEvent {
  readonly kind: "mode_selected";
  readonly mode: ExecutionMode;
  readonly reasonCode: string;
  readonly reason: string;
  readonly skippedStages: readonly string[];
  readonly factors: readonly string[];
}

/** Emitted once the planner has fixed deliverables and target files. */
export interface PlanDraftedEvent extends BaseEvent {
  readonly kind: "plan_drafted";
  readonly deliverables: readonly {
    readonly description: string;
    readonly targetFiles: readonly string[];
  }[];
  readonly targetFiles: readonly string[];
  /**
   * Plan steps presented to the operator. Mirrors the graph nodes that
   * will run, in dispatch order. Each step is a single human-readable
   * phrase so a reviewer can scan the run shape at a glance.
   */
  readonly steps: readonly string[];
}

/**
 * Emitted ONLY when Scout (preflight or graph) actually read files.
 * `files` is the de-duplicated list of paths Scout opened — never the
 * planner's wishlist. Without this discipline the event would lie.
 */
export interface InspectingFilesEvent extends BaseEvent {
  readonly kind: "inspecting_files";
  readonly trigger: "preflight_scout" | "scout";
  readonly taskId: string;
  readonly files: readonly string[];
}

/**
 * Emitted just before the first Builder dispatch in the run. After this
 * event the Builder is about to write to the workspace; reviewers
 * watching the stream see this as the "I am about to edit" signal.
 */
export interface BeforeEditEvent extends BaseEvent {
  readonly kind: "before_edit";
  readonly files: readonly string[];
  readonly deliverable: string;
  readonly mode: ExecutionMode;
}

/** Emitted when ANY safety gate blocks the run. */
export interface SafetyBlockEvent extends BaseEvent {
  readonly kind: "safety_block";
  readonly gate:
    | "preflight_chain"
    | "merge_gate"
    | "fast_path_diff_check"
    | "verifier"
    | "promotion_typecheck"
    | "approval_rejected";
  readonly primaryReason: string;
  readonly blockers: readonly string[];
}

/** Emitted on the awaiting-approval pause. */
export interface AwaitingApprovalEvent extends BaseEvent {
  readonly kind: "awaiting_approval";
  readonly changeCount: number;
  readonly mode: ExecutionMode;
  /**
   * What still needs to happen between approval and source promotion.
   * Read by the UI to render a checklist for the operator.
   */
  readonly remainingSteps: readonly string[];
}

/** Emitted at the very end of the run, as a one-line wrap-up. */
export interface RunCompletedSummaryEvent extends BaseEvent {
  readonly kind: "run_completed_summary";
  readonly classification: string;
  readonly verdict: string;
  readonly durationMs: number;
  readonly filesChanged: number;
}

export type OperatorNarrativeEvent =
  | RiskAssessmentEvent
  | ModeSelectedEvent
  | PlanDraftedEvent
  | InspectingFilesEvent
  | BeforeEditEvent
  | SafetyBlockEvent
  | AwaitingApprovalEvent
  | RunCompletedSummaryEvent;

// ─── Construction Helpers ────────────────────────────────────────────
//
// Helpers exist so call sites in coordinator.ts read like prose:
//   narrate.riskAssessment(active, { level, reasons, ... })
// The helpers also enforce that every event carries the full base fields
// (runId, at, headline, detail) — without them the UI can't render.

function nowIso(): string {
  return new Date().toISOString();
}

function joinList(xs: readonly string[], cap = 5): string {
  if (xs.length === 0) return "(none)";
  const head = xs.slice(0, cap).join(", ");
  return xs.length > cap ? `${head}, +${xs.length - cap} more` : head;
}

export function makeRiskAssessment(args: {
  runId: string;
  level: "low" | "medium" | "high";
  reasons: readonly string[];
  targets: readonly string[];
  scope: string;
  blastRadius: number;
}): RiskAssessmentEvent {
  const targetSummary = joinList(args.targets, 3);
  return {
    kind: "risk_assessment",
    runId: args.runId,
    at: nowIso(),
    headline: `Risk assessment: ${args.level.toUpperCase()} (scope=${args.scope}, blast=${args.blastRadius})`,
    detail: args.reasons.length > 0
      ? `${args.level.toUpperCase()} risk because ${args.reasons.join("; ")}. Targets: ${targetSummary}.`
      : `${args.level.toUpperCase()} risk; ${args.targets.length} target file(s): ${targetSummary}.`,
    level: args.level,
    reasons: [...args.reasons],
    targets: [...args.targets],
    scope: args.scope,
    blastRadius: args.blastRadius,
  };
}

export function makeModeSelected(args: {
  runId: string;
  mode: ExecutionMode;
  reasonCode: string;
  reason: string;
  skippedStages: readonly string[];
  factors: readonly string[];
}): ModeSelectedEvent {
  const skippedNote = args.skippedStages.length > 0
    ? ` Skipping: ${args.skippedStages.join(", ")}.`
    : "";
  return {
    kind: "mode_selected",
    runId: args.runId,
    at: nowIso(),
    headline: `Execution mode: ${args.mode}`,
    detail: `${args.reason}.${skippedNote}`,
    mode: args.mode,
    reasonCode: args.reasonCode,
    reason: args.reason,
    skippedStages: [...args.skippedStages],
    factors: [...args.factors],
  };
}

export function makePlanDrafted(args: {
  runId: string;
  deliverables: readonly { description: string; targetFiles: readonly string[] }[];
  targetFiles: readonly string[];
  steps: readonly string[];
}): PlanDraftedEvent {
  return {
    kind: "plan_drafted",
    runId: args.runId,
    at: nowIso(),
    headline: `Plan drafted: ${args.steps.length} step(s) on ${args.targetFiles.length} file(s)`,
    detail: `Plan: ${args.steps.join(" → ")}.`,
    deliverables: args.deliverables.map((d) => ({
      description: d.description,
      targetFiles: [...d.targetFiles],
    })),
    targetFiles: [...args.targetFiles],
    steps: [...args.steps],
  };
}

export function makeInspectingFiles(args: {
  runId: string;
  taskId: string;
  trigger: "preflight_scout" | "scout";
  files: readonly string[];
}): InspectingFilesEvent {
  return {
    kind: "inspecting_files",
    runId: args.runId,
    at: nowIso(),
    headline: `Mapping ${args.files.length} file(s) before editing`,
    detail: `Inspecting (via ${args.trigger}): ${joinList(args.files, 5)}.`,
    trigger: args.trigger,
    taskId: args.taskId,
    files: [...args.files],
  };
}

export function makeBeforeEdit(args: {
  runId: string;
  files: readonly string[];
  deliverable: string;
  mode: ExecutionMode;
}): BeforeEditEvent {
  return {
    kind: "before_edit",
    runId: args.runId,
    at: nowIso(),
    headline: `Builder starting on ${args.files.length} file(s)`,
    detail: `${args.mode} edit beginning: ${args.deliverable}. Files: ${joinList(args.files, 3)}.`,
    files: [...args.files],
    deliverable: args.deliverable,
    mode: args.mode,
  };
}

export function makeSafetyBlock(args: {
  runId: string;
  gate: SafetyBlockEvent["gate"];
  primaryReason: string;
  blockers: readonly string[];
}): SafetyBlockEvent {
  return {
    kind: "safety_block",
    runId: args.runId,
    at: nowIso(),
    headline: `Safety gate blocked: ${args.gate}`,
    detail: `${args.gate} blocked the run. ${args.primaryReason}.`,
    gate: args.gate,
    primaryReason: args.primaryReason,
    blockers: [...args.blockers],
  };
}

export function makeAwaitingApproval(args: {
  runId: string;
  changeCount: number;
  mode: ExecutionMode;
  remainingSteps: readonly string[];
}): AwaitingApprovalEvent {
  return {
    kind: "awaiting_approval",
    runId: args.runId,
    at: nowIso(),
    headline: `Awaiting approval (${args.changeCount} file(s) ready)`,
    detail: `Pipeline paused. Remaining before promotion: ${args.remainingSteps.join(" → ") || "approval"}.`,
    changeCount: args.changeCount,
    mode: args.mode,
    remainingSteps: [...args.remainingSteps],
  };
}

export function makeRunCompletedSummary(args: {
  runId: string;
  classification: string;
  verdict: string;
  durationMs: number;
  filesChanged: number;
}): RunCompletedSummaryEvent {
  return {
    kind: "run_completed_summary",
    runId: args.runId,
    at: nowIso(),
    headline: `Run finished: ${args.classification}`,
    detail: `${args.classification} after ${args.durationMs}ms; ${args.filesChanged} file(s) changed; verdict=${args.verdict}.`,
    classification: args.classification,
    verdict: args.verdict,
    durationMs: args.durationMs,
    filesChanged: args.filesChanged,
  };
}

// ─── Predicate helpers used by tests / UI grouping ───────────────────

export function isOperatorNarrativeEvent(e: unknown): e is OperatorNarrativeEvent {
  if (!e || typeof e !== "object") return false;
  const r = e as Record<string, unknown>;
  return typeof r.kind === "string" && typeof r.runId === "string" && typeof r.at === "string";
}
