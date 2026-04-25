/**
 * Add or extend a named import — without duplicating, without
 * reordering existing import lines, and without changing the file's
 * export surface.
 *
 * Supports two cases:
 *   1. Module is already imported with a `{ … }` clause from the same
 *      specifier — extend the clause, keeping any existing names.
 *   2. Module is not imported yet — insert a new `import { name } from
 *      "specifier";` line just below the last existing import (or at
 *      the top of the file if there are none).
 *
 * Refuses when:
 *   - file is missing
 *   - the existing import for the same specifier uses a different shape
 *     (default-only, namespace `* as ns`, side-effect-only) — those are
 *     unambiguous but mixing them is risky, so we punt to the LLM
 *   - post-edit validation fails
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildUnifiedDiff,
  computeExportDelta,
  validatePostEdit,
} from "./util.js";
import type { AppliedTransform, SkippedTransform, TransformResult } from "./types.js";

export interface AddImportInput {
  readonly projectRoot: string;
  readonly file: string;
  /** Module specifier — e.g. "./utils.js" or "node:fs". */
  readonly specifier: string;
  /** Names to import, in declaration order. */
  readonly names: readonly string[];
  /** When true, insert as `import type { … } from "…"`. */
  readonly typeOnly?: boolean;
}

export type AddNamedImportToContentResult =
  | {
      readonly ok: true;
      readonly updated: string;
      readonly pattern: "named-import-extend" | "named-import-add";
      readonly summary: string;
      readonly notes: string;
    }
  | {
      readonly ok: false;
      readonly code: SkippedTransform["reasonCode"];
      readonly reason: string;
    };

export async function tryAddImport(input: AddImportInput): Promise<TransformResult> {
  if (input.names.length === 0) {
    return refusal(input.file, "unsupported-shape", "No names provided to import.");
  }
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal(input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");
  const result = addNamedImportToContent(original, {
    file: input.file,
    specifier: input.specifier,
    names: input.names,
    typeOnly: input.typeOnly,
  });
  if (!result.ok) {
    return refusal(input.file, result.code, result.reason);
  }
  if (result.updated === original) {
    return refusal(input.file, "duplicate", `All requested names already imported from "${input.specifier}".`);
  }
  const updated = result.updated;

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
    transformType: "import-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: result.pattern,
    insertedSnippetSummary: result.summary,
    exportDiff,
    notes: result.notes,
  };
  return applied;
}

export function addNamedImportToContent(
  original: string,
  input: {
    readonly file: string;
    readonly specifier: string;
    readonly names: readonly string[];
    readonly typeOnly?: boolean;
  },
): AddNamedImportToContentResult {
  if (input.names.length === 0) {
    return { ok: false, code: "unsupported-shape", reason: "No names provided to import." };
  }
  const lines = original.split("\n");

  // Locate any existing import line for this specifier.
  const importLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) importLineIndices.push(i);
  }
  let matchedIdx = -1;
  for (const idx of importLineIndices) {
    const line = lines[idx];
    if (line.includes(`"${input.specifier}"`) || line.includes(`'${input.specifier}'`)) {
      matchedIdx = idx;
      break;
    }
  }

  if (matchedIdx >= 0) {
    const original_line = lines[matchedIdx];
    // Only handle the `{ … }` named-import shape. Refuse otherwise.
    const namedRe = /^(\s*import\s+(?:type\s+)?)\{\s*([^}]*?)\s*\}\s*(from\s+['"][^'"]+['"]\s*;?\s*)$/;
    const m = namedRe.exec(original_line);
    if (!m) {
      return {
        ok: false,
        code: "unsupported-shape",
        reason: `Existing import from "${input.specifier}" is not a named-import {…} shape — refusing to mix shapes.`,
      };
    }
    const [, prefix, namesStr, suffix] = m;
    const existingNames = namesStr.split(",").map((s) => s.trim()).filter(Boolean);
    const merged = mergeNames(existingNames, input.names);
    if (merged.length === existingNames.length) {
      return {
        ok: true,
        updated: original,
        pattern: "named-import-extend",
        summary: `import already contains { ${input.names.join(", ")} } from "${input.specifier}"`,
        notes: `Existing import for "${input.specifier}" already contains requested name(s).`,
      };
    }
    const newImport = `${prefix}{ ${merged.join(", ")} } ${suffix.replace(/\s*;\s*$/, "")};`;
    const newLines = [...lines];
    newLines[matchedIdx] = newImport.replace(/\n.*/g, "");
    return {
      ok: true,
      updated: newLines.join("\n"),
      pattern: "named-import-extend",
      summary: `extend import { ${input.names.join(", ")} } from "${input.specifier}"`,
      notes: `Extended existing import for "${input.specifier}" at line ${matchedIdx + 1}.`,
    };
  } else {
    // Fresh import. Insert after the last existing import line, or at
    // the top of the file if there are no imports.
    const insertAt = importLineIndices.length > 0
      ? importLineIndices[importLineIndices.length - 1] + 1
      : 0;
    const importLine = `import ${input.typeOnly ? "type " : ""}{ ${input.names.join(", ")} } from "${input.specifier}";`;
    const newLines = [...lines];
    newLines.splice(insertAt, 0, importLine);
    return {
      ok: true,
      updated: newLines.join("\n"),
      pattern: "named-import-add",
      summary: `add import { ${input.names.join(", ")} } from "${input.specifier}"`,
      notes: `Added new import for "${input.specifier}".`,
    };
  }
}

function refusal(file: string, code: SkippedTransform["reasonCode"], reason: string): SkippedTransform {
  return { kind: "skipped", transformType: "import-add", file, reasonCode: code, reason };
}

function mergeNames(existing: readonly string[], add: readonly string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const n of add) {
    if (!seen.has(n)) { out.push(n); seen.add(n); }
  }
  return out;
}
