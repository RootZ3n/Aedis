/**
 * Module-anchor guard.
 *
 * When the operator names a project/module in the prompt
 * ("…in Magister project", "…in the foo module", "…for the bar
 * package") and that name corresponds to a real top-level directory
 * in the repo, every discovered target must live inside that
 * directory. If they all live outside, Builder is about to edit the
 * wrong area — typically because preflight scouts surfaced files
 * whose paths matched looser keywords than the prompt's anchor.
 *
 * This guard runs alongside the feature-completeness guard, before
 * Builder is dispatched. The failure mode is NEEDS_CLARIFICATION via
 * the same error path so the operator can re-attach a target inside
 * the named anchor instead of approving a bogus diff.
 *
 * Pure function — no I/O. The caller injects directory listings.
 */
import type { RequestAnalysis } from "./charter.js";

export interface ModuleAnchorInputs {
  readonly prompt: string;
  readonly analysis: Pick<RequestAnalysis, "category">;
  /** Repo-relative target paths after scout-merge + charter rebuild. */
  readonly charterTargets: readonly string[];
  /**
   * Repo-relative listing function. `""` returns top-level entries
   * (file names AND subdirectory names). Test stubs inject a fake.
   */
  readonly listChildren: (relativeDir: string) => readonly string[];
}

export interface ModuleAnchorFinding {
  readonly reason: string;
  /** The anchor name as it appeared in the prompt (e.g. "Magister"). */
  readonly anchorName: string;
  /** The matching repo top-level directory (lowercased). */
  readonly anchorDirectory: string;
  /** Targets that fell outside the anchor — every charter target. */
  readonly violatingTargets: readonly string[];
  /**
   * Code files inside the anchor directory that are plausible
   * replacements. Caller surfaces these as recommendedTargets so the
   * UI can present a chip list.
   */
  readonly suggestedTargets: readonly string[];
}

const ANCHOR_NOUN = "(?:project|module|package|component|service|app|lib|repo|library|codebase)";

// Match "in Magister project", "in the magister project", "for the foo module".
// The captured group is the proper noun preceding the anchor noun.
const ANCHOR_PATTERN = new RegExp(
  String.raw`\b(?:in|for|inside|within)\s+(?:the\s+)?([A-Za-z][\w-]*)\s+${ANCHOR_NOUN}\b`,
  "gi",
);

// Names that don't identify a unique anchor directory. Always lowercase.
const ANCHOR_BLOCKLIST = new Set([
  "the",
  "this",
  "that",
  "new",
  "current",
  "main",
  "primary",
  "given",
  "first",
  "second",
  "next",
  "last",
  "test",
  "tests",
  "all",
  "any",
  "every",
  "another",
  "some",
  "default",
]);

const CODE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|gd|java|kt|rb|php|cc|cpp|h|hpp|cs|swift)$/i;

/**
 * Decide whether the prompt names an anchor that conflicts with the
 * discovered targets. Returns the finding when EVERY charter target
 * is outside the anchor directory; otherwise null (let dispatch
 * proceed).
 */
export function detectModuleAnchorMismatch(
  inputs: ModuleAnchorInputs,
): ModuleAnchorFinding | null {
  if (inputs.charterTargets.length === 0) return null;
  if (inputs.analysis.category === "investigation") return null;

  const candidates = extractAnchorCandidates(inputs.prompt);
  if (candidates.length === 0) return null;

  // Top-level repo entries — match candidate names against directory names.
  const topLevel = inputs.listChildren("");
  const topLevelDirs = new Set<string>();
  for (const entry of topLevel) {
    // listChildren returns entries with no leading prefix when relDir==="".
    // Defensive: strip any path separator that snuck through.
    const name = entry.replace(/^.*[/\\]/, "").toLowerCase();
    if (!name) continue;
    // Skip files (best-effort: files have an extension; directories
    // typically don't). The guard uses the existence of a directory
    // anchor — a top-level FILE named "magister.ts" doesn't qualify.
    if (CODE_FILE_RE.test(name) || /\.[a-z0-9]+$/i.test(name)) continue;
    topLevelDirs.add(name);
  }

  for (const anchorName of candidates) {
    const anchorDir = anchorName.toLowerCase();
    if (!topLevelDirs.has(anchorDir)) continue;

    const anchorPrefix = `${anchorDir}/`;
    const insideAnchor = inputs.charterTargets.some((target) => {
      const lower = target.replace(/\\/g, "/").toLowerCase();
      return lower === anchorDir || lower.startsWith(anchorPrefix);
    });
    if (insideAnchor) return null;

    // ALL targets fell outside the anchor — build a finding.
    const suggested = collectSuggestedTargets(inputs.listChildren, anchorDir);
    return {
      reason:
        `Prompt anchors this task to "${anchorName}" but every discovered target is outside ` +
        `${anchorDir}/. Builder would edit the wrong area without further clarification.`,
      anchorName,
      anchorDirectory: anchorDir,
      violatingTargets: [...inputs.charterTargets],
      suggestedTargets: suggested,
    };
  }

  return null;
}

function extractAnchorCandidates(prompt: string): string[] {
  const found: string[] = [];
  ANCHOR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANCHOR_PATTERN.exec(prompt)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    if (ANCHOR_BLOCKLIST.has(raw.toLowerCase())) continue;
    found.push(raw);
  }
  // De-dupe while preserving first-seen order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of found) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return unique;
}

function collectSuggestedTargets(
  listChildren: (relativeDir: string) => readonly string[],
  anchorDir: string,
): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [anchorDir];
  let visited = 0;
  // Bounded BFS one level deep — enough to surface plausible siblings
  // without spending unbounded time when the anchor is huge.
  while (queue.length > 0 && visited < 12) {
    const dir = queue.shift()!;
    visited++;
    let entries: readonly string[];
    try {
      entries = listChildren(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      if (CODE_FILE_RE.test(entry)) {
        out.push(entry);
        if (out.length >= 8) return out;
      } else if (!/\.[a-z0-9]+$/i.test(entry) && dir === anchorDir) {
        // Subdirectory — descend one level only when we're at the
        // anchor root. Two-level descent would explode for large repos.
        queue.push(entry);
      }
    }
  }
  return out;
}
