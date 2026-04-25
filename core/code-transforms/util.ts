/**
 * Shared post-edit validation + diff helpers for the deterministic
 * transform layer. Every transform calls into these to verify it
 * produced a clean, minimal patch and to render a unified diff for
 * the receipt.
 *
 * These helpers are intentionally narrow:
 *   - validatePostEdit: brace-balance + line-count sanity
 *   - computeExportDelta: re-uses the Builder's named-export extractor
 *     so a deterministic transform fails by the same rules the
 *     existing export-loss guard uses
 *   - buildUnifiedDiff: minimal hunk renderer suitable for receipts
 */

import { extractNamedExports } from "../../workers/builder.js";
import type { ExportDiff } from "../../workers/builder-diagnostics.js";

export interface PostEditValidation {
  readonly ok: boolean;
  readonly reason: string;
}

export function validatePostEdit(original: string, updated: string): PostEditValidation {
  if (updated === original) {
    return { ok: false, reason: "transform produced an identical file (no-op)" };
  }
  const beforeBraces = balanceCount(original);
  const afterBraces = balanceCount(updated);
  if (beforeBraces.curly !== afterBraces.curly) {
    return {
      ok: false,
      reason: `brace balance drifted: { vs } before=${beforeBraces.curly} after=${afterBraces.curly}`,
    };
  }
  if (beforeBraces.paren !== afterBraces.paren) {
    return {
      ok: false,
      reason: `paren balance drifted: ( vs ) before=${beforeBraces.paren} after=${afterBraces.paren}`,
    };
  }
  if (beforeBraces.square !== afterBraces.square) {
    return {
      ok: false,
      reason: `bracket balance drifted: [ vs ] before=${beforeBraces.square} after=${afterBraces.square}`,
    };
  }
  // Heuristic: an insertion must increase the line count, never
  // decrease it. (Pure-replacement transforms are not yet supported
  // by this layer.)
  if (updated.split("\n").length < original.split("\n").length) {
    return { ok: false, reason: "transform reduced the file's line count" };
  }
  return { ok: true, reason: "" };
}

interface Balance { curly: number; paren: number; square: number }

/**
 * Compute the running difference between opener and closer counts
 * across a source. Ignores characters inside string/template literals
 * and line comments. Doesn't handle block comments perfectly — that's
 * a known limitation; production-grade balance checking would need a
 * tokenizer. The check is "did the delta change?" not "is the file
 * balanced?", so as long as the same imperfections apply before and
 * after, it's enough to catch unintended drift.
 */
function balanceCount(source: string): Balance {
  let curly = 0, paren = 0, square = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
    if (inBlockComment) {
      if (ch === "*" && source[i + 1] === "/") { inBlockComment = false; i++; }
      continue;
    }
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") { escape = true; continue; }
      if (ch === inString) { inString = null; continue; }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") { inLineComment = true; i++; continue; }
    if (ch === "/" && source[i + 1] === "*") { inBlockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { inString = ch; continue; }
    if (ch === "{") curly++;
    else if (ch === "}") curly--;
    else if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
  }
  return { curly, paren, square };
}

/**
 * Compute a structural ExportDiff for receipts. Same shape the Builder's
 * attempt records use, so the Coordinator's downstream consumers don't
 * need a special path for deterministic transforms.
 */
export function computeExportDelta(original: string, updated: string): ExportDiff {
  const before = new Set(extractNamedExports(original));
  const after = new Set(extractNamedExports(updated));
  const missing: string[] = [];
  const added: string[] = [];
  for (const n of before) if (!after.has(n)) missing.push(n);
  for (const n of after) if (!before.has(n)) added.push(n);
  missing.sort(); added.sort();
  return {
    original: [...before].sort(),
    proposed: [...after].sort(),
    missing,
    added,
  };
}

/**
 * Brace-balanced find of the closing delimiter matching the opener at
 * `openIdx`. String- and comment-aware. Works for `{}`, `()`, `[]`,
 * and angle-bracket pairs (`<>`) when the opener character is passed
 * as `expectedOpen`. Returns -1 on unbalanced input.
 *
 * Common util used by every transform that needs to find the end of a
 * delimited block (object literal body, function call, generic args).
 */
export function findMatchingDelimiter(
  source: string,
  openIdx: number,
  expectedOpen: "{" | "(" | "[",
): number {
  const close = ({ "{": "}", "(": ")", "[": "]" } as const)[expectedOpen];
  if (source[openIdx] !== expectedOpen) return -1;
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
    if (inBlockComment) {
      if (ch === "*" && source[i + 1] === "/") { inBlockComment = false; i++; }
      continue;
    }
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") { escape = true; continue; }
      if (ch === inString) { inString = null; continue; }
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") { inLineComment = true; i++; continue; }
    if (ch === "/" && source[i + 1] === "*") { inBlockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { inString = ch; continue; }
    if (ch === expectedOpen) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Render a minimal unified diff suitable for receipts. We don't need
 * an exact `git diff` — the receipt UI accepts the synthetic shape
 * the Builder already emits in its own buildUnifiedDiff. We provide a
 * line-by-line diff with an `@@ -…,… +…,… @@` header.
 */
export function buildUnifiedDiff(file: string, original: string, updated: string): string {
  const a = original.split("\n");
  const b = updated.split("\n");
  // Find the first and last differing lines.
  let firstDiff = 0;
  while (firstDiff < a.length && firstDiff < b.length && a[firstDiff] === b[firstDiff]) firstDiff++;
  let lastDiffA = a.length - 1;
  let lastDiffB = b.length - 1;
  while (lastDiffA >= firstDiff && lastDiffB >= firstDiff && a[lastDiffA] === b[lastDiffB]) {
    lastDiffA--; lastDiffB--;
  }
  // Build hunk
  const aSlice = a.slice(firstDiff, lastDiffA + 1);
  const bSlice = b.slice(firstDiff, lastDiffB + 1);
  const aCount = aSlice.length;
  const bCount = bSlice.length;
  const header = `--- a/${file}\n+++ b/${file}\n@@ -${firstDiff + 1},${aCount} +${firstDiff + 1},${bCount} @@`;
  const body = [
    ...aSlice.map((l) => `-${l}`),
    ...bSlice.map((l) => `+${l}`),
  ].join("\n");
  return aCount === 0 && bCount === 0 ? "" : `${header}\n${body}\n`;
}
