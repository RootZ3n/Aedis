/**
 * Unit tests for the class-extend transforms + the
 * parseClassExtendPrompt parser.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryAddClassField,
  tryAddClassMethod,
} from "./index.js";
import { parseClassExtendPrompt, classifyTaskShape } from "../task-shape.js";

function tmpFile(content: string): { dir: string; file: string; abs: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aedis-class-extend-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  const rel = "src/services.ts";
  const abs = join(dir, rel);
  writeFileSync(abs, content, "utf-8");
  return { dir, file: rel, abs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── Prompt parser ─────────────────────────────────────────────────

test("parseClassExtendPrompt: 'add private logger:Logger to UserService'", () => {
  const r = parseClassExtendPrompt("add private logger:Logger to UserService");
  assert.ok(r);
  assert.equal(r!.className, "UserService");
  assert.equal(r!.memberKind, "field");
  assert.equal(r!.memberName, "logger");
  assert.equal(r!.memberType, "Logger");
  assert.equal(r!.visibility, "private");
});

test("parseClassExtendPrompt: 'add async createUser(user:User):Promise<void> method to UserService'", () => {
  const r = parseClassExtendPrompt("add async createUser(user:User):Promise<void> method to UserService");
  assert.ok(r);
  assert.equal(r!.className, "UserService");
  assert.equal(r!.memberKind, "method");
  assert.equal(r!.memberName, "createUser");
  assert.equal(r!.parameters, "user:User");
  assert.equal(r!.memberType, "Promise<void>");
  assert.equal(r!.isAsync, true);
});

test("parseClassExtendPrompt: 'add static helper(): string method to UtilClass'", () => {
  const r = parseClassExtendPrompt("add static helper(): string method to UtilClass");
  assert.ok(r);
  assert.equal(r!.className, "UtilClass");
  assert.equal(r!.memberKind, "method");
  assert.equal(r!.memberName, "helper");
  assert.equal(r!.isStatic, true);
});

test("parseClassExtendPrompt: 'add readonly id:string to UserService'", () => {
  const r = parseClassExtendPrompt("add readonly id:string to UserService");
  assert.ok(r);
  assert.equal(r!.memberKind, "field");
  assert.equal(r!.isReadonly, true);
});

test("parseClassExtendPrompt: 'extend UserService with method getUser()'", () => {
  const r = parseClassExtendPrompt("extend UserService with method getUser()");
  assert.ok(r);
  assert.equal(r!.className, "UserService");
  assert.equal(r!.memberKind, "method");
  assert.equal(r!.memberName, "getUser");
});

test("parseClassExtendPrompt: prompts without a class signal return null", () => {
  // No class/method/paren/modifier signals — should NOT route to class-extend.
  assert.equal(parseClassExtendPrompt("add email:string to User interface"), null);
  assert.equal(parseClassExtendPrompt("add field x to UserSchema"), null);
});

test("parseClassExtendPrompt: refuses prompts that explicitly say 'interface'", () => {
  assert.equal(parseClassExtendPrompt("add foo:string to ApiInterface interface"), null);
});

test("classifyTaskShape: 'add private logger:Logger to UserService' → class-extend", () => {
  const f = classifyTaskShape("add private logger:Logger to UserService");
  assert.equal(f.shape, "class-extend");
  assert.ok(f.classExtend);
});

test("classifyTaskShape: type-extend prompt is NOT routed to class-extend", () => {
  const f = classifyTaskShape("add email:string to User interface");
  assert.equal(f.shape, "type-extend");
});

// ─── tryAddClassField ──────────────────────────────────────────────

test("tryAddClassField: inserts before constructor with private + readonly", async () => {
  const src =
`export class UserService {
  constructor() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "UserService",
      fieldName: "logger",
      fieldType: "Logger",
      visibility: "private",
      isReadonly: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // private readonly logger: Logger; on its own line, before constructor
      assert.match(r.updatedContent, /private readonly logger: Logger;\s*\n\s*\n?\s*constructor/);
      // export still intact
      assert.ok(r.exportDiff.proposed.includes("UserService"));
      assert.equal(r.exportDiff.missing.length, 0);
    }
  } finally { t.cleanup(); }
});

test("tryAddClassField: inserts at end when class has no constructor / methods", async () => {
  const src = `class Empty {\n}\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "Empty", fieldName: "x", fieldType: "number",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /class Empty \{[\s\S]*x: number;[\s\S]*\}/);
    }
  } finally { t.cleanup(); }
});

test("tryAddClassField: inserts before method block when no constructor", async () => {
  const src =
`class UserService {
  getUser() {
    return null;
  }
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "UserService", fieldName: "id", fieldType: "string",
      visibility: "public",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // The new field appears BEFORE getUser
      const idIdx = r.updatedContent.indexOf("id: string");
      const getUserIdx = r.updatedContent.indexOf("getUser()");
      assert.ok(idIdx > 0 && idIdx < getUserIdx, "field should come before the first method");
    }
  } finally { t.cleanup(); }
});

test("tryAddClassField: refuses on duplicate field", async () => {
  const src = `class A { id: string; }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "A", fieldName: "id", fieldType: "number",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

test("tryAddClassField: refuses when class not found", async () => {
  const src = `class Other { x: number; }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "Missing", fieldName: "id", fieldType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "not-recognizable");
  } finally { t.cleanup(); }
});

test("tryAddClassField: refuses on multiple top-level classes with the same name", async () => {
  const src = `class A { id: string; }\nclass A { x: number; }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "A", fieldName: "y", fieldType: "string",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "ambiguous");
  } finally { t.cleanup(); }
});

test("tryAddClassField: APPLIES on decorated classes (parser handles decorator blocks)", async () => {
  // Decorated members are now supported. The parser identifies the
  // first method-like member and the new field is inserted ABOVE its
  // decorator block, preserving the decorator/member pairing.
  const src =
`class UserController {
  @Inject() service: UserService;

  @Get("/user")
  getUser() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "UserController", fieldName: "logger", fieldType: "Logger",
      visibility: "private",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // The new field lands ABOVE the @Get(...) decorator on getUser
      const loggerIdx = r.updatedContent.indexOf("private logger: Logger");
      const getDecoratorIdx = r.updatedContent.indexOf("@Get");
      assert.ok(loggerIdx > 0 && loggerIdx < getDecoratorIdx, "logger field should land before @Get decorator");
      // Existing decorators preserved
      assert.match(r.updatedContent, /@Inject\(\) service: UserService;/);
      assert.match(r.updatedContent, /@Get\("\/user"\)\s*\n\s*getUser/);
    }
  } finally { t.cleanup(); }
});

test("tryAddClassField: REFUSES on malformed decorator (unbalanced parens)", async () => {
  const src =
`class UserController {
  @Inject(
  service: UserService;

  getUser() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "UserController", fieldName: "logger", fieldType: "Logger",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("tryAddClassField: handles `class X<T extends Foo>` generics", async () => {
  const src =
`class Repo<T extends { id: string }> {
  constructor() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "Repo", fieldName: "size", fieldType: "number",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /size: number;\s*\n\s*\n?\s*constructor/);
    }
  } finally { t.cleanup(); }
});

test("tryAddClassField: optional + static + visibility", async () => {
  const src = `class C {\n  constructor() {}\n}\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "C", fieldName: "count", fieldType: "number",
      visibility: "protected", isStatic: true, optional: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /protected static count\?: number;/);
    }
  } finally { t.cleanup(); }
});

// ─── tryAddClassMethod ──────────────────────────────────────────────

test("tryAddClassMethod: appends async method with stub body before closing brace", async () => {
  const src =
`export class UserService {
  constructor() {}

  getUser() {
    return null;
  }
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "UserService",
      methodName: "createUser",
      parameters: "user: User",
      returnType: "Promise<void>",
      isAsync: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // Signature
      assert.match(
        r.updatedContent,
        /async createUser\(user: User\): Promise<void> \{/,
      );
      // Stub body
      assert.match(r.updatedContent, /\/\/ TODO: implement createUser/);
      // Method appears AFTER getUser (i.e. at end)
      const newIdx = r.updatedContent.indexOf("createUser(user: User)");
      const getUserIdx = r.updatedContent.indexOf("getUser()");
      assert.ok(newIdx > getUserIdx);
    }
  } finally { t.cleanup(); }
});

test("tryAddClassMethod: static method", async () => {
  const src =
`class UtilClass {
  doThing() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "UtilClass",
      methodName: "of",
      parameters: "value: string",
      returnType: "UtilClass",
      isStatic: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /static of\(value: string\): UtilClass \{/);
    }
  } finally { t.cleanup(); }
});

test("tryAddClassMethod: refuses on duplicate method name", async () => {
  const src = `class A { foo() {} }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "A", methodName: "foo",
      parameters: "", returnType: "void",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

test("tryAddClassMethod: refuses on classes with computed members", async () => {
  const src =
`class A {
  ["a" + "b"]() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "A", methodName: "doThing",
      parameters: "", returnType: "void",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("tryAddClassMethod: APPLIES on decorated classes (preserves decorator on existing method)", async () => {
  const src =
`class UserController {
  @Get()
  list() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "UserController", methodName: "create",
      parameters: "", returnType: "void",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // New method appended at end, existing decorator preserved.
      assert.match(r.updatedContent, /@Get\(\)\s*\n\s*list\(\)/);
      assert.match(r.updatedContent, /create\(\): void \{/);
    }
  } finally { t.cleanup(); }
});

test("tryAddClassMethod: REFUSES on malformed decorator", async () => {
  const src =
`class UserController {
  @Get(
  list() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "UserController", methodName: "create",
      parameters: "", returnType: "void",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("tryAddClassMethod: visibility prefix", async () => {
  const src = `class A { constructor() {} }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "A", methodName: "internalCheck",
      parameters: "", returnType: "boolean",
      visibility: "private",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /private internalCheck\(\): boolean \{/);
    }
  } finally { t.cleanup(); }
});

test("tryAddClassMethod: handles `class extends Base` correctly", async () => {
  const src =
`class Base {}
class Repo extends Base {
  constructor() { super(); }
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "Repo", methodName: "all",
      parameters: "", returnType: "string[]",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /all\(\): string\[\] \{/);
      // Base class untouched
      assert.match(r.updatedContent, /class Base \{\}/);
    }
  } finally { t.cleanup(); }
});

// ─── Disk-write contract ────────────────────────────────────────────

test("class-extend transforms do NOT write the file — caller does", async () => {
  const src = `class A {\n  constructor() {}\n}\n`;
  const t = tmpFile(src);
  try {
    await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "A", fieldName: "id", fieldType: "string",
    });
    const onDisk = readFileSync(t.abs, "utf-8");
    assert.equal(onDisk, src);
  } finally { t.cleanup(); }
});
