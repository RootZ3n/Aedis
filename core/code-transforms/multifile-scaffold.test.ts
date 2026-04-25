import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBackendScaffold, planBackendScaffold } from "./index.js";

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "aedis-scaffold-"));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  return {
    dir,
    read: (path: string) => readFileSync(join(dir, path), "utf-8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const CONTROLLER_WITH_SERVICE =
`import { Controller, Get } from "@nestjs/common";
import { UserService } from "./user.service";

@Controller("/users")
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get("/users")
  async listUsers() {
    return this.userService.listUsers();
  }
}
`;

const SERVICE =
`export class UserService {
}
`;

const DTO = `export interface CreateUserDto {\n  name: string;\n}\n`;

test("planner: resolves controller, service, DTO, and service injection state", async () => {
  const r = repo({
    "src/user.controller.ts": CONTROLLER_WITH_SERVICE,
    "src/user.service.ts": SERVICE,
    "src/create-user.dto.ts": DTO,
  });
  try {
    const planned = await planBackendScaffold({
      projectRoot: r.dir,
      userRequest: "Add POST /users endpoint that calls UserService.createUser with CreateUserDto.",
      targetFiles: ["src/user.controller.ts", "src/user.service.ts", "src/create-user.dto.ts"],
    });
    assert.equal(planned.ok, true);
    if (planned.ok) {
      assert.equal(planned.plan.controllerClass, "UserController");
      assert.equal(planned.plan.serviceClass, "UserService");
      assert.equal(planned.plan.serviceProperty, "userService");
      assert.equal(planned.plan.serviceInjectionNeeded, false);
      assert.equal(planned.plan.dtoAction, "import-existing");
    }
  } finally { r.cleanup(); }
});

test("scaffold: controller + service method + DTO imports", async () => {
  const r = repo({
    "src/user.controller.ts": CONTROLLER_WITH_SERVICE,
    "src/user.service.ts": SERVICE,
    "src/create-user.dto.ts": DTO,
  });
  try {
    const result = await applyBackendScaffold({
      projectRoot: r.dir,
      userRequest: "Add POST /users endpoint that calls UserService.createUser with CreateUserDto.",
      targetFiles: ["src/user.controller.ts", "src/user.service.ts", "src/create-user.dto.ts"],
    });
    assert.equal(result.kind, "applied");
    const controller = r.read("src/user.controller.ts");
    const service = r.read("src/user.service.ts");
    assert.match(controller, /import \{ Controller, Get, Post, Body \} from "@nestjs\/common";/);
    assert.match(controller, /import \{ CreateUserDto \} from "\.\/create-user.dto";/);
    assert.match(controller, /@Post\("\/users"\)\n  async createUser\(@Body\(\) body: CreateUserDto\) \{\n    return this\.userService\.createUser\(body\);\n  \}/);
    assert.match(service, /import \{ CreateUserDto \} from "\.\/create-user.dto";/);
    assert.match(service, /async createUser\(dto: CreateUserDto\): Promise<unknown> \{\n    \/\/ TODO: implement createUser\n  \}/);
  } finally { r.cleanup(); }
});

test("scaffold: GET endpoint calls service without DTO body", async () => {
  const r = repo({
    "src/user.controller.ts": CONTROLLER_WITH_SERVICE.replace(/  @Get[\s\S]*?  }\n/, ""),
    "src/user.service.ts": SERVICE,
  });
  try {
    const result = await applyBackendScaffold({
      projectRoot: r.dir,
      userRequest: "Add GET /users endpoint that calls UserService.listUsers.",
      targetFiles: ["src/user.controller.ts", "src/user.service.ts"],
    });
    assert.equal(result.kind, "applied");
    assert.match(r.read("src/user.controller.ts"), /@Get\("\/users"\)\n  async listUsers\(\) \{\n    return this\.userService\.listUsers\(\);\n  \}/);
    assert.doesNotMatch(r.read("src/user.controller.ts"), /Body/);
  } finally { r.cleanup(); }
});

test("scaffold: adds constructor param-property and service import when injection is missing", async () => {
  const r = repo({
    "src/user.controller.ts":
`import { Controller } from "@nestjs/common";

@Controller("/users")
export class UserController {
}
`,
    "src/user.service.ts": SERVICE,
  });
  try {
    const result = await applyBackendScaffold({
      projectRoot: r.dir,
      userRequest: "Add GET /users endpoint that calls UserService.listUsers.",
      targetFiles: ["src/user.controller.ts", "src/user.service.ts"],
    });
    assert.equal(result.kind, "applied");
    const controller = r.read("src/user.controller.ts");
    assert.match(controller, /import \{ UserService \} from "\.\/user.service";/);
    assert.match(controller, /constructor\(private readonly userService: UserService\) \{\}/);
    assert.match(controller, /this\.userService\.listUsers\(\)/);
  } finally { r.cleanup(); }
});

test("scaffold: refuses duplicate route", async () => {
  const r = repo({
    "src/user.controller.ts": CONTROLLER_WITH_SERVICE,
    "src/user.service.ts": SERVICE,
  });
  try {
    const result = await applyBackendScaffold({
      projectRoot: r.dir,
      userRequest: "Add GET /users endpoint that calls UserService.listUsers.",
      targetFiles: ["src/user.controller.ts", "src/user.service.ts"],
    });
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") assert.equal(result.skipped.at(-1)?.reasonCode, "duplicate");
  } finally { r.cleanup(); }
});

test("scaffold: refuses duplicate service method and rolls back controller write", async () => {
  const r = repo({
    "src/user.controller.ts": CONTROLLER_WITH_SERVICE.replace(/  @Get[\s\S]*?  }\n/, ""),
    "src/user.service.ts": `export class UserService {\n  async listUsers() { return []; }\n}\n`,
  });
  const before = r.read("src/user.controller.ts");
  try {
    const result = await applyBackendScaffold({
      projectRoot: r.dir,
      userRequest: "Add GET /users endpoint that calls UserService.listUsers.",
      targetFiles: ["src/user.controller.ts", "src/user.service.ts"],
    });
    assert.equal(result.kind, "skipped");
    assert.equal(r.read("src/user.controller.ts"), before);
  } finally { r.cleanup(); }
});

test("scaffold: refuses ambiguous service", async () => {
  const r = repo({
    "src/user.controller.ts": CONTROLLER_WITH_SERVICE,
    "src/user.service.ts": SERVICE,
    "src/other-user.service.ts": SERVICE,
  });
  try {
    const result = await applyBackendScaffold({
      projectRoot: r.dir,
      userRequest: "Add POST /users endpoint that calls UserService.createUser with CreateUserDto.",
      targetFiles: ["src/user.controller.ts", "src/user.service.ts", "src/other-user.service.ts"],
    });
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") assert.equal(result.skipped[0].reasonCode, "ambiguous");
  } finally { r.cleanup(); }
});

test("scaffold: refuses unsupported NestJS import shape", async () => {
  const r = repo({
    "src/user.controller.ts":
`import NestCommon from "@nestjs/common";
import { UserService } from "./user.service";

export class UserController {
  constructor(private readonly userService: UserService) {}
}
`,
    "src/user.service.ts": SERVICE,
  });
  try {
    const result = await applyBackendScaffold({
      projectRoot: r.dir,
      userRequest: "Add GET /users endpoint that calls UserService.listUsers.",
      targetFiles: ["src/user.controller.ts", "src/user.service.ts"],
    });
    assert.equal(result.kind, "skipped");
    if (result.kind === "skipped") assert.equal(result.skipped.at(-1)?.reasonCode, "unsupported-shape");
  } finally { r.cleanup(); }
});
