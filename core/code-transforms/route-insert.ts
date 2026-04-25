/**
 * Deterministic HTTP route insertion.
 *
 * Given an existing TS/JS file with at least one recognized route
 * registration, insert a new handler:
 *   - in the same style as the existing routes,
 *   - with the same indentation,
 *   - placed AFTER the last existing route on a new blank-line-separated
 *     block,
 *   - without touching any other line.
 *
 * Refuses (returns SkippedTransform) when:
 *   - file doesn't exist
 *   - no recognizable route binding
 *   - same method+path already registered (duplicate)
 *   - the file's brace balance is non-zero (the parser would refuse)
 *   - post-edit validation fails (export surface changed, brace balance
 *     drifted, route count increased by more than 1)
 *
 * This module never calls a model. It either applies a clean patch
 * or refuses. The Coordinator falls back to the LLM Builder on refuse.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  detectRouteFramework,
  findExistingRoutes,
} from "./parse-routes.js";
import {
  buildUnifiedDiff,
  computeExportDelta,
  validatePostEdit,
} from "./util.js";
import type {
  AppliedTransform,
  HttpMethod,
  RouteSite,
  SkippedTransform,
  TransformResult,
} from "./types.js";

export interface RouteInsertInput {
  readonly projectRoot: string;
  /** Path relative to projectRoot, OR absolute. */
  readonly file: string;
  readonly method: HttpMethod;
  readonly path: string;
  /**
   * Optional response body literal. When provided we generate a
   * handler that returns this object. When absent we generate a
   * stub that returns { ok: true } so the verifier can still type-
   * check; the caller can hand-edit afterwards if a richer body is
   * needed.
   */
  readonly responseBody?: string;
  /**
   * Optional inline handler source. When provided the inserted
   * handler body is exactly this text (between { and }). Wins over
   * responseBody. Use when the caller has already synthesized a
   * concrete body and just wants the wiring around it.
   */
  readonly handlerBody?: string;
}

export async function tryAddRoute(input: RouteInsertInput): Promise<TransformResult> {
  const abs = resolve(input.projectRoot, input.file);
  if (!existsSync(abs)) {
    return refusal(input.file, "file-missing", `Target file not found at ${abs}`);
  }
  const original = await readFile(abs, "utf-8");
  const detection = detectRouteFramework(original);
  if (!detection.framework || !detection.bindingName) {
    return refusal(
      input.file,
      "not-recognizable",
      `No recognizable route framework in ${input.file} (evidence: ${detection.evidence.join(", ") || "none"}).`,
    );
  }

  const existing = findExistingRoutes(original, detection.bindingName);
  if (existing.length === 0) {
    return refusal(
      input.file,
      "not-recognizable",
      `Detected framework=${detection.framework} binding=${detection.bindingName} but no existing route registration to anchor on.`,
    );
  }

  // Refuse if the same method+path is already registered. The Coordinator
  // can decide whether to skip the task or escalate to the LLM Builder.
  const dup = existing.find((s) => s.method === input.method && s.path === input.path);
  if (dup) {
    return refusal(
      input.file,
      "duplicate",
      `Route ${input.method} ${input.path} already registered at line ${dup.startLine + 1}.`,
    );
  }

  // Anchor: use the last existing route. Preserve its indent.
  const anchor = existing[existing.length - 1];
  const lines = original.split("\n");
  const snippet = renderRoute({
    framework: detection.framework,
    bindingName: detection.bindingName,
    method: input.method,
    path: input.path,
    indent: anchor.indent,
    handlerBody: input.handlerBody,
    responseBody: input.responseBody,
  });

  // Insert right after anchor.endLine. Add a blank line separator if
  // there isn't already one.
  const insertAt = anchor.endLine + 1;
  const needsBlankBefore = insertAt < lines.length && lines[insertAt - 1]?.trim() !== "";
  const needsBlankAfter = insertAt < lines.length && lines[insertAt]?.trim() !== "";
  const block = [
    needsBlankBefore ? "" : null,
    ...snippet,
    needsBlankAfter ? "" : null,
  ].filter((l): l is string => l !== null);

  const newLines = [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)];
  const updated = newLines.join("\n");

  // Post-edit validation: refuse if anything looks off.
  const validation = validatePostEdit(original, updated);
  if (!validation.ok) {
    return refusal(input.file, "validation-failed", validation.reason);
  }

  // Confirm exactly ONE new route appears in the result.
  const updatedRoutes = findExistingRoutes(updated, detection.bindingName);
  if (updatedRoutes.length !== existing.length + 1) {
    return refusal(
      input.file,
      "validation-failed",
      `Route count after edit was ${updatedRoutes.length}, expected ${existing.length + 1}.`,
    );
  }

  const exportDiff = computeExportDelta(original, updated);
  if (exportDiff.missing.length > 0) {
    return refusal(
      input.file,
      "validation-failed",
      `Edit dropped exports: ${exportDiff.missing.join(", ")}.`,
    );
  }

  const applied: AppliedTransform = {
    kind: "applied",
    transformType: "route-insert",
    file: input.file,
    originalContent: original,
    updatedContent: updated,
    diff: buildUnifiedDiff(input.file, original, updated),
    matchedPattern: `${detection.framework}:${detection.bindingName}.${input.method.toLowerCase()}`,
    insertedSnippetSummary: `${detection.bindingName}.${input.method.toLowerCase()}("${input.path}", …)`,
    exportDiff,
    notes: `Inserted ${input.method} ${input.path} at line ${insertAt + 1}, anchored after ${detection.bindingName}.${anchor.method.toLowerCase()}("${anchor.path}").`,
  };
  return applied;
}

function refusal(file: string, code: SkippedTransform["reasonCode"], reason: string): SkippedTransform {
  return { kind: "skipped", transformType: "route-insert", file, reasonCode: code, reason };
}

function renderRoute(input: {
  framework: ReturnType<typeof detectRouteFramework>["framework"];
  bindingName: string;
  method: HttpMethod;
  path: string;
  indent: string;
  handlerBody?: string;
  responseBody?: string;
}): string[] {
  const methodLc = input.method.toLowerCase();
  const ind = input.indent;
  const body = input.handlerBody
    ?? defaultHandlerBody(input.responseBody);
  if (input.framework === "fastify") {
    // fastify.get("/path", async (request, reply) => { … });
    return [
      `${ind}${input.bindingName}.${methodLc}("${input.path}", async (_request, _reply) => {`,
      ...indentBlock(body, ind + "  "),
      `${ind}});`,
    ];
  }
  // Express styles share the same shape.
  return [
    `${ind}${input.bindingName}.${methodLc}("${input.path}", (_req, res) => {`,
    ...indentBlock(expressBody(body), ind + "  "),
    `${ind}});`,
  ];
}

function defaultHandlerBody(responseBody: string | undefined): string {
  if (responseBody && responseBody.trim().length > 0) {
    return `return ${responseBody.trim()};`;
  }
  return `return { ok: true };`;
}

function expressBody(body: string): string {
  // Express's reply pattern is `res.json(...)`. If the caller passed
  // a `return X;` body we translate it to `res.json(X);`.
  const trimmed = body.trim();
  const m = /^return\s+(.+?);?$/s.exec(trimmed);
  if (m) return `res.json(${m[1].trim()});`;
  return body;
}

function indentBlock(body: string, indent: string): string[] {
  return body.split("\n").map((l) => `${indent}${l}`);
}

export type { AppliedTransform, RouteSite, SkippedTransform };
