/**
 * Deterministic code transforms — regex + brace-counter helpers that
 * perform routine TypeScript/JavaScript edits without going through a
 * model. Every transform is fail-closed: it either applies a clean
 * minimal patch or returns a structured "skipped" reason so the
 * Coordinator can fall back to the LLM Builder.
 *
 * Design goals:
 *   - Zero new runtime dependencies. The Aedis package.json already
 *     ships `typescript` for tsc, but we deliberately don't pull in
 *     ts-morph / Babel / acorn / @babel/parser. Regex + brace-counter
 *     keeps the transforms readable, debuggable, and predictable.
 *   - Pre-validate the file looks like one we know how to edit.
 *   - Post-validate that the edit kept the export surface, kept the
 *     brace balance, and didn't introduce an obvious syntactic regression.
 *   - On any uncertainty: REFUSE, don't approximate. The fallback is
 *     a model call, which is acceptable.
 *
 * The transforms exposed from this module:
 *   - tryAddRoute        — insert an HTTP route handler beside existing routes
 *   - tryAddNamedExport  — append an `export const X = …;` if X isn't already exported
 *   - tryAddImport       — add or extend a named import
 *   - tryAddObjectProperty — add a property to a recognized exported config object
 */

export type {
  TransformResult,
  AppliedTransform,
  SkippedTransform,
  RouteFramework,
} from "./types.js";

export {
  detectRouteFramework,
  findExistingRoutes,
} from "./parse-routes.js";

export { tryAddRoute } from "./route-insert.js";
export { tryAddNamedExport } from "./exports.js";
export { tryAddImport } from "./imports.js";
export { tryAddObjectProperty } from "./property.js";
export {
  planBackendScaffold,
  applyBackendScaffold,
  type BackendScaffoldPlan,
} from "./multifile-scaffold.js";
export { tryAddInterfaceProperty } from "./interface-extend.js";
export { tryAddTypeAliasProperty } from "./type-alias-extend.js";
export { tryAddZodSchemaField } from "./zod-extend.js";
export {
  tryAddClassField,
  tryAddClassMethod,
  tryAddConstructorParamProperty,
  tryAddDecoratedClassMethod,
  tryAddDecoratedClassField,
  type AddClassFieldInput,
  type AddClassMethodInput,
  type AddConstructorParamInput,
  type AddDecoratedClassMethodInput,
  type AddDecoratedClassFieldInput,
  type Visibility,
} from "./class-extend.js";
