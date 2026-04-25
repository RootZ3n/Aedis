/**
 * Unit tests for decorated-class support and the new
 * tryAddConstructorParamProperty transform.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tryAddClassField,
  tryAddClassMethod,
  tryAddConstructorParamProperty,
  tryAddDecoratedClassMethod,
  tryAddDecoratedClassField,
} from "./index.js";
import { parseClassExtendPrompt, classifyTaskShape } from "../task-shape.js";
import { parseClassBody, parseConstructorParams } from "./class-parser.js";

function tmpFile(content: string): { dir: string; file: string; abs: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aedis-decorated-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  const rel = "src/controllers.ts";
  const abs = join(dir, rel);
  writeFileSync(abs, content, "utf-8");
  return { dir, file: rel, abs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── Parser ────────────────────────────────────────────────────────

test("parseClassBody: identifies stacked decorators on a method", () => {
  const src = `class C {
  @Get("/x")
  @UseGuards(AuthGuard)
  getX() {}
}
`;
  const open = src.indexOf("{");
  const close = src.lastIndexOf("}");
  const result = parseClassBody(src, open, close);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].kind, "method");
  assert.equal(result.members[0].name, "getX");
  assert.equal(result.members[0].decoratorCount, 2);
  // start points at the first decorator (after the leading indent)
  assert.ok(src.slice(result.members[0].start).startsWith("@Get"));
});

test("parseClassBody: handles multi-line decorator with `{}` inside argument", () => {
  const src = `class C {
  @Get({
    path: "/x",
    middleware: [auth],
  })
  getX() {}
}
`;
  const open = src.indexOf("{");
  const close = src.lastIndexOf("}");
  const result = parseClassBody(src, open, close);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].kind, "method");
  // member.start MUST point at @Get, not somewhere in the decorator's arg.
  assert.ok(src.slice(result.members[0].start).startsWith("@Get({"));
});

test("parseClassBody: refuses computed member name", () => {
  const src = `class C {\n  ["foo"]() {}\n}\n`;
  const open = src.indexOf("{");
  const close = src.lastIndexOf("}");
  const result = parseClassBody(src, open, close);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "computed-member");
});

test("parseClassBody: refuses malformed decorator", () => {
  const src = `class C {\n  @Get(\n  getX() {}\n}\n`;
  const open = src.indexOf("{");
  const close = src.lastIndexOf("}");
  const result = parseClassBody(src, open, close);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "malformed-decorator");
});

test("parseConstructorParams: splits on top-level commas with parameter decorators", () => {
  const src = `(@Inject('TOKEN') private readonly thing: Thing, private other: Other,)`;
  const open = src.indexOf("(");
  const close = src.lastIndexOf(")");
  const params = parseConstructorParams(src, open, close);
  assert.ok(params);
  assert.equal(params!.length, 2);
  assert.equal(params![0].name, "thing");
  assert.equal(params![0].hasDecorators, true);
  assert.equal(params![1].name, "other");
  assert.equal(params![1].hasDecorators, false);
});

test("parseConstructorParams: handles types with generic angle brackets and commas", () => {
  const src = `(repo: Repository<User>, opts: { a: number, b: string })`;
  const open = src.indexOf("(");
  const close = src.lastIndexOf(")");
  const params = parseConstructorParams(src, open, close);
  assert.ok(params);
  assert.equal(params!.length, 2);
  assert.equal(params![0].name, "repo");
  assert.equal(params![1].name, "opts");
});

// ─── Decorated field insertion ─────────────────────────────────────

test("decorated field: insert above first decorated method, preserve all decorators", async () => {
  const src =
`class UserController {
  @Inject() service: UserService;

  @Get("/user")
  @UseGuards(AuthGuard)
  getUser() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "UserController",
      fieldName: "logger",
      fieldType: "Logger",
      visibility: "private",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // Decorator on existing field preserved
      assert.match(r.updatedContent, /@Inject\(\) service: UserService;/);
      // Decorator stack on getUser preserved AS A BLOCK
      assert.match(r.updatedContent, /@Get\("\/user"\)\s*\n\s*@UseGuards\(AuthGuard\)\s*\n\s*getUser\(\)/);
      // New field lands ABOVE the @Get decorator
      const loggerIdx = r.updatedContent.indexOf("private logger: Logger");
      const getDecoIdx = r.updatedContent.indexOf("@Get");
      assert.ok(loggerIdx < getDecoIdx);
    }
  } finally { t.cleanup(); }
});

test("decorated NestJS controller: field insertion preserves constructor indentation", async () => {
  const src =
`@Controller("/users")
export class UserController {
  @Inject() readonly service: UserService;

  constructor(
    private readonly repo: UserRepository,
  ) {}

  @Get("/user")
  getUser() {
    return null;
  }
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "UserController",
      fieldName: "logger",
      fieldType: "Logger",
      visibility: "private",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(
        r.updatedContent,
        /  private logger: Logger;\n\n  constructor\(\n    private readonly repo: UserRepository,/,
      );
      assert.match(r.updatedContent, /@Controller\("\/users"\)\nexport class UserController/);
      assert.match(r.updatedContent, /@Inject\(\) readonly service: UserService;/);
      assert.match(r.updatedContent, /  @Get\("\/user"\)\n  getUser\(\)/);
    }
  } finally { t.cleanup(); }
});

test("decorated field: multi-line decorator with `{}` is not split by insertion", async () => {
  const src =
`class UserController {
  @Get({
    path: "/user",
  })
  getUser() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "UserController",
      fieldName: "logger",
      fieldType: "Logger",
      visibility: "private",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // The @Get({...}) block remains intact and is followed by getUser
      assert.match(r.updatedContent, /@Get\(\{\s*\n\s*path: "\/user",\s*\n\s*\}\)\s*\n\s*getUser\(\)/);
      const loggerIdx = r.updatedContent.indexOf("private logger");
      const getIdx = r.updatedContent.indexOf("@Get");
      assert.ok(loggerIdx < getIdx);
    }
  } finally { t.cleanup(); }
});

// ─── Decorated method insertion ────────────────────────────────────

test("decorated method add: existing decorated members untouched", async () => {
  const src =
`class UserController {
  @Get("/user")
  @UseGuards(AuthGuard)
  getUser() {
    return null;
  }
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "UserController",
      methodName: "createUser",
      parameters: "user: User",
      returnType: "Promise<void>",
      isAsync: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // Existing decorator stack untouched
      assert.match(r.updatedContent, /@Get\("\/user"\)\s*\n\s*@UseGuards\(AuthGuard\)\s*\n\s*getUser\(\)/);
      // New method appended at end
      assert.match(r.updatedContent, /async createUser\(user: User\): Promise<void> \{/);
      const newIdx = r.updatedContent.indexOf("async createUser");
      const getIdx = r.updatedContent.indexOf("getUser()");
      assert.ok(newIdx > getIdx);
    }
  } finally { t.cleanup(); }
});

test("decorated NestJS service: add method to class decorator without moving decorators", async () => {
  const src =
`@Injectable()
export class UserService {
  @Inject() readonly repo: UserRepository;

  findAll() {
    return [];
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
      assert.match(r.updatedContent, /@Injectable\(\)\nexport class UserService/);
      assert.match(r.updatedContent, /  @Inject\(\) readonly repo: UserRepository;/);
      assert.match(r.updatedContent, /  async createUser\(user: User\): Promise<void> \{/);
    }
  } finally { t.cleanup(); }
});

test("decorated member add: add @Get(\"/users\") getUsers to controller and extend import", async () => {
  const src =
`import { Controller } from "@nestjs/common";

@Controller("/users")
export class UserController {
  @Get("/user")
  getUser() {
    return null;
  }
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddDecoratedClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "UserController",
      methodName: "getUsers",
      parameters: "",
      returnType: "",
      isAsync: true,
      decorator: { name: "Get", argument: "\"/users\"", importFrom: "@nestjs/common" },
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /import \{ Controller, Get \} from "@nestjs\/common";/);
      assert.match(r.updatedContent, /  @Get\("\/users"\)\n  async getUsers\(\) \{\n    \/\/ TODO: implement getUsers\n  \}/);
      assert.match(r.updatedContent, /  async getUsers\(\) \{\n    \/\/ TODO: implement getUsers\n  \}\n\}/);
      assert.match(r.updatedContent, /  @Get\("\/user"\)\n  getUser\(\)/);
    }
  } finally { t.cleanup(); }
});

test("decorated member add: add @Post(\"/users\") createUser and create import", async () => {
  const src =
`export class UserController {
  list() {
    return [];
  }
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddDecoratedClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "UserController",
      methodName: "createUser",
      parameters: "",
      returnType: "",
      isAsync: true,
      decorator: { name: "Post", argument: "\"/users\"", importFrom: "@nestjs/common" },
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /^import \{ Post \} from "@nestjs\/common";\n/);
      assert.match(r.updatedContent, /  @Post\("\/users"\)\n  async createUser\(\)/);
    }
  } finally { t.cleanup(); }
});

test("decorated member add: refuses duplicate method name", async () => {
  const src = `class UserController {\n  getUsers() {}\n}\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddDecoratedClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "UserController",
      methodName: "getUsers",
      parameters: "",
      returnType: "",
      decorator: { name: "Get", argument: "\"/users\"", importFrom: "@nestjs/common" },
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

test("decorated member add: refuses duplicate route decorator", async () => {
  const src = `class UserController {\n  @Get("/users")\n  list() {}\n}\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddDecoratedClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "UserController",
      methodName: "getUsers",
      parameters: "",
      returnType: "",
      decorator: { name: "Get", argument: "\"/users\"", importFrom: "@nestjs/common" },
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

test("decorated member add: refuses unsupported NestJS import shape", async () => {
  const src =
`import NestCommon from "@nestjs/common";

class UserController {
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddDecoratedClassMethod({
      projectRoot: t.dir, file: t.file,
      className: "UserController",
      methodName: "getUsers",
      parameters: "",
      returnType: "",
      decorator: { name: "Get", argument: "\"/users\"", importFrom: "@nestjs/common" },
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

test("decorated field add: add @Inject() private readonly logger", async () => {
  const src =
`import { Injectable } from "@nestjs/common";

@Injectable()
export class UserService {
  findAll() {
    return [];
  }
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddDecoratedClassField({
      projectRoot: t.dir, file: t.file,
      className: "UserService",
      fieldName: "logger",
      fieldType: "Logger",
      visibility: "private",
      isReadonly: true,
      decorator: { name: "Inject", argument: "", importFrom: "@nestjs/common" },
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /import \{ Injectable, Inject \} from "@nestjs\/common";/);
      assert.match(r.updatedContent, /  @Inject\(\)\n  private readonly logger: Logger;\n\n  findAll\(\)/);
    }
  } finally { t.cleanup(); }
});

test("task-shape: NestJS GET route prompt maps to decorated class method", () => {
  const f = classifyTaskShape("add NestJS GET route /models to ModelController");
  assert.equal(f.shape, "class-extend");
  assert.equal(f.classExtend?.memberKind, "method");
  assert.equal(f.classExtend?.memberName, "getModels");
  assert.equal(f.classExtend?.decorator?.name, "Get");
  assert.equal(f.classExtend?.decorator?.argument, "\"/models\"");
});

test("TypeORM entity: insert field without splitting decorated columns", async () => {
  const src =
`@Entity()
export class UserEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 120 })
  name: string;

  toJSON() {
    return { id: this.id, name: this.name };
  }
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "UserEntity",
      fieldName: "createdBy",
      fieldType: "string",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /@PrimaryGeneratedColumn\("uuid"\)\n  id: string;/);
      assert.match(r.updatedContent, /@Column\(\{ type: "varchar", length: 120 \}\)\n  name: string;/);
      assert.match(r.updatedContent, /  createdBy: string;\n\n  toJSON\(\)/);
    }
  } finally { t.cleanup(); }
});

// ─── Constructor parameter add ─────────────────────────────────────

test("tryAddConstructorParamProperty: append to multi-line param list with trailing comma", async () => {
  const src =
`class UserController {
  constructor(
    private readonly service: UserService,
  ) {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddConstructorParamProperty({
      projectRoot: t.dir, file: t.file,
      className: "UserController",
      paramName: "logger",
      paramType: "Logger",
      visibility: "private",
      isReadonly: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // Existing param + new param + closing paren on its own line
      assert.match(
        r.updatedContent,
        /constructor\(\s*\n\s*private readonly service: UserService,\s*\n\s*private readonly logger: Logger,\s*\n\s*\)/,
      );
    }
  } finally { t.cleanup(); }
});

test("tryAddConstructorParamProperty: append to single-line param list", async () => {
  const src = `class C { constructor(private a: number) {} }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddConstructorParamProperty({
      projectRoot: t.dir, file: t.file,
      className: "C",
      paramName: "logger",
      paramType: "Logger",
      visibility: "private",
      isReadonly: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(
        r.updatedContent,
        /constructor\(private a: number, private readonly logger: Logger\)/,
      );
    }
  } finally { t.cleanup(); }
});

test("tryAddConstructorParamProperty: empty param list", async () => {
  const src = `class C {\n  constructor() {}\n}\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddConstructorParamProperty({
      projectRoot: t.dir, file: t.file,
      className: "C",
      paramName: "logger",
      paramType: "Logger",
      visibility: "private",
      isReadonly: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /constructor\(private readonly logger: Logger\)/);
    }
  } finally { t.cleanup(); }
});

test("tryAddConstructorParamProperty: synthesizes constructor in decorated NestJS service", async () => {
  const src =
`@Injectable()
export class UserService {
  @Inject() readonly config: ConfigService;

  findAll() {
    return [];
  }
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddConstructorParamProperty({
      projectRoot: t.dir, file: t.file,
      className: "UserService",
      paramName: "logger",
      paramType: "Logger",
      visibility: "private",
      isReadonly: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /@Injectable\(\)\nexport class UserService/);
      assert.match(r.updatedContent, /  @Inject\(\) readonly config: ConfigService;/);
      assert.match(
        r.updatedContent,
        /  constructor\(private readonly logger: Logger\) \{\}\n\n  findAll\(\)/,
      );
    }
  } finally { t.cleanup(); }
});

test("tryAddConstructorParamProperty: synthesizes constructor after TypeORM decorated fields", async () => {
  const src =
`@Entity()
export class UserEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddConstructorParamProperty({
      projectRoot: t.dir, file: t.file,
      className: "UserEntity",
      paramName: "clock",
      paramType: "Clock",
      visibility: "private",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /@Column\(\)\n  name: string;/);
      assert.match(r.updatedContent, /  constructor\(private clock: Clock\) \{\}\n}/);
    }
  } finally { t.cleanup(); }
});

test("tryAddConstructorParamProperty: preserves existing parameter decorators", async () => {
  const src =
`class C {
  constructor(
    @Inject('TOKEN') private readonly thing: Thing,
  ) {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddConstructorParamProperty({
      projectRoot: t.dir, file: t.file,
      className: "C",
      paramName: "logger",
      paramType: "Logger",
      visibility: "private",
      isReadonly: true,
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      // @Inject('TOKEN') decorator on the existing param is intact
      assert.match(r.updatedContent, /@Inject\('TOKEN'\) private readonly thing: Thing,/);
      assert.match(r.updatedContent, /private readonly logger: Logger,/);
    }
  } finally { t.cleanup(); }
});

test("tryAddConstructorParamProperty: refuses on duplicate param name", async () => {
  const src = `class C { constructor(private logger: Logger) {} }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddConstructorParamProperty({
      projectRoot: t.dir, file: t.file,
      className: "C",
      paramName: "logger",
      paramType: "Logger",
      visibility: "private",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "duplicate");
  } finally { t.cleanup(); }
});

test("tryAddConstructorParamProperty: synthesizes constructor when class has no constructor", async () => {
  const src = `class C { x: number = 1; }\n`;
  const t = tmpFile(src);
  try {
    const r = await tryAddConstructorParamProperty({
      projectRoot: t.dir, file: t.file,
      className: "C",
      paramName: "logger",
      paramType: "Logger",
    });
    assert.equal(r.kind, "applied");
    if (r.kind === "applied") {
      assert.match(r.updatedContent, /x: number = 1;\s+constructor\(logger: Logger\) \{\}/);
    }
  } finally { t.cleanup(); }
});

test("tryAddConstructorParamProperty: refuses on malformed decorator in body", async () => {
  const src =
`class C {
  @Inject(
  service: UserService;

  constructor() {}
}
`;
  const t = tmpFile(src);
  try {
    const r = await tryAddConstructorParamProperty({
      projectRoot: t.dir, file: t.file,
      className: "C",
      paramName: "logger",
      paramType: "Logger",
    });
    assert.equal(r.kind, "skipped");
    if (r.kind === "skipped") assert.equal(r.reasonCode, "unsupported-shape");
  } finally { t.cleanup(); }
});

// ─── Prompt parser: constructor-param shapes ───────────────────────

test("parseClassExtendPrompt: 'add private readonly logger: Logger to constructor of UserController'", () => {
  const r = parseClassExtendPrompt(
    "add private readonly logger: Logger to constructor of UserController",
  );
  assert.ok(r);
  assert.equal(r!.memberKind, "constructor-param");
  assert.equal(r!.className, "UserController");
  assert.equal(r!.memberName, "logger");
  assert.equal(r!.memberType, "Logger");
  assert.equal(r!.visibility, "private");
  assert.equal(r!.isReadonly, true);
});

test("parseClassExtendPrompt: 'add logger:Logger in UserController constructor'", () => {
  const r = parseClassExtendPrompt("add logger:Logger in UserController constructor");
  assert.ok(r);
  assert.equal(r!.memberKind, "constructor-param");
  assert.equal(r!.className, "UserController");
  assert.equal(r!.memberName, "logger");
  assert.equal(r!.memberType, "Logger");
});

test("classifyTaskShape: constructor-param prompt routes to class-extend", () => {
  const f = classifyTaskShape("add private readonly logger: Logger to constructor of UserController");
  assert.equal(f.shape, "class-extend");
  assert.ok(f.classExtend);
  assert.equal(f.classExtend!.memberKind, "constructor-param");
});

// ─── Disk-write contract ───────────────────────────────────────────

test("decorated-class transforms do NOT write the file — caller does", async () => {
  const src =
`class C {
  @Get("/x") getX() {}
}
`;
  const t = tmpFile(src);
  try {
    await tryAddClassField({
      projectRoot: t.dir, file: t.file,
      className: "C", fieldName: "logger", fieldType: "Logger",
    });
    const onDisk = readFileSync(t.abs, "utf-8");
    assert.equal(onDisk, src);
  } finally { t.cleanup(); }
});
