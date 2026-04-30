/**
 * Scout Spawn Decision — determines when to spawn scout agents.
 *
 * Pure function: takes prompt, context, and config; returns a spawn
 * decision. No side effects, no model calls, no state mutations.
 *
 * Spawn rules:
 *   YES when: large prompt, multiple files/modules mentioned, unknown
 *     target, multiple subsystems, investigative verbs, medium Loqui
 *     confidence with recoverable scope, task plan target discovery.
 *   NO when: simple explicit task, exact file+change given, unsafe
 *     prompt, vague with no target, budget exhausted.
 */

import type { ScoutSpawnDecision, ScoutReportType } from "./scout-report.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ScoutSpawnInput {
  /** The user prompt or subtask prompt */
  readonly prompt: string;
  /** Loqui intent confidence (0–1), if classified */
  readonly intentConfidence?: number;
  /** Loqui intent, if classified */
  readonly intent?: string;
  /** Known target files from target discovery, if any */
  readonly knownTargetFiles?: readonly string[];
  /** Whether a task plan is being created (needs target discovery) */
  readonly isTaskPlanCreation?: boolean;
  /** Remaining budget in USD (null = unlimited) */
  readonly remainingBudgetUsd?: number | null;
  /** Current model profile */
  readonly modelProfile?: string;
  /** Whether cloud API keys are available */
  readonly cloudKeysAvailable?: boolean;
  /** System memory pressure level ("ok" | "warning" | "critical") */
  readonly systemPressureLevel?: "ok" | "warning" | "critical";
}

// ─── Constants ───────────────────────────────────────────────────────

/** Minimum prompt length (chars) to consider "large" */
const LARGE_PROMPT_THRESHOLD = 200;

/** Minimum word count to consider prompt complex */
const COMPLEX_WORD_THRESHOLD = 30;

/** Budget floor — don't spawn if remaining budget is below this */
const BUDGET_FLOOR_USD = 0.01;

/** Investigative verb patterns */
const INVESTIGATIVE_PATTERNS = [
  /\b(find\s+where|find\s+all|find\s+every)\b/i,
  /\b(audit|trace|investigate|understand|search\s+for)\b/i,
  /\b(which\s+files?|what\s+files?|where\s+(is|are|does))\b/i,
  /\b(how\s+(does|do|is)\s+\w+\s+(work|handled|implemented|used))\b/i,
  /\b(map\s+(out|the)|architecture|structure|dependencies)\b/i,
  /\b(identify|discover|locate|scan|inspect|analyze)\b/i,
];

/** Multi-file / multi-module patterns */
const MULTI_SCOPE_PATTERNS = [
  /\b(all\s+files|every\s+file|across\s+(the\s+)?codebase)\b/i,
  /\b(multiple\s+(files|modules|components|services))\b/i,
  /\b(refactor|rename|migrate)\b.*\b(all|every|across)\b/i,
  /\band\b.*\band\b/i, // "X and Y and Z" → multi-target
];

/** Patterns that indicate an explicit, simple task */
const SIMPLE_EXPLICIT_PATTERNS = [
  /^(create|add|write)\s+(a\s+)?README/i,
  /^(add|insert|append)\s+.*\s+(to|in|at)\s+\S+\.(ts|js|py|md|json|yaml|yml|toml)/i,
  /^(change|update|replace|set)\s+.*\s+(in|at)\s+\S+:\d+/i, // file:line
  /^(delete|remove)\s+(line|function|class|method)\s+\w+\s+(from|in)\s+\S+/i,
  /^(fix|correct)\s+(the\s+)?(typo|spelling|whitespace)/i,
];

/** Unsafe / destructive patterns — block, no scout */
const UNSAFE_PATTERNS = [
  /\b(rm\s+-rf|drop\s+database|delete\s+all|wipe|destroy|nuke)\b/i,
  /\b(format\s+disk|truncate\s+table|drop\s+table)\b/i,
];

/** Vague with no target — clarify, no scout */
const VAGUE_PATTERNS = [
  /^(make\s+(it|things?|the\s+(code|repo|project))\s+(better|nicer|cleaner|faster))$/i,
  /^(improve|optimize|clean\s*up)$/i,
  /^(fix\s+(everything|all|it))$/i,
];

// ─── Decision Logic ──────────────────────────────────────────────────

export function shouldSpawnScouts(input: ScoutSpawnInput): ScoutSpawnDecision {
  const { prompt } = input;
  const lower = prompt.toLowerCase().trim();
  const words = prompt.split(/\s+/);
  const reasons: string[] = [];
  const types: ScoutReportType[] = [];

  // ─── BLOCK conditions (return no-spawn) ──────────────────────────

  // System memory pressure → block scouts to avoid OOM
  if (input.systemPressureLevel === "critical") {
    return noSpawn("System under memory pressure (critical) — scouts suppressed");
  }

  // Unsafe prompt → block
  if (UNSAFE_PATTERNS.some((p) => p.test(prompt))) {
    return noSpawn("Prompt contains unsafe/destructive patterns — blocked");
  }

  // Vague with no target → clarify, no scout
  if (VAGUE_PATTERNS.some((p) => p.test(lower))) {
    return noSpawn("Prompt is too vague with no actionable target — needs clarification");
  }

  // Budget exhausted
  if (input.remainingBudgetUsd != null && input.remainingBudgetUsd < BUDGET_FLOOR_USD) {
    return noSpawn("Budget exhausted — no scouts");
  }

  // Simple explicit task with known file
  if (SIMPLE_EXPLICIT_PATTERNS.some((p) => p.test(prompt))) {
    return noSpawn("Task is simple and explicit — scout not needed");
  }

  // Exact file + change provided and known targets
  if (
    input.knownTargetFiles &&
    input.knownTargetFiles.length === 1 &&
    words.length < COMPLEX_WORD_THRESHOLD &&
    !INVESTIGATIVE_PATTERNS.some((p) => p.test(prompt))
  ) {
    return noSpawn("Exact target file known and task is simple — scout not needed");
  }

  // ─── SPAWN conditions (accumulate reasons) ───────────────────────

  // Large prompt
  if (prompt.length > LARGE_PROMPT_THRESHOLD || words.length > COMPLEX_WORD_THRESHOLD) {
    reasons.push("large/complex prompt");
    types.push("repo_map", "target_discovery");
  }

  // Investigative verbs
  if (INVESTIGATIVE_PATTERNS.some((p) => p.test(prompt))) {
    reasons.push("investigative intent detected");
    types.push("target_discovery");
  }

  // Multi-scope patterns
  if (MULTI_SCOPE_PATTERNS.some((p) => p.test(prompt))) {
    reasons.push("multi-file/module scope");
    types.push("target_discovery", "risk");
  }

  // Unknown target — no known files
  if (!input.knownTargetFiles || input.knownTargetFiles.length === 0) {
    reasons.push("target file unknown");
    types.push("target_discovery");
  }

  // Medium Loqui confidence with recoverable scope
  if (
    input.intentConfidence != null &&
    input.intentConfidence >= 0.35 &&
    input.intentConfidence < 0.7 &&
    input.intent === "build"
  ) {
    reasons.push("medium Loqui confidence — repo exploration may help");
    types.push("target_discovery", "repo_map");
  }

  // Task plan creation needs target discovery
  if (input.isTaskPlanCreation) {
    reasons.push("task plan creation — needs target discovery");
    types.push("target_discovery", "repo_map", "test_discovery");
  }

  // Test-related keywords
  if (/\b(test|spec|verify|coverage|assertion)\b/i.test(prompt)) {
    types.push("test_discovery");
  }

  // Risk-related keywords
  if (/\b(risk|danger|migration|config|secret|sensitive|breaking)\b/i.test(prompt)) {
    types.push("risk");
  }

  // Docs-related keywords
  if (/\b(doc|readme|documentation|api\s+doc|changelog)\b/i.test(prompt)) {
    types.push("docs");
  }

  // ─── Final decision ──────────────────────────────────────────────

  if (reasons.length === 0) {
    return noSpawn("No spawn triggers matched — task appears straightforward");
  }

  const uniqueTypes = [...new Set(types)];
  const localOrCloud = recommendRouting(input, uniqueTypes);

  return {
    spawn: true,
    reason: reasons.join("; "),
    scoutCount: uniqueTypes.length,
    scoutTypes: uniqueTypes,
    localOrCloudRecommendation: localOrCloud,
    expectedEvidence: uniqueTypes.map(typeToEvidence),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function noSpawn(reason: string): ScoutSpawnDecision {
  return {
    spawn: false,
    reason,
    scoutCount: 0,
    scoutTypes: [],
    localOrCloudRecommendation: "deterministic",
    expectedEvidence: [],
  };
}

function typeToEvidence(type: ScoutReportType): string {
  switch (type) {
    case "repo_map":
      return "repository structure, framework, package manager, directories";
    case "target_discovery":
      return "candidate files ranked by relevance with reasons";
    case "test_discovery":
      return "relevant test files and verification commands";
    case "risk":
      return "risky files, generated files, config, secrets-adjacent paths";
    case "docs":
      return "relevant documentation and README references";
  }
}

function recommendRouting(
  input: ScoutSpawnInput,
  types: ScoutReportType[],
): "local" | "cloud" | "deterministic" {
  // Local-smoke or no cloud keys → deterministic/local only
  if (input.modelProfile === "local-smoke") return "deterministic";
  if (!input.cloudKeysAvailable) return "local";

  // Simple search-only scouts → deterministic (no model needed)
  const searchOnly = types.every(
    (t) => t === "repo_map" || t === "test_discovery" || t === "docs",
  );
  if (searchOnly) return "deterministic";

  // Complex analysis → local preferred, cloud if needed
  const hasComplex = types.includes("target_discovery") || types.includes("risk");
  if (hasComplex && input.prompt.length > LARGE_PROMPT_THRESHOLD * 2) {
    return "cloud";
  }

  return "local";
}
