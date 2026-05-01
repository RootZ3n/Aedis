/**
 * Fast-path deterministic diff check — the gate that replaces the
 * LLM-driven Critic for fast_review runs.
 *
 * It is INTENTIONALLY paranoid. The claim of fast_review is "this is a
 * docs/comment/typo edit, not a code change", and the Builder may have
 * misinterpreted the prompt. We re-validate the actual diff against
 * that claim before allowing the run to advance to approval.
 *
 * If any check fails, the result is `{ ok: false, reasons }`. Callers
 * MUST escalate (re-run as standard_review) or fail the run; they
 * MUST NOT silently downgrade to "warning". The fast path's safety
 * argument depends on this gate being hard.
 *
 * Pure — no I/O, no env reads, no LLM. Suitable for unit tests with
 * concrete diff fixtures.
 */

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Minimal shape of a Builder file change. Aedis already produces a
 * richer `FileChange` type but the diff check only needs path,
 * operation, original content, and new content (or a unified diff).
 */
export interface FastDiffCheckChange {
  readonly path: string;
  readonly operation: "create" | "modify" | "delete";
  /** New content; may be empty for "delete". */
  readonly content: string | null;
  /** Original content; may be null for "create". */
  readonly originalContent: string | null;
  /** Optional unified diff string. Used as a fallback when content is unavailable. */
  readonly diff?: string | null;
}

export interface FastDiffCheckOptions {
  /** Maximum bytes of new content allowed in fast_review. Default 4096. */
  readonly maxNewBytes?: number;
  /**
   * Maximum number of changed lines (added + removed). Default 40.
   * Single-line README/comment edits typically touch <5 lines; the
   * default leaves headroom for paragraph-level docs edits.
   */
  readonly maxChangedLines?: number;
}

export interface FastDiffCheckResult {
  readonly ok: boolean;
  /** One reason per check that failed. Empty when ok. */
  readonly reasons: readonly string[];
  /**
   * Per-file detail for the receipt. Same shape regardless of pass/fail
   * so the UI can render a uniform table.
   */
  readonly perFile: readonly {
    readonly path: string;
    readonly ok: boolean;
    readonly reasons: readonly string[];
    readonly addedLines: number;
    readonly removedLines: number;
    readonly bytes: number;
  }[];
}

// ─── Pattern Tables ──────────────────────────────────────────────────

// Doc-file extensions allowed in fast_review.
const DOC_EXT = /\.(md|markdown|mdx|rst|adoc|txt)$/i;
const DOC_BASENAME = /(^|\/)(README|CHANGELOG|CONTRIBUTING|LICENSE|CODE_OF_CONDUCT|AUTHORS|NOTICE)(\.[A-Za-z]+)?$/;

// Code-file extensions where fast_review is only safe when the diff
// is comment-only. The post-build check inspects added lines and
// rejects any line that is not within a comment.
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|lua|sh|bash|gd|tscn|tres|gdshader|vue|svelte|css|scss|sass|less|html)$/i;

// Secret-shaped patterns. Same generation as the redaction layer
// elsewhere in Aedis; we want to refuse fast-promotion of anything
// that even smells like a credential leak.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:Authorization|api.?key|secret|token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_./+\-]{8,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,                                 // AWS access key
  /\bASIA[0-9A-Z]{16}\b/,                                 // AWS STS
  /\bgh[opsr]_[A-Za-z0-9]{30,}\b/,                        // GitHub tokens
  /\bsk-[A-Za-z0-9]{20,}\b/,                              // OpenAI / others
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,                     // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,                   // PEM
];

// Comment-line predicates per language family. These intentionally
// recognize ONLY simple single-line comments in code files. Block
// comments and string-literal-resembling-comments are rejected as
// "not obviously a comment" and route the run to strict_review.
const SINGLE_LINE_COMMENT_PREFIXES: ReadonlyArray<{ ext: RegExp; prefixes: readonly RegExp[] }> = [
  { ext: /\.(ts|tsx|js|jsx|mjs|cjs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|gd|gdshader|rs|go|css|scss|sass|less)$/i, prefixes: [/^\s*\/\//] },
  { ext: /\.(py|rb|sh|bash|toml|ini|conf|yml|yaml)$/i, prefixes: [/^\s*#/] },
  { ext: /\.(lua)$/i, prefixes: [/^\s*--/] },
  { ext: /\.(html|svelte|vue)$/i, prefixes: [/^\s*<!--/, /^\s*\/\//] },
  { ext: /\.(tscn|tres)$/i, prefixes: [/^\s*;/] },
];

// ─── Helpers ─────────────────────────────────────────────────────────

function isDocFile(path: string): boolean {
  return DOC_EXT.test(path) || DOC_BASENAME.test(path);
}

function isCodeFile(path: string): boolean {
  return CODE_EXT.test(path);
}

function commentPrefixes(path: string): readonly RegExp[] {
  for (const entry of SINGLE_LINE_COMMENT_PREFIXES) {
    if (entry.ext.test(path)) return entry.prefixes;
  }
  return [];
}

function lineIsBlankOrComment(line: string, prefixes: readonly RegExp[]): boolean {
  if (line.trim().length === 0) return true;
  return prefixes.some((rx) => rx.test(line));
}

interface AddedRemovedCounts {
  added: string[];
  removed: string[];
}

/**
 * Compute added / removed lines between two text blobs. We use a
 * simple LCS-free heuristic: lines unique to `next` are "added",
 * unique to `prev` are "removed", duplicates count as moves and are
 * NOT classified (a fast_review change that just shuffles lines is
 * fine — the gate cares about new code, not order).
 */
function diffLines(prev: string, next: string): AddedRemovedCounts {
  const prevLines = prev.split("\n");
  const nextLines = next.split("\n");
  const prevCount = new Map<string, number>();
  for (const l of prevLines) prevCount.set(l, (prevCount.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of nextLines) {
    const c = prevCount.get(l) ?? 0;
    if (c === 0) added.push(l);
    else prevCount.set(l, c - 1);
  }
  const nextCount = new Map<string, number>();
  for (const l of nextLines) nextCount.set(l, (nextCount.get(l) ?? 0) + 1);
  const removed: string[] = [];
  for (const l of prevLines) {
    const c = nextCount.get(l) ?? 0;
    if (c === 0) removed.push(l);
    else nextCount.set(l, c - 1);
  }
  return { added, removed };
}

function diffLinesFromUnifiedDiff(diff: string): AddedRemovedCounts {
  const added: string[] = [];
  const removed: string[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) added.push(raw.slice(1));
    else if (raw.startsWith("-")) removed.push(raw.slice(1));
  }
  return { added, removed };
}

function bytesOf(s: string | null | undefined): number {
  if (!s) return 0;
  return Buffer.byteLength(s, "utf-8");
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Validate a Builder change-set against fast_review's claims:
 *   - exactly one file is touched
 *   - the file is either a doc-allowlist file OR a code file with
 *     comment-only added lines
 *   - total added bytes are below the cap
 *   - total changed lines are below the cap
 *   - no secret-shaped content appears in any added line
 *   - no `delete` operation (a fast review never deletes a whole file)
 */
export function checkFastPathDiff(
  changes: readonly FastDiffCheckChange[],
  opts: FastDiffCheckOptions = {},
): FastDiffCheckResult {
  const maxNewBytes = opts.maxNewBytes ?? 4096;
  const maxChangedLines = opts.maxChangedLines ?? 40;

  const reasons: string[] = [];
  const perFile: FastDiffCheckResult["perFile"][number][] = [];

  if (changes.length === 0) {
    return {
      ok: false,
      reasons: ["fast_review produced no file changes"],
      perFile: [],
    };
  }

  if (changes.length !== 1) {
    reasons.push(`fast_review touched ${changes.length} files (must be exactly 1)`);
  }

  for (const ch of changes) {
    const fileReasons: string[] = [];
    const path = ch.path;
    const isDoc = isDocFile(path);
    const isCode = isCodeFile(path);
    const bytes = bytesOf(ch.content);

    if (ch.operation === "delete") {
      fileReasons.push("delete operation not allowed in fast_review");
    }

    if (!isDoc && !isCode) {
      fileReasons.push(`file extension is not a fast-path doc or recognised code type: ${path}`);
    }

    // Compute added/removed lines.
    let counts: AddedRemovedCounts;
    if (ch.content !== null && ch.originalContent !== null) {
      counts = diffLines(ch.originalContent, ch.content);
    } else if (ch.diff) {
      counts = diffLinesFromUnifiedDiff(ch.diff);
    } else if (ch.operation === "create" && ch.content !== null) {
      counts = { added: ch.content.split("\n"), removed: [] };
    } else {
      // No way to know what changed — refuse fast path.
      fileReasons.push("no diff data available for fast-path verification");
      counts = { added: [], removed: [] };
    }

    const totalChanged = counts.added.length + counts.removed.length;

    if (bytes > maxNewBytes) {
      fileReasons.push(`new content is ${bytes} bytes (cap ${maxNewBytes})`);
    }
    if (totalChanged > maxChangedLines) {
      fileReasons.push(`${totalChanged} changed lines (cap ${maxChangedLines})`);
    }

    // Secret detection on added content.
    for (const line of counts.added) {
      for (const rx of SECRET_PATTERNS) {
        if (rx.test(line)) {
          fileReasons.push("added content contains secret-shaped token");
          break;
        }
      }
    }

    // For code files, every added line must be blank or a single-line
    // comment in that file's language. This is the load-bearing check
    // that prevents fast_review from accepting a real code change.
    if (isCode && !isDoc) {
      const prefixes = commentPrefixes(path);
      if (prefixes.length === 0) {
        fileReasons.push(`code file ${path} has no recognised comment prefix for fast-path validation`);
      } else {
        for (const line of counts.added) {
          if (!lineIsBlankOrComment(line, prefixes)) {
            fileReasons.push("added line is not a blank line or single-line comment");
            break;
          }
        }
      }
    }

    perFile.push({
      path,
      ok: fileReasons.length === 0,
      reasons: fileReasons,
      addedLines: counts.added.length,
      removedLines: counts.removed.length,
      bytes,
    });
    reasons.push(...fileReasons.map((r) => `${path}: ${r}`));
  }

  return { ok: reasons.length === 0, reasons, perFile };
}
