/**
 * ImplementationBrief — Engineer-grade work order passed to the Builder.
 *
 * Sits between Charter + Scope + Plan and the Builder. Carries the
 * decisions that used to be invisible to workers: which files were
 * selected and why, which were considered and dropped, what the
 * Builder is allowed to change, what counts as "done", and what the
 * retry/escalation path is if the first attempt is weak.
 *
 * The Coordinator produces one brief per run (not per builder node).
 * Each builder node receives the full brief in its assignment so it
 * can reason about its file in the context of the wider scope.
 *
 * The brief is:
 *   - persisted to the run receipt (for transparency and post-mortem)
 *   - formatted into the builder prompt (for model grounding)
 *   - consumed by the weak-output classifier for sharpened retries
 */

import type { Charter, Deliverable, IntentObject } from "./intent.js";
import type { RequestAnalysis, RequestCategory } from "./charter.js";
import type { ScopeClassification, ScopeType } from "./scope-classifier.js";
import type { Plan, PlanWave } from "./multi-file-planner.js";
import type { ChangeSet } from "./change-set.js";

// ─── Types ───────────────────────────────────────────────────────────

export type TaskType = RequestCategory; // re-export charter category
export type TaskScope = "single-file" | "small-linked" | "multi-file" | "broad";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface SelectedFile {
  readonly path: string;
  readonly role: "primary" | "sibling" | "schema" | "consumer" | "test" | "integration" | "docs";
  readonly rationale: string;
  /** The plan wave this file belongs to, if multi-file plan exists. */
  readonly waveId?: number;
}

export interface RejectedCandidate {
  readonly path: string;
  readonly reason: string;
}

export interface TaskStage {
  readonly id: number;
  readonly name: string;
  readonly files: readonly string[];
  readonly intent: string;
  readonly dependsOn: readonly number[];
}

export interface ImplementationBrief {
  /** Original, unmodified user prompt. */
  readonly rawUserRequest: string;
  /** Normalized prompt (after the intent/prompt normalizer). */
  readonly normalizedRequest: string;
  /** Short imperative rephrasing — the first line the Builder should obey. */
  readonly normalizedGoal: string;
  /** Classified task type (feature/bugfix/refactor/...). */
  readonly taskType: TaskType;
  /** Classified scope (single-file/multi-file/broad/...). */
  readonly scope: TaskScope;
  /** Underlying scope classifier verdict, for downstream consumers that need the full object. */
  readonly scopeType: ScopeType;
  /** Blast-radius level from planning time. */
  readonly riskLevel: RiskLevel;
  /** Reasons the risk level is what it is. */
  readonly riskFactors: readonly string[];
  /** Files the Builder is expected to touch, with rationale. */
  readonly selectedFiles: readonly SelectedFile[];
  /** Files considered but dropped, with reason. */
  readonly rejectedCandidates: readonly RejectedCandidate[];
  /** Staged plan of work. One stage for single-file tasks; N for multi-file. */
  readonly stages: readonly TaskStage[];
  /** Explicit non-goals — things the Builder MUST NOT change. */
  readonly nonGoals: readonly string[];
  /** Expected verification commands (hints for the Verifier + for the Builder's mental model). */
  readonly verificationCommands: readonly string[];
  /** Fallback plan if the primary approach fails or is infeasible. */
  readonly fallbackPlan: string;
  /** Does the task likely require clarification? When true the Coordinator should prefer asking over building. */
  readonly needsClarification: boolean;
  /** Free-form clarifying questions the Builder should answer if it proceeds with assumptions. */
  readonly openQuestions: readonly string[];
  /** When this brief was built, for traceability. */
  readonly createdAt: string;
  /** The intent this brief was built for. */
  readonly intentId: string;
  /** The run this brief was built for. */
  readonly runId: string;
  /**
   * A short, sharpened retry hint. Null on the first attempt; populated
   * by the weak-output recovery pipeline when an earlier attempt failed
   * and a retry is queued with a more specific instruction.
   */
  readonly retryHint: string | null;
  /**
   * Attempt number this brief describes. 1 on the first build, 2 on the
   * weak-output retry, etc.
   */
  readonly attempt: number;
}

// ─── Builder ──────────────────────────────────────────────────────────

export interface BuildBriefInput {
  readonly intent: IntentObject;
  readonly analysis: RequestAnalysis;
  readonly charter: Charter;
  readonly scope: ScopeClassification;
  readonly changeSet: ChangeSet;
  readonly plan: Plan | undefined;
  readonly rawUserPrompt: string;
  readonly normalizedPrompt: string;
  /** Files the coordinator actually plans to dispatch Builder nodes for, post-canonicalization. */
  readonly dispatchableFiles: readonly string[];
  /** Files that were considered but dropped (non-existent, out of scope, etc). Reasons must be provided. */
  readonly rejectedCandidates?: readonly RejectedCandidate[];
  /** Optional retry hint when this is not the first attempt. */
  readonly retryHint?: string;
  readonly attempt?: number;
}

export interface MinimalImplementationBriefInput {
  readonly intent: IntentObject;
  readonly rawUserPrompt: string;
  readonly normalizedPrompt: string;
  readonly error: string;
  readonly analysis?: Partial<RequestAnalysis>;
  readonly charter?: Charter | null;
  readonly scope?: ScopeClassification | null;
  readonly dispatchableFiles?: readonly string[];
  readonly rejectedCandidates?: readonly RejectedCandidate[];
}

/**
 * Build an ImplementationBrief from the structured outputs of upstream
 * planning phases. Pure-ish — does no I/O, just transforms the already-
 * computed decisions into a single, prompt-ready work order.
 */
export function buildImplementationBrief(input: BuildBriefInput): ImplementationBrief {
  const scopeType = input.scope.type;
  const scope = toBriefScope(scopeType);
  const taskType = input.analysis.category;

  const selectedFiles = buildSelectedFiles(input);
  const stages = buildStages(input, selectedFiles);
  const riskLevel = toRiskLevel(input.scope.blastRadius, input.analysis);
  const verificationCommands = defaultVerificationCommands(input, selectedFiles);
  const nonGoals = buildNonGoals(input);
  const fallbackPlan = buildFallbackPlan(input, selectedFiles);
  const needsClarification = detectNeedsClarification(input, selectedFiles);
  const openQuestions = buildOpenQuestions(input.analysis);
  const normalizedGoal = input.charter.objective.replace(/^(Implement|Fix|Refactor|Scaffold|Configure|Add test coverage for|Document|Investigate):\s*/, "").trim() || input.analysis.raw;

  return Object.freeze({
    rawUserRequest: input.rawUserPrompt,
    normalizedRequest: input.normalizedPrompt,
    normalizedGoal,
    taskType,
    scope,
    scopeType,
    riskLevel,
    riskFactors: Object.freeze([...input.analysis.riskSignals]),
    selectedFiles: Object.freeze(selectedFiles),
    rejectedCandidates: Object.freeze([...(input.rejectedCandidates ?? [])]),
    stages: Object.freeze(stages),
    nonGoals: Object.freeze(nonGoals),
    verificationCommands: Object.freeze(verificationCommands),
    fallbackPlan,
    needsClarification,
    openQuestions: Object.freeze(openQuestions),
    createdAt: new Date().toISOString(),
    intentId: input.intent.id,
    runId: input.intent.runId,
    retryHint: input.retryHint ?? null,
    attempt: input.attempt ?? 1,
  });
}

function dedupeRejectedCandidates(
  rejectedCandidates: readonly RejectedCandidate[],
): RejectedCandidate[] {
  const seen = new Set<string>();
  const out: RejectedCandidate[] = [];
  for (const candidate of rejectedCandidates) {
    const path = candidate.path.trim();
    const reason = candidate.reason.trim();
    if (!path || !reason) continue;
    const key = `${path}::${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, reason });
  }
  return out;
}

function syntheticScopeForFallback(dispatchableFiles: readonly string[]): ScopeClassification {
  const fileCount = dispatchableFiles.length;
  const type: ScopeType = fileCount > 1 ? "multi-file" : "single-file";
  return {
    type,
    blastRadius: Math.max(fileCount, 1),
    recommendDecompose: fileCount > 1,
    reason: "fallback scope classification",
    governance: {
      decompositionRequired: fileCount >= 4,
      approvalRequired: false,
      escalationRecommended: false,
      wavesRequired: fileCount > 1,
    },
  };
}

function fallbackCharter(
  intent: IntentObject,
  rawUserPrompt: string,
  dispatchableFiles: readonly string[],
): Charter {
  const existing = intent.charter;
  if (
    existing &&
    typeof existing.objective === "string" &&
    Array.isArray(existing.successCriteria) &&
    Array.isArray(existing.deliverables)
  ) {
    return existing;
  }

  return {
    objective: `Implement: ${rawUserPrompt || intent.userRequest}`,
    successCriteria: ["Make the smallest safe edit possible", "Surface blockers explicitly"],
    deliverables: dispatchableFiles.length > 0
      ? dispatchableFiles.map((path) => ({
          description: `Modify ${path}`,
          targetFiles: [path],
          type: "modify" as const,
        }))
      : [{
          description: rawUserPrompt || intent.userRequest,
          targetFiles: [],
          type: "modify" as const,
        }],
    qualityBar: existing?.qualityBar ?? "standard",
  };
}

export function buildMinimalImplementationBrief(
  input: MinimalImplementationBriefInput,
): ImplementationBrief {
  const dispatchableFiles = Array.from(new Set(
    (input.dispatchableFiles ?? [])
      .map((file) => file.trim())
      .filter((file) => file.length > 0),
  ));
  const analysis: RequestAnalysis = {
    raw: input.analysis?.raw ?? input.rawUserPrompt,
    category: input.analysis?.category ?? "investigation",
    targets: dispatchableFiles,
    scopeEstimate: dispatchableFiles.length > 4 ? "large" : dispatchableFiles.length > 1 ? "medium" : "small",
    riskSignals: [...(input.analysis?.riskSignals ?? [])],
    ambiguities: [
      ...(input.analysis?.ambiguities ?? []),
      `Implementation brief fallback in effect: ${input.error}`,
    ],
  };
  const charter = fallbackCharter(input.intent, input.rawUserPrompt, dispatchableFiles);
  const scope = input.scope ?? syntheticScopeForFallback(dispatchableFiles);
  const brief = buildImplementationBrief({
    intent: input.intent,
    analysis,
    charter,
    scope,
    changeSet: {
      intent: input.intent,
      filesInScope: [],
      dependencyRelationships: {},
      invariants: [],
      sharedInvariants: [],
      coherenceVerdict: { coherent: true, reason: "fallback" },
      acceptanceCriteria: [],
    } as unknown as ChangeSet,
    plan: undefined,
    rawUserPrompt: input.rawUserPrompt,
    normalizedPrompt: input.normalizedPrompt,
    dispatchableFiles,
    rejectedCandidates: dedupeRejectedCandidates(input.rejectedCandidates ?? []),
  });

  return Object.freeze({
    ...brief,
    fallbackPlan:
      `Planning/brief generation degraded earlier (${input.error}). ` +
      "Keep the edit minimal, stay inside the selected files, and report blockers explicitly.",
    openQuestions: Object.freeze([
      ...brief.openQuestions,
      `Fallback brief reason: ${input.error}`,
    ]),
  });
}

export function buildImplementationBriefOrFallback(
  input: BuildBriefInput,
): ImplementationBrief {
  try {
    return buildImplementationBrief(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildMinimalImplementationBrief({
      intent: input.intent,
      rawUserPrompt: input.rawUserPrompt,
      normalizedPrompt: input.normalizedPrompt,
      error: message,
      analysis: input.analysis,
      charter: input.intent.charter,
      scope: input.scope,
      dispatchableFiles: input.dispatchableFiles,
      rejectedCandidates: input.rejectedCandidates,
    });
  }
}

export function briefWithRejectedCandidates(
  brief: ImplementationBrief,
  rejectedCandidates: readonly RejectedCandidate[],
): ImplementationBrief {
  const merged = dedupeRejectedCandidates([
    ...brief.rejectedCandidates,
    ...rejectedCandidates,
  ]);
  return Object.freeze({
    ...brief,
    rejectedCandidates: Object.freeze(merged),
    createdAt: new Date().toISOString(),
  });
}

// ─── Selected-files derivation ────────────────────────────────────────

function buildSelectedFiles(input: BuildBriefInput): SelectedFile[] {
  const out: SelectedFile[] = [];
  const seen = new Set<string>();
  const waves = input.plan?.waves ?? [];

  const waveOf = (file: string): number | undefined => {
    for (const w of waves) {
      if (w.files.includes(file)) return w.id;
    }
    return undefined;
  };

  const waveName = (waveId: number | undefined): PlanWave["name"] | undefined => {
    if (waveId == null) return undefined;
    return waves.find((w) => w.id === waveId)?.name;
  };

  const roleForFile = (file: string, waveId: number | undefined): SelectedFile["role"] => {
    const name = waveName(waveId);
    if (name === "schema/types") return "schema";
    if (name === "consumers") return "consumer";
    if (name === "tests/docs") {
      if (/\.(md|rst|txt)$/i.test(file)) return "docs";
      return "test";
    }
    if (name === "integration") return "integration";
    const lower = file.toLowerCase();
    if (/\.(test|spec)\.[a-z0-9]+$/.test(lower)) return "test";
    if (/\.(md|rst|txt)$/i.test(lower)) return "docs";
    return "primary";
  };

  const rationaleFor = (file: string, role: SelectedFile["role"], waveId: number | undefined): string => {
    switch (role) {
      case "primary":
        return `Primary target. Listed in charter deliverables${waveId != null ? ` (wave ${waveId})` : ""}.`;
      case "schema":
        return `Shared types/schema file. Planner assigned to wave ${waveId} so contract changes land before consumers.`;
      case "consumer":
        return `Consumer of upstream schema/types. Planner assigned to wave ${waveId}.`;
      case "test":
        return `Test file. Planner placed in wave ${waveId ?? 3} so coverage follows behavior changes.`;
      case "integration":
        return `Integration/orchestration file. Planner placed in wave ${waveId ?? 4} to wire pieces together last.`;
      case "docs":
        return `Documentation. Updated alongside code changes.`;
      default:
        return `Scoped target.`;
    }
  };

  for (const file of input.dispatchableFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    const waveId = waveOf(file);
    const role = roleForFile(file, waveId);
    out.push({
      path: file,
      role,
      rationale: rationaleFor(file, role, waveId),
      ...(waveId != null ? { waveId } : {}),
    });
  }

  // Include every file mentioned in the plan even if it didn't make it
  // into dispatchableFiles — the Builder benefits from knowing the wider
  // scope even when one wave is skipped.
  for (const wave of waves) {
    for (const file of wave.files) {
      if (seen.has(file)) continue;
      seen.add(file);
      const role = roleForFile(file, wave.id);
      out.push({
        path: file,
        role,
        rationale: rationaleFor(file, role, wave.id) + " (planned but not dispatched this run)",
        waveId: wave.id,
      });
    }
  }

  return out;
}

// ─── Stages ───────────────────────────────────────────────────────────

function buildStages(input: BuildBriefInput, selected: readonly SelectedFile[]): TaskStage[] {
  const plan = input.plan;
  if (plan && plan.waves.length > 0) {
    return plan.waves.map<TaskStage>((wave) => ({
      id: wave.id,
      name: wave.name,
      files: wave.files,
      intent: wave.verificationCheckpoint,
      dependsOn: wave.dependsOn,
    }));
  }

  // Single-file or small-linked — emit a synthetic single stage so the
  // brief always has at least one stage. Downstream code can count
  // stages without null checks.
  const files = selected.map((s) => s.path);
  return [{
    id: 1,
    name: "implementation",
    files,
    intent: `Make the edit required by the user's request. Verify the target file still compiles and the existing tests pass.`,
    dependsOn: [],
  }];
}

// ─── Risk / non-goals / fallback / clarification / questions ─────────

function toRiskLevel(blastRadius: number, analysis: RequestAnalysis): RiskLevel {
  if (analysis.riskSignals.includes("security-sensitive")) return "high";
  if (analysis.riskSignals.includes("data-layer")) return "high";
  if (analysis.riskSignals.includes("production-facing")) return "high";
  if (blastRadius >= 15) return "high";
  if (blastRadius >= 8) return "medium";
  return "low";
}

function toBriefScope(type: ScopeType): TaskScope {
  switch (type) {
    case "single-file": return "single-file";
    case "small-linked": return "small-linked";
    case "multi-file": return "multi-file";
    case "architectural":
    case "migration":
    case "cross-cutting-sweep":
      return "broad";
  }
}

function buildNonGoals(input: BuildBriefInput): string[] {
  const out: string[] = [];
  out.push("Do not refactor unrelated code or reformat files outside the listed scope.");
  out.push("Do not rename or remove exports unless the user request explicitly asks for it.");
  out.push("Do not add dependencies, install packages, or modify configuration files not listed in scope.");
  if (input.analysis.category !== "test") {
    out.push("Do not add or modify tests unless the user asked for them (main code changes are enough — verifier runs existing tests separately).");
  }
  if (input.analysis.category === "bugfix") {
    out.push("Do not rewrite the file or change unrelated functions; target only the broken behavior.");
  }
  if (input.analysis.category === "docs") {
    out.push("Do not modify source code; documentation changes only.");
  }
  return out;
}

function defaultVerificationCommands(input: BuildBriefInput, selected: readonly SelectedFile[]): string[] {
  const out: string[] = [];
  const hasTs = selected.some((s) => /\.(ts|tsx)$/.test(s.path));
  const hasPy = selected.some((s) => /\.py$/.test(s.path));
  const hasGo = selected.some((s) => /\.go$/.test(s.path));
  const hasRs = selected.some((s) => /\.rs$/.test(s.path));
  const hasGd = selected.some((s) => /\.(gd|tscn|tres|gdshader)$/.test(s.path));

  if (hasTs) {
    out.push("npm test");
    out.push("npx tsc --noEmit");
  }
  if (hasPy) {
    out.push("python -m pytest");
    out.push("python -m pyflakes <changed files>");
  }
  if (hasGo) out.push("go test ./... && go vet ./...");
  if (hasRs) out.push("cargo test && cargo check");
  if (hasGd) out.push("godot --headless --check-only");
  if (out.length === 0) out.push("<no automatic verifier configured — run the project-appropriate test/lint commands>");
  return out;
}

function buildFallbackPlan(input: BuildBriefInput, selected: readonly SelectedFile[]): string {
  if (selected.length === 0) {
    return "If no selected file is appropriate, DO NOT invent a file. Return a blocker explaining what target information is missing.";
  }
  if (input.analysis.ambiguities.length > 0) {
    return "If the request is ambiguous in a way that would require inventing behavior, return a blocker listing the assumptions you'd otherwise have to make.";
  }
  if (input.scope.type === "architectural") {
    return "If the full refactor cannot be done in one pass, make the smallest bounded change that is cleanly revertible and report what remains.";
  }
  return "If the smallest viable edit does not satisfy the request (e.g. file already correct, ambiguous target), return a blocker with the evidence.";
}

function detectNeedsClarification(input: BuildBriefInput, selected: readonly SelectedFile[]): boolean {
  if (selected.length === 0) return true;
  // Ambiguous hedging language and no concrete file target.
  if (input.analysis.ambiguities.some((a) => a.includes("hedging")) && selected.length === 0) return true;
  return false;
}

function buildOpenQuestions(analysis: RequestAnalysis): string[] {
  return [...analysis.ambiguities];
}

/**
 * Produce a retry version of an existing brief, with a sharpened hint
 * and a bumped attempt counter. All other fields are preserved so the
 * Builder sees the same selected files / non-goals / fallback plan on
 * the retry — only the retry-specific guidance changes.
 */
export function briefWithRetryHint(
  brief: ImplementationBrief,
  retryHint: string,
): ImplementationBrief {
  return Object.freeze({
    ...brief,
    retryHint,
    attempt: brief.attempt + 1,
    createdAt: new Date().toISOString(),
  });
}

// ─── Formatting for the Builder prompt ────────────────────────────────

/**
 * Render the brief as a dense, model-friendly block. Kept under ~2k chars
 * in the common case so we don't blow the builder prompt budget.
 */
export function formatBriefForBuilder(brief: ImplementationBrief): string {
  const lines: string[] = [];
  lines.push("IMPLEMENTATION BRIEF (engineered work order):");
  lines.push(`• Goal: ${brief.normalizedGoal}`);
  lines.push(`• Task type: ${brief.taskType}  • Scope: ${brief.scope} (${brief.scopeType})  • Risk: ${brief.riskLevel}`);
  if (brief.riskFactors.length > 0) {
    lines.push(`• Risk factors: ${brief.riskFactors.join(", ")}`);
  }
  if (brief.attempt > 1 && brief.retryHint) {
    lines.push(`• RETRY ATTEMPT ${brief.attempt}. Earlier attempt was weak. Sharpened guidance: ${brief.retryHint}`);
  }

  if (brief.selectedFiles.length > 0) {
    lines.push("• Selected files (work within these; do not invent new paths):");
    for (const f of brief.selectedFiles.slice(0, 12)) {
      const wave = f.waveId != null ? ` [wave ${f.waveId}]` : "";
      lines.push(`    - ${f.path} (${f.role})${wave} — ${f.rationale}`);
    }
    if (brief.selectedFiles.length > 12) {
      lines.push(`    - …and ${brief.selectedFiles.length - 12} more (see receipts)`);
    }
  }

  if (brief.rejectedCandidates.length > 0) {
    lines.push("• Rejected candidates (do NOT use these):");
    for (const r of brief.rejectedCandidates.slice(0, 8)) {
      lines.push(`    - ${r.path} — ${r.reason}`);
    }
  }

  if (brief.stages.length > 1) {
    lines.push(`• Stages (${brief.stages.length}):`);
    for (const s of brief.stages) {
      const dep = s.dependsOn.length > 0 ? ` depends on [${s.dependsOn.join(", ")}]` : "";
      lines.push(`    ${s.id}. ${s.name} — ${s.files.length} file(s)${dep}`);
    }
  }

  if (brief.nonGoals.length > 0) {
    lines.push("• Non-goals (MUST NOT change):");
    for (const n of brief.nonGoals) lines.push(`    - ${n}`);
  }

  if (brief.verificationCommands.length > 0) {
    lines.push(`• Expected verification: ${brief.verificationCommands.join(" ; ")}`);
  }

  lines.push(`• Fallback: ${brief.fallbackPlan}`);

  if (brief.openQuestions.length > 0) {
    lines.push("• Open questions (assume if you must, but flag):");
    for (const q of brief.openQuestions) lines.push(`    - ${q}`);
  }

  return lines.join("\n");
}

/**
 * Render the brief as a JSON payload suitable for receipt persistence.
 * Deterministic field order for diff-friendly storage.
 */
export function briefToReceiptJson(brief: ImplementationBrief): Record<string, unknown> {
  return {
    intentId: brief.intentId,
    runId: brief.runId,
    createdAt: brief.createdAt,
    attempt: brief.attempt,
    retryHint: brief.retryHint,
    rawUserRequest: brief.rawUserRequest,
    normalizedRequest: brief.normalizedRequest,
    normalizedGoal: brief.normalizedGoal,
    taskType: brief.taskType,
    scope: brief.scope,
    scopeType: brief.scopeType,
    riskLevel: brief.riskLevel,
    riskFactors: [...brief.riskFactors],
    selectedFiles: brief.selectedFiles.map((f) => ({ ...f })),
    rejectedCandidates: brief.rejectedCandidates.map((r) => ({ ...r })),
    stages: brief.stages.map((s) => ({ ...s, files: [...s.files], dependsOn: [...s.dependsOn] })),
    nonGoals: [...brief.nonGoals],
    verificationCommands: [...brief.verificationCommands],
    fallbackPlan: brief.fallbackPlan,
    needsClarification: brief.needsClarification,
    openQuestions: [...brief.openQuestions],
  };
}

// ─── Weak-output classification ──────────────────────────────────────

export type WeakOutputReason =
  | "empty-diff"
  | "prose-or-corruption"
  | "scope-drift"
  | "export-loss"
  | "raw-diff-output"
  | "verifier-failure"
  | "critic-reject"
  | "unknown";

export interface WeakOutputFinding {
  readonly reason: WeakOutputReason;
  readonly message: string;
  /** Sharpened guidance to inject into the retry brief. */
  readonly retryHint: string;
  /** Whether retrying is worthwhile for this reason. */
  readonly retriable: boolean;
}

/**
 * Inspect a builder error or critic verdict, map it to a structured
 * weak-output reason, and return a sharpened retry hint. Called by the
 * Coordinator's recovery layer to decide whether to retry and with
 * what guidance.
 */
export function classifyWeakOutput(signal: {
  readonly builderError?: string;
  readonly criticVerdict?: "approve" | "request-changes" | "reject";
  readonly criticIssues?: readonly string[];
  readonly verifierFailed?: boolean;
  readonly verifierMessage?: string;
  readonly changeCount?: number;
}): WeakOutputFinding {
  const err = signal.builderError ?? "";
  if (/returned no effective file changes|empty diff/i.test(err)) {
    return {
      reason: "empty-diff",
      message: err || "Builder produced no diff",
      retryHint: "The previous attempt produced NO change. You MUST make a concrete edit this time. If the request literally cannot be satisfied by editing the listed selected files, RETURN THE ORIGINAL FILE with a single-line marker comment describing the blocker — DO NOT silently return unchanged content.",
      retriable: true,
    };
  }
  if (/raw diff|refusing to write raw diff/i.test(err)) {
    return {
      reason: "raw-diff-output",
      message: err,
      retryHint: "The previous attempt returned raw unified-diff text as file content, which would have corrupted the file. In full-file mode: return the FULL final file content only. In section-edit mode: return a unified diff with original line numbers.",
      retriable: true,
    };
  }
  if (/prose|conversational/i.test(err)) {
    return {
      reason: "prose-or-corruption",
      message: err,
      retryHint: "The previous attempt returned prose/markdown instead of code. Return ONLY the file content — no explanations, no headers, no fences.",
      retriable: true,
    };
  }
  if (/export|preserved exports/i.test(err)) {
    return {
      reason: "export-loss",
      message: err,
      retryHint: "The previous attempt deleted exports that downstream files depend on. Preserve EVERY existing export unless the user request explicitly asked for removal.",
      retriable: true,
    };
  }
  if (signal.criticVerdict === "reject") {
    return {
      reason: "critic-reject",
      message: (signal.criticIssues ?? []).join(" | ") || "Critic rejected the diff",
      retryHint: `Critic blockers: ${(signal.criticIssues ?? []).slice(0, 3).join(" | ") || "scope/quality"}. Address each blocker concretely before producing a new diff.`,
      retriable: true,
    };
  }
  if (signal.criticVerdict === "request-changes") {
    return {
      reason: "critic-reject",
      message: (signal.criticIssues ?? []).join(" | "),
      retryHint: `Critic requested changes: ${(signal.criticIssues ?? []).slice(0, 3).join(" | ") || "see receipt"}. Focus the retry on these issues.`,
      retriable: true,
    };
  }
  if (signal.verifierFailed) {
    return {
      reason: "verifier-failure",
      message: signal.verifierMessage || "Verifier failed",
      retryHint: `Verifier failed: ${signal.verifierMessage ?? "tests/type-check did not pass"}. Read the error and adjust — do not regenerate blindly.`,
      retriable: true,
    };
  }
  if (signal.changeCount === 0) {
    return {
      reason: "empty-diff",
      message: "Zero file changes recorded",
      retryHint: "No files were actually changed. Make a concrete edit to at least one selected file or return a blocker.",
      retriable: true,
    };
  }
  return {
    reason: "unknown",
    message: err || "Unknown weakness",
    retryHint: "Review the user request and the selected files, then produce a more concrete edit.",
    retriable: false,
  };
}

// ─── Capability routing ──────────────────────────────────────────────

export type CapabilityFloor = "fast" | "standard" | "premium";

/**
 * Given a brief, recommend the minimum capability tier a builder model
 * must have. The Coordinator's router uses this to warn or escalate
 * when the configured default falls below the floor.
 */
export function capabilityFloorForBrief(brief: ImplementationBrief): {
  readonly floor: CapabilityFloor;
  readonly reason: string;
} {
  if (brief.scope === "broad" || brief.scopeType === "architectural" || brief.scopeType === "migration" || brief.scopeType === "cross-cutting-sweep") {
    return { floor: "premium", reason: `scope=${brief.scopeType} — needs high-capability planning` };
  }
  if (brief.riskLevel === "high" || brief.riskLevel === "critical") {
    return { floor: "standard", reason: `risk=${brief.riskLevel}` };
  }
  if (brief.scope === "multi-file") {
    return { floor: "standard", reason: "multi-file coordination" };
  }
  if (brief.taskType === "refactor") {
    return { floor: "standard", reason: "refactor — non-trivial reasoning" };
  }
  return { floor: "fast", reason: "single-file bounded edit" };
}
