/**
 * Named-Target Discovery.
 *
 * Bridges the gap between "the user named a thing" and "Aedis knows
 * which path to act on." When a build prompt mentions a module-style
 * name (Magister, Instructor Mode, Loqui, Velum) but no explicit
 * file or repo-relative path, target discovery comes back empty and
 * the Coordinator's clarification gate fires with a generic "name a
 * specific file" message. That blocks the supervised happy path —
 * the user shouldn't have to tell Aedis where its own modules live.
 *
 * This module extracts capitalized identifiers and multi-word
 * proper-noun phrases from a prompt, then searches the project root
 * for matching directories or files under conventional locations
 * (modules/, apps/, packages/, src/, core/, server/, ui/, workers/,
 * services/, libs/). Matches are scored deterministically and
 * returned with the rule(s) that produced them so the upstream
 * caller can decide whether to bind a single match, surface a multi-
 * match clarification, or fall through to the existing "no target"
 * message.
 *
 * Pure read-only function. No model calls. No mutations. The path
 * search uses only `readdirSync` against the configured project
 * root. Names that look like English verbs/articles (`Add`, `The`,
 * `Mode`) are stop-listed to avoid spurious searches.
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface NamedTargetCandidate {
  /** Repo-relative path, slash-normalized. */
  readonly path: string;
  /** Absolute path. */
  readonly absolutePath: string;
  /** True when the path is a directory; false when it is a file. */
  readonly isDirectory: boolean;
  /** Original extracted name that produced this match. */
  readonly name: string;
  /** Score for ordering (higher = better). Bounded but not normalized. */
  readonly score: number;
  /** Why this candidate was chosen. */
  readonly reasons: readonly string[];
}

export interface NamedTargetDiscoveryResult {
  /** All candidates, sorted by score descending. */
  readonly candidates: readonly NamedTargetCandidate[];
  /**
   * Resolved single best path when the top candidate is unambiguously
   * better than any runner-up (gap >= AMBIGUITY_GAP). Null when
   * ambiguous, when no matches exist, or when discovery did not run
   * (e.g. caller already had explicit targets).
   */
  readonly resolvedPath: string | null;
  /** True when 2+ candidates tie within AMBIGUITY_GAP of the leader. */
  readonly ambiguous: boolean;
  /** Names extracted from the prompt that drove the search. */
  readonly extractedNames: readonly string[];
}

export interface NamedTargetDiscoveryInput {
  readonly prompt: string;
  readonly projectRoot: string;
  /**
   * Skip discovery when the caller already has explicit targets —
   * named-target search is a fallback, not a replacement. Optional;
   * default behavior runs discovery regardless.
   */
  readonly knownTargets?: readonly string[];
}

// ─── Constants ───────────────────────────────────────────────────────

/** Common repo locations searched first; ordered by priority (high → low). */
const SEARCH_ROOTS: readonly string[] = [
  "modules",
  "apps",
  "packages",
  "src",
  "core",
  "server",
  "ui",
  "workers",
  "services",
  "libs",
  "lib",
  "components",
  "features",
];

/** Required minimum gap between top two candidates to count as resolved. */
const AMBIGUITY_GAP = 25;

/**
 * Names that look capitalized but are not module candidates: English
 * articles, common verbs that BUILD_RULES already consume as imperative
 * markers, and a few generic UI / domain words. Without this filter,
 * `Add Instructor Mode to Magister` would search for `Add`, `Instructor
 * Mode`, `Magister` — the first one is dead weight that wastes a
 * filesystem walk and inflates ambiguity. Lowercase-compared.
 */
const NAME_STOPLIST: ReadonlySet<string> = new Set([
  // Articles / pronouns
  "a", "an", "the", "this", "that", "these", "those", "it", "its",
  "i", "you", "we", "us", "they", "them", "my", "your", "our", "their",
  // Common verbs that BUILD_RULES already match as imperative markers
  "add", "build", "create", "implement", "fix", "patch", "make",
  "update", "modify", "remove", "delete", "scaffold", "generate",
  "write", "refactor", "rename", "rewrite", "restructure", "ship",
  "deliver", "land", "commit", "push", "wire", "extend", "introduce",
  "repair", "resolve", "drop",
  // Connectors / prepositions / question words
  "to", "from", "for", "in", "on", "at", "by", "with", "of", "as",
  "and", "or", "but", "not", "if", "then", "else", "when", "while",
  "what", "why", "how", "where", "who", "which", "whose",
  // Generic placeholders
  "thing", "things", "stuff", "code", "feature", "module", "function",
  "class", "method", "file", "files", "test", "tests",
  "mode", "modes", "system", "systems", "service", "services",
  "interactive", "teaching", "logs", "log", "lines", "line",
  "steps", "step", "questions", "question", "follow", "follow-up",
  "key", "pasted",
  // Articles that show up capitalized at sentence start
  "should", "must", "needs", "need", "have", "has",
]);

/**
 * Words allowed inside a multi-word phrase even though they would
 * be stoplisted if extracted alone. Lets the extractor keep
 * "Instructor Mode" together rather than dropping the trailing
 * "Mode" and leaving a bare "Instructor".
 */
const MULTIWORD_TAIL_ALLOW: ReadonlySet<string> = new Set([
  "mode", "manager", "engine", "service", "handler", "controller",
  "store", "client", "worker", "agent", "gateway", "registry",
]);

// ─── Public API ──────────────────────────────────────────────────────

export function discoverNamedTargets(
  input: NamedTargetDiscoveryInput,
): NamedTargetDiscoveryResult {
  const projectRoot = resolve(input.projectRoot);
  const known = input.knownTargets ?? [];
  if (known.length > 0) {
    return {
      candidates: [],
      resolvedPath: null,
      ambiguous: false,
      extractedNames: [],
    };
  }

  const extracted = extractNamedCandidates(input.prompt);
  if (extracted.length === 0) {
    return {
      candidates: [],
      resolvedPath: null,
      ambiguous: false,
      extractedNames: [],
    };
  }

  const candidates: NamedTargetCandidate[] = [];
  const seen = new Set<string>();

  for (const name of extracted) {
    const matches = searchForName(projectRoot, name);
    for (const match of matches) {
      if (seen.has(match.path)) continue;
      seen.add(match.path);
      candidates.push(match);
    }
  }

  candidates.sort(compareCandidates);

  const ambiguous =
    candidates.length >= 2 &&
    candidates[0].score - candidates[1].score < AMBIGUITY_GAP;
  const resolvedPath =
    candidates.length === 0
      ? null
      : ambiguous
        ? null
        : candidates[0].path;

  return {
    candidates,
    resolvedPath,
    ambiguous,
    extractedNames: extracted,
  };
}

// ─── Name extraction ─────────────────────────────────────────────────

/**
 * Extract capitalized identifier candidates from a prompt. Supports:
 *   - PascalCase tokens   (`Magister`, `RunReceipt`)
 *   - Multi-word capitalized phrases (`Instructor Mode`)
 *   - Snake/kebab name fragments when the user already wrote the
 *     normalized form (`instructor-mode`, `instructor_mode`)
 *
 * Stoplisted names are dropped, but multi-word phrases keep an
 * allow-listed tail (`Mode`, `Service`, `Manager`, …) so we don't
 * lose the qualifying suffix.
 */
export function extractNamedCandidates(prompt: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    out.push(trimmed);
  };

  // ── 1. Multi-word capitalized phrases ──────────────────────────
  const phraseRe =
    /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){1,3})\b/g;
  for (const match of prompt.matchAll(phraseRe)) {
    const phrase = match[1].trim();
    const parts = phrase.split(/\s+/);
    // Accept if at least the head is non-stop, and tail is either
    // non-stop or in the multi-word allow list.
    const head = parts[0];
    if (NAME_STOPLIST.has(head.toLowerCase())) {
      // Drop the lead stop word and try the remainder
      const rest = parts.slice(1).join(" ");
      if (rest.length > 0 && !NAME_STOPLIST.has(parts[1]?.toLowerCase() ?? "")) {
        const tail = parts[parts.length - 1].toLowerCase();
        if (
          parts.length === 2 ||
          !NAME_STOPLIST.has(tail) ||
          MULTIWORD_TAIL_ALLOW.has(tail)
        ) {
          push(rest);
        }
      }
      continue;
    }
    const tail = parts[parts.length - 1].toLowerCase();
    if (NAME_STOPLIST.has(tail) && !MULTIWORD_TAIL_ALLOW.has(tail)) {
      // Drop the trailing stop word
      const trimmedPhrase = parts.slice(0, -1).join(" ");
      if (trimmedPhrase.length > 0) push(trimmedPhrase);
      continue;
    }
    push(phrase);
  }

  // ── 2. Single PascalCase tokens ────────────────────────────────
  const singleRe = /\b([A-Z][a-zA-Z0-9]{2,})\b/g;
  for (const match of prompt.matchAll(singleRe)) {
    const word = match[1];
    if (NAME_STOPLIST.has(word.toLowerCase())) continue;
    push(word);
  }

  // ── 3. Already-normalized snake/kebab tokens ───────────────────
  // Useful when the user types "instructor-mode" in chat, or when
  // a copy-paste from an issue lower-cases the name.
  const slugRe = /\b([a-z][a-z0-9]+(?:[-_][a-z0-9]+){1,3})\b/g;
  for (const match of prompt.matchAll(slugRe)) {
    const slug = match[1];
    // Filter slugs that are obviously file paths (will be picked up
    // by the existing path extractor) or hex-ish.
    if (slug.includes(".")) continue;
    if (/^[a-f0-9_-]{6,}$/.test(slug)) continue;
    push(slug);
  }

  return out;
}

// ─── Filesystem search ───────────────────────────────────────────────

interface NameVariants {
  readonly lower: string;
  readonly kebab: string;
  readonly snake: string;
  readonly compact: string;
  readonly camel: string;
}

function buildVariants(name: string): NameVariants {
  // Split CamelCase / Multi Word and normalize.
  const words = name
    .replace(/[_\-\s]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  const lower = words.join(" ");
  const kebab = words.join("-");
  const snake = words.join("_");
  const compact = words.join("");
  const camel = words
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join("");
  return { lower, kebab, snake, compact, camel };
}

function searchForName(
  projectRoot: string,
  name: string,
): NamedTargetCandidate[] {
  const variants = buildVariants(name);
  const matchSet = new Set([
    variants.kebab,
    variants.snake,
    variants.compact,
    variants.camel,
  ].filter(Boolean));

  const matches: NamedTargetCandidate[] = [];
  for (let i = 0; i < SEARCH_ROOTS.length; i += 1) {
    const root = SEARCH_ROOTS[i];
    const rootPath = join(projectRoot, root);
    let entries: readonly string[];
    try {
      entries = readdirSync(rootPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const lowerEntry = entry.toLowerCase();
      if (!matchSet.has(lowerEntry)) continue;
      const full = join(rootPath, entry);
      let isDirectory = false;
      try {
        const s = statSync(full);
        isDirectory = s.isDirectory();
      } catch {
        continue;
      }
      const relative = `${root}/${entry}`.replace(/\\/g, "/");
      const score = scoreCandidate({
        rootIndex: i,
        isDirectory,
        exactCase: entry === variants.kebab || entry === variants.snake || entry === variants.compact,
      });
      const reasons = [
        `matched ${root}/ as a known module root`,
        isDirectory ? "directory match" : "file match",
      ];
      matches.push({
        path: relative,
        absolutePath: full,
        isDirectory,
        name,
        score,
        reasons,
      });
    }
  }

  // Also check for a top-level directory named after the module
  // (common in single-package repos where `core/` IS the module).
  const topLevelMatches: NamedTargetCandidate[] = [];
  let topEntries: readonly string[] = [];
  try {
    topEntries = readdirSync(projectRoot);
  } catch {
    topEntries = [];
  }
  for (const entry of topEntries) {
    if (!matchSet.has(entry.toLowerCase())) continue;
    if (SEARCH_ROOTS.includes(entry)) continue; // skip the search-root markers themselves
    const full = join(projectRoot, entry);
    let isDirectory = false;
    try {
      const s = statSync(full);
      isDirectory = s.isDirectory();
    } catch {
      continue;
    }
    topLevelMatches.push({
      path: entry,
      absolutePath: full,
      isDirectory,
      name,
      score: scoreCandidate({ rootIndex: SEARCH_ROOTS.length, isDirectory, exactCase: false }),
      reasons: ["top-level directory match"],
    });
  }

  return [...matches, ...topLevelMatches];
}

function scoreCandidate(input: {
  rootIndex: number;
  isDirectory: boolean;
  exactCase: boolean;
}): number {
  // Lower-index roots win convincingly: the per-rank step is wider
  // than AMBIGUITY_GAP so `modules/foo` always beats `apps/foo`
  // and isn't flagged as ambiguous. Roots beyond the first few have
  // their decay clamped so a deep root still scores higher than a
  // top-level fallback.
  const cappedIndex = Math.min(input.rootIndex, 5);
  let score = 200 - cappedIndex * 30;
  if (input.isDirectory) score += 20;
  if (input.exactCase) score += 5;
  return score;
}

function compareCandidates(
  a: NamedTargetCandidate,
  b: NamedTargetCandidate,
): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.path.localeCompare(b.path);
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Compose the multi-line "I found multiple matches" clarification
 * the Coordinator sends when discovery is ambiguous. Pure formatting
 * helper so the route handler / coordinator can stay thin.
 */
export function formatAmbiguousNamedTargetMessage(
  result: NamedTargetDiscoveryResult,
): string {
  const top = result.candidates.slice(0, 6).map((c) => c.path);
  if (top.length === 0) {
    return "No matching module was found in the configured repo.";
  }
  return (
    `I found multiple paths that could match — ${top.join(", ")}. ` +
    `Which one should I use? Reply with the path (e.g. "${top[0]}").`
  );
}

/**
 * Compose the "I couldn't find a Magister module" message when
 * extraction yielded names but the filesystem search returned
 * nothing under any known root.
 */
export function formatMissingNamedTargetMessage(
  result: NamedTargetDiscoveryResult,
): string {
  const names = result.extractedNames.slice(0, 3);
  if (names.length === 0) {
    return (
      "I couldn't identify a file or module to work on. " +
      "Name a specific path (e.g. `core/foo.ts`) or describe the module to change."
    );
  }
  const namePart =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return (
    `I couldn't find a ${namePart} module or file under the configured repo. ` +
    `Should I create one, or point me to the path?`
  );
}

/**
 * True when the path resolves inside the project root. Used by the
 * Coordinator before binding a discovered candidate so we never
 * silently jump to a sibling repo just because its name matched.
 */
export function isInsideProjectRoot(
  candidatePath: string,
  projectRoot: string,
): boolean {
  const abs = resolve(candidatePath);
  const root = resolve(projectRoot);
  if (abs === root) return true;
  const withSep = root.endsWith(sep) ? root : root + sep;
  return abs.startsWith(withSep);
}
