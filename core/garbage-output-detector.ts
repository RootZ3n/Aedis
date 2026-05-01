/**
 * Garbage-output detector — deterministic post-Builder check that
 * refuses to advance a run when the diff carries the visual signs of
 * model failure (repetitive output, placeholder-only stubs, suspicious
 * bulk additions for trivial prompts, near-no-op diffs).
 *
 * Pure: no I/O, no env reads, no LLM. Operates on the same
 * FileChange shape the Builder already produces.
 *
 * The detector is INTENTIONALLY conservative. False negatives let bad
 * output reach approval (the human still has the final say). False
 * positives block legitimate output and force a re-run, which is
 * costly. The thresholds are tuned for "obvious garbage" — not "any
 * output that looks weird."
 *
 * On trigger the caller MUST:
 *   - block approval / mark needs_review
 *   - record per-finding reasons in the receipt
 *   - surface the reasons in the operator narrative
 *   - never silently demote findings to advisory
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface GarbageCheckChange {
  readonly path: string;
  readonly operation: "create" | "modify" | "delete";
  readonly content: string | null;
  readonly originalContent: string | null;
  readonly diff?: string | null;
}

export type GarbageReasonKind =
  | "repeated_identical_lines"
  | "duplicate_exports"
  | "suspicious_bulk_addition"
  | "placeholder_only"
  | "noop_diff"
  | "byte_for_byte_duplicate";

export interface GarbageFinding {
  readonly kind: GarbageReasonKind;
  readonly path: string;
  /** Human-readable explanation of what was detected. */
  readonly reason: string;
  /** Optional sample lines / snippet (post-redaction is caller's job). */
  readonly sample?: readonly string[];
}

export interface GarbageCheckResult {
  readonly ok: boolean;
  readonly findings: readonly GarbageFinding[];
  readonly perFile: readonly {
    readonly path: string;
    readonly ok: boolean;
    readonly findings: readonly GarbageFinding[];
    readonly addedLines: number;
    readonly removedLines: number;
  }[];
}

export interface GarbageCheckOptions {
  /**
   * Maximum number of repeated-identical added lines before the
   * `repeated_identical_lines` finding fires. Default 4 — covers the
   * "model spat out the same line 5 times" case. Whitespace-only lines
   * never count.
   */
  readonly maxRepeatedLines?: number;
  /**
   * For "tiny task" prompts (heuristic: < `tinyTaskCharCount`), the
   * resulting diff must add fewer than this many lines. Crosses the
   * threshold → `suspicious_bulk_addition`.
   */
  readonly maxTinyTaskAddedLines?: number;
  readonly tinyTaskCharCount?: number;
  /**
   * Threshold for the placeholder-only check. If more than this fraction
   * of the added lines are TODO/FIXME-style placeholders, the file
   * triggers `placeholder_only`. Default 0.6.
   */
  readonly placeholderRatioThreshold?: number;
}

// ─── Pattern Tables ──────────────────────────────────────────────────

const PLACEHOLDER_LINE_PATTERNS: readonly RegExp[] = [
  /^\s*\/\/\s*(todo|fixme|xxx|hack|implement|placeholder|stub)\b/i,
  /^\s*#\s*(todo|fixme|xxx|hack|implement|placeholder|stub)\b/i,
  /\bTODO\(implement\)\b/,
  /\bnot[_\s]implemented(_yet)?\b/i,
  /\bplaceholder\s+only\b/i,
  /\b(NotImplementedError|UnsupportedOperationException)\b/,
  /^\s*throw\s+new\s+Error\(\s*["'`]not\s+implemented["'`]/i,
  /^\s*pass\s*$/, // Python placeholder
  /^\s*\.\.\.\s*$/, // TS/JS/Python ellipsis
];

const EXPORT_PATTERNS: readonly RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^\s*export\s+\{\s*([^}]+)\s*\}/,
];

// ─── Helpers ─────────────────────────────────────────────────────────

function diffLines(prev: string | null, next: string | null): { added: string[]; removed: string[] } {
  const prevLines = (prev ?? "").split("\n");
  const nextLines = (next ?? "").split("\n");
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

function diffLinesFromUnified(diff: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) added.push(raw.slice(1));
    else if (raw.startsWith("-")) removed.push(raw.slice(1));
  }
  return { added, removed };
}

function isWhitespace(line: string): boolean {
  return line.trim().length === 0;
}

function detectRepeatedLines(
  added: readonly string[],
  threshold: number,
): GarbageFinding | null {
  // Bucket non-whitespace lines and find the most-repeated.
  const counts = new Map<string, number>();
  for (const line of added) {
    if (isWhitespace(line)) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let topLine = "";
  let topCount = 0;
  for (const [line, count] of counts) {
    if (count > topCount) { topCount = count; topLine = line; }
  }
  if (topCount > threshold) {
    return {
      kind: "repeated_identical_lines",
      path: "<file>",
      reason: `${topCount} identical added lines (threshold ${threshold + 1}); model output appears repetitive`,
      sample: [topLine.slice(0, 160)],
    };
  }
  return null;
}

function detectDuplicateExports(added: readonly string[]): GarbageFinding | null {
  const seen = new Map<string, number>();
  for (const line of added) {
    for (const rx of EXPORT_PATTERNS) {
      const m = rx.exec(line);
      if (!m) continue;
      const names = m[1].split(",").map((s) => s.trim().replace(/\s+as\s+\w+/, "").trim()).filter(Boolean);
      for (const name of names) {
        seen.set(name, (seen.get(name) ?? 0) + 1);
      }
    }
  }
  const dupes = [...seen.entries()].filter(([, c]) => c > 1);
  if (dupes.length === 0) return null;
  const list = dupes.map(([n, c]) => `${n}×${c}`).join(", ");
  return {
    kind: "duplicate_exports",
    path: "<file>",
    reason: `Duplicate export declarations in added content: ${list}`,
    sample: dupes.map(([n]) => n),
  };
}

function detectPlaceholderOnly(
  added: readonly string[],
  threshold: number,
): GarbageFinding | null {
  const nonBlank = added.filter((l) => !isWhitespace(l));
  if (nonBlank.length < 3) return null; // too small to flag
  const placeholderHits = nonBlank.filter((line) =>
    PLACEHOLDER_LINE_PATTERNS.some((rx) => rx.test(line)),
  ).length;
  const ratio = placeholderHits / nonBlank.length;
  if (ratio < threshold) return null;
  return {
    kind: "placeholder_only",
    path: "<file>",
    reason:
      `${placeholderHits}/${nonBlank.length} added lines are placeholder/TODO-style ` +
      `(ratio ${(ratio * 100).toFixed(0)}% ≥ threshold ${(threshold * 100).toFixed(0)}%); ` +
      `model returned a stub instead of implementation`,
  };
}

function detectByteForByteDuplicate(change: GarbageCheckChange): GarbageFinding | null {
  if (change.operation !== "modify") return null;
  if (change.content === null || change.originalContent === null) return null;
  if (change.content !== change.originalContent) return null;
  return {
    kind: "byte_for_byte_duplicate",
    path: change.path,
    reason: "Modified file is byte-for-byte identical to the original — Builder produced no real change",
  };
}

function detectNoopDiff(addedCount: number, removedCount: number): GarbageFinding | null {
  if (addedCount === 0 && removedCount === 0) {
    return {
      kind: "noop_diff",
      path: "<file>",
      reason: "Diff added zero lines and removed zero lines — no meaningful change",
    };
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Inspect a Builder change-set for garbage signs. Returns `ok: true`
 * with no findings on healthy diffs; returns `ok: false` with
 * per-file detail otherwise.
 *
 * `prompt` is used only for the suspicious-bulk-addition heuristic
 * (tiny prompts → tiny diffs expected). Empty prompt → bulk check skipped.
 */
export function checkGarbageOutput(
  changes: readonly GarbageCheckChange[],
  prompt: string,
  opts: GarbageCheckOptions = {},
): GarbageCheckResult {
  const maxRepeated = opts.maxRepeatedLines ?? 4;
  const maxTinyAdded = opts.maxTinyTaskAddedLines ?? 80;
  const tinyChars = opts.tinyTaskCharCount ?? 80;
  const placeholderThreshold = opts.placeholderRatioThreshold ?? 0.6;

  const findings: GarbageFinding[] = [];
  const perFile: GarbageCheckResult["perFile"][number][] = [];

  const isTinyPrompt = prompt.length > 0 && prompt.length < tinyChars;

  for (const change of changes) {
    const fileFindings: GarbageFinding[] = [];

    // Byte-for-byte duplicate: caught FIRST so we don't burn other
    // checks on what's effectively no change at all.
    const dupe = detectByteForByteDuplicate(change);
    if (dupe) fileFindings.push(dupe);

    let added: string[] = [];
    let removed: string[] = [];
    let haveDiffSignal = false;
    if (change.content !== null && change.originalContent !== null) {
      const r = diffLines(change.originalContent, change.content);
      added = r.added; removed = r.removed;
      haveDiffSignal = true;
    } else if (change.diff) {
      const r = diffLinesFromUnified(change.diff);
      added = r.added; removed = r.removed;
      haveDiffSignal = true;
    } else if (change.operation === "create" && change.content !== null) {
      added = change.content.split("\n");
      haveDiffSignal = true;
    }

    // No-op diff: zero added and zero removed lines. Only fire when
    // we actually have a diff signal — a `modify` change that arrived
    // without originalContent or a unified diff is "unknowable", not
    // "no-op", and flagging it would produce false positives on the
    // many code paths that don't capture before-state.
    if (haveDiffSignal) {
      const noop = detectNoopDiff(added.length, removed.length);
      if (noop) fileFindings.push({ ...noop, path: change.path });
    }

    // Suspicious bulk addition for a tiny prompt.
    if (isTinyPrompt && added.length > maxTinyAdded) {
      fileFindings.push({
        kind: "suspicious_bulk_addition",
        path: change.path,
        reason:
          `Added ${added.length} lines for a ${prompt.length}-char prompt ` +
          `(threshold ${maxTinyAdded}); diff is suspiciously large for the requested change`,
      });
    }

    // Repeated identical added lines.
    const rep = detectRepeatedLines(added, maxRepeated);
    if (rep) fileFindings.push({ ...rep, path: change.path });

    // Duplicate exports inside the added content.
    const dupeExp = detectDuplicateExports(added);
    if (dupeExp) fileFindings.push({ ...dupeExp, path: change.path });

    // Placeholder-only content.
    const ph = detectPlaceholderOnly(added, placeholderThreshold);
    if (ph) fileFindings.push({ ...ph, path: change.path });

    perFile.push({
      path: change.path,
      ok: fileFindings.length === 0,
      findings: fileFindings,
      addedLines: added.length,
      removedLines: removed.length,
    });
    findings.push(...fileFindings);
  }

  return { ok: findings.length === 0, findings, perFile };
}

/**
 * Format a GarbageCheckResult as a single human-readable line for use
 * in receipts and logs. Returns "" when ok.
 */
export function summarizeGarbageResult(r: GarbageCheckResult): string {
  if (r.ok) return "";
  const groups = new Map<GarbageReasonKind, number>();
  for (const f of r.findings) groups.set(f.kind, (groups.get(f.kind) ?? 0) + 1);
  const parts = [...groups.entries()].map(([k, n]) => `${k}×${n}`);
  return `Garbage output detected: ${parts.join(", ")}`;
}
