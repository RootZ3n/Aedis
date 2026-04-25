/**
 * Append a named export at the end of a TS/JS file without touching
 * any existing line. Refuses when:
 *   - the file is missing
 *   - the name is already exported
 *   - the file's brace balance is non-zero (parser would refuse)
 *   - post-edit validation fails
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { extractNamedExports } from "../../workers/builder.js";
import {
  buildUnifiedDiff,
  computeExportDelta,
  validatePostEdit,
} from "./util.js";
import type { AppliedTransform, SkippedTransform, TransformResult } from "./types.js";

export interface AddExportInput {
  readonly projectRoot: string;
  readonly file: string;
  /** The export keyword + declaration, e.g. `export const FOO = 1;`. */
  readonly declaration: string;
  /** The name being exported — used for duplicate detection. */
  readonly name: string;
}

export async function tryAddNamedExport(input: AddExportInput): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal(input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");
  const existing = new Set(extractNamedExports(original));
  if (existing.has(input.name)) {
    return refusal(input.file, "duplicate", `Export "${input.name}" already declared.`);
  }
  if (!/^\s*export\b/.test(input.declaration)) {
    return refusal(input.file, "unsupported-shape", `Declaration must start with 'export '.`);
  }
  // Refuse if the declaration appears to declare a different name.
  // (Conservative: we only allow `export const X`, `export function X`,
  // `export class X`, `export type X`, `export interface X`, `export enum X`.)
  const declRegex = new RegExp(`^\\s*export\\s+(?:async\\s+)?(?:default\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+${escapeRegex(input.name)}\\b`);
  if (!declRegex.test(input.declaration)) {
    return refusal(
      input.file,
      "unsupported-shape",
      `Declaration does not declare a named export called "${input.name}".`,
    );
  }
  const trailing = original.endsWith("\n") ? "" : "\n";
  const updated = `${original}${trailing}\n${input.declaration.trimEnd()}\n`;
  const validation = validatePostEdit(original, updated);
  if (!validation.ok) {
    return refusal(input.file, "validation-failed", validation.reason);
  }
  const exportDiff = computeExportDelta(original, updated);
  if (!exportDiff.added.includes(input.name)) {
    return refusal(input.file, "validation-failed", `Post-edit export set does not contain "${input.name}".`);
  }
  if (exportDiff.missing.length > 0) {
    return refusal(
      input.file,
      "validation-failed",
      `Edit dropped exports: ${exportDiff.missing.join(", ")}.`,
    );
  }
  const applied: AppliedTransform = {
    kind: "applied",
    transformType: "named-export-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `export-tail-append`,
    insertedSnippetSummary: `export ${input.name}`,
    exportDiff,
    notes: `Appended named export "${input.name}" at end of file.`,
  };
  return applied;
}

function refusal(file: string, code: SkippedTransform["reasonCode"], reason: string): SkippedTransform {
  return { kind: "skipped", transformType: "named-export-add", file, reasonCode: code, reason };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
