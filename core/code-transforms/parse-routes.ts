/**
 * Route registration parser. Walks a TS/JS source file and returns
 * every HTTP route registration we recognize, along with where it
 * starts/ends and the framework binding name.
 *
 * Recognized shapes (must match LITERALLY at the start of a statement):
 *
 *   <ident>.get("/path", handler);                       // fastify or express-app
 *   <ident>.post("/path", handler);                       // ditto
 *   router.get("/path", handler);                         // express-router (ident == "router")
 *   <ident>.get<T>("/path", handler);                     // generics ok
 *   <ident>.get("/path", { … }, async (...) => { … });    // option object ok
 *
 * Multi-line option objects + bodies are handled by counting
 * parentheses depth from the opening `(` of the call expression. We
 * stop at the matching `)` followed by `;` (or end-of-line if no
 * semicolon).
 *
 * Anything that doesn't match exactly returns no site for that line
 * — we'd rather under-detect than misidentify.
 */

import type { HttpMethod, RouteFramework, RouteSite } from "./types.js";

const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

const ROUTE_CALL_REGEX =
  /^(\s*)([A-Za-z_$][A-Za-z0-9_$]*)\.(get|post|put|patch|delete|options|head)(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/;

/**
 * Detect which framework the file uses based on which binding the
 * route calls reference. We treat `fastify` (or `app`/`server` with
 * a fastify import nearby) as fastify; `router` as express-router;
 * everything else as express-app.
 *
 * The matcher is intentionally generous — we just need a label for
 * the receipt and to choose handler-snippet style. The actual
 * insertion uses the binding name observed in the file.
 */
export function detectRouteFramework(source: string): {
  framework: RouteFramework | null;
  bindingName: string | null;
  evidence: string[];
} {
  const evidence: string[] = [];
  const fastifyImport = /from\s+['"]fastify['"]/.test(source);
  const expressImport = /from\s+['"]express['"]/.test(source);
  const fastifyCalls = source.match(/\b([a-zA-Z_$][\w$]*)\.(get|post|put|patch|delete)\(/g) ?? [];

  if (fastifyImport) evidence.push("fastify-import");
  if (expressImport) evidence.push("express-import");

  // Find the most-common binding used in route calls.
  const counts = new Map<string, number>();
  for (const call of fastifyCalls) {
    const match = /^([a-zA-Z_$][\w$]*)\./.exec(call);
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  let bindingName: string | null = null;
  let max = 0;
  for (const [name, count] of counts) {
    if (count > max) { max = count; bindingName = name; }
  }

  if (!bindingName) return { framework: null, bindingName: null, evidence };

  if (fastifyImport && (bindingName === "fastify" || bindingName === "app" || bindingName === "server")) {
    return { framework: "fastify", bindingName, evidence };
  }
  if (bindingName === "router" || /\bRouter\(\)/.test(source)) {
    return { framework: "express-router", bindingName, evidence };
  }
  if (expressImport) {
    return { framework: "express-app", bindingName, evidence };
  }
  // Heuristic last-resort: when only one binding is used and it's
  // `fastify`, assume fastify. Otherwise refuse.
  if (bindingName === "fastify") {
    return { framework: "fastify", bindingName, evidence: [...evidence, "binding-fastify"] };
  }
  if (bindingName === "router") {
    return { framework: "express-router", bindingName, evidence: [...evidence, "binding-router"] };
  }
  return { framework: null, bindingName, evidence: [...evidence, "ambiguous"] };
}

export function findExistingRoutes(source: string, bindingName: string): RouteSite[] {
  const lines = source.split("\n");
  const sites: RouteSite[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = ROUTE_CALL_REGEX.exec(line);
    if (!match) { i++; continue; }
    const [, indent, ident, methodLower, path] = match;
    if (ident !== bindingName) { i++; continue; }
    const method = methodLower.toUpperCase() as HttpMethod;
    if (!HTTP_METHODS.includes(method)) { i++; continue; }
    // Find the matching ) that closes the call. Walk forward, count
    // parens, ignore content inside string literals.
    const startLine = i;
    const endLine = findMatchingParenEnd(lines, i);
    if (endLine < 0) { i++; continue; } // unbalanced — refuse
    sites.push({
      framework: "fastify", // overridden by the caller (we only need shape, not framework)
      method,
      path,
      startLine,
      endLine,
      indent,
    });
    i = endLine + 1;
  }
  return sites;
}

/**
 * Walk forward from `startLine` and find the line where the call
 * expression's outermost `)` lives. Returns -1 if it cannot be found
 * within a sane limit (200 lines).
 *
 * String-aware: skips characters inside ' " ` literals, including
 * escaped quotes. Doesn't try to be a full parser — handles the
 * common cases of multi-line option objects and arrow function bodies.
 */
function findMatchingParenEnd(lines: readonly string[], startLine: number): number {
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escape = false;
  let started = false;
  const limit = Math.min(lines.length, startLine + 200);
  for (let i = startLine; i < limit; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === "\\") { escape = true; continue; }
        if (ch === inString) { inString = null; continue; }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") { inString = ch; continue; }
      if (ch === "/" && line[c + 1] === "/") break; // line comment
      if (ch === "(") { depth++; started = true; continue; }
      if (ch === ")") {
        depth--;
        if (started && depth === 0) {
          // Optional trailing semicolon — include this line.
          return i;
        }
      }
    }
  }
  return -1;
}
