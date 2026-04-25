/**
 * Deterministic Zod schema field add — for the simple, ubiquitous
 * shape `const X = z.object({ … })`. Refuses anything more clever.
 *
 * Supported:
 *   const X = z.object({ a: z.string() });
 *   const X = z.object({ a: z.string(), b: z.number().optional() });
 *   export const X = z.object({ … });
 *
 * Refused (returns SkippedTransform):
 *   - chained schemas:   z.object({…}).strict() / .partial() / .extend({…})
 *   - intersections:     z.intersection(A, B)
 *   - merges:            z.object({…}).merge(B)
 *   - spreads:           z.object({ ...other, a: z.string() })
 *   - dynamic keys:      z.object({ [key]: z.string() })
 *   - already-declared keys
 *
 * The TS type → Zod call mapping is intentionally narrow. If the
 * caller's type doesn't fit, return SkippedTransform with reason
 * "unsupported-shape" and let the LLM Builder decide.
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

export interface AddZodSchemaFieldInput {
  readonly projectRoot: string;
  readonly file: string;
  /** Schema constant name, e.g. "UserSchema". */
  readonly schemaName: string;
  /** Field key, e.g. "email". */
  readonly fieldName: string;
  /**
   * Either a TypeScript type expression we can map to a zod call
   * (e.g. "string" → "z.string()"), or an explicit zod expression
   * starting with "z.…" (passed through verbatim).
   */
  readonly fieldType: string;
  readonly optional?: boolean;
}

const PRIMITIVE_MAP: Record<string, string> = {
  "string": "z.string()",
  "number": "z.number()",
  "boolean": "z.boolean()",
  "bigint": "z.bigint()",
  "date": "z.date()",
  "Date": "z.date()",
  "any": "z.any()",
  "unknown": "z.unknown()",
  "null": "z.null()",
  "undefined": "z.undefined()",
};

export async function tryAddZodSchemaField(
  input: AddZodSchemaFieldInput,
): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal(input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");

  // Match: `(export )? const <Name>(: SomeType)? = z.object(`
  const declRegex = new RegExp(
    `(^|\\n)(\\s*)(?:export\\s+)?const\\s+${escapeRegex(input.schemaName)}\\b[^=\\n]*=\\s*z\\.object\\s*\\(\\s*`,
  );
  const declMatch = declRegex.exec(original);
  if (!declMatch) {
    return refusal(
      input.file,
      "not-recognizable",
      `No \`const ${input.schemaName} = z.object(…)\` found.`,
    );
  }

  const startAfterMatch = declMatch.index + declMatch[0].length;
  // The next non-whitespace char must be `{`. Otherwise this is
  // something like `z.object(BaseShape)` or a spread — refuse.
  const head = original.slice(startAfterMatch).trimStart();
  if (!head.startsWith("{")) {
    return refusal(
      input.file,
      "unsupported-shape",
      `${input.schemaName} = z.object(…) is not a direct object literal — refusing.`,
    );
  }
  const openIdx = original.indexOf("{", startAfterMatch);
  const closeIdx = findMatchingDelimiter(original, openIdx, "{");
  if (closeIdx < 0) {
    return refusal(input.file, "not-recognizable", "Schema object body `{…}` could not be balanced.");
  }
  // The character following the matching `}` should be `)` (close
  // of z.object). Anything else (e.g. `).strict()`, `).extend(`) is
  // chained — refuse.
  const afterClose = original.slice(closeIdx + 1).trimStart();
  if (!afterClose.startsWith(")")) {
    return refusal(
      input.file,
      "unsupported-shape",
      `${input.schemaName} body has trailing content before \`)\` — refusing.`,
    );
  }
  // Detect chained calls AFTER `)` — `.strict()` / `.partial()` / etc.
  const afterParen = afterClose.slice(1).trimStart();
  if (afterParen.startsWith(".")) {
    return refusal(
      input.file,
      "unsupported-shape",
      `${input.schemaName} chains additional Zod calls (\`${afterParen.slice(0, 24)}…\`) — refusing.`,
    );
  }

  const body = original.slice(openIdx + 1, closeIdx);
  if (/\.\.\./.test(body)) {
    return refusal(input.file, "unsupported-shape", "Schema body contains a spread (`...`) — refusing.");
  }
  if (/\[\s*[A-Za-z_$][\w$]*\s*\]\s*:/.test(body)) {
    return refusal(input.file, "unsupported-shape", "Schema body contains a computed key — refusing.");
  }

  // Duplicate-key detection.
  const keyRegex = new RegExp(
    `(?:^|[\\s,{])${escapeRegex(input.fieldName)}\\s*:`,
    "m",
  );
  if (keyRegex.test(body)) {
    return refusal(
      input.file,
      "duplicate",
      `Field "${input.fieldName}" is already declared on ${input.schemaName}.`,
    );
  }

  const zodExpr = mapToZod(input.fieldType.trim(), input.optional ?? false);
  if (!zodExpr) {
    return refusal(
      input.file,
      "unsupported-shape",
      `Field type "${input.fieldType}" cannot be mapped deterministically to a Zod call.`,
    );
  }

  const closeLineStart = original.lastIndexOf("\n", closeIdx) + 1;
  const closeIndent = original.slice(closeLineStart, closeIdx).match(/^\s*/)?.[0] ?? "";
  const memberIndent = closeIndent + "  ";

  const trimmedBody = body.replace(/\s+$/, "");
  const fieldLine = `${memberIndent}${input.fieldName}: ${zodExpr},`;
  const insertion =
    trimmedBody.length === 0
      ? `\n${fieldLine}\n${closeIndent}`
      : `${trimmedBody.endsWith(",") ? "" : ","}\n${fieldLine}\n${closeIndent}`;

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
    transformType: "zod-field-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `const ${input.schemaName} = z.object({ … })`,
    insertedSnippetSummary: `${input.schemaName}.${input.fieldName}: ${zodExpr}`,
    exportDiff,
    notes:
      `Added field "${input.fieldName}: ${zodExpr}" to ${input.schemaName}` +
      (input.optional ? " (optional)" : ""),
  };
  return applied;
}

function refusal(file: string, code: SkippedTransform["reasonCode"], reason: string): SkippedTransform {
  return { kind: "skipped", transformType: "zod-field-add", file, reasonCode: code, reason };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mapToZod(typeText: string, optional: boolean): string | null {
  const wrap = (expr: string): string => optional ? `${expr}.optional()` : expr;

  // Caller-provided zod expression — let it pass through verbatim.
  if (/^z\./.test(typeText)) {
    return wrap(typeText);
  }
  // Primitive mapping.
  const primitive = PRIMITIVE_MAP[typeText];
  if (primitive) return wrap(primitive);

  // Array of primitive.
  const arrayMatch = /^([A-Za-z_$][\w$]*)\[\]$/.exec(typeText);
  if (arrayMatch) {
    const inner = PRIMITIVE_MAP[arrayMatch[1]];
    if (inner) return wrap(`z.array(${inner})`);
  }
  // String-literal union: "a" | "b" | "c"
  const literals = typeText.split("|").map((s) => s.trim()).filter(Boolean);
  if (literals.length >= 2 && literals.every((l) => /^['"`].*['"`]$/.test(l))) {
    const stripped = literals.map((l) => l.replace(/^['"`]|['"`]$/g, ""));
    return wrap(`z.enum([${stripped.map((s) => `"${s}"`).join(", ")}])`);
  }
  // Record<string, string> | Record<string, number>
  const recordMatch = /^Record<\s*string\s*,\s*([A-Za-z_$][\w$]*)\s*>$/.exec(typeText);
  if (recordMatch) {
    const inner = PRIMITIVE_MAP[recordMatch[1]];
    if (inner) return wrap(`z.record(z.string(), ${inner})`);
  }
  return null;
}
