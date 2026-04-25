/**
 * Shared types for the deterministic-transform layer.
 */

import type { ExportDiff } from "../../workers/builder-diagnostics.js";

export type RouteFramework =
  | "fastify"   // fastify.get(...) / fastify.post(...) — most common in Portum
  | "express-app" // app.get(...) where app is an Express instance
  | "express-router"; // router.get(...) on an Express Router

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface AppliedTransform {
  readonly kind: "applied";
  readonly transformType:
    | "route-insert"
    | "named-export-add"
    | "import-add"
    | "property-add"
    | "interface-property-add"
    | "type-alias-property-add"
    | "zod-field-add"
    | "class-field-add"
    | "class-method-add"
    | "class-constructor-param-add"
    | "decorated-class-method-add"
    | "decorated-class-field-add"
    | "dto-file-create";
  /** Target file (relative path or absolute, whatever was passed in). */
  readonly file: string;
  /** Original file content before the edit. */
  readonly originalContent: string;
  /** New file content after the edit. */
  readonly updatedContent: string;
  /** Unified diff string suitable for receipts/UI. */
  readonly diff: string;
  /** Pattern matched (e.g. "fastify.get"). */
  readonly matchedPattern: string;
  /** Short summary of what was inserted (one line). */
  readonly insertedSnippetSummary: string;
  /** Export surface delta — empty when nothing changed. */
  readonly exportDiff: ExportDiff;
  /** Free-form notes for the receipt (e.g. "inserted at line 142, after fastify.get('/audit')"). */
  readonly notes: string;
}

export interface SkippedTransform {
  readonly kind: "skipped";
  readonly transformType:
    | "route-insert"
    | "named-export-add"
    | "import-add"
    | "property-add"
    | "interface-property-add"
    | "type-alias-property-add"
    | "zod-field-add"
    | "class-field-add"
    | "class-method-add"
    | "class-constructor-param-add"
    | "decorated-class-method-add"
    | "decorated-class-field-add"
    | "dto-file-create";
  readonly file: string;
  /** Why we refused — short, machine-friendly tag. */
  readonly reasonCode:
    | "file-missing"
    | "not-recognizable"
    | "duplicate"
    | "unsafe-edit"
    | "validation-failed"
    | "unsupported-shape"
    | "ambiguous";
  /** Human-readable explanation for the receipt. */
  readonly reason: string;
}

export type TransformResult = AppliedTransform | SkippedTransform;

export interface RouteSite {
  readonly framework: RouteFramework;
  readonly method: HttpMethod;
  readonly path: string;
  /** 0-indexed line where the route registration starts (the call expression line). */
  readonly startLine: number;
  /** 0-indexed line where the closing `);` of the registration sits. */
  readonly endLine: number;
  /** The leading whitespace on the call line — we re-use it on the new route. */
  readonly indent: string;
}
