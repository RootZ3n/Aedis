/**
 * Multi-file feature underspecification guard.
 *
 * When the operator submits a new-feature prompt like
 *
 *     "Add a new conversational mode called Teach Me Anything to Magister"
 *
 * the scout often finds a single anchor target (the registry/router
 * that all modes are wired into). Dispatching Builder against just
 * that one file usually fails because real features require a
 * companion file, a session handler, a prompt template, etc. — files
 * the scout did not enumerate because they don't exist yet.
 *
 * This guard runs AFTER scouts have merged their advisory targets
 * into the charter and BEFORE the coordinator dispatches Builder.
 * If the prompt clearly describes a new scaffold and only one target
 * was discovered, it lists likely-related sibling files so the
 * operator can decompose or attach them all at once.
 *
 * Pure function — no I/O. The caller injects a directory-listing
 * function so the guard is fully testable. Wires through the
 * coordinator's existing pre-dispatch path so the failure mode is
 * always NEEDS_CLARIFICATION (not subtask_terminal_failure).
 *
 * Conservative by design: triggers only when ALL of:
 *   - request category is "scaffold" (per CharterGenerator)
 *   - exactly one charter target was identified after scout merge
 *   - prompt contains new-X-mode / new-X-feature wording
 *   - sibling-listing returns at least one neighbouring file
 *
 * Otherwise the guard returns null and the run proceeds normally.
 */

import { dirname } from "node:path";

import type { RequestAnalysis } from "./charter.js";

export interface FeatureCompletenessInputs {
  readonly prompt: string;
  readonly analysis: Pick<RequestAnalysis, "category">;
  readonly charterTargets: readonly string[];
  /** Repo-relative directory listing. Test stubs inject a fake. */
  readonly listSiblings: (relativeDir: string) => readonly string[];
}

export interface FeatureCompletenessFinding {
  readonly reason: string;
  readonly anchorTarget: string;
  /**
   * Files in the same parent directory as the anchor (and one level
   * down). Caller surfaces these as recommendedTargets on the
   * NeedsClarificationError so the UI can render a chip list.
   */
  readonly suggestedSiblings: readonly string[];
}

const NEW_FEATURE_REGEX =
  /\b(new|add(?:ing)?|create|introduce)\b[^.\n]{0,40}\b(mode|feature|companion|handler|session|template|router|pipeline|integration|provider|workflow|persona)\b/i;

/**
 * Decide whether the prompt + post-scout target list match the
 * "underspecified scaffold" pattern. Returns the finding when it
 * does — or null when the run should proceed as-is.
 */
export function detectFeatureUnderspecified(
  inputs: FeatureCompletenessInputs,
): FeatureCompletenessFinding | null {
  if (inputs.analysis.category !== "scaffold") return null;
  if (inputs.charterTargets.length !== 1) return null;
  if (!NEW_FEATURE_REGEX.test(inputs.prompt)) return null;

  const anchor = inputs.charterTargets[0];
  const parent = dirname(anchor);
  const siblings = collectSiblings(inputs.listSiblings, anchor, parent);
  if (siblings.length === 0) return null;

  return {
    reason:
      `Scaffold prompt detected ("${shorten(inputs.prompt)}") but only one target was found ` +
      `(${anchor}). Multi-file features usually require sibling changes — ` +
      `the operator should review and attach the additional files before Builder runs.`,
    anchorTarget: anchor,
    suggestedSiblings: siblings,
  };
}

function collectSiblings(
  list: (relativeDir: string) => readonly string[],
  anchor: string,
  parent: string,
): readonly string[] {
  const out: string[] = [];
  // Same directory.
  for (const sib of list(parent)) {
    if (sib === anchor) continue;
    if (!isCodeFile(sib)) continue;
    out.push(sib);
  }
  // One level down — feature folders typically have a children
  // directory like `modes/`, `companions/`, etc.
  for (const child of list(parent)) {
    if (child === anchor) continue;
    if (isCodeFile(child)) continue;
    // Treat any non-code entry as a potential subdirectory; the
    // listing function is the authority on what exists.
    for (const grandChild of list(child)) {
      if (grandChild === anchor) continue;
      if (!isCodeFile(grandChild)) continue;
      out.push(grandChild);
    }
  }
  // De-duplicate while preserving order, cap to 12 to keep payloads
  // bounded.
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const p of out) {
    if (seen.has(p)) continue;
    seen.add(p);
    uniq.push(p);
    if (uniq.length >= 12) break;
  }
  return uniq;
}

function isCodeFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|gd|gdscript)$/i.test(path);
}

function shorten(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
