/**
 * Deterministic type alias property add — for object-shape aliases.
 *
 * Locates `type <Name> = { … }` (with or without `export`) and inserts
 * a single property line just before the closing `}`. Refuses
 * (returns SkippedTransform) when:
 *   - file missing
 *   - no matching alias found
 *   - alias is NOT a plain object literal:
 *       type X = A & B;            // intersection
 *       type X = A | B;            // union
 *       type X = SomeMapped<A>;    // mapped type
 *       type X = T extends U ? …;  // conditional
 *       type X<T> = …;             // we still allow generics; the
 *                                  // parser only refuses non-object RHS
 *   - the property is already declared
 *   - post-edit validation fails
 *
 * For unions/intersections the LLM Builder is the right call —
 * picking which arm to extend is a semantic question we can't make
 * deterministic.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildUnifiedDiff,
  computeExportDelta,
  findMatchingDelimiter,
  validatePostEdit,
} from "./util.js";
import type { AppliedTransform, SkippedTransform, TransformResult } from "./types.js";

export interface AddTypeAliasPropertyInput {
  readonly projectRoot: string;
  readonly file: string;
  readonly typeName: string;
  readonly propertyName: string;
  readonly propertyType: string;
  readonly optional?: boolean;
  readonly readonly?: boolean;
}

export async function tryAddTypeAliasProperty(
  input: AddTypeAliasPropertyInput,
): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal(input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");

  // Match: `(export )? type <Name>(<Generics>)? = <RHS>`
  // Capture everything from `=` to the line end so we can decide if
  // the RHS starts with `{` (object literal) or with something else
  // (intersection/union/mapped/etc).
  const declRegex = new RegExp(
    `(^|\\n)(\\s*)(?:export\\s+)?type\\s+${escapeRegex(input.typeName)}\\b(?:\\s*<[^=]*?>)?\\s*=\\s*`,
  );
  const declMatch = declRegex.exec(original);
  if (!declMatch) {
    return refusal(
      input.file,
      "not-recognizable",
      `No \`type ${input.typeName} = …\` declaration found.`,
    );
  }
  const startOfRhs = declMatch.index + declMatch[0].length;
  const rhsHead = original.slice(startOfRhs).trimStart();
  if (!rhsHead.startsWith("{")) {
    return refusal(
      input.file,
      "unsupported-shape",
      `Type alias ${input.typeName} is not a plain object literal (RHS starts with "${rhsHead.slice(0, 40)}…").`,
    );
  }
  // Locate the actual `{` in the original (preserving offsets).
  const openIdx = original.indexOf("{", startOfRhs);
  if (openIdx < 0) {
    return refusal(input.file, "not-recognizable", "Type alias object opener `{` not found.");
  }
  const closeIdx = findMatchingDelimiter(original, openIdx, "{");
  if (closeIdx < 0) {
    return refusal(input.file, "not-recognizable", "Could not find matching `}` for type alias body.");
  }
  // Refuse if the closing brace is followed by ` & `, ` | `, etc.
  // (intersection/union outside the body — the alias is wider than
  // just the object).
  const afterClose = original.slice(closeIdx + 1).trimStart();
  if (afterClose.startsWith("&") || afterClose.startsWith("|")) {
    return refusal(
      input.file,
      "unsupported-shape",
      `Type alias ${input.typeName} composes (intersection/union) outside the object literal — refusing.`,
    );
  }

  const body = original.slice(openIdx + 1, closeIdx);

  // Duplicate detection (same regex shape as interface).
  const dupRegex = new RegExp(
    `(?:^|[\\s;,{])\\s*(?:readonly\\s+)?${escapeRegex(input.propertyName)}\\s*\\??\\s*:`,
    "m",
  );
  if (dupRegex.test(body)) {
    return refusal(
      input.file,
      "duplicate",
      `Property "${input.propertyName}" is already declared on type ${input.typeName}.`,
    );
  }

  const closeLineStart = original.lastIndexOf("\n", closeIdx) + 1;
  const closeIndent = original.slice(closeLineStart, closeIdx).match(/^\s*/)?.[0] ?? "";
  const memberIndent = closeIndent + "  ";

  const propLine =
    `${memberIndent}` +
    (input.readonly ? "readonly " : "") +
    `${input.propertyName}` +
    (input.optional ? "?" : "") +
    `: ${input.propertyType.trim()};`;

  const trimmedBody = body.replace(/\s+$/, "");
  // Type-alias bodies typically use either `;` or `,` between members.
  // Default to `;` to match interface convention; preserve a comma if
  // the existing body uses commas.
  const usesCommas = /,\s*\n\s*[A-Za-z_$]/.test(trimmedBody) && !/;\s*\n\s*[A-Za-z_$]/.test(trimmedBody);
  const sep = usesCommas ? "," : ";";
  const propLineSep = usesCommas
    ? propLine.replace(/;$/, ",")
    : propLine;
  const insertion =
    trimmedBody.length === 0
      ? `\n${propLineSep}\n${closeIndent}`
      : `${trimmedBody.endsWith(";") || trimmedBody.endsWith(",") ? "" : sep}\n${propLineSep}\n${closeIndent}`;

  const updated =
    original.slice(0, closeIdx).replace(/\s+$/, "") +
    insertion +
    original.slice(closeIdx);

  const validation = validatePostEdit(original, updated);
  if (!validation.ok) {
    return refusal(input.file, "validation-failed", validation.reason);
  }
  const exportDiff = computeExportDelta(original, updated);
  if (exportDiff.missing.length > 0) {
    return refusal(input.file, "validation-failed", `Edit dropped exports: ${exportDiff.missing.join(", ")}.`);
  }

  const applied: AppliedTransform = {
    kind: "applied",
    transformType: "type-alias-property-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `type ${input.typeName} = { … }`,
    insertedSnippetSummary:
      `${input.typeName}.${input.readonly ? "readonly " : ""}${input.propertyName}${input.optional ? "?" : ""}: ${input.propertyType}`,
    exportDiff,
    notes:
      `Added property "${input.propertyName}: ${input.propertyType}" to type alias ${input.typeName}` +
      (input.optional ? " (optional)" : "") +
      (input.readonly ? " (readonly)" : "") +
      (usesCommas ? " (comma-separated body)" : ""),
  };
  return applied;
}

function refusal(file: string, code: SkippedTransform["reasonCode"], reason: string): SkippedTransform {
  return { kind: "skipped", transformType: "type-alias-property-add", file, reasonCode: code, reason };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
