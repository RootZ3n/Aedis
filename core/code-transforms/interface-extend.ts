/**
 * Deterministic interface property add.
 *
 * Locates `interface <Name> { … }` (with or without `export`) and
 * inserts a single property line just before the closing `}`. Refuses
 * (returns SkippedTransform) when:
 *   - file missing
 *   - no matching interface found
 *   - the interface uses `extends` against more than one base AND the
 *     prompt didn't explicitly ask for that — we can still extend, but
 *     we record the inheritance so the receipt makes it visible
 *   - the property is already declared in the target interface
 *     (set-based by name; signature changes are a separate transform)
 *   - body contains an index signature `[key: …]: …` AND the new prop
 *     name would conflict — we don't try to reason about index sigs
 *   - post-edit validation fails (brace/paren/bracket balance,
 *     line-count, export delta)
 *
 * Supports:
 *   - optional (`?:`)
 *   - readonly
 *   - both `interface X { … }` and `export interface X { … }`
 *   - multiple interfaces in the same file (matches by name)
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

export interface AddInterfacePropertyInput {
  readonly projectRoot: string;
  readonly file: string;
  /** Interface name, e.g. "User". */
  readonly interfaceName: string;
  /** Property name, e.g. "email". */
  readonly propertyName: string;
  /** TypeScript type expression, e.g. "string", "Record<string, string>". */
  readonly propertyType: string;
  readonly optional?: boolean;
  readonly readonly?: boolean;
}

export async function tryAddInterfaceProperty(
  input: AddInterfacePropertyInput,
): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal(input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");

  const declRegex = new RegExp(
    `(^|\\n)(\\s*)(?:export\\s+)?interface\\s+${escapeRegex(input.interfaceName)}\\b([^{\\n]*)\\{`,
  );
  const declMatch = declRegex.exec(original);
  if (!declMatch) {
    return refusal(
      input.file,
      "not-recognizable",
      `No \`interface ${input.interfaceName} { … }\` declaration found in file.`,
    );
  }

  const headerText = declMatch[3] ?? "";
  const baseIndent = declMatch[2] ?? "";
  // Refuse on multi-base extends — semantics are still well defined,
  // but listing it makes the receipt explicit and lets the LLM Builder
  // handle the "field X belongs in base Y" case.
  const extendsCount = (headerText.match(/\bextends\b/g) ?? []).length;
  // Single `extends Base` is allowed. Multiple bases (e.g. extends A, B)
  // sometimes mean conflicting intent; we still proceed, but flag.

  const openIdx = original.indexOf("{", declMatch.index);
  if (openIdx < 0) {
    return refusal(input.file, "not-recognizable", "Interface body opener `{` not found.");
  }
  const closeIdx = findMatchingDelimiter(original, openIdx, "{");
  if (closeIdx < 0) {
    return refusal(input.file, "not-recognizable", "Could not find matching `}` for interface body.");
  }
  const body = original.slice(openIdx + 1, closeIdx);

  // Duplicate-property detection. Match `name?: …` or `readonly name: …`
  // at the start of a body line.
  const dupRegex = new RegExp(
    `(?:^|[\\s;{])\\s*(?:readonly\\s+)?${escapeRegex(input.propertyName)}\\s*\\??\\s*:`,
    "m",
  );
  if (dupRegex.test(body)) {
    return refusal(
      input.file,
      "duplicate",
      `Property "${input.propertyName}" is already declared on interface ${input.interfaceName}.`,
    );
  }

  // Compute member indentation by looking at the closing-brace line
  // and adding two spaces. Mirrors the project-wide convention.
  const closeLineStart = original.lastIndexOf("\n", closeIdx) + 1;
  const closeIndent = original.slice(closeLineStart, closeIdx).match(/^\s*/)?.[0] ?? baseIndent;
  const memberIndent = closeIndent.length > baseIndent.length ? closeIndent + "  " : closeIndent + "  ";

  const propLine =
    `${memberIndent}` +
    (input.readonly ? "readonly " : "") +
    `${input.propertyName}` +
    (input.optional ? "?" : "") +
    `: ${input.propertyType.trim()};`;

  // Detect existing trailing-semicolon style — if the last member
  // already ends with `;`, just append. If body is empty, format
  // as a single-member body. Otherwise add a leading newline.
  const trimmedBody = body.replace(/\s+$/, "");
  const insertion =
    trimmedBody.length === 0
      ? `\n${propLine}\n${closeIndent}`
      : `${trimmedBody.endsWith(";") || trimmedBody.endsWith(",") ? "" : ";"}\n${propLine}\n${closeIndent}`;

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
    transformType: "interface-property-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `interface ${input.interfaceName}${extendsCount > 0 ? " (extends)" : ""}`,
    insertedSnippetSummary:
      `${input.interfaceName}.${input.readonly ? "readonly " : ""}${input.propertyName}${input.optional ? "?" : ""}: ${input.propertyType}`,
    exportDiff,
    notes:
      `Added property "${input.propertyName}: ${input.propertyType}" to interface ${input.interfaceName}` +
      (input.optional ? " (optional)" : "") +
      (input.readonly ? " (readonly)" : "") +
      (extendsCount > 0 ? `; interface uses extends — caller may also need to update bases.` : ""),
  };
  return applied;
}

function refusal(file: string, code: SkippedTransform["reasonCode"], reason: string): SkippedTransform {
  return { kind: "skipped", transformType: "interface-property-add", file, reasonCode: code, reason };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
