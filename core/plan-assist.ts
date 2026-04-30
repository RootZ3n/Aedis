/**
 * Plan Assist — detects plan-worthy prompts and generates editable
 * task plan suggestions.
 *
 * Pure function: no side effects, no model calls, no state mutations.
 * Takes a user prompt and returns either a plan suggestion or null.
 *
 * Plan Assist does NOT:
 *   - auto-run the plan
 *   - bypass approval
 *   - silently expand vague objectives into repo edits
 *   - weaken safety gates
 *
 * Safety invariants:
 *   - Vague broad prompts → returns clarification, not a plan
 *   - Destructive/unsafe prompts → returns block, not a plan
 *   - Plan creation does not start execution
 *   - Every suggested subtask includes a reason field
 */

// ─── Types ───────────────────────────────────────────────────────────

export type PlanAssistRisk = "low" | "medium" | "high";

export interface SuggestedSubtask {
  readonly title: string;
  readonly prompt: string;
  readonly risk: PlanAssistRisk;
  readonly scope: string;
  readonly reason: string;
}

export interface PlanSuggestion {
  readonly kind: "plan_suggestion";
  readonly objective: string;
  readonly subtasks: readonly SuggestedSubtask[];
  readonly reason: string;
  readonly signals: readonly string[];
  readonly confidence: number;
}

export interface PlanAssistClarify {
  readonly kind: "clarify";
  readonly question: string;
  readonly reason: string;
  readonly signals: readonly string[];
}

export interface PlanAssistBlock {
  readonly kind: "block";
  readonly reason: string;
  readonly signals: readonly string[];
}

export interface PlanAssistSkip {
  readonly kind: "skip";
  readonly reason: string;
}

export type PlanAssistResult =
  | PlanSuggestion
  | PlanAssistClarify
  | PlanAssistBlock
  | PlanAssistSkip;

// ─── Detection Patterns ──────────────────────────────────────────────

/** Multi-step connectors — "and", "then", "also", "plus" joining actions */
const MULTI_STEP_CONNECTORS =
  /\b(and\s+(then\s+)?(also\s+)?(add|create|update|fix|remove|refactor|implement|write|build|change|test|move|rename|delete|migrate|convert))\b/i;

/** Checklist markers — numbered lists, bullet points, dashes */
const CHECKLIST_PATTERNS = [
  /^\s*\d+[.)]\s+/m,                // 1. or 1)
  /^\s*[-*]\s+\w/m,                  // - item or * item
  /^\s*\[[ x]?\]\s+/mi,             // [ ] or [x] checkbox
];

/** Large-scope markers — build spec language */
const LARGE_SCOPE_PATTERNS = [
  /\b(implement|build|create)\b.*\b(with|including|that has|which)\b/i,
  /\b(add|implement)\b.*\b(and|,)\s*(add|implement|update|create)\b/i,
  /\brefactor\b.*\b(across|throughout|every|all)\b/i,
  /\b(migrate|convert)\b.*\b(from|to)\b/i,
  /\b(feature|module|system|service|api|endpoint)\b.*\b(with|that|which)\b.*\b(should|must|needs?)\b/i,
];

/** Explicit multi-file/multi-target language */
const MULTI_TARGET_PATTERNS = [
  /\b(fix\s+\w+\s+and\s+(update|change|modify|test))\b/i,
  /\b(update|change|modify)\s+\w+\s+and\s+(update|change|modify|test)\b/i,
  /\b(multiple\s+(files?|modules?|components?|services?))\b/i,
  /\b(across\s+(the\s+)?codebase)\b/i,
  /\b(each|every)\s+(file|module|component|service)\b/i,
];

/** Action verb extraction — used to split multi-clause prompts */
const ACTION_VERBS =
  /\b(add|create|implement|build|write|fix|update|change|modify|remove|delete|refactor|rename|move|migrate|convert|test|verify|configure|set\s+up|install|integrate|connect|enable|disable)\b/gi;

/** Unsafe/destructive — block, no plan */
const UNSAFE_PATTERNS = [
  /\b(rm\s+-rf|drop\s+database|delete\s+all|wipe|destroy|nuke)\b/i,
  /\b(format\s+disk|truncate\s+table|drop\s+table)\b/i,
  /\b(force\s+push|--force|--hard.*reset)\b/i,
];

/** Vague quality markers — clarify, no plan */
const VAGUE_NO_TARGET_PATTERNS = [
  /^(make\s+(it|things?|the\s+(code|repo|project))\s+(better|nicer|cleaner|faster|more\s+\w+))$/i,
  /^(improve|optimize|clean\s*up)$/i,
  /^(fix\s+(everything|all|it|things))$/i,
  /^(do\s+something|help|help\s+me)$/i,
];

// ─── Risk Assessment ─────────────────────────────────────────────────

const HIGH_RISK_WORDS = /\b(database|migration|schema|auth|security|credentials?|password|deploy|production|infra|config|secret|env|token|payment|billing)\b/i;
const MEDIUM_RISK_WORDS = /\b(refactor|rename|move|delete|remove|api|endpoint|route|test|ci|pipeline|dependency|upgrade|downgrade)\b/i;

function assessRisk(text: string): PlanAssistRisk {
  if (HIGH_RISK_WORDS.test(text)) return "high";
  if (MEDIUM_RISK_WORDS.test(text)) return "medium";
  return "low";
}

// ─── Scope Extraction ────────────────────────────────────────────────

const FILE_REF = /\b([a-zA-Z0-9_./\\-]+\.(ts|tsx|js|jsx|py|rs|go|java|rb|php|css|html|md|json|yaml|yml|toml))\b/;
const MODULE_REF = /\b(src|lib|core|server|api|app|components?|workers?|routes?|models?|services?|utils?|helpers?|tests?|pages?|views?)\/[a-zA-Z0-9_/-]+/;

function extractScope(text: string): string {
  const fileMatch = text.match(FILE_REF);
  if (fileMatch) return fileMatch[1];
  const moduleMatch = text.match(MODULE_REF);
  if (moduleMatch) return moduleMatch[0];
  // Try to extract a noun phrase target
  const targetMatch = text.match(/\b(?:the\s+)?(\w+(?:\s+\w+)?)\s+(?:file|module|component|service|function|class|method|endpoint|route|page|view|model)\b/i);
  if (targetMatch) return targetMatch[1] + " (inferred)";
  return "unknown";
}

// ─── Core Detection ──────────────────────────────────────────────────

/**
 * Detect whether a prompt is plan-worthy and generate suggestions.
 * Pure function — no side effects.
 */
export function detectPlanAssist(prompt: string): PlanAssistResult {
  const raw = (prompt ?? "").trim();
  if (!raw) {
    return { kind: "skip", reason: "empty input" };
  }

  const lower = raw.toLowerCase();
  const signals: string[] = [];

  // ── BLOCK: unsafe/destructive ────────────────────────────────────
  if (UNSAFE_PATTERNS.some((p) => p.test(raw))) {
    return {
      kind: "block",
      reason: "Prompt contains unsafe/destructive operations — cannot plan",
      signals: ["block:unsafe"],
    };
  }

  // ── CLARIFY: vague with no target ────────────────────────────────
  if (VAGUE_NO_TARGET_PATTERNS.some((p) => p.test(lower))) {
    return {
      kind: "clarify",
      question:
        "That's too broad to plan safely. What specific feature, bug, or change do you want? " +
        "Name a file, module, or describe the concrete outcome.",
      reason: "Prompt is vague with no actionable target",
      signals: ["clarify:vague-no-target"],
    };
  }

  // ── Detect plan-worthy signals ───────────────────────────────────

  // Multi-step connectors: "fix X and update Y and test Z"
  if (MULTI_STEP_CONNECTORS.test(raw)) {
    signals.push("multi-step:connector");
  }

  // Checklist format
  for (const pattern of CHECKLIST_PATTERNS) {
    if (pattern.test(raw)) {
      signals.push("multi-step:checklist");
      break;
    }
  }

  // Large-scope build spec
  for (const pattern of LARGE_SCOPE_PATTERNS) {
    if (pattern.test(raw)) {
      signals.push("large-scope:build-spec");
      break;
    }
  }

  // Multi-target language
  for (const pattern of MULTI_TARGET_PATTERNS) {
    if (pattern.test(raw)) {
      signals.push("multi-target:explicit");
      break;
    }
  }

  // Word count threshold — long prompts with action verbs
  const words = raw.split(/\s+/);
  const actionMatches = raw.match(ACTION_VERBS) || [];
  if (words.length > 40 && actionMatches.length >= 2) {
    signals.push("large-scope:long-prompt");
  }

  // Multiple sentences with different action verbs
  const sentences = raw.split(/[.!;\n]+/).filter((s) => s.trim().length > 5);
  const sentencesWithActions = sentences.filter((s) =>
    ACTION_VERBS.test(s),
  );
  // Reset regex lastIndex after global test
  ACTION_VERBS.lastIndex = 0;
  if (sentencesWithActions.length >= 2) {
    signals.push("multi-step:multi-sentence-actions");
  }

  // ── Not plan-worthy → skip ──────────────────────────────────────
  if (signals.length === 0) {
    return { kind: "skip", reason: "Prompt is not plan-worthy" };
  }

  // ── Generate subtask suggestions ────────────────────────────────
  const subtasks = generateSubtasks(raw, signals);
  if (subtasks.length < 2) {
    return { kind: "skip", reason: "Could not decompose into multiple subtasks" };
  }

  const confidence = Math.min(0.9, 0.4 + signals.length * 0.15);

  return {
    kind: "plan_suggestion",
    objective: extractObjective(raw),
    subtasks,
    reason: `Plan suggested: ${signals.join(", ")}`,
    signals,
    confidence,
  };
}

// ─── Subtask Generation ──────────────────────────────────────────────

function generateSubtasks(prompt: string, signals: readonly string[]): SuggestedSubtask[] {
  const isChecklist = signals.includes("multi-step:checklist");

  if (isChecklist) {
    return generateFromChecklist(prompt);
  }

  // Try splitting on connectors ("and then", "and also", ", and")
  if (signals.includes("multi-step:connector") || signals.includes("multi-step:multi-sentence-actions")) {
    return generateFromConnectors(prompt);
  }

  // Large-scope: try to decompose by sentence/clause
  return generateFromClauses(prompt);
}

/**
 * Parse numbered/bulleted checklist items into ordered subtasks.
 * Preserves the original order — critical for checklists.
 */
function generateFromChecklist(prompt: string): SuggestedSubtask[] {
  const lines = prompt.split(/\r?\n/);
  const subtasks: SuggestedSubtask[] = [];

  // First extract the objective (text before the first list item)
  let objectiveLines: string[] = [];
  let listStarted = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isListItem =
      /^\d+[.)]\s+/.test(trimmed) ||
      /^[-*]\s+\w/.test(trimmed) ||
      /^\[[ x]?\]\s+/i.test(trimmed);

    if (isListItem) {
      listStarted = true;
      // Strip the marker
      const text = trimmed
        .replace(/^\d+[.)]\s+/, "")
        .replace(/^[-*]\s+/, "")
        .replace(/^\[[ x]?\]\s+/i, "")
        .trim();

      if (text.length > 3) {
        subtasks.push({
          title: truncateTitle(text),
          prompt: text,
          risk: assessRisk(text),
          scope: extractScope(text),
          reason: "Checklist item (preserving original order)",
        });
      }
    } else if (!listStarted) {
      objectiveLines.push(trimmed);
    }
  }

  return subtasks;
}

/**
 * Split on "and" / "then" / "also" / "," connectors between action verbs.
 */
function generateFromConnectors(prompt: string): SuggestedSubtask[] {
  // Split on connectors that join action clauses
  const splitPatterns = [
    /\.\s+(?=[A-Z])/,                              // sentence boundary
    /\s+and\s+then\s+/i,                            // "and then"
    /\s+and\s+also\s+/i,                            // "and also"
    /\s*,\s+and\s+/i,                               // ", and"
    /\s*,\s+then\s+/i,                              // ", then"
    /\s+then\s+/i,                                  // "then"
    /\s+plus\s+/i,                                  // "plus"
    /\s+also\s+/i,                                  // "also"
  ];

  let parts = [prompt];
  for (const pattern of splitPatterns) {
    const newParts: string[] = [];
    for (const part of parts) {
      const split = part.split(pattern);
      newParts.push(...split);
    }
    parts = newParts;
  }

  // Also try splitting on simple "and" between action verbs
  const finalParts: string[] = [];
  for (const part of parts) {
    const andSplit = part.split(/\s+and\s+(?=(?:add|create|implement|build|write|fix|update|change|modify|remove|delete|refactor|rename|move|migrate|test|verify)\b)/i);
    finalParts.push(...andSplit);
  }

  // Filter to meaningful clauses
  const subtasks: SuggestedSubtask[] = [];
  for (const part of finalParts) {
    const trimmed = part.trim();
    if (trimmed.length < 8) continue;
    // Must contain an action verb to be a subtask
    ACTION_VERBS.lastIndex = 0;
    if (!ACTION_VERBS.test(trimmed)) continue;
    ACTION_VERBS.lastIndex = 0;

    subtasks.push({
      title: truncateTitle(trimmed),
      prompt: trimmed,
      risk: assessRisk(trimmed),
      scope: extractScope(trimmed),
      reason: "Action clause from multi-step request",
    });
  }

  return subtasks;
}

/**
 * Decompose a large-scope prompt by sentence/clause boundaries.
 */
function generateFromClauses(prompt: string): SuggestedSubtask[] {
  const sentences = prompt
    .split(/[.!;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  const subtasks: SuggestedSubtask[] = [];
  for (const sentence of sentences) {
    ACTION_VERBS.lastIndex = 0;
    if (!ACTION_VERBS.test(sentence)) continue;
    ACTION_VERBS.lastIndex = 0;

    subtasks.push({
      title: truncateTitle(sentence),
      prompt: sentence,
      risk: assessRisk(sentence),
      scope: extractScope(sentence),
      reason: "Clause from build specification",
    });
  }

  // If we only got one subtask from clause splitting, try harder:
  // look for "with X, Y, and Z" feature lists within a single sentence
  if (subtasks.length < 2 && sentences.length >= 1) {
    const featureList = prompt.match(
      /\b(?:with|including|that has|which has|featuring)\b\s*:?\s*(.+)/i,
    );
    if (featureList) {
      const features = featureList[1]
        .split(/\s*,\s*|\s+and\s+/)
        .map((f) => f.trim())
        .filter((f) => f.length > 3);

      if (features.length >= 2) {
        // Use the objective as context for each feature subtask
        const objective = prompt.slice(0, featureList.index).trim();
        return features.map((feature) => ({
          title: truncateTitle(feature),
          prompt: `${objective}: ${feature}`,
          risk: assessRisk(feature),
          scope: extractScope(feature),
          reason: "Feature from specification list",
        }));
      }
    }
  }

  return subtasks;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function truncateTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 60) return clean;
  return clean.slice(0, 57) + "...";
}

function extractObjective(prompt: string): string {
  // Use the first sentence or first 120 chars as the objective
  const firstSentence = prompt.split(/[.!;\n]/)[0].trim();
  if (firstSentence.length <= 120) return firstSentence;
  return firstSentence.slice(0, 117) + "...";
}
