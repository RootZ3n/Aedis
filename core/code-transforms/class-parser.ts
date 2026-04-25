/**
 * Class body parser — walks a TypeScript class body and returns the
 * member declarations it contains, including any leading decorator
 * blocks. Used by the class-extend transforms to:
 *
 *   - find a safe insertion point for a new field that doesn't split
 *     a multi-line decorator from its target member
 *   - parse the constructor's parameter list (with parameter-property
 *     decorators) for the constructor-param transform
 *   - detect computed member names ahead of any edit, so we can fail
 *     closed instead of corrupting the file
 *
 * Pure functions, no I/O, no AST library. Decorator support is
 * forward-walking (we never need to walk back over decorator blocks)
 * which is why multi-line decorators with `{}` inside their argument
 * objects are handled correctly.
 */

import { findMatchingDelimiter } from "./util.js";

export interface ParsedClassMember {
  /** Inclusive index of the first character of the member, including any leading decorator block. */
  readonly start: number;
  /** Index of the first character of the actual declaration (after the decorator block). */
  readonly declStart: number;
  /** Exclusive end index — first index after the member's terminator (`;` or matching `}`). */
  readonly end: number;
  readonly kind: "method" | "field" | "constructor" | "getter" | "setter";
  readonly name: string;
  /** Number of decorator expressions in the leading block (0 when none). */
  readonly decoratorCount: number;
}

export type ClassBodyParseResult =
  | { readonly ok: true; readonly members: readonly ParsedClassMember[] }
  | { readonly ok: false; readonly code: "malformed-decorator" | "computed-member" | "unrecognized-shape"; readonly reason: string };

const MODIFIER_KEYWORDS = [
  "public", "private", "protected",
  "static", "readonly", "abstract", "override", "async", "declare",
];
const MODIFIER_RE = new RegExp(`^(?:${MODIFIER_KEYWORDS.join("|")})\\s+`);

/**
 * Parse a class body (the slice between `{` and `}`, exclusive of
 * those characters) into ordered ParsedClassMember entries.
 *
 * `bodyOpenIdx` and `bodyCloseIdx` are SOURCE-LEVEL indices: the
 * caller should pass the location of the opening `{` and the matching
 * `}` of the class body. The returned `start`, `declStart`, and `end`
 * fields are also source-level indices.
 *
 * Returns `{ ok: false, … }` on:
 *   - malformed decorators (unbalanced `(` in `@Foo(…)`),
 *   - computed member names (`["x"]() {}`, `[Symbol.iterator]() {}`),
 *   - any member whose declaration shape we don't recognize.
 */
export function parseClassBody(
  source: string,
  bodyOpenIdx: number,
  bodyCloseIdx: number,
): ClassBodyParseResult {
  const members: ParsedClassMember[] = [];
  let pos = bodyOpenIdx + 1;
  while (pos < bodyCloseIdx) {
    pos = skipWsAndComments(source, pos, bodyCloseIdx);
    if (pos >= bodyCloseIdx) break;

    const memberStart = pos;
    const deco = scanDecoratorBlock(source, pos, bodyCloseIdx);
    if (deco.malformed) {
      return { ok: false, code: "malformed-decorator", reason: deco.reason };
    }
    pos = deco.afterIdx;
    pos = skipWsAndComments(source, pos, bodyCloseIdx);
    if (pos >= bodyCloseIdx) break;

    if (source[pos] === ";") {
      // Stray semicolon between members — skip it.
      pos++;
      continue;
    }
    if (source[pos] === "[") {
      return {
        ok: false,
        code: "computed-member",
        reason: `Computed member name detected at offset ${pos}; refusing.`,
      };
    }

    const declStart = pos;

    // Skip modifier keywords until we land on the member kind hint.
    let probe = pos;
    while (true) {
      const slice = source.slice(probe, Math.min(probe + 30, bodyCloseIdx));
      const match = MODIFIER_RE.exec(slice);
      if (!match) break;
      probe += match[0].length;
      probe = skipWsAndComments(source, probe, bodyCloseIdx);
    }

    if (probe >= bodyCloseIdx) {
      return { ok: false, code: "unrecognized-shape", reason: "End of body reached after modifiers." };
    }

    let kind: ParsedClassMember["kind"];
    let name: string;
    let endPos: number;

    const aheadSlice = source.slice(probe, Math.min(probe + 80, bodyCloseIdx));

    // constructor( … ) or constructor< … >( … )
    if (/^constructor\s*[(<]/.test(aheadSlice)) {
      kind = "constructor";
      name = "constructor";
      let parenSearch = probe + "constructor".length;
      // Skip optional generics
      parenSearch = skipWsAndComments(source, parenSearch, bodyCloseIdx);
      if (source[parenSearch] === "<") {
        const closeAngle = scanBalancedAngles(source, parenSearch, bodyCloseIdx);
        if (closeAngle < 0) {
          return { ok: false, code: "unrecognized-shape", reason: "Unbalanced generics on constructor." };
        }
        parenSearch = closeAngle + 1;
        parenSearch = skipWsAndComments(source, parenSearch, bodyCloseIdx);
      }
      if (source[parenSearch] !== "(") {
        return { ok: false, code: "unrecognized-shape", reason: "Constructor missing opening `(`." };
      }
      const tail = scanFunctionTail(source, parenSearch, bodyCloseIdx);
      if (tail < 0) {
        return { ok: false, code: "unrecognized-shape", reason: "Constructor body could not be parsed." };
      }
      endPos = tail;
    } else {
      // get / set <name>( … ) — accessor
      const accessorMatch = /^(get|set)\s+([A-Za-z_$][\w$]*)/.exec(aheadSlice);
      if (accessorMatch) {
        let after = probe + accessorMatch[0].length;
        after = skipWsAndComments(source, after, bodyCloseIdx);
        if (source[after] === "(") {
          kind = accessorMatch[1] === "get" ? "getter" : "setter";
          name = accessorMatch[2];
          const tail = scanFunctionTail(source, after, bodyCloseIdx);
          if (tail < 0) {
            return { ok: false, code: "unrecognized-shape", reason: `${kind} body could not be parsed.` };
          }
          endPos = tail;
          members.push({ start: memberStart, declStart, end: endPos, kind, name, decoratorCount: deco.count });
          pos = endPos;
          continue;
        }
      }
      // Plain identifier — could be field or method.
      const idMatch = /^([A-Za-z_$][\w$]*)/.exec(aheadSlice);
      if (!idMatch) {
        return {
          ok: false,
          code: "unrecognized-shape",
          reason: `Could not parse member identifier near offset ${probe}.`,
        };
      }
      name = idMatch[1];
      let after = probe + idMatch[0].length;
      after = skipWsAndComments(source, after, bodyCloseIdx);
      // Optional postfix `?` or `!`
      if (source[after] === "?" || source[after] === "!") {
        after++;
        after = skipWsAndComments(source, after, bodyCloseIdx);
      }
      // Optional generic parameter list (only for methods)
      if (source[after] === "<") {
        const closeAngle = scanBalancedAngles(source, after, bodyCloseIdx);
        if (closeAngle < 0) {
          return { ok: false, code: "unrecognized-shape", reason: "Unbalanced generics on member." };
        }
        after = closeAngle + 1;
        after = skipWsAndComments(source, after, bodyCloseIdx);
      }
      if (source[after] === "(") {
        kind = "method";
        const tail = scanFunctionTail(source, after, bodyCloseIdx);
        if (tail < 0) {
          return { ok: false, code: "unrecognized-shape", reason: `Method ${name} body could not be parsed.` };
        }
        endPos = tail;
      } else if (source[after] === ":" || source[after] === "=" || source[after] === ";") {
        kind = "field";
        const tail = scanFieldTail(source, after, bodyCloseIdx);
        if (tail < 0) {
          return { ok: false, code: "unrecognized-shape", reason: `Field ${name} terminator not found.` };
        }
        endPos = tail;
      } else {
        return {
          ok: false,
          code: "unrecognized-shape",
          reason: `Member ${name} has unrecognized shape (next char "${source[after]}").`,
        };
      }
    }

    members.push({ start: memberStart, declStart, end: endPos, kind, name, decoratorCount: deco.count });
    pos = endPos;
  }
  return { ok: true, members };
}

// ─── Helpers ───────────────────────────────────────────────────────

export function skipWsAndComments(source: string, pos: number, end: number): number {
  while (pos < end) {
    const ch = source[pos];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      pos++;
    } else if (ch === "/" && source[pos + 1] === "/") {
      while (pos < end && source[pos] !== "\n") pos++;
    } else if (ch === "/" && source[pos + 1] === "*") {
      pos += 2;
      while (pos < end - 1 && !(source[pos] === "*" && source[pos + 1] === "/")) pos++;
      if (pos < end - 1) pos += 2;
      else return end;
    } else {
      break;
    }
  }
  return pos;
}

interface DecoratorScanResult {
  readonly afterIdx: number;
  readonly count: number;
  readonly malformed: boolean;
  readonly reason: string;
}

/**
 * Scan zero-or-more `@Decorator(...)` expressions starting at `pos`.
 * Returns the index after the trailing decorator (which may be on a
 * different line for multi-line decorator bodies). Decorators are
 * separated by whitespace/newlines; the scan stops at the first
 * non-`@` non-whitespace character.
 */
export function scanDecoratorBlock(source: string, pos: number, end: number): DecoratorScanResult {
  let count = 0;
  let cursor = skipWsAndComments(source, pos, end);
  while (cursor < end && source[cursor] === "@") {
    cursor++;
    // Identifier (with optional namespacing via `.`)
    if (cursor < end && !/[A-Za-z_$]/.test(source[cursor])) {
      return { afterIdx: cursor, count, malformed: true, reason: "Decorator missing identifier after `@`." };
    }
    while (cursor < end && /[\w$]/.test(source[cursor])) cursor++;
    while (cursor < end && source[cursor] === ".") {
      cursor++;
      while (cursor < end && /[\w$]/.test(source[cursor])) cursor++;
    }
    cursor = skipWsAndComments(source, cursor, end);
    if (cursor < end && source[cursor] === "(") {
      const close = findMatchingDelimiter(source, cursor, "(");
      if (close < 0 || close >= end) {
        return { afterIdx: cursor, count, malformed: true, reason: "Decorator call has unbalanced parens." };
      }
      cursor = close + 1;
    }
    count++;
    cursor = skipWsAndComments(source, cursor, end);
  }
  return { afterIdx: cursor, count, malformed: false, reason: "" };
}

/**
 * From the opening `(` of a function-shaped member, scan past the
 * parameter list, optional `:returnType`, and the body (`{...}` or a
 * trailing `;` for abstract/overload signatures). Returns the
 * exclusive end index, or -1 on parse failure.
 */
function scanFunctionTail(source: string, parenStart: number, end: number): number {
  if (source[parenStart] !== "(") return -1;
  const closeParen = findMatchingDelimiter(source, parenStart, "(");
  if (closeParen < 0 || closeParen >= end) return -1;
  let i = closeParen + 1;
  i = skipWsAndComments(source, i, end);
  // Optional return type — `: <type>`. Walk to `{` or `;` at depth 0.
  if (source[i] === ":") {
    i++;
    let depth = 0;
    while (i < end) {
      const ch = source[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const sclose = scanStringLiteral(source, i, end);
        if (sclose < 0) return -1;
        i = sclose + 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "<" || ch === "{") {
        if (depth === 0 && ch === "{") break;
        depth++;
      } else if (ch === ")" || ch === "]" || ch === ">" || ch === "}") {
        depth--;
      } else if (depth === 0 && ch === ";") break;
      i++;
    }
  }
  i = skipWsAndComments(source, i, end);
  if (source[i] === "{") {
    const close = findMatchingDelimiter(source, i, "{");
    if (close < 0 || close >= end) return -1;
    return close + 1;
  }
  if (source[i] === ";") return i + 1;
  // Abstract method without body and without semicolon — treat as parse failure.
  return -1;
}

/**
 * From the `:` / `=` / `;` immediately after a field name, scan to
 * the field's terminator. Walks past any nested string/template/
 * paren/brace/bracket structure.
 */
function scanFieldTail(source: string, startIdx: number, end: number): number {
  let i = startIdx;
  let depth = 0;
  while (i < end) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const sclose = scanStringLiteral(source, i, end);
      if (sclose < 0) return -1;
      i = sclose + 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth < 0) {
        // We've fallen out of the class body — refuse.
        return -1;
      }
    } else if (depth === 0 && ch === ";") {
      return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Best-effort balanced-angle-bracket scanner for generic argument
 * lists. Returns the index of the matching `>` or -1.
 *
 * String-aware. Doesn't try to disambiguate `<` as a comparison
 * operator — we only call this in positions where the source is in a
 * "type position" (right after an identifier, after `:`, etc.).
 */
export function scanBalancedAngles(source: string, startIdx: number, end: number): number {
  if (source[startIdx] !== "<") return -1;
  let depth = 0;
  let i = startIdx;
  while (i < end) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const sclose = scanStringLiteral(source, i, end);
      if (sclose < 0) return -1;
      i = sclose + 1;
      continue;
    }
    if (ch === "<") depth++;
    else if (ch === ">") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Scan past a string/template literal opened at `openIdx`. Returns
 * the index of the closing quote, or -1 on EOF.
 */
export function scanStringLiteral(source: string, openIdx: number, end: number): number {
  const quote = source[openIdx];
  if (quote !== '"' && quote !== "'" && quote !== "`") return -1;
  let i = openIdx + 1;
  while (i < end) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      const close = findMatchingDelimiter(source, i + 1, "{");
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Split a parameter list (the contents BETWEEN the constructor's `(`
 * and `)`) on top-level commas. Each entry is returned with absolute
 * start/end offsets in the SOURCE — the caller passes the source-
 * relative open/close indices so the returned offsets remain stable.
 *
 * Returns `null` on malformed input (unbalanced delimiters, malformed
 * parameter decorator).
 */
export interface ParsedConstructorParam {
  readonly raw: string;       // full text of the parameter
  readonly startIdx: number;   // inclusive
  readonly endIdx: number;     // exclusive (does NOT include trailing comma)
  readonly name: string;       // declared parameter name
  readonly hasDecorators: boolean;
}

export function parseConstructorParams(
  source: string,
  parenOpen: number,
  parenClose: number,
): readonly ParsedConstructorParam[] | null {
  const params: ParsedConstructorParam[] = [];
  if (parenOpen + 1 >= parenClose) return params; // empty param list

  let pos = parenOpen + 1;
  let paramStart = -1;
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  while (pos < parenClose) {
    const ch = source[pos];
    if (inString) {
      if (ch === "\\") { pos += 2; continue; }
      if (ch === inString) inString = null;
      else if (inString === "`" && ch === "$" && source[pos + 1] === "{") {
        const close = findMatchingDelimiter(source, pos + 1, "{");
        if (close < 0) return null;
        pos = close + 1;
        continue;
      }
      pos++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; pos++; continue; }
    if (ch === "/" && source[pos + 1] === "/") {
      while (pos < parenClose && source[pos] !== "\n") pos++;
      continue;
    }
    if (ch === "/" && source[pos + 1] === "*") {
      pos += 2;
      while (pos < parenClose - 1 && !(source[pos] === "*" && source[pos + 1] === "/")) pos++;
      if (pos < parenClose - 1) pos += 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    if (paramStart < 0 && /\S/.test(ch)) paramStart = pos;
    if (depth === 0 && ch === ",") {
      if (paramStart >= 0) {
        const param = sliceParam(source, paramStart, pos);
        if (!param) return null;
        params.push(param);
      }
      paramStart = -1;
    }
    pos++;
  }
  // Trailing param
  if (paramStart >= 0) {
    const tailEnd = trimTrailingWs(source, paramStart, parenClose);
    if (tailEnd > paramStart) {
      const param = sliceParam(source, paramStart, tailEnd);
      if (!param) return null;
      params.push(param);
    }
  }
  return params;
}

function trimTrailingWs(source: string, startIdx: number, end: number): number {
  let i = end;
  while (i > startIdx && /\s/.test(source[i - 1])) i--;
  return i;
}

function sliceParam(source: string, startIdx: number, endIdxExclusive: number): ParsedConstructorParam | null {
  const raw = source.slice(startIdx, endIdxExclusive);
  // Skip leading whitespace inside the slice.
  let cursor = 0;
  while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
  // Decorators attached to the parameter.
  let hasDecorators = false;
  while (cursor < raw.length && raw[cursor] === "@") {
    hasDecorators = true;
    cursor++;
    while (cursor < raw.length && /[\w$.]/.test(raw[cursor])) cursor++;
    while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
    if (raw[cursor] === "(") {
      const close = findMatchingDelimiter(raw, cursor, "(");
      if (close < 0) return null;
      cursor = close + 1;
    }
    while (cursor < raw.length && /\s/.test(raw[cursor])) cursor++;
  }
  // Modifiers on the parameter (parameter properties: public/private/protected/readonly).
  while (cursor < raw.length) {
    const tail = raw.slice(cursor);
    const m = /^(public|private|protected|readonly)\s+/.exec(tail);
    if (!m) break;
    cursor += m[0].length;
  }
  // Parameter name — first identifier before `:`/`=`/`?`.
  const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(raw.slice(cursor));
  if (!nameMatch) return null;
  const name = nameMatch[1];
  return {
    raw,
    startIdx,
    endIdx: endIdxExclusive,
    name,
    hasDecorators,
  };
}
