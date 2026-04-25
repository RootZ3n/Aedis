/**
 * Unit tests for the type-extend transform layer:
 *   - tryAddInterfaceProperty
 *   - tryAddTypeAliasProperty
 *   - tryAddZodSchemaField
 *
 * Plus the task-shape parser for "add X to <Symbol>" prompts.
 *
 * No model calls. Each test spins up a tmp file, runs the transform,
 * and asserts shape + content + export preservation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryAddInterfaceProperty,
  tryAddTypeAliasProperty,
  tryAddZodSchemaField,
} from "./index.js";
import { parseTypeExtendPrompt, classifyTaskShape } from "../task-shape.js";

function tmpFile(content: string): { dir: string; file: string; abs: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aedis-type-extend-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  const rel = "src/types.ts";
  const abs = join(dir, rel);
  writeFileSync(abs, content, "utf-8");
  return { dir, file: rel, abs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── parseTypeExtendPrompt ──────────────────────────────────────────

test("parseTypeExtendPrompt: 'add email:string to User interface'", () => {
  const r = parseTypeExtendPrompt("add email:string to User interface");
  assert.ok(r);
  assert.equal(r!.symbol, "User");
  assert.equal(r!.property, "email");
  assert.equal(r!.propertyType, "string");
  assert.equal(r!.optional, false);
  assert.equal(r!.kindHint, "interface");
});

test("parseTypeExtendPrompt: 'add optional metadata?:Record<string,string> to ApiResponse type'", () => {
  const r = parseTypeExtendPrompt("add optional metadata?:Record<string,string> to ApiResponse type");
  assert.ok(r);
  assert.equal(r!.symbol, "ApiResponse");
  assert.equal(r!.property, "metadata");
  assert.equal(r!.propertyType, "Record<string,string>");
  assert.equal(r!.optional, true);
  assert.equal(r!.kindHint, "type");
});

test("parseTypeExtendPrompt: 'add enabled:boolean to FeatureFlagSchema'", () => {
  const r = parseTypeExtendPrompt("add enabled:boolean to FeatureFlagSchema");
  assert.ok(r);
  assert.equal(r!.symbol, "FeatureFlagSchema");
  assert.equal(r!.property, "enabled");
  assert.equal(r!.propertyType, "boolean");
  assert.equal(r!.kindHint, "schema");
});

test("parseTypeExtendPrompt: bare 'add X field to Y'", () => {
  const r = parseTypeExtendPrompt("add age field to User");
  assert.ok(r);
  assert.equal(r!.symbol, "User");
  assert.equal(r!.property, "age");
  assert.equal(r!.propertyType, "string");
});

test("parseTypeExtendPrompt: 'extend X with Y:T'", () => {
  const r = parseTypeExtendPrompt("extend Config with timeoutMs:number");
  assert.ok(r);
  assert.equal(r!.symbol, "Config");
  assert.equal(r!.property, "timeoutMs");
  assert.equal(r!.propertyType, "number");
});

test("parseTypeExtendPrompt: prompts without a symbol return null", () => {
  assert.equal(parseTypeExtendPrompt("add a /health endpoint"), null);
  assert.equal(parseTypeExtendPrompt("refactor utils"), null);
});

test("classifyTaskShape: type-extend wins over general", () => {
  const f = classifyTaskShape("add email:string to User interface");
  assert.equal(f.shape, "type-extend");
  assert.ok(f.typeExtend);
  assert.equal(f.typeExtend!.symbol, "User");
});

test("classifyTaskShape: route-add still wins when http verb is present", () => {
  // Even if "add" is present, an HTTP verb pattern dominates.
  const f = classifyTaskShape("add GET /health endpoint");
  assert.equal(f.shape, "route-add");
});

// ─── Interface property add ─────────────────────────────────────────

test("tryAddInterfaceProperty: appends required property to existing interface", async () => {
  const src =
`export interface User {
  id: string;
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddInterfaceProperty({
      projectRoot: t.dir,
      file: t.file,
      interfaceName: "User",
      propertyName: "email",
      propertyType: "string",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /id:\s*string;/);
      assert.match(r.updatedContent, /email:\s*string;/);
      assert.deepEqual([...r.exportDiff.missing], []);
      assert.deepEqual([...r.exportDiff.proposed], ["User"]);
    }
  } finally { t.cleanup(); }
});

test("tryAddInterfaceProperty: optional + readonly", async () => {
  const src = `interface User { id: string; }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddInterfaceProperty({
      projectRoot: t.dir,
      file: t.file,
      interfaceName: "User",
      propertyName: "metadata",
      propertyType: "Record<string,string>",
      optional: true,
      readonly: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /readonly\s+metadata\?:\s*Record<string,string>;/);
    }
  } finally { t.cleanup(); }
});

test("tryAddInterfaceProperty: refuses on duplicate property name", async () => {
  const src = `interface User { id: string; email: string; }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddInterfaceProperty({
      projectRoot: t.dir, file: t.file,
      interfaceName: "User", propertyName: "email", propertyType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

test("tryAddInterfaceProperty: refuses when interface not found", async () => {
  const src = `interface OtherThing { id: string; }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddInterfaceProperty({
      projectRoot: t.dir, file: t.file,
      interfaceName: "User", propertyName: "x", propertyType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "not-recognizable");
  } finally { t.cleanup(); }
});

test("tryAddInterfaceProperty: handles `extends` interfaces (records evidence)", async () => {
  const src =
`interface Base { id: string; }
interface User extends Base {
  name: string;
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddInterfaceProperty({
      projectRoot: t.dir, file: t.file,
      interfaceName: "User", propertyName: "email", propertyType: "string",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // Order check: name before email; email between } closer
      assert.match(r.updatedContent, /name:\s*string;\s*\n\s*email:\s*string;/);
      assert.match(r.notes, /extends/i);
    }
  } finally { t.cleanup(); }
});

test("tryAddInterfaceProperty: preserves all other top-level exports", async () => {
  const src =
`export interface A { x: string; }
export interface User { id: string; }
export const helper = 1;
export function f() { return 1; }
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddInterfaceProperty({
      projectRoot: t.dir, file: t.file,
      interfaceName: "User", propertyName: "email", propertyType: "string",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.deepEqual(r.exportDiff.missing, []);
      // All four exports remain.
      assert.ok(r.exportDiff.proposed.includes("A"));
      assert.ok(r.exportDiff.proposed.includes("User"));
      assert.ok(r.exportDiff.proposed.includes("helper"));
      assert.ok(r.exportDiff.proposed.includes("f"));
    }
  } finally { t.cleanup(); }
});

// ─── Type alias property add ────────────────────────────────────────

test("tryAddTypeAliasProperty: extends a `type X = { … }`", async () => {
  const src = `export type ApiResponse = {\n  status: string;\n};\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddTypeAliasProperty({
      projectRoot: t.dir, file: t.file,
      typeName: "ApiResponse",
      propertyName: "metadata",
      propertyType: "Record<string,string>",
      optional: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /metadata\?:\s*Record<string,string>;/);
      assert.match(r.updatedContent, /status:\s*string;/);
    }
  } finally { t.cleanup(); }
});

test("tryAddTypeAliasProperty: refuses on intersection RHS", async () => {
  const src = `type ApiResponse = Base & { status: string };\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddTypeAliasProperty({
      projectRoot: t.dir, file: t.file,
      typeName: "ApiResponse",
      propertyName: "metadata", propertyType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("tryAddTypeAliasProperty: refuses on intersection appended after closing brace", async () => {
  const src = `type ApiResponse = {\n  status: string;\n} & Base;\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddTypeAliasProperty({
      projectRoot: t.dir, file: t.file,
      typeName: "ApiResponse",
      propertyName: "metadata", propertyType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("tryAddTypeAliasProperty: refuses on duplicate property", async () => {
  const src = `type ApiResponse = { status: string; metadata: string; };\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddTypeAliasProperty({
      projectRoot: t.dir, file: t.file,
      typeName: "ApiResponse",
      propertyName: "metadata", propertyType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

test("tryAddTypeAliasProperty: respects existing comma-separated body", async () => {
  const src =
`type ApiResponse = {
  status: string,
  code: number,
};
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddTypeAliasProperty({
      projectRoot: t.dir, file: t.file,
      typeName: "ApiResponse",
      propertyName: "metadata", propertyType: "string",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // New member should use comma to match the file's style.
      assert.match(r.updatedContent, /metadata:\s*string,/);
    }
  } finally { t.cleanup(); }
});

// ─── Zod schema field add ───────────────────────────────────────────

test("tryAddZodSchemaField: adds simple field", async () => {
  const src =
`import { z } from "zod";
export const UserSchema = z.object({
  id: z.string(),
});
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddZodSchemaField({
      projectRoot: t.dir, file: t.file,
      schemaName: "UserSchema",
      fieldName: "email",
      fieldType: "string",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /email:\s*z\.string\(\)/);
      assert.match(r.updatedContent, /id:\s*z\.string\(\)/);
    }
  } finally { t.cleanup(); }
});

test("tryAddZodSchemaField: optional field gets .optional()", async () => {
  const src = `const X = z.object({ a: z.string() });\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddZodSchemaField({
      projectRoot: t.dir, file: t.file,
      schemaName: "X", fieldName: "b", fieldType: "boolean", optional: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /b:\s*z\.boolean\(\)\.optional\(\)/);
    }
  } finally { t.cleanup(); }
});

test("tryAddZodSchemaField: refuses on chained .strict()", async () => {
  const src = `const X = z.object({ a: z.string() }).strict();\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddZodSchemaField({
      projectRoot: t.dir, file: t.file,
      schemaName: "X", fieldName: "b", fieldType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("tryAddZodSchemaField: refuses on .extend(", async () => {
  const src = `const X = z.object({ a: z.string() }).extend({ b: z.string() });\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddZodSchemaField({
      projectRoot: t.dir, file: t.file,
      schemaName: "X", fieldName: "c", fieldType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("tryAddZodSchemaField: refuses on spread", async () => {
  const src = `const Base = z.object({ x: z.string() });\nconst X = z.object({ ...Base.shape, y: z.string() });\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddZodSchemaField({
      projectRoot: t.dir, file: t.file,
      schemaName: "X", fieldName: "z", fieldType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("tryAddZodSchemaField: refuses on duplicate field", async () => {
  const src = `const X = z.object({ a: z.string(), b: z.number() });\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddZodSchemaField({
      projectRoot: t.dir, file: t.file,
      schemaName: "X", fieldName: "b", fieldType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

test("tryAddZodSchemaField: maps Record<string,string> to z.record", async () => {
  const src = `const X = z.object({ a: z.string() });\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddZodSchemaField({
      projectRoot: t.dir, file: t.file,
      schemaName: "X", fieldName: "meta", fieldType: "Record<string,string>",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /meta:\s*z\.record\(z\.string\(\),\s*z\.string\(\)\)/);
    }
  } finally { t.cleanup(); }
});

test("tryAddZodSchemaField: refuses on type it cannot map", async () => {
  const src = `const X = z.object({ a: z.string() });\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddZodSchemaField({
      projectRoot: t.dir, file: t.file,
      schemaName: "X", fieldName: "u", fieldType: "User", // unrecognized
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("tryAddZodSchemaField: passes through verbatim z.* expressions", async () => {
  const src = `const X = z.object({ a: z.string() });\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddZodSchemaField({
      projectRoot: t.dir, file: t.file,
      schemaName: "X", fieldName: "u",
      fieldType: "z.lazy(() => UserSchema)",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /u:\s*z\.lazy\(\(\) => UserSchema\)/);
    }
  } finally { t.cleanup(); }
});

// ─── Disk-write contract ────────────────────────────────────────────

test("type-extend transforms do NOT write the file — caller does", async () => {
  const src = `interface User { id: string; }\n`;
  const t = tmpFile(src);
  try {
    await tryAddInterfaceProperty({
      projectRoot: t.dir, file: t.file,
      interfaceName: "User", propertyName: "email", propertyType: "string",
    });
    const onDisk = readFileSync(t.abs, "utf-8");
    assert.equal(onDisk, src);
  } finally { t.cleanup(); }
});
