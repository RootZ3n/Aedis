/**
 * Deterministic Builder facade — exposed to the Coordinator. Inspects
 * the task-shape + brief, picks the right transform, applies it, and
 * returns either a synthesized successful BuilderResult or a structured
 * skip reason. The Coordinator falls back to the LLM Builder on skip.
 *
 * What's wired today:
 *
 *   route-add  → tryAddRoute
 *
 * Future shapes (export/import/property additions) will plug in here
 * once the Coordinator can decide which one to invoke from the brief.
 *
 * The layer never touches workspace state. It returns the proposed
 * file change; the caller is responsible for writing it (typically by
 * synthesizing a BuilderResult and letting the existing dispatch path
 * collect it).
 */

import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { classifyTaskShape, type TaskShapeFinding, type TypeExtendDetails, type ClassExtendDetails } from "../task-shape.js";
import type { ImplementationBrief } from "../implementation-brief.js";
import type {
  AppliedTransform,
  SkippedTransform,
  TransformResult,
} from "./types.js";
import type { BuilderAttemptRecord } from "../../workers/builder-diagnostics.js";
import type { FileMutationRoleUpdate } from "../change-set.js";
import { tryAddRoute } from "./route-insert.js";
import { tryAddInterfaceProperty } from "./interface-extend.js";
import { tryAddTypeAliasProperty } from "./type-alias-extend.js";
import { tryAddZodSchemaField } from "./zod-extend.js";
import {
  tryAddClassField,
  tryAddClassMethod,
  tryAddConstructorParamProperty,
  tryAddDecoratedClassField,
  tryAddDecoratedClassMethod,
} from "./class-extend.js";
import { applyBackendScaffold } from "./multifile-scaffold.js";

export interface DeterministicBuilderInput {
  readonly projectRoot: string;
  readonly userRequest: string;
  readonly targetFiles: readonly string[];
  readonly brief?: ImplementationBrief | null;
  readonly tier?: string;
  readonly generationId: string;
}

export interface DeterministicAppliedFile {
  readonly file: string;
  readonly transform: AppliedTransform;
  readonly attemptRecord: BuilderAttemptRecord;
}

export interface DeterministicBuilderApplied {
  readonly kind: "applied";
  readonly applied: readonly DeterministicAppliedFile[];
  /** When at least one target was skipped, list the reasons too. */
  readonly skipped: readonly SkippedTransform[];
  readonly targetRoles?: readonly FileMutationRoleUpdate[];
  /** Human-friendly summary for the receipt. */
  readonly summary: string;
  readonly taskShape: TaskShapeFinding;
}

export interface DeterministicBuilderSkipped {
  readonly kind: "skipped";
  readonly skipped: readonly SkippedTransform[];
  readonly reason: string;
  readonly taskShape: TaskShapeFinding;
}

export type DeterministicBuilderResult =
  | DeterministicBuilderApplied
  | DeterministicBuilderSkipped;

/**
 * Try to satisfy the user request via deterministic transforms.
 * Currently only handles `route-add` shape. Returns "skipped" with a
 * structured reason for every other shape; the coordinator must
 * fall through to the LLM Builder.
 */
export async function tryDeterministicBuilder(
  input: DeterministicBuilderInput,
): Promise<DeterministicBuilderResult> {
  const taskShape = classifyTaskShape(input.userRequest);
  if (input.targetFiles.length === 0) {
    return {
      kind: "skipped",
      taskShape,
      skipped: [],
      reason: "No target files in assignment.",
    };
  }

  if (/\b[A-Z][\w$]*Service\.[A-Za-z_$][\w$]*\b/.test(input.userRequest)) {
    return await dispatchBackendScaffold(input, taskShape);
  }

  if (taskShape.shape === "route-add") {
    return await dispatchRouteAdd(input, taskShape);
  }
  if (taskShape.shape === "type-extend" && taskShape.typeExtend) {
    return await dispatchTypeExtend(input, taskShape, taskShape.typeExtend);
  }
  if (taskShape.shape === "class-extend" && taskShape.classExtend) {
    return await dispatchClassExtend(input, taskShape, taskShape.classExtend);
  }

  return {
    kind: "skipped",
    taskShape,
    skipped: [],
    reason: `Deterministic builder does not handle shape=${taskShape.shape}; falling through to LLM Builder.`,
  };
}

async function dispatchBackendScaffold(
  input: DeterministicBuilderInput,
  taskShape: TaskShapeFinding,
): Promise<DeterministicBuilderResult> {
  const result = await applyBackendScaffold({
    projectRoot: input.projectRoot,
    userRequest: input.userRequest,
    targetFiles: input.targetFiles,
  });
  if (result.kind === "skipped") {
    return {
      kind: "skipped",
      taskShape,
      skipped: result.skipped,
      reason: result.reason,
    };
  }
  const applied = result.applied.map((transform, idx) => ({
    file: transform.file,
    transform,
    attemptRecord: makeAttemptRecord({
      target: transform.file,
      transform,
      tier: input.tier ?? "deterministic",
      generationId: input.generationId,
      attemptIndex: idx + 1,
    }),
  }));
  return {
    kind: "applied",
    taskShape,
    applied,
    skipped: result.skipped,
    targetRoles: result.targetRoles,
    summary:
      `deterministic backend-scaffold: ${result.plan.httpMethod} ${result.plan.routePath} ` +
      `→ ${result.plan.controllerClass}.${result.plan.controllerMethod} calls ` +
      `${result.plan.serviceClass}.${result.plan.serviceMethod}; files=${applied.map((a) => a.file).join(", ")}` +
      (result.skipped.length > 0 ? ` (skipped ${result.skipped.length})` : ""),
  };
}

async function dispatchRouteAdd(
  input: DeterministicBuilderInput,
  taskShape: TaskShapeFinding,
): Promise<DeterministicBuilderResult> {
  const method = (taskShape.httpVerbs[0] ?? "GET").toUpperCase() as
    | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
  const path = taskShape.httpPaths[0];
  if (!path) {
    return {
      kind: "skipped",
      taskShape,
      skipped: [],
      reason: "Route-add detected but no path was named in the prompt.",
    };
  }

  const applied: DeterministicAppliedFile[] = [];
  const skipped: SkippedTransform[] = [];
  for (const target of input.targetFiles) {
    const r = await tryAddRoute({
      projectRoot: input.projectRoot,
      file: target,
      method,
      path,
    });
    if (r.kind === "applied") {
      const record = makeAttemptRecord({
        target,
        transform: r,
        tier: input.tier ?? "deterministic",
        generationId: input.generationId,
        attemptIndex: applied.length + 1,
      });
      applied.push({ file: target, transform: r, attemptRecord: record });
    } else {
      skipped.push(r);
    }
  }

  if (applied.length === 0) {
    return {
      kind: "skipped",
      taskShape,
      skipped,
      reason:
        skipped.length > 0
          ? `Every target refused: ${skipped.map((s) => `${s.file} (${s.reasonCode})`).join("; ")}`
          : "No target files matched a deterministic transform.",
    };
  }
  for (const a of applied) {
    const abs = resolve(input.projectRoot, a.file);
    await writeFile(abs, a.transform.updatedContent, "utf-8");
  }
  return {
    kind: "applied",
    taskShape,
    applied,
    skipped,
    summary: `deterministic route-add: ${method} ${path} → ${applied.map((a) => a.file).join(", ")}` +
      (skipped.length > 0 ? ` (skipped ${skipped.length})` : ""),
  };
}

/**
 * Try every target file; for each, peek at the file content to decide
 * which transform to invoke (interface vs type alias vs zod schema).
 * The file's actual structure beats the prompt's `kindHint` — that's
 * just a tiebreaker.
 */
async function dispatchTypeExtend(
  input: DeterministicBuilderInput,
  taskShape: TaskShapeFinding,
  details: TypeExtendDetails,
): Promise<DeterministicBuilderResult> {
  const applied: DeterministicAppliedFile[] = [];
  const skipped: SkippedTransform[] = [];
  for (const target of input.targetFiles) {
    const abs = resolve(input.projectRoot, target);
    if (!existsSync(abs)) {
      skipped.push({
        kind: "skipped",
        transformType: "interface-property-add",
        file: target,
        reasonCode: "file-missing",
        reason: `Target file not found at ${abs}`,
      });
      continue;
    }
    const content = await readFile(abs, "utf-8");
    const detected = detectSymbolKind(content, details.symbol, details.kindHint);
    if (detected === "interface") {
      const r = await tryAddInterfaceProperty({
        projectRoot: input.projectRoot,
        file: target,
        interfaceName: details.symbol,
        propertyName: details.property,
        propertyType: details.propertyType,
        optional: details.optional,
        readonly: details.readonly,
      });
      pushResult(applied, skipped, target, r, input);
    } else if (detected === "type") {
      const r = await tryAddTypeAliasProperty({
        projectRoot: input.projectRoot,
        file: target,
        typeName: details.symbol,
        propertyName: details.property,
        propertyType: details.propertyType,
        optional: details.optional,
        readonly: details.readonly,
      });
      pushResult(applied, skipped, target, r, input);
    } else if (detected === "schema") {
      const r = await tryAddZodSchemaField({
        projectRoot: input.projectRoot,
        file: target,
        schemaName: details.symbol,
        fieldName: details.property,
        fieldType: details.propertyType,
        optional: details.optional,
      });
      pushResult(applied, skipped, target, r, input);
    } else {
      skipped.push({
        kind: "skipped",
        transformType: "interface-property-add",
        file: target,
        reasonCode: "not-recognizable",
        reason: `Could not locate symbol "${details.symbol}" as interface/type/zod-schema in ${target}.`,
      });
    }
  }

  if (applied.length === 0) {
    return {
      kind: "skipped",
      taskShape,
      skipped,
      reason:
        skipped.length > 0
          ? `Every target refused: ${skipped.map((s) => `${s.file} (${s.reasonCode})`).join("; ")}`
          : `No target file contained symbol "${details.symbol}".`,
    };
  }
  for (const a of applied) {
    const abs = resolve(input.projectRoot, a.file);
    await writeFile(abs, a.transform.updatedContent, "utf-8");
  }
  return {
    kind: "applied",
    taskShape,
    applied,
    skipped,
    summary:
      `deterministic type-extend: ${details.symbol}.${details.property}: ${details.propertyType}` +
      (details.optional ? "?" : "") +
      ` → ${applied.map((a) => a.file).join(", ")}` +
      (skipped.length > 0 ? ` (skipped ${skipped.length})` : ""),
  };
}

function pushResult(
  applied: DeterministicAppliedFile[],
  skipped: SkippedTransform[],
  target: string,
  r: TransformResult,
  input: DeterministicBuilderInput,
): void {
  if (r.kind === "applied") {
    const record = makeAttemptRecord({
      target,
      transform: r,
      tier: input.tier ?? "deterministic",
      generationId: input.generationId,
      attemptIndex: applied.length + 1,
    });
    applied.push({ file: target, transform: r, attemptRecord: record });
  } else {
    skipped.push(r);
  }
}

/**
 * Dispatch a `class-extend` task. For every target file, if it
 * declares `class <name>`, invoke either tryAddClassField or
 * tryAddClassMethod based on the parsed memberKind. Multiple top-level
 * classes with the same name are surfaced as `ambiguous` by the
 * underlying transform.
 */
async function dispatchClassExtend(
  input: DeterministicBuilderInput,
  taskShape: TaskShapeFinding,
  details: ClassExtendDetails,
): Promise<DeterministicBuilderResult> {
  const applied: DeterministicAppliedFile[] = [];
  const skipped: SkippedTransform[] = [];
  for (const target of input.targetFiles) {
    let r;
    if (details.memberKind === "constructor-param") {
      r = await tryAddConstructorParamProperty({
        projectRoot: input.projectRoot,
        file: target,
        className: details.className,
        paramName: details.memberName,
        paramType: details.memberType,
        visibility: details.visibility,
        isReadonly: details.isReadonly,
        optional: details.optional,
      });
    } else if (details.memberKind === "field") {
      if (details.decorator) {
        r = await tryAddDecoratedClassField({
          projectRoot: input.projectRoot,
          file: target,
          className: details.className,
          fieldName: details.memberName,
          fieldType: details.memberType,
          visibility: details.visibility,
          isStatic: details.isStatic,
          isReadonly: details.isReadonly,
          optional: details.optional,
          decorator: details.decorator,
        });
      } else {
      r = await tryAddClassField({
        projectRoot: input.projectRoot,
        file: target,
        className: details.className,
        fieldName: details.memberName,
        fieldType: details.memberType,
        visibility: details.visibility,
        isStatic: details.isStatic,
        isReadonly: details.isReadonly,
        optional: details.optional,
      });
      }
    } else {
      if (details.decorator) {
        r = await tryAddDecoratedClassMethod({
          projectRoot: input.projectRoot,
          file: target,
          className: details.className,
          methodName: details.memberName,
          parameters: details.parameters,
          returnType: details.memberType,
          body: details.body,
          visibility: details.visibility,
          isStatic: details.isStatic,
          isAsync: details.isAsync,
          decorator: details.decorator,
        });
      } else {
      r = await tryAddClassMethod({
        projectRoot: input.projectRoot,
        file: target,
        className: details.className,
        methodName: details.memberName,
        parameters: details.parameters,
        returnType: details.memberType,
        body: details.body,
        visibility: details.visibility,
        isStatic: details.isStatic,
        isAsync: details.isAsync,
      });
      }
    }
    pushResult(applied, skipped, target, r, input);
  }
  if (applied.length === 0) {
    return {
      kind: "skipped",
      taskShape,
      skipped,
      reason:
        skipped.length > 0
          ? `Every target refused: ${skipped.map((s) => `${s.file} (${s.reasonCode})`).join("; ")}`
          : `No target file contained class "${details.className}".`,
    };
  }
  for (const a of applied) {
    const abs = resolve(input.projectRoot, a.file);
    await writeFile(abs, a.transform.updatedContent, "utf-8");
  }
  const sigSummary =
    details.memberKind === "method"
      ? `${details.memberName}(${details.parameters})${details.memberType ? ": " + details.memberType : ""}`
      : details.memberKind === "constructor-param"
      ? `constructor(${details.memberName}: ${details.memberType})`
      : `${details.memberName}${details.optional ? "?" : ""}: ${details.memberType}`;
  return {
    kind: "applied",
    taskShape,
    applied,
    skipped,
    summary:
      `deterministic class-extend: ${details.decorator ? "@" + details.decorator.name + " " : ""}${details.className}.${sigSummary}` +
      ` → ${applied.map((a) => a.file).join(", ")}` +
      (skipped.length > 0 ? ` (skipped ${skipped.length})` : ""),
  };
}

/**
 * Decide which transform applies to `symbol` in `content`. The prompt's
 * `kindHint` is consulted only when the file declares the symbol in
 * more than one shape (rare). Otherwise the file content wins.
 */
function detectSymbolKind(
  content: string,
  symbol: string,
  hint: TypeExtendDetails["kindHint"],
): "interface" | "type" | "schema" | null {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const interfaceRe = new RegExp(`(^|\\n)\\s*(?:export\\s+)?interface\\s+${escaped}\\b`);
  const typeRe = new RegExp(`(^|\\n)\\s*(?:export\\s+)?type\\s+${escaped}\\b`);
  const zodRe = new RegExp(`(^|\\n)\\s*(?:export\\s+)?const\\s+${escaped}\\b[^=\\n]*=\\s*z\\.object\\b`);
  const matches: Array<"interface" | "type" | "schema"> = [];
  if (interfaceRe.test(content)) matches.push("interface");
  if (typeRe.test(content)) matches.push("type");
  if (zodRe.test(content)) matches.push("schema");
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Multiple matches in one file (unusual). Use the prompt hint.
  if (hint === "interface" && matches.includes("interface")) return "interface";
  if (hint === "type" && matches.includes("type")) return "type";
  if (hint === "schema" && matches.includes("schema")) return "schema";
  // Default priority: schema > interface > type (schemas are the most
  // restrictive, so most-likely correct).
  return matches.includes("schema") ? "schema" : matches.includes("interface") ? "interface" : "type";
}

function makeAttemptRecord(input: {
  target: string;
  transform: AppliedTransform;
  tier: string;
  generationId: string;
  attemptIndex: number;
}): BuilderAttemptRecord {
  return {
    attemptId: randomUUID(),
    attemptIndex: input.attemptIndex,
    generationId: input.generationId,
    targetFile: input.target,
    patchMode: "diff-apply",
    provider: "deterministic",
    model: `deterministic/${input.transform.transformType}`,
    tier: input.tier,
    fellBack: false,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    durationMs: 0,
    outcome: "success",
    failureReason: null,
    guardRejected: false,
    guardName: null,
    exportDiff: input.transform.exportDiff,
    stale: false,
  };
}
