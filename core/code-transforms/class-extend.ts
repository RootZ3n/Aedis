/**
 * Deterministic class member insertion — fields and methods.
 *
 * Both transforms locate `class <Name> { … }` (with or without
 * `export`/`abstract`/`extends`/`implements`/generics/decorators-on-the-
 * class) and add a single member at a sensible location:
 *
 *   - Field insertion: just before the first member that has a `(`
 *     (constructor or method). If no such member, just before the
 *     closing `}`. The parser includes leading decorator blocks in
 *     member.start, so the new field lands before those decorators.
 *
 *   - Method insertion: at the end of the class body, just before the
 *     closing `}`. Trailing decorator lines (none expected at body
 *     tail) would be walked similarly if present.
 *
 * Refuses (returns SkippedTransform) when:
 *   - file is missing
 *   - the class isn't found / multiple top-level classes share the name
 *     ("ambiguous")
 *   - a member with the same name already exists (duplicate by name;
 *     overload-aware insertion is out of scope for v1)
 *   - the class body contains computed member names (`["x"]() {}`)
 *   - post-edit validation fails (brace/paren/bracket balance,
 *     line-count, export delta)
 *
 * The transforms never call a model and never write the file —
 * `deterministic-builder.ts` writes the result to disk.
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
import {
  parseClassBody,
  parseConstructorParams,
  scanDecoratorBlock,
  skipWsAndComments,
  type ParsedClassMember,
  type ParsedConstructorParam,
} from "./class-parser.js";
import { addNamedImportToContent } from "./imports.js";
import type { AppliedTransform, SkippedTransform, TransformResult } from "./types.js";

export type Visibility = "public" | "private" | "protected";

export interface AddClassFieldInput {
  readonly projectRoot: string;
  readonly file: string;
  readonly className: string;
  readonly fieldName: string;
  /** TypeScript type expression. May be empty for `name = value;` style. */
  readonly fieldType: string;
  /** Optional initializer text — if set, emitted as `name: T = init;` */
  readonly initializer?: string;
  readonly visibility?: Visibility;
  readonly isStatic?: boolean;
  readonly isReadonly?: boolean;
  readonly optional?: boolean;
}

export interface AddConstructorParamInput {
  readonly projectRoot: string;
  readonly file: string;
  readonly className: string;
  readonly paramName: string;
  /** TypeScript type — e.g. "Logger", "Repository<User>". */
  readonly paramType: string;
  readonly visibility?: Visibility;
  readonly isReadonly?: boolean;
  readonly optional?: boolean;
  /** Initializer text — when set, emitted as `name: T = init`. Constructor params don't typically need this but it's supported. */
  readonly initializer?: string;
}

export interface AddClassMethodInput {
  readonly projectRoot: string;
  readonly file: string;
  readonly className: string;
  readonly methodName: string;
  /** Parameter list contents WITHOUT the surrounding parens. */
  readonly parameters: string;
  /** Return type, e.g. "Promise<void>". Empty string allowed. */
  readonly returnType: string;
  /** Body text WITHOUT the surrounding braces. Empty body allowed. */
  readonly body?: string;
  readonly visibility?: Visibility;
  readonly isStatic?: boolean;
  readonly isAsync?: boolean;
}

export interface DecoratorInput {
  readonly name: string;
  /** Argument text without outer parens. Empty emits `@Name()`. */
  readonly argument?: string;
  /** Safe named import source. Supported for NestJS decorators via @nestjs/common. */
  readonly importFrom?: string;
}

export interface AddDecoratedClassMethodInput extends AddClassMethodInput {
  readonly decorator: DecoratorInput;
}

export interface AddDecoratedClassFieldInput extends AddClassFieldInput {
  readonly decorator: DecoratorInput;
}

interface ClassLocation {
  readonly headerStart: number;     // index of `class` keyword
  readonly bodyOpenIdx: number;     // index of `{`
  readonly bodyCloseIdx: number;    // index of `}`
  readonly bodyIndent: string;      // indent of the line containing `}`
  readonly memberIndent: string;    // bodyIndent + "  "
  readonly extendsClause: string;   // contents of `extends X` if any
  readonly implementsClause: string;// contents of `implements I, J` if any
}

// ─── Public API ────────────────────────────────────────────────────

export async function tryAddClassField(input: AddClassFieldInput): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal("class-field-add", input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");
  const located = locateClass(original, input.className);
  if (!located.ok) return refusal("class-field-add", input.file, located.code, located.reason);
  // Parse the body so we can route around decorator blocks safely
  // (multi-line decorators with `{}` inside their option objects
  // would otherwise split when we walk back line-by-line).
  const parsed = parseClassBody(original, located.location.bodyOpenIdx, located.location.bodyCloseIdx);
  if (!parsed.ok) {
    return refusal(
      "class-field-add",
      input.file,
      "unsupported-shape",
      `Class ${input.className}: ${parsed.reason}`,
    );
  }

  if (parsed.members.some((m) => m.name === input.fieldName)) {
    return refusal(
      "class-field-add",
      input.file,
      "duplicate",
      `Member "${input.fieldName}" already exists on class ${input.className}.`,
    );
  }

  const fieldLine = renderFieldLine(input, located.location.memberIndent);
  // Insertion site: just before the first method-like member (method,
  // constructor, getter, or setter). The parser already includes any
  // leading decorator block in `member.start`, so inserting there
  // lands ABOVE the decorator.
  const firstMethodLike = parsed.members.find(
    (m) => m.kind === "method" || m.kind === "constructor" || m.kind === "getter" || m.kind === "setter",
  );
  const anchor = firstMethodLike ? insertionLineStart(original, firstMethodLike.start) : null;
  const insertionIdx = anchor ?? located.location.bodyCloseIdx;
  // Detect whether we need a leading blank line (only when inserting
  // amid existing members) and whether we need a trailing blank line.
  const leadingBlank = needsLeadingBlank(original, insertionIdx);
  const trailingBlank = anchor !== null
    ? needsTrailingBlank(original, insertionIdx)
    : needsTrailingBlankAtBodyEnd(original, located.location);
  const insertion =
    (leadingBlank ? "\n" : "") +
    `${fieldLine}\n` +
    (trailingBlank ? "\n" : "");
  const updated =
    original.slice(0, insertionIdx) + insertion + original.slice(insertionIdx);

  const validation = validatePostEdit(original, updated);
  if (!validation.ok) {
    return refusal("class-field-add", input.file, "validation-failed", validation.reason);
  }
  const exportDiff = computeExportDelta(original, updated);
  if (exportDiff.missing.length > 0) {
    return refusal(
      "class-field-add",
      input.file,
      "validation-failed",
      `Edit dropped exports: ${exportDiff.missing.join(", ")}.`,
    );
  }
  return {
    kind: "applied",
    transformType: "class-field-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `class ${input.className}${located.location.extendsClause ? " (extends)" : ""}`,
    insertedSnippetSummary: fieldSummary(input),
    exportDiff,
    notes: `Added field "${input.fieldName}: ${input.fieldType}" to class ${input.className}` +
      (input.visibility ? ` (visibility=${input.visibility})` : "") +
      (input.isStatic ? " (static)" : "") +
      (input.isReadonly ? " (readonly)" : "") +
      (anchor === null ? " — class body had no methods, inserted at end" : " — inserted before first method/constructor"),
  };
}

export async function tryAddClassMethod(input: AddClassMethodInput): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal("class-method-add", input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");
  const located = locateClass(original, input.className);
  if (!located.ok) return refusal("class-method-add", input.file, located.code, located.reason);
  const parsed = parseClassBody(original, located.location.bodyOpenIdx, located.location.bodyCloseIdx);
  if (!parsed.ok) {
    return refusal(
      "class-method-add",
      input.file,
      "unsupported-shape",
      `Class ${input.className}: ${parsed.reason}`,
    );
  }

  if (parsed.members.some((m) => m.name === input.methodName)) {
    return refusal(
      "class-method-add",
      input.file,
      "duplicate",
      `Member "${input.methodName}" already exists on class ${input.className} — overload-aware insertion is not supported.`,
    );
  }

  const methodBlock = renderMethodBlock(input, located.location.memberIndent);
  // Always insert at the end of the body, just before the closing `}`.
  const insertionIdx = located.location.bodyCloseIdx;
  const trailingChunk = original.slice(0, insertionIdx).trimEnd();
  // We want a blank line BEFORE the new method when the body has prior
  // content; nothing extra when the body is empty. The closing `}`
  // already sits on its own line in the common case.
  const bodyHasContent = trailingChunk.length > 0 && trailingChunk[trailingChunk.length - 1] !== "{";
  const leadingBlank = bodyHasContent;
  const trailingNewline = !original.slice(insertionIdx).startsWith("\n") ? "\n" : "";
  const insertion =
    (leadingBlank ? "\n" : "") +
    methodBlock +
    "\n" +
    trailingNewline.replace(/^\n/, ""); // we want exactly one newline between method and `}`
  // The simpler shape: rebuild around the closing brace's indent.
  const closeLineStart = original.lastIndexOf("\n", insertionIdx) + 1;
  const closeIndent = original.slice(closeLineStart, insertionIdx).match(/^\s*/)?.[0] ?? located.location.bodyIndent;
  // Insert exactly: \n{methodBlock}\n{closeIndent}
  const block =
    "\n" +
    methodBlock +
    `\n${closeIndent}`;
  const updated =
    original.slice(0, insertionIdx).replace(/\s+$/, "") +
    block +
    original.slice(insertionIdx);

  const validation = validatePostEdit(original, updated);
  if (!validation.ok) {
    return refusal("class-method-add", input.file, "validation-failed", validation.reason);
  }
  const exportDiff = computeExportDelta(original, updated);
  if (exportDiff.missing.length > 0) {
    return refusal(
      "class-method-add",
      input.file,
      "validation-failed",
      `Edit dropped exports: ${exportDiff.missing.join(", ")}.`,
    );
  }
  void insertion; // avoid unused-warning of the simpler-shape branch
  return {
    kind: "applied",
    transformType: "class-method-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `class ${input.className}${located.location.extendsClause ? " (extends)" : ""}`,
    insertedSnippetSummary: methodSummary(input),
    exportDiff,
    notes: `Added method "${input.methodName}(${input.parameters})${input.returnType ? ": " + input.returnType : ""}" to class ${input.className}` +
      (input.visibility ? ` (visibility=${input.visibility})` : "") +
      (input.isStatic ? " (static)" : "") +
      (input.isAsync ? " (async)" : "") +
      ` — inserted at end of class body`,
  };
}

export async function tryAddDecoratedClassMethod(input: AddDecoratedClassMethodInput): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal("decorated-class-method-add", input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");
  const located = locateClass(original, input.className);
  if (!located.ok) return refusal("decorated-class-method-add", input.file, located.code, located.reason);
  const parsed = parseClassBody(original, located.location.bodyOpenIdx, located.location.bodyCloseIdx);
  if (!parsed.ok) {
    return refusal(
      "decorated-class-method-add",
      input.file,
      "unsupported-shape",
      `Class ${input.className}: ${parsed.reason}`,
    );
  }
  if (!isSimpleDecoratorName(input.decorator.name)) {
    return refusal("decorated-class-method-add", input.file, "unsupported-shape", `Unsupported decorator name "${input.decorator.name}".`);
  }
  if (!isSafeDecoratorArgument(input.decorator.argument ?? "")) {
    return refusal("decorated-class-method-add", input.file, "unsupported-shape", "Decorator argument is not a simple literal/call shape.");
  }
  if (parsed.members.some((m) => m.name === input.methodName)) {
    return refusal(
      "decorated-class-method-add",
      input.file,
      "duplicate",
      `Member "${input.methodName}" already exists on class ${input.className}.`,
    );
  }
  const duplicateRoute = findDuplicateRouteDecorator(original, parsed.members, input.decorator);
  if (duplicateRoute) {
    return refusal(
      "decorated-class-method-add",
      input.file,
      "duplicate",
      `Route decorator ${duplicateRoute} already exists on class ${input.className}.`,
    );
  }

  const methodBlock = renderDecoratedMethodBlock(input, located.location.memberIndent);
  const decoratedRouteMembers = parsed.members.filter((m) => hasAnyNestRouteDecorator(original, m));
  const lastRoute = decoratedRouteMembers[decoratedRouteMembers.length - 1];
  const insertionIdx = lastRoute ? afterMemberInsertionIndex(original, lastRoute.end) : located.location.bodyCloseIdx;
  const closeLineStart = original.lastIndexOf("\n", located.location.bodyCloseIdx) + 1;
  const closeIndent = original.slice(closeLineStart, located.location.bodyCloseIdx).match(/^\s*/)?.[0] ?? located.location.bodyIndent;
  const bodyHasContent = original.slice(located.location.bodyOpenIdx + 1, located.location.bodyCloseIdx).trim().length > 0;
  const insertion = lastRoute
    ? `\n\n${methodBlock}\n`
    : `${bodyHasContent ? "\n" : ""}${methodBlock}\n${closeIndent}`;
  let updated = original.slice(0, insertionIdx).replace(/[ \t]+$/, "") + insertion + original.slice(insertionIdx);

  const importResult = maybeAddDecoratorImport(updated, input.file, input.decorator);
  if (!importResult.ok) {
    return refusal("decorated-class-method-add", input.file, importResult.code, importResult.reason);
  }
  updated = importResult.updated;

  const validation = validatePostEdit(original, updated);
  if (!validation.ok) {
    return refusal("decorated-class-method-add", input.file, "validation-failed", validation.reason);
  }
  const exportDiff = computeExportDelta(original, updated);
  if (exportDiff.missing.length > 0) {
    return refusal(
      "decorated-class-method-add",
      input.file,
      "validation-failed",
      `Edit dropped exports: ${exportDiff.missing.join(", ")}.`,
    );
  }
  return {
    kind: "applied",
    transformType: "decorated-class-method-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `class ${input.className} + @${input.decorator.name}`,
    insertedSnippetSummary: `${renderDecoratorLine(input.decorator, "")} ${methodSummary(input)}`.trim(),
    exportDiff,
    notes:
      `Added decorated method @${input.decorator.name} "${input.methodName}" to class ${input.className}` +
      (lastRoute ? " — inserted after existing decorated route methods" : " — inserted at end of class body") +
      (importResult.changed ? `; ${importResult.notes}` : "; decorator import already present or not required"),
  };
}

export async function tryAddDecoratedClassField(input: AddDecoratedClassFieldInput): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal("decorated-class-field-add", input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");
  const located = locateClass(original, input.className);
  if (!located.ok) return refusal("decorated-class-field-add", input.file, located.code, located.reason);
  const parsed = parseClassBody(original, located.location.bodyOpenIdx, located.location.bodyCloseIdx);
  if (!parsed.ok) {
    return refusal(
      "decorated-class-field-add",
      input.file,
      "unsupported-shape",
      `Class ${input.className}: ${parsed.reason}`,
    );
  }
  if (!isSimpleDecoratorName(input.decorator.name) || !isSafeDecoratorArgument(input.decorator.argument ?? "")) {
    return refusal("decorated-class-field-add", input.file, "unsupported-shape", "Decorator shape is not supported for deterministic field insertion.");
  }
  if (parsed.members.some((m) => m.name === input.fieldName)) {
    return refusal(
      "decorated-class-field-add",
      input.file,
      "duplicate",
      `Member "${input.fieldName}" already exists on class ${input.className}.`,
    );
  }

  const fieldBlock = `${renderDecoratorLine(input.decorator, located.location.memberIndent)}\n${renderFieldLine(input, located.location.memberIndent)}`;
  const firstMethodLike = parsed.members.find(
    (m) => m.kind === "method" || m.kind === "constructor" || m.kind === "getter" || m.kind === "setter",
  );
  const anchor = firstMethodLike ? insertionLineStart(original, firstMethodLike.start) : null;
  const insertionIdx = anchor ?? located.location.bodyCloseIdx;
  const leadingBlank = needsLeadingBlank(original, insertionIdx);
  const trailingBlank = anchor !== null
    ? needsTrailingBlank(original, insertionIdx)
    : needsTrailingBlankAtBodyEnd(original, located.location);
  const insertion = (leadingBlank ? "\n" : "") + `${fieldBlock}\n` + (trailingBlank ? "\n" : "");
  let updated = original.slice(0, insertionIdx) + insertion + original.slice(insertionIdx);

  const importResult = maybeAddDecoratorImport(updated, input.file, input.decorator);
  if (!importResult.ok) {
    return refusal("decorated-class-field-add", input.file, importResult.code, importResult.reason);
  }
  updated = importResult.updated;

  const validation = validatePostEdit(original, updated);
  if (!validation.ok) {
    return refusal("decorated-class-field-add", input.file, "validation-failed", validation.reason);
  }
  const exportDiff = computeExportDelta(original, updated);
  if (exportDiff.missing.length > 0) {
    return refusal(
      "decorated-class-field-add",
      input.file,
      "validation-failed",
      `Edit dropped exports: ${exportDiff.missing.join(", ")}.`,
    );
  }
  return {
    kind: "applied",
    transformType: "decorated-class-field-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `class ${input.className} + @${input.decorator.name}`,
    insertedSnippetSummary: `${renderDecoratorLine(input.decorator, "")} ${fieldSummary(input)}`.trim(),
    exportDiff,
    notes:
      `Added decorated field @${input.decorator.name} "${input.fieldName}" to class ${input.className}` +
      (anchor === null ? " — class body had no methods, inserted at end" : " — inserted before first method/constructor") +
      (importResult.changed ? `; ${importResult.notes}` : "; decorator import already present or not required"),
  };
}

/**
 * Constructor parameter property add — the NestJS / Angular dependency
 * injection idiom. Locates `class X { constructor(<params>) { … } }`
 * and appends a new parameter at the end of the param list while
 * preserving:
 *
 *   - existing parameter decorators (`@Inject('TOKEN')`)
 *   - parameter property modifiers (`private`, `readonly`, …)
 *   - multi-line param-list formatting and trailing-comma style
 *
 * Refuses on:
 *   - class not found / multiple classes with the name (ambiguous)
 *   - no constructor in the class
 *   - duplicate parameter name
 *   - malformed parameter decorator (unbalanced parens)
 *   - any post-edit validation failure
 */
export async function tryAddConstructorParamProperty(
  input: AddConstructorParamInput,
): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal("class-constructor-param-add", input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");
  const located = locateClass(original, input.className);
  if (!located.ok) {
    return refusal("class-constructor-param-add", input.file, located.code, located.reason);
  }
  const parsed = parseClassBody(original, located.location.bodyOpenIdx, located.location.bodyCloseIdx);
  if (!parsed.ok) {
    return refusal(
      "class-constructor-param-add",
      input.file,
      "unsupported-shape",
      `Class ${input.className}: ${parsed.reason}`,
    );
  }
  const ctor = parsed.members.find((m) => m.kind === "constructor");
  if (!ctor) {
    return synthesizeConstructorParamProperty(input, original, located.location, parsed.members);
  }

  // Find the constructor's `(` and matching `)` from declStart.
  const ctorWord = original.indexOf("constructor", ctor.declStart);
  if (ctorWord < 0) {
    return refusal("class-constructor-param-add", input.file, "unrecognized-shape" as never, "constructor keyword missing");
  }
  // Skip past optional `<generics>` between `constructor` and `(`.
  let probe = ctorWord + "constructor".length;
  probe = skipWsAndComments(original, probe, ctor.end);
  if (original[probe] === "<") {
    // Walk balanced angles
    let depth = 0;
    while (probe < ctor.end) {
      const ch = original[probe];
      if (ch === "<") depth++;
      else if (ch === ">") { depth--; if (depth === 0) { probe++; break; } }
      probe++;
    }
    probe = skipWsAndComments(original, probe, ctor.end);
  }
  const parenOpen = probe;
  if (original[parenOpen] !== "(") {
    return refusal(
      "class-constructor-param-add",
      input.file,
      "unsupported-shape",
      `Constructor of ${input.className} does not start with "(" at expected position.`,
    );
  }
  const parenClose = findMatchingDelimiter(original, parenOpen, "(");
  if (parenClose < 0 || parenClose >= ctor.end) {
    return refusal(
      "class-constructor-param-add",
      input.file,
      "unsupported-shape",
      `Constructor of ${input.className} has unbalanced parens.`,
    );
  }

  const params = parseConstructorParams(original, parenOpen, parenClose);
  if (params === null) {
    return refusal(
      "class-constructor-param-add",
      input.file,
      "unsupported-shape",
      `Constructor of ${input.className} has malformed parameters (e.g. unbalanced decorator).`,
    );
  }
  if (params.some((p) => p.name === input.paramName)) {
    return refusal(
      "class-constructor-param-add",
      input.file,
      "duplicate",
      `Constructor of ${input.className} already declares parameter "${input.paramName}".`,
    );
  }

  const paramsRaw = original.slice(parenOpen + 1, parenClose);
  const newParam = renderConstructorParam(input);
  // Decide formatting: multi-line if the existing list spans newlines.
  const isMultiLine = /\n/.test(paramsRaw);
  const trimmed = paramsRaw.replace(/[ \t]+$/g, "");
  const lastNonWs = trimmed.replace(/\s+$/g, "");
  const hasTrailingComma = lastNonWs.endsWith(",");

  let updated: string;
  if (params.length === 0) {
    // Empty list — insert as the only param. Preserve any existing
    // whitespace style (e.g. `(\n  )`).
    if (isMultiLine) {
      // figure out indent from the closing paren's line
      const closeLineStart = original.lastIndexOf("\n", parenClose) + 1;
      const closeIndent = original.slice(closeLineStart, parenClose).match(/^\s*/)?.[0] ?? "";
      const memberIndent = closeIndent + "  ";
      const insertion = `\n${memberIndent}${newParam}${hasTrailingComma ? "," : ""}\n${closeIndent}`;
      updated =
        original.slice(0, parenOpen + 1) +
        insertion +
        original.slice(parenClose);
    } else {
      updated =
        original.slice(0, parenOpen + 1) +
        newParam +
        original.slice(parenClose);
    }
  } else if (isMultiLine) {
    // Multi-line: insert on a new line right before the closing paren.
    const lastParam = params[params.length - 1];
    const closeLineStart = original.lastIndexOf("\n", parenClose) + 1;
    const closeIndent = original.slice(closeLineStart, parenClose).match(/^\s*/)?.[0] ?? "";
    // Member indent: peek the line of the last param.
    const lastParamLineStart = original.lastIndexOf("\n", lastParam.startIdx) + 1;
    const lastParamIndent = original.slice(lastParamLineStart, lastParam.startIdx).match(/^\s*/)?.[0] ?? closeIndent + "  ";
    const sep = hasTrailingComma ? "" : ",";
    const before = original.slice(0, parenClose).replace(/\s+$/, "");
    const insertion =
      `${sep}\n${lastParamIndent}${newParam}${hasTrailingComma ? "," : ""}\n${closeIndent}`;
    updated = before + insertion + original.slice(parenClose);
  } else {
    // Single-line: append `, <newParam>` before `)`.
    const sep = hasTrailingComma ? " " : ", ";
    const before = original.slice(0, parenClose).replace(/\s+$/, "");
    const insertion = `${sep}${newParam}`;
    updated = before + insertion + original.slice(parenClose);
  }

  const validation = validatePostEdit(original, updated);
  if (!validation.ok) {
    return refusal("class-constructor-param-add", input.file, "validation-failed", validation.reason);
  }
  const exportDiff = computeExportDelta(original, updated);
  if (exportDiff.missing.length > 0) {
    return refusal(
      "class-constructor-param-add",
      input.file,
      "validation-failed",
      `Edit dropped exports: ${exportDiff.missing.join(", ")}.`,
    );
  }

  return {
    kind: "applied",
    transformType: "class-constructor-param-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `constructor of class ${input.className}`,
    insertedSnippetSummary: paramSummary(input),
    exportDiff,
    notes:
      `Added constructor parameter "${input.paramName}: ${input.paramType}" to class ${input.className}` +
      (input.visibility ? ` (visibility=${input.visibility})` : "") +
      (input.isReadonly ? " (readonly)" : "") +
      (isMultiLine ? " — multi-line param list, preserved formatting" : " — single-line param list"),
  };
}

function synthesizeConstructorParamProperty(
  input: AddConstructorParamInput,
  original: string,
  loc: ClassLocation,
  members: readonly ParsedClassMember[],
): TransformResult {
  const newParam = renderConstructorParam(input);
  const ctorLine = `${loc.memberIndent}constructor(${newParam}) {}`;
  const firstMethodLike = members.find(
    (m) => m.kind === "method" || m.kind === "getter" || m.kind === "setter",
  );
  const anchor = firstMethodLike ? insertionLineStart(original, firstMethodLike.start) : null;
  const insertionIdx = anchor ?? loc.bodyCloseIdx;
  const leadingBlank = needsLeadingBlank(original, insertionIdx);
  const trailingBlank = anchor !== null
    ? needsTrailingBlank(original, insertionIdx)
    : needsTrailingBlankAtBodyEnd(original, loc);
  const insertion =
    (leadingBlank ? "\n" : "") +
    `${ctorLine}\n` +
    (trailingBlank ? "\n" : "");
  const updated = original.slice(0, insertionIdx) + insertion + original.slice(insertionIdx);

  const validation = validatePostEdit(original, updated);
  if (!validation.ok) {
    return refusal("class-constructor-param-add", input.file, "validation-failed", validation.reason);
  }
  const exportDiff = computeExportDelta(original, updated);
  if (exportDiff.missing.length > 0) {
    return refusal(
      "class-constructor-param-add",
      input.file,
      "validation-failed",
      `Edit dropped exports: ${exportDiff.missing.join(", ")}.`,
    );
  }

  return {
    kind: "applied",
    transformType: "class-constructor-param-add",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `class ${input.className} (new constructor)`,
    insertedSnippetSummary: paramSummary(input),
    exportDiff,
    notes:
      `Added constructor with parameter "${input.paramName}: ${input.paramType}" to class ${input.className}` +
      (input.visibility ? ` (visibility=${input.visibility})` : "") +
      (input.isReadonly ? " (readonly)" : "") +
      (anchor === null ? " — class body had no methods, inserted at end" : " — inserted before first method/accessor"),
  };
}

function renderConstructorParam(input: AddConstructorParamInput): string {
  const parts: string[] = [];
  if (input.visibility) parts.push(input.visibility);
  if (input.isReadonly) parts.push("readonly");
  const namePart = `${input.paramName}${input.optional ? "?" : ""}`;
  parts.push(namePart);
  let s = parts.join(" ");
  if (input.paramType.trim().length > 0) {
    s += `: ${input.paramType.trim()}`;
  }
  if (input.initializer && input.initializer.trim().length > 0) {
    s += ` = ${input.initializer.trim()}`;
  }
  return s;
}

function paramSummary(input: AddConstructorParamInput): string {
  const mods = [
    input.visibility,
    input.isReadonly ? "readonly" : null,
  ].filter(Boolean).join(" ");
  return `${input.className}.constructor(${mods ? mods + " " : ""}${input.paramName}${input.optional ? "?" : ""}: ${input.paramType})`;
}

// ─── Helpers ───────────────────────────────────────────────────────

interface ClassLocateResult {
  readonly ok: true;
  readonly location: ClassLocation;
}
interface ClassLocateFailure {
  readonly ok: false;
  readonly code: SkippedTransform["reasonCode"];
  readonly reason: string;
}

function locateClass(source: string, className: string): ClassLocateResult | ClassLocateFailure {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match top-level class declarations (with optional export / default /
  // abstract / decorator-on-class). Decorators may appear on lines
  // ABOVE the `class` keyword — they're fine; we only refuse if
  // members are decorated.
  const classRegex = new RegExp(
    `(^|\\n)\\s*(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+${escaped}\\b`,
    "g",
  );
  const matches: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = classRegex.exec(source)) !== null) {
    matches.push(m.index + (m[1] ? m[1].length : 0));
  }
  if (matches.length === 0) {
    return { ok: false, code: "not-recognizable", reason: `No \`class ${className}\` declaration found.` };
  }
  if (matches.length > 1) {
    return { ok: false, code: "ambiguous", reason: `Multiple top-level \`class ${className}\` declarations in the file.` };
  }
  const headerStart = matches[0];
  // Walk forward to find the body opener. Track angle-bracket depth so
  // generics (`class X<T extends Foo>`) don't mis-anchor.
  let i = headerStart;
  let angleDepth = 0;
  let bodyOpenIdx = -1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    else if (ch === "{" && angleDepth === 0) { bodyOpenIdx = i; break; }
    i++;
  }
  if (bodyOpenIdx < 0) {
    return { ok: false, code: "not-recognizable", reason: "Could not locate class body `{`." };
  }
  const bodyCloseIdx = findMatchingDelimiter(source, bodyOpenIdx, "{");
  if (bodyCloseIdx < 0) {
    return { ok: false, code: "not-recognizable", reason: "Could not locate matching `}` for class body." };
  }
  const header = source.slice(headerStart, bodyOpenIdx);
  const extendsMatch = /\bextends\b\s*([^{]+?)(?=\s+implements\b|\s*\{|$)/.exec(header);
  const implementsMatch = /\bimplements\b\s*([^{]+?)(?=\s*\{|$)/.exec(header);
  const closeLineStart = source.lastIndexOf("\n", bodyCloseIdx) + 1;
  const bodyIndent = source.slice(closeLineStart, bodyCloseIdx).match(/^\s*/)?.[0] ?? "";
  const memberIndent = bodyIndent + "  ";

  return {
    ok: true,
    location: {
      headerStart,
      bodyOpenIdx,
      bodyCloseIdx,
      bodyIndent,
      memberIndent,
      extendsClause: extendsMatch?.[1].trim() ?? "",
      implementsClause: implementsMatch?.[1].trim() ?? "",
    },
  };
}

function needsLeadingBlank(source: string, insertionIdx: number): boolean {
  const before = source.slice(0, insertionIdx);
  // True unless the previous non-empty line is the body opener `{`.
  const prevNl = before.lastIndexOf("\n");
  const prevLineStart = before.lastIndexOf("\n", prevNl - 1) + 1;
  const prevLine = before.slice(prevLineStart, prevNl).trimEnd();
  if (prevLine.endsWith("{")) return false;
  if (prevLine.length === 0) return false;
  return true;
}

function insertionLineStart(source: string, idx: number): number {
  const lineStart = source.lastIndexOf("\n", idx - 1) + 1;
  const prefix = source.slice(lineStart, idx);
  return /^\s*$/.test(prefix) ? lineStart : idx;
}

function needsTrailingBlank(source: string, insertionIdx: number): boolean {
  const after = source.slice(insertionIdx);
  // True unless the next non-empty line is also blank.
  const nextNl = after.indexOf("\n");
  if (nextNl < 0) return false;
  return after.slice(0, nextNl).trim().length > 0;
}

function needsTrailingBlankAtBodyEnd(source: string, loc: ClassLocation): boolean {
  // Inserting just before `}` of an empty body. Always pad to keep
  // visual breathing room.
  const before = source.slice(0, loc.bodyCloseIdx);
  return !before.endsWith("\n");
}

function renderFieldLine(input: AddClassFieldInput, indent: string): string {
  const parts: string[] = [];
  if (input.visibility) parts.push(input.visibility);
  if (input.isStatic) parts.push("static");
  if (input.isReadonly) parts.push("readonly");
  parts.push(`${input.fieldName}${input.optional ? "?" : ""}`);
  let line = `${indent}${parts.join(" ")}`;
  if (input.fieldType.trim().length > 0) {
    line += `: ${input.fieldType.trim()}`;
  }
  if (input.initializer && input.initializer.trim().length > 0) {
    line += ` = ${input.initializer.trim()}`;
  }
  return `${line};`;
}

function renderDecoratedMethodBlock(input: AddDecoratedClassMethodInput, indent: string): string {
  return `${renderDecoratorLine(input.decorator, indent)}\n${renderMethodBlock(input, indent)}`;
}

function renderDecoratorLine(input: DecoratorInput, indent: string): string {
  const arg = input.argument === undefined ? "" : input.argument.trim();
  return `${indent}@${input.name}(${arg})`;
}

function fieldSummary(input: AddClassFieldInput): string {
  const mods = [
    input.visibility,
    input.isStatic ? "static" : null,
    input.isReadonly ? "readonly" : null,
  ].filter(Boolean).join(" ");
  return `${input.className}.${mods ? mods + " " : ""}${input.fieldName}${input.optional ? "?" : ""}: ${input.fieldType}`;
}

function renderMethodBlock(input: AddClassMethodInput, indent: string): string {
  const sigParts: string[] = [];
  if (input.visibility) sigParts.push(input.visibility);
  if (input.isStatic) sigParts.push("static");
  if (input.isAsync) sigParts.push("async");
  sigParts.push(`${input.methodName}(${input.parameters.trim()})`);
  let signature = `${indent}${sigParts.join(" ")}`;
  if (input.returnType && input.returnType.trim().length > 0) {
    signature += `: ${input.returnType.trim()}`;
  }
  signature += " {";
  const body = (input.body ?? "").trim();
  const closer = `${indent}}`;
  if (body.length === 0) {
    // Empty body — produce a stub with a single TODO line so the
    // verifier can still parse the class. For void-returning async
    // methods we leave it truly empty (no statements needed).
    const inner = `${indent}  // TODO: implement ${input.methodName}`;
    return `${signature}\n${inner}\n${closer}`;
  }
  const indentedBody = body
    .split("\n")
    .map((l) => l.length === 0 ? "" : `${indent}  ${l}`)
    .join("\n");
  return `${signature}\n${indentedBody}\n${closer}`;
}

function methodSummary(input: AddClassMethodInput): string {
  const mods = [
    input.visibility,
    input.isStatic ? "static" : null,
    input.isAsync ? "async" : null,
  ].filter(Boolean).join(" ");
  return `${input.className}.${mods ? mods + " " : ""}${input.methodName}(${input.parameters})${input.returnType ? ": " + input.returnType : ""}`;
}

function isSimpleDecoratorName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(name);
}

function isSafeDecoratorArgument(arg: string): boolean {
  const trimmed = arg.trim();
  if (trimmed.length === 0) return true;
  if (/^["'][^"'`\\]*(?:\\.[^"'`\\]*)*["']$/.test(trimmed)) return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(trimmed)) return true;
  return false;
}

const NEST_ROUTE_DECORATORS = new Set(["Get", "Post", "Put", "Patch", "Delete"]);

function hasAnyNestRouteDecorator(source: string, member: ParsedClassMember): boolean {
  if (member.decoratorCount === 0) return false;
  const text = source.slice(member.start, member.declStart);
  return /@(Get|Post|Put|Patch|Delete)\s*\(/.test(text);
}

function findDuplicateRouteDecorator(
  source: string,
  members: readonly ParsedClassMember[],
  decorator: DecoratorInput,
): string | null {
  if (!NEST_ROUTE_DECORATORS.has(decorator.name)) return null;
  const requestedPath = normalizeDecoratorPath(decorator.argument ?? "");
  for (const member of members) {
    if (member.decoratorCount === 0) continue;
    const text = source.slice(member.start, member.declStart);
    const re = new RegExp(`@${decorator.name}\\s*\\(([^)]*)\\)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const existingPath = normalizeDecoratorPath(m[1] ?? "");
      if (existingPath === requestedPath) {
        return `@${decorator.name}(${requestedPath ? JSON.stringify(requestedPath) : ""})`;
      }
    }
  }
  return null;
}

function normalizeDecoratorPath(arg: string): string {
  const trimmed = arg.trim();
  if (trimmed.length === 0) return "";
  const quoted = /^["']([^"']*)["']$/.exec(trimmed);
  return quoted ? quoted[1] : trimmed;
}

function afterMemberInsertionIndex(source: string, memberEnd: number): number {
  let idx = memberEnd;
  while (idx < source.length && (source[idx] === " " || source[idx] === "\t")) idx++;
  if (source[idx] === "\r") idx++;
  if (source[idx] === "\n") idx++;
  return idx;
}

type DecoratorImportResult =
  | { readonly ok: true; readonly updated: string; readonly changed: boolean; readonly notes: string }
  | { readonly ok: false; readonly code: SkippedTransform["reasonCode"]; readonly reason: string };

function maybeAddDecoratorImport(source: string, file: string, decorator: DecoratorInput): DecoratorImportResult {
  if (!decorator.importFrom) {
    return { ok: true, updated: source, changed: false, notes: "" };
  }
  if (decorator.importFrom !== "@nestjs/common") {
    return {
      ok: false,
      code: "unsupported-shape",
      reason: `Decorator import source "${decorator.importFrom}" is not supported deterministically.`,
    };
  }
  const result = addNamedImportToContent(source, {
    file,
    specifier: decorator.importFrom,
    names: [decorator.name],
  });
  if (!result.ok) {
    return { ok: false, code: result.code, reason: result.reason };
  }
  return {
    ok: true,
    updated: result.updated,
    changed: result.updated !== source,
    notes: result.notes,
  };
}

function refusal(
  transformType: AppliedTransform["transformType"],
  file: string,
  code: SkippedTransform["reasonCode"],
  reason: string,
): SkippedTransform {
  return { kind: "skipped", transformType, file, reasonCode: code, reason };
}
