/**
 * Loqui Follow-Up Scope Binding.
 *
 * When the previous Loqui turn was a clarification asking the user
 * for a file/module path, and the next user message is essentially
 * just a path, that message is the missing scope — not a fresh
 * standalone task. This module decides when to merge a path-only
 * follow-up with the prior build intent so the router can dispatch
 * the combined request through the normal build pipeline (target
 * discovery, scouts, plan, approval) instead of hitting the
 * specificity gate again or treating the bare path as gibberish.
 *
 * Pure function — no I/O beyond an existence stat against the
 * resolved absolute path. Never executes anything; the router
 * still decides whether the combined prompt is build-worthy.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface FollowUpScopeContext {
  /**
   * The user prompt that was clarification-blocked. Required — no
   * follow-up can be inferred without the original intent to bind to.
   */
  readonly originalPrompt: string;
  /**
   * Project root for resolving and normalizing paths. When provided,
   * absolute paths inside the root are normalized to repo-relative
   * form so target discovery and scouts can match them against the
   * workspace tree.
   */
  readonly projectRoot?: string;
}

export interface PathFollowUpResolution {
  /** Combined prompt: original intent + the named scope. */
  readonly combinedPrompt: string;
  /** Repo-relative form when inside projectRoot, else absolute. */
  readonly relativePath: string;
  /** Resolved absolute path (always absolute). */
  readonly absolutePath: string;
  /** True when the path exists on disk at detection time. */
  readonly exists: boolean;
  /** True when the existing path is a directory (vs file). */
  readonly isDirectory: boolean;
  /** Human-facing acknowledgement to show before dispatch. */
  readonly reason: string;
}

// ─── Path-only detection ─────────────────────────────────────────────
//
// A "path-only" message is one whose substantive content is a single
// path token, with optional leading hints ("in", "use", "path:", etc.)
// and trailing punctuation. We accept absolute Unix paths, relative
// paths with a slash, and bare filenames with an extension. URLs and
// multi-token instructions are rejected so a real new build request
// like "fix the bug in core/foo.ts" never gets misread as a follow-up.

const LEAD_WORDS: ReadonlySet<string> = new Set([
  "in", "at", "use", "using", "look", "please", "try", "the",
  "scope", "module", "target", "path", "directory", "dir", "folder",
  "scope:", "module:", "target:", "path:", "dir:", "folder:",
]);

const URL_RE = /^[a-z][a-z0-9+.\-]*:\/\//i;

/**
 * Returns the bare path token when `input` is essentially a path-only
 * message, or null otherwise. Strips leading hint words and trailing
 * punctuation; a token without a slash must carry a recognizable
 * extension (`foo.ts`) to qualify, otherwise it is not a path.
 */
export function extractPathOnlyToken(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  if (/[\r\n]/.test(raw)) return null;
  // Cap length so a multi-clause request that happens to start with a
  // path can't masquerade as a follow-up.
  if (raw.length > 240) return null;

  const tokens = raw
    .replace(/[\s,]+$/g, "")
    .split(/\s+/)
    .map((tok) => tok.replace(/[.!?,;:]+$/g, ""))
    .filter((tok) => tok.length > 0);

  while (tokens.length > 1 && LEAD_WORDS.has(tokens[0].toLowerCase())) {
    tokens.shift();
  }
  if (tokens.length !== 1) return null;

  const candidate = tokens[0];
  if (URL_RE.test(candidate)) return null;
  // Strip optional surrounding quotes/backticks
  const unquoted = candidate.replace(/^["'`]+|["'`]+$/g, "");
  if (!unquoted) return null;

  const looksLikePath =
    unquoted.includes("/") || unquoted.includes("\\") || /\.[a-z0-9]+$/i.test(unquoted);
  if (!looksLikePath) return null;
  return unquoted;
}

// ─── Resolution ──────────────────────────────────────────────────────

/**
 * Build a follow-up resolution from a path-only message and the
 * conversational context. Returns null when the input is not a
 * path-only message, when there is no original prompt to bind it to,
 * or when the path token decodes to something that cannot be a
 * filesystem location (e.g., empty after sanitization).
 *
 * The resolver does NOT require the path to exist — a non-existent
 * path is still a meaningful scope answer (the user might be naming
 * a file they want created, or a scout target that the operator can
 * verify). Callers that need existence verification read
 * `resolution.exists` and `resolution.isDirectory` and decide.
 */
export function resolvePathFollowUp(
  input: string,
  ctx: FollowUpScopeContext,
): PathFollowUpResolution | null {
  if (!ctx || typeof ctx.originalPrompt !== "string" || ctx.originalPrompt.trim().length === 0) {
    return null;
  }
  const candidate = extractPathOnlyToken(input);
  if (!candidate) return null;

  const projectRoot = ctx.projectRoot ? resolve(ctx.projectRoot) : null;
  const normalizedCandidate = candidate.replace(/\\/g, "/");

  let absolute: string;
  let relativePath: string;

  if (isAbsolute(normalizedCandidate)) {
    absolute = resolve(normalizedCandidate);
    if (projectRoot && pathIsInside(absolute, projectRoot)) {
      const rel = relative(projectRoot, absolute);
      relativePath = rel.length === 0 ? "." : rel.replace(/\\/g, "/");
    } else {
      relativePath = absolute;
    }
  } else {
    const stripped = normalizedCandidate.replace(/^\.\//, "");
    if (projectRoot) {
      absolute = resolve(projectRoot, stripped);
      relativePath = stripped;
    } else {
      absolute = resolve(stripped);
      relativePath = stripped;
    }
  }

  let exists = false;
  let isDirectory = false;
  if (existsSync(absolute)) {
    try {
      const s = statSync(absolute);
      exists = true;
      isDirectory = s.isDirectory();
    } catch {
      exists = false;
    }
  }

  const original = ctx.originalPrompt.trim();
  const scopeNoun = isDirectory ? "directory" : exists ? "file" : "path";
  const combinedPrompt =
    `${original}\n\nTarget scope: ${relativePath} (${scopeNoun}).`;

  const reason =
    `Got it — using ${relativePath} as the target scope. ` +
    `I'll discover relevant files and prepare the build through the normal approval pipeline.`;

  return {
    combinedPrompt,
    relativePath,
    absolutePath: absolute,
    exists,
    isDirectory,
    reason,
  };
}

function pathIsInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSep);
}
