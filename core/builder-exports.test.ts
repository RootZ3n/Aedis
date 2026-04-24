import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExportPreservationDirective,
  enforcePreservedExports,
  extractNamedExports,
  extractNamedExportSignatures,
  findRemovedExports,
  requestAuthorizesRemoval,
} from "../workers/builder.js";

// ─── extractNamedExports ────────────────────────────────────────────

test("extractNamedExports: recovers function/class/const/interface/type/enum exports", () => {
  const src = `
export function divide(a: number, b: number): number { return a / b; }
export const VERSION = "1";
export class Stack<T> { push(x: T) {} }
export interface User { id: string }
export type Id = string | number;
export enum Color { Red, Green }
export async function fetchThing() { return null; }
`;
  assert.deepEqual(
    extractNamedExports(src),
    ["Color", "Id", "Stack", "User", "VERSION", "divide", "fetchThing"].sort(),
  );
});

test("extractNamedExports: ignores anonymous default exports but keeps re-exports", () => {
  const src = `
export default function() { return 1; }
export { foo } from "./foo.js";
export { bar as baz };
import { bar } from "./bar.js";
export const real = 42;
`;
  assert.deepEqual(extractNamedExports(src), ["baz", "foo", "real"]);
});

test("extractNamedExports: deduplicates when the same name appears twice (shouldn't in practice)", () => {
  const src = `
export function foo() {}
export function foo() {}
`;
  assert.deepEqual(extractNamedExports(src), ["foo"]);
});

test("extractNamedExports: empty/null-ish inputs return empty array", () => {
  assert.deepEqual(extractNamedExports(""), []);
  assert.deepEqual(extractNamedExports("// just a comment"), []);
});

// ─── findRemovedExports ─────────────────────────────────────────────

test("findRemovedExports: minimal patch preserving every export reports zero missing", () => {
  const before = `export function add(a: number, b: number) { return a + b; }
export function mul(a: number, b: number) { return a * b; }`;
  const after = `export function add(a: number, b: number) { return a + b; }
export function mul(a: number, b: number) { return a * b + 0; }`; // trivial change
  const issue = findRemovedExports(before, after);
  assert.deepEqual(issue.missing, []);
  assert.equal(issue.originalCount, 2);
  assert.equal(issue.updatedCount, 2);
});

test("findRemovedExports: single-name rename counts as 1 removal (legitimate refactor escape hatch)", () => {
  const before = `export function oldName() {}`;
  const after = `export function newName() {}`;
  const issue = findRemovedExports(before, after);
  assert.deepEqual(issue.missing, ["oldName"]);
});

test("findRemovedExports: wholesale rewrite — original exports all gone", () => {
  const before = `
export function divide(a: number, b: number) { return a / b; }
export function isEven(n: number) { return n % 2 === 0; }
export function capitalize(s: string) { return s[0].toUpperCase() + s.slice(1); }
export function validateEmail(s: string) { return s.includes("@"); }
export class Stack<T> {}
`;
  const after = `
export function multiply(a: number, b: number) { return a * b; }
`;
  const issue = findRemovedExports(before, after);
  assert.equal(issue.missing.length, 5);
  assert.deepEqual(
    [...issue.missing].sort(),
    ["Stack", "capitalize", "divide", "isEven", "validateEmail"],
  );
});

// ─── enforcePreservedExports ────────────────────────────────────────

test("enforcePreservedExports: clean minimal patch does NOT throw", () => {
  const before = `export function f() { return 1; }\nexport function g() { return 2; }`;
  const after = `export function f() { return 1; }\nexport function g() { return 3; }`;
  enforcePreservedExports(before, after, "src/utils.ts"); // no throw
});

test("enforcePreservedExports: single rename is tolerated (<2 threshold)", () => {
  const before = `export function oldName() {}\nexport function sibling() {}`;
  const after = `export function newName() {}\nexport function sibling() {}`;
  enforcePreservedExports(before, after, "src/utils.ts"); // no throw
});

test("enforcePreservedExports: 2+ export deletions throw with actionable message (stress-01..14 regression)", () => {
  const before = `
export function divide(a: number, b: number) { return a / b; }
export function isEven(n: number) { return n % 2 === 0; }
export function capitalize(s: string) { return s[0].toUpperCase() + s.slice(1); }
export function validateEmail(s: string) { return s.includes("@"); }
export class Stack<T> {}
export function fibonacci(n: number) { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }
`;
  const after = `
export function fibonacci(n: number) {
  if (n < 0) return 0;
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
`;
  assert.throws(
    () => enforcePreservedExports(before, after, "src/utils.ts"),
    /removed 5 existing export\(s\)/,
  );
});

test("enforcePreservedExports: non-code files are skipped (no throw on markdown)", () => {
  // Markdown files don't have JS exports but the regex shouldn't be
  // applied anyway — extension gate skips them.
  enforcePreservedExports(
    "# Title\n- list item\n- another",
    "# Different Title\n- item",
    "docs/README.md",
  );
});

test("enforcePreservedExports: error message lists the removed names (up to 8)", () => {
  const before = `
export function a() {}
export function b() {}
export function c() {}
export function d() {}
`;
  const after = ``;
  try {
    enforcePreservedExports(before, after, "src/x.ts");
    assert.fail("expected throw");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /a.*b.*c.*d/);
    assert.match(msg, /src\/x\.ts/);
  }
});

// ─── buildExportPreservationDirective ───────────────────────────────

test("buildExportPreservationDirective: names every export by identifier for normal files", () => {
  const src = `
export function foo() {}
export const bar = 1;
export class Baz {}
`;
  const directive = buildExportPreservationDirective(src);
  assert.match(directive, /exports 3 symbol/);
  for (const name of ["foo", "bar", "Baz"]) {
    assert.ok(directive.includes(name), `directive must name ${name}`);
  }
  assert.match(directive, /MUST still export every one of them/);
});

test("buildExportPreservationDirective: no-exports file gets the generic rule, not a ruined list", () => {
  const directive = buildExportPreservationDirective("// just comments");
  assert.match(directive, /EXPORT PRESERVATION/);
  assert.ok(
    !directive.includes("0 symbol"),
    `empty-export directive must not say "0 symbol": ${directive}`,
  );
});

// ─── Phase 11 Task 1 — strict single-export preservation ──────────────

const REMOVAL_AUTHORIZED_PROMPTS: readonly string[] = [
  "remove the deprecated validateEmail function",
  "delete the old Stack class",
  "drop the unused helper",
  "eliminate the legacy code path",
  "rename oldName to newName",
  "replace the old logger with a new one",
  "extract the email validator into a separate module",
];

for (const prompt of REMOVAL_AUTHORIZED_PROMPTS) {
  test(`requestAuthorizesRemoval: "${prompt}" → true`, () => {
    assert.equal(requestAuthorizesRemoval(prompt), true);
  });
}

const REMOVAL_NOT_AUTHORIZED_PROMPTS: readonly string[] = [
  "fix the off-by-one in fibonacci",
  "add a multiply function",
  "correct the capitalize handling of empty strings",
  "update the version constant",
  "improve the parser's error message",
  "replace the error message with a clearer one",
  "extract a helper for readability",
];

for (const prompt of REMOVAL_NOT_AUTHORIZED_PROMPTS) {
  test(`requestAuthorizesRemoval: "${prompt}" → false (simple targeted task)`, () => {
    assert.equal(requestAuthorizesRemoval(prompt), false);
  });
}

test("requestAuthorizesRemoval: nullish/non-string inputs return false", () => {
  assert.equal(requestAuthorizesRemoval(null), false);
  assert.equal(requestAuthorizesRemoval(undefined), false);
  assert.equal(requestAuthorizesRemoval(""), false);
});

test("enforcePreservedExports (P11 strict): single-export removal throws when user request does NOT authorize removal", () => {
  // stress-01/02-shape scenario: user asks to fix fibonacci, builder
  // silently drops `Stack` while "fixing" fibonacci. Before P11, this
  // slipped through (threshold was >=2). Now it throws.
  const before = `
export function fibonacci(n: number) { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }
export class Stack<T> {}
export function validateEmail(s: string) { return s.includes("@"); }
`;
  const after = `
export function fibonacci(n: number) {
  if (n < 0) return 0;
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
export function validateEmail(s: string) { return s.includes("@"); }
`;
  assert.throws(
    () =>
      enforcePreservedExports(
        before,
        after,
        "src/utils.ts",
        "Fix the off-by-one error in fibonacci",
      ),
    /removed 1 existing export.*Stack.*unrelated-symbol corruption/,
  );
});

test("enforcePreservedExports (P11 strict): single-export removal is ALLOWED when user request authorizes removal", () => {
  const before = `
export function keep() {}
export function drop() {}
`;
  const after = `
export function keep() {}
`;
  // With explicit removal intent, the original >=2 threshold applies
  // → 1 removal is allowed (supports legitimate one-export deletions).
  enforcePreservedExports(
    before,
    after,
    "src/utils.ts",
    "Remove the drop function — it's deprecated.",
  );
});

test("enforcePreservedExports (P11 strict): legitimate rename passes when 'rename' authorizes", () => {
  const before = `export function oldName() {}`;
  const after = `export function newName() {}`;
  enforcePreservedExports(
    before,
    after,
    "src/utils.ts",
    "Rename oldName to newName",
  );
});

test("enforcePreservedExports (P11 strict): export preserved via re-export does NOT throw", () => {
  const before = `
export function validateEmail(s: string) { return s.includes("@"); }
export function keep() {}
`;
  const after = `
export { validateEmail } from "./email";
export function keep() {}
`;
  enforcePreservedExports(
    before,
    after,
    "src/utils.ts",
    "Extract the email validator into a new file and re-export it from utils.ts",
  );
});

test("enforcePreservedExports (P11 strict): wholesale rewrite still throws even with removal authorization", () => {
  const before = `
export function a() {}
export function b() {}
export function c() {}
export function d() {}
`;
  const after = `
export function only() {}
`;
  // Even when the user authorizes removal, 4+ export deletions with 1
  // unrelated addition is a wholesale rewrite, not a rename. Threshold
  // is still 2 in authorized mode — this trips it.
  assert.throws(
    () =>
      enforcePreservedExports(
        before,
        after,
        "src/utils.ts",
        "Replace the old helpers",
      ),
    /removed 4 existing export/,
  );
});

test("enforcePreservedExports (P11 strict): legacy caller without userRequest keeps Phase 10 behavior (>=2 threshold)", () => {
  const before = `export function keep() {}\nexport function drop() {}`;
  const after = `export function keep() {}`;
  // No userRequest → assume authorized (legacy) → threshold stays >=2
  // → single-export drop does NOT throw.
  enforcePreservedExports(before, after, "src/utils.ts");
});

test("buildExportPreservationDirective: caps the name list at 16 and summarizes the rest", () => {
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) {
    lines.push(`export function f${i}() {}`);
  }
  const directive = buildExportPreservationDirective(lines.join("\n"));
  assert.match(directive, /20 symbol/);
  assert.match(directive, /and 4 more/);
});

// ─── Phase 12 — three corruption modes ──────────────────────────────

// Case 1: removed export keyword but kept the function/class.
test("findRemovedExports (P12 case 1): export keyword stripped, symbol kept → flagged as missing", () => {
  // The user said the previous detection only matched `-export` lines
  // in a diff. The reality: extractNamedExports requires `export` to
  // match, so dropping the keyword removes the symbol from the
  // after-set. findRemovedExports then reports it as missing. This
  // test locks that behavior in.
  const before = `export function foo() { return 1; }
export function bar() { return 2; }
export function baz() { return 3; }`;
  const after = `function foo() { return 1; }
function bar() { return 2; }
function baz() { return 3; }`;
  const issue = findRemovedExports(before, after);
  assert.deepEqual([...issue.missing].sort(), ["bar", "baz", "foo"]);
  assert.equal(issue.signatureChanges.length, 0);
});

test("enforcePreservedExports (P12 case 1): export-stripped patch throws even without removal authorization", () => {
  const before = `export function foo() {}\nexport function bar() {}`;
  const after = `function foo() {}\nfunction bar() {}`;
  assert.throws(
    () =>
      enforcePreservedExports(
        before,
        after,
        "src/utils.ts",
        "fix the off-by-one in foo",
      ),
    /removed 2 existing export/,
  );
});

// Case 2: signature change while keeping the export name.
test("extractNamedExportSignatures: captures function signature including params and return type", () => {
  const sigs = extractNamedExportSignatures(
    `export function foo(a: number, b: string): boolean { return true; }`,
  );
  assert.equal(sigs.size, 1);
  const sig = sigs.get("foo")!;
  assert.match(sig, /function foo \(a: number, b: string\): boolean/);
});

test("extractNamedExportSignatures: captures class extends/implements", () => {
  const sigs = extractNamedExportSignatures(
    `export class Stack<T> extends Base<T> implements ICollection<T> { push() {} }`,
  );
  const sig = sigs.get("Stack")!;
  assert.ok(sig.includes("Stack"));
  assert.ok(sig.includes("extends Base<T>"));
  assert.ok(sig.includes("implements ICollection<T>"));
});

test("extractNamedExportSignatures: captures const type annotation", () => {
  const sigs = extractNamedExportSignatures(`export const VERSION: number = 5;`);
  const sig = sigs.get("VERSION")!;
  assert.match(sig, /const VERSION : number/);
});

test("findRemovedExports (P12 case 2): kept export with mutated signature → flagged as signatureChange", () => {
  const before = `export function foo(a: number): boolean { return true; }`;
  const after = `export function foo(a: number, b: string): boolean { return true; }`;
  const issue = findRemovedExports(before, after);
  assert.equal(issue.missing.length, 0);
  assert.equal(issue.signatureChanges.length, 1);
  assert.equal(issue.signatureChanges[0].name, "foo");
  assert.match(issue.signatureChanges[0].before, /function foo \(a: number\): boolean/);
  assert.match(issue.signatureChanges[0].after, /function foo \(a: number, b: string\): boolean/);
});

test("enforcePreservedExports (P12 case 2): single signature change does NOT throw — could be the requested fix", () => {
  const before = `export function capitalize(s: string): string { return s.toUpperCase(); }`;
  const after = `export function capitalize(s: string | null): string { return s ? s.toUpperCase() : ""; }`;
  // Strict mode (no removal authorization), but only ONE signature
  // changed — that's likely the user's actual fix. Don't block.
  enforcePreservedExports(
    before,
    after,
    "src/utils.ts",
    "fix capitalize to handle empty/null strings",
  );
});

test("enforcePreservedExports (P12 case 2): multiple signature changes WITHOUT authorization → throws", () => {
  const before = `export function divide(a: number, b: number): number { return a / b; }
export function isEven(n: number): boolean { return n % 2 === 0; }
export function capitalize(s: string): string { return s.toUpperCase(); }`;
  // Same names exported, but each signature mutated. Builder didn't
  // remove anything but corrupted the API surface of three siblings.
  const after = `export function divide(a: number, b: number, mode: string): number { return a / b; }
export function isEven(n: number, strict: boolean): boolean { return n % 2 === 0; }
export function capitalize(s: string, locale: string): string { return s.toUpperCase(); }`;
  assert.throws(
    () =>
      enforcePreservedExports(
        before,
        after,
        "src/utils.ts",
        "fix the bug in capitalize", // single-target prompt, no removal authorized
      ),
    /changed 3 export signature/,
  );
});

test("enforcePreservedExports (P12 case 2 guard): authorized refactor tolerates 2 signature changes", () => {
  const before = `export function add(a: number, b: number): number { return a + b; }
export function multiply(a: number, b: number): number { return a * b; }`;
  const after = `export function add(...nums: number[]): number { return nums.reduce((a, b) => a + b, 0); }
export function multiply(...nums: number[]): number { return nums.reduce((a, b) => a * b, 1); }`;
  // Refactor explicitly authorizes change; 2 sig changes < authorized
  // threshold of 3 → no throw.
  enforcePreservedExports(
    before,
    after,
    "src/utils.ts",
    "Refactor add and multiply to accept variadic args — extract them into the new arithmetic module",
  );
});

// Case 3: moved without re-export.
test("findRemovedExports (P12 case 3): symbol moved out of file with no re-export → flagged as missing", () => {
  const before = `export function helper() { return 1; }
export function keep() { return 2; }`;
  const after = `// helper moved to ./helper.ts but forgot to re-export
export function keep() { return 2; }`;
  const issue = findRemovedExports(before, after);
  assert.deepEqual([...issue.missing], ["helper"]);
});

test("findRemovedExports (P12 case 3 guard): symbol moved with re-export clause → NOT flagged (legitimate move)", () => {
  // Constraint says "do not block legitimate extract/re-export cases".
  // When the model moves a function and adds an `export { name } from
  // './new-location'` clause in its place, the export set stays
  // intact and we should NOT flag.
  const before = `export function helper() { return 1; }
export function keep() { return 2; }`;
  const after = `export { helper } from "./helper-new.js";
export function keep() { return 2; }`;
  const issue = findRemovedExports(before, after);
  assert.deepEqual([...issue.missing], []);
  assert.equal(issue.signatureChanges.length, 0);
});

test("enforcePreservedExports (P12 case 3 guard): legitimate extract+re-export passes", () => {
  const before = `export function divide(a: number, b: number) { return a / b; }
export function isEven(n: number) { return n % 2 === 0; }`;
  const after = `export { divide, isEven } from "./math-utils.js";`;
  // "Extract X into a new file" is the canonical legitimate move
  // pattern; with the re-export clause both names are preserved.
  enforcePreservedExports(
    before,
    after,
    "src/utils.ts",
    "Extract divide and isEven into a new file src/math-utils.js",
  );
});

// Bonus: abstract class extension that the regex now accepts.
test("extractNamedExports (P12): abstract class is recognized as a named export", () => {
  const names = extractNamedExports(
    `export abstract class Base { abstract foo(): void; }`,
  );
  assert.deepEqual(names, ["Base"]);
});
