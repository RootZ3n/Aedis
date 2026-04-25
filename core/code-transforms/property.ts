/**
 * Add a property to a recognized exported object literal. Supports
 * the simple, ubiquitous shape:
 *
 *   export const NAME = {
 *     keyA: valueA,
 *     keyB: valueB,
 *   };
 *
 * or
 *
 *   export const NAME: SomeType = {
 *     keyA: valueA,
 *   };
 *
 * Refuses (returns SkippedTransform) when:
 *   - the file is missing
 *   - the named export isn't an object-literal initializer
 *   - the property already exists on the object
 *   - the object literal contains a spread (`...`), computed key
 *     (`[expr]:`), or method shorthand — those are dynamic enough
 *     that we'd rather defer to the LLM
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

export interface AddPropertyInput {
  readonly projectRoot: string;
  readonly file: string;
  /** Name of the exported object. */
  readonly objectName: string;
  /** Property key. */
  readonly propertyKey: string;
  /** Property value text — inserted verbatim. */
  readonly propertyValue: string;
}

export async function tryAddObjectProperty(input: AddPropertyInput): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal(input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");

  // Locate `export const NAME [: T] = {` ... `};`
  const declRegex = new RegExp(
    `(^|\\n)\\s*export\\s+const\\s+${escapeRegex(input.objectName)}\\b[^=\\n]*=\\s*\\{`,
  );
  const declMatch = declRegex.exec(original);
  if (!declMatch) {
    return refusal(
      input.file,
      "not-recognizable",
      `Could not locate \`export const ${input.objectName} = { … }\` in file.`,
    );
  }
  // Find the matching closing brace for this object.
  const openIdx = original.indexOf("{", declMatch.index);
  if (openIdx < 0) {
    return refusal(input.file, "not-recognizable", "Object opener `{` not found.");
  }
  const closeIdx = findMatchingDelimiter(original, openIdx, "{");
  if (closeIdx < 0) {
    return refusal(input.file, "not-recognizable", "Could not find matching `}`.");
  }
  const objectBody = original.slice(openIdx + 1, closeIdx);

  // Refuse on dynamic shapes.
  if (/\.\.\./.test(objectBody)) {
    return refusal(input.file, "unsupported-shape", "Object contains a spread (`...`) — refusing.");
  }
  if (/\[\s*[A-Za-z_$][\w$]*\s*\]\s*:/.test(objectBody)) {
    return refusal(input.file, "unsupported-shape", "Object contains a computed key — refusing.");
  }

  // Duplicate-key check: simple identifier:keys only (skip strings/quotes).
  const keyRegex = /(^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g;
  for (const m of objectBody.matchAll(keyRegex)) {
    if (m[2] === input.propertyKey) {
      return refusal(input.file, "duplicate", `Key "${input.propertyKey}" already on ${input.objectName}.`);
    }
  }

  // Choose insertion site: just before the closing brace, on its own line.
  const closeLineStart = original.lastIndexOf("\n", closeIdx) + 1;
  const closeIndent = original.slice(closeLineStart, closeIdx).match(/^\s*/)?.[0] ?? "";
  const memberIndent = closeIndent + "  ";

  // Detect existing trailing-comma style — if the last entry already
  // has a trailing comma, we don't need to add one.
  const beforeClose = original.slice(0, closeIdx).trimEnd();
  const needsLeadingComma = !beforeClose.endsWith(",") && !beforeClose.endsWith("{");

  const insertion = `${needsLeadingComma ? "," : ""}\n${memberIndent}${input.propertyKey}: ${input.propertyValue},\n${closeIndent}`;
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
    transformType: "property-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `object-literal-tail-add:${input.objectName}`,
    insertedSnippetSummary: `${input.objectName}.${input.propertyKey} = ${shorten(input.propertyValue, 40)}`,
    exportDiff,
    notes: `Added property "${input.propertyKey}" to ${input.objectName} before closing brace.`,
  };
  return applied;
}

function refusal(file: string, code: SkippedTransform["reasonCode"], reason: string): SkippedTransform {
  return { kind: "skipped", transformType: "property-add", file, reasonCode: code, reason };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shorten(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
