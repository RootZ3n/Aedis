/**
 * Trivial Task Detector — identifies single-file, low-risk edits eligible
 * for the fast execution path.
 *
 * A task qualifies as trivial when ALL of:
 *   1. Exactly one target file
 *   2. Prompt indicates comment-only, whitespace, formatting, or a
 *      small literal replacement
 *   3. No test requirement detected in the prompt
 *   4. No risk signals (security, destructive ops, etc.)
 *
 * The fast path skips decomposition overhead, limits scout scope, reduces
 * critic to heuristic-only review, and drops the integrator node — but
 * keeps verifier + typecheck and scope lock enforcement intact.
 */

// Patterns that indicate a trivial, comment/whitespace/formatting edit.
const TRIVIAL_PATTERNS = [
  /\b(add|update|fix|change|edit|modify|insert|remove)\s+(a\s+)?comment/i,
  /\b(comment|uncomment|jsdoc|docstring|annotation)\b/i,
  /\b(whitespace|spacing|indent(ation)?|trailing\s+space|blank\s+line)/i,
  /\b(format(ting)?|prettier|lint\s*fix)\b/i,
  /\b(typo|spelling|wording)\b/i,
  /\b(copyright|license)\s+(header|notice|banner)/i,
  /\b(todo|fixme|hack|xxx)\s+(comment|note|tag)/i,
];

const SIMPLE_LITERAL_REPLACEMENT =
  /\b(change|replace|update|set)\s+[`'"]?([A-Za-z0-9_.:-][^,.;\n]{0,40}?)['"`]?\s+\bto\b\s+[`'"]?([^,.;\n]{1,80})/i;

function isSimpleLiteralReplacement(prompt: string): boolean {
  const match = SIMPLE_LITERAL_REPLACEMENT.exec(prompt);
  if (!match) return false;

  const before = match[2]?.trim() ?? "";
  const after = match[3]?.trim() ?? "";
  if (!before || !after) return false;

  const combined = `${before} ${after}`;
  if (/\b(support|implement|refactor|migrate|integrate|redesign|security|auth|database|endpoint|api)\b/i.test(combined)) {
    return false;
  }

  return before.split(/\s+/).length <= 6 && after.split(/\s+/).length <= 10;
}

// Patterns that indicate a test requirement — disqualifies fast path.
const TEST_REQUIREMENT_PATTERNS = [
  /\badd\s+test/i,
  /\bwrite\s+test/i,
  /\btest\s+(coverage|case|suite)/i,
  /\bunit\s+test/i,
  /\bintegration\s+test/i,
  /\b(spec|\.test\.|\.spec\.)\b/i,
];

export interface TrivialCheckResult {
  readonly isTrivial: boolean;
  readonly reason: string;
}

export function isTrivialTask(opts: {
  readonly targets: readonly string[];
  readonly prompt: string;
  readonly scopeEstimate: string;
  readonly riskSignals: readonly string[];
}): TrivialCheckResult {
  const { targets, prompt, scopeEstimate, riskSignals } = opts;

  if (targets.length !== 1) {
    return { isTrivial: false, reason: `${targets.length} target file(s), need exactly 1` };
  }

  if (riskSignals.length > 0) {
    return { isTrivial: false, reason: `risk signals present: ${riskSignals.join(", ")}` };
  }

  if (scopeEstimate === "medium" || scopeEstimate === "large" || scopeEstimate === "epic") {
    return { isTrivial: false, reason: `scope too large: ${scopeEstimate}` };
  }

  const isTrivialEdit =
    TRIVIAL_PATTERNS.some((p) => p.test(prompt)) ||
    isSimpleLiteralReplacement(prompt);
  if (!isTrivialEdit) {
    return { isTrivial: false, reason: "prompt does not match trivial edit patterns" };
  }

  const hasTestReq = TEST_REQUIREMENT_PATTERNS.some((p) => p.test(prompt));
  if (hasTestReq) {
    return { isTrivial: false, reason: "prompt contains test requirement" };
  }

  return { isTrivial: true, reason: "single-file trivial edit" };
}
