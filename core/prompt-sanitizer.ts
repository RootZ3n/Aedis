/**
 * PromptSanitizer — Strip literal/comment regions from a user prompt
 * and collect explicit non-target file references.
 *
 * Both the charter (core/charter.ts) and the coordinator's target
 * discovery (core/target-discovery.ts) extract filenames from prompts.
 * Without a shared sanitizer they disagree about what counts as a
 * literal: charter knew to ignore quoted/fenced/negated mentions but
 * target-discovery ran a raw regex over the untreated prompt, so a
 * filename mentioned only inside `'…'` or after `Do not modify …`
 * leaked back into the changeSet through the discovery path. Run
 * ffe132ed-2c34-4f66-9837-7de6c6b1f6c1 hit exactly that — README.md
 * was extracted from a quoted comment and from a negative directive,
 * silently overrode the charter's clean ["start.sh"] result, and the
 * Builder edited the wrong file before the merge gate caught it.
 */

export interface SanitizedPrompt {
  /**
   * Prompt text with all literal-content surfaces removed: triple-
   * backtick fenced blocks, double quotes, single backticks, and
   * single quotes (with apostrophe-aware lookaround so contractions
   * survive). Use this as the input for any positive file-reference
   * extraction — never the raw prompt.
   */
  readonly sanitized: string;
  /**
   * Files the user explicitly told us NOT to touch. Captured from
   * verb-led negations ("do not modify X", "don't edit X", "without
   * changing X") and object-led negations ("leave X unchanged"). The
   * negation regexes run against the SANITIZED text so a literal
   * example like `Add a comment that says "do not modify config.yaml"`
   * does NOT mark config.yaml as a non-target.
   */
  readonly negatedTargets: ReadonlySet<string>;
}

const QUOTED_LITERAL_STRIPS: ReadonlyArray<RegExp> = [
  /```[\s\S]*?```/g,
  /"[^"]*"/g,
  /`[^`]*`/g,
  // Apostrophes inside contractions/possessives ("Aedis's", "doesn't",
  // "user's") must NOT be treated as quote delimiters. Lookbehind/
  // lookahead reject letter or digit on either side, so the regex
  // only fires on quotes that look like real string delimiters.
  /(?<![A-Za-z0-9])'[^']*'(?![A-Za-z0-9])/g,
];

const NEGATION_PATTERNS: ReadonlyArray<RegExp> = [
  // Verb-led negation: "do not modify X", "don't change X",
  // "without touching X", "never edit X".
  /\b(?:do(?:es)?\s+not|don['’]?t|never|without)\s+(?:modify|modifying|change|changing|edit|editing|update|updating|touch|touching)\s+(?:the\s+)?([\w\-./]+\.[A-Za-z]+)/gi,
  // Object-led negation: "leave X unchanged/untouched/alone/as-is".
  /\bleave\s+(?:the\s+)?([\w\-./]+\.[A-Za-z]+)\s+(?:unchanged|untouched|alone|as[-\s]is)\b/gi,
];

/**
 * Sanitize `prompt` for file-reference extraction. Returns the
 * stripped text alongside the explicit non-target set so downstream
 * extractors can apply both consistently.
 */
export function sanitizePromptForFileExtraction(prompt: string): SanitizedPrompt {
  const sanitized = QUOTED_LITERAL_STRIPS.reduce(
    (acc, re) => acc.replace(re, ""),
    prompt,
  );

  const negatedTargets = new Set<string>();
  for (const pattern of NEGATION_PATTERNS) {
    // /g regexes carry lastIndex across calls; reset defensively in
    // case the same RegExp instance is shared across invocations.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sanitized)) !== null) {
      const captured = match[1];
      if (typeof captured === "string" && captured.length > 0) {
        negatedTargets.add(
          captured.replace(/[),:;]+$/g, "").replace(/\.$/, ""),
        );
      }
    }
  }

  return { sanitized, negatedTargets };
}

/**
 * Whether `target` matches any explicit non-target reference. Checks
 * exact path first, then falls back to basename match — a bare
 * negation like "Do not modify README.md" blocks both the bare
 * reference and any `docs/README.md` resolution. A path-qualified
 * negation like "Don't modify src/lib/helper.ts" only matches that
 * exact path; a `helper.ts` elsewhere in the tree is left alone
 * because the user pointed at a specific file.
 */
export function isNegatedTarget(
  target: string,
  negatedTargets: ReadonlySet<string>,
): boolean {
  if (negatedTargets.has(target)) return true;
  const slashIdx = target.lastIndexOf("/");
  if (slashIdx < 0) return false;
  const basename = target.slice(slashIdx + 1);
  return negatedTargets.has(basename);
}
