import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBackendScaffold, planBackendScaffold } from "../core/code-transforms/index.js";

const BASE_CONTROLLER = `import { Controller, Get } from "@nestjs/common";
import { UserService } from "./user.service";

@Controller("/users")
export class UserController {
  constructor(private readonly userService: UserService) {}
}
`;

const BASE_SERVICE = `export class UserService {
}
`;

const BASE_DTO = `export interface CreateUserDto {
  name: string;
}
`;

interface Scenario {
  readonly id: "A" | "B" | "C" | "D" | "E";
  readonly prompt: string;
  readonly files: Record<string, string>;
  readonly targets: readonly string[];
  readonly expectApplied: boolean;
}

const scenarios: readonly Scenario[] = [
  {
    id: "A",
    prompt: "Add POST /users endpoint that calls UserService.createUser with CreateUserDto.",
    files: {
      "src/user.controller.ts": BASE_CONTROLLER,
      "src/user.service.ts": BASE_SERVICE,
      "src/create-user.dto.ts": BASE_DTO,
    },
    targets: ["src/user.controller.ts", "src/user.service.ts", "src/create-user.dto.ts"],
    expectApplied: true,
  },
  {
    id: "B",
    prompt: "Add GET /users endpoint that calls UserService.listUsers.",
    files: {
      "src/user.controller.ts": BASE_CONTROLLER,
      "src/user.service.ts": BASE_SERVICE,
    },
    targets: ["src/user.controller.ts", "src/user.service.ts"],
    expectApplied: true,
  },
  {
    id: "C",
    prompt: "Add GET /users endpoint that calls UserService.listUsers.",
    files: {
      "src/user.controller.ts": `import { Controller } from "@nestjs/common";\n\n@Controller("/users")\nexport class UserController {\n}\n`,
      "src/user.service.ts": BASE_SERVICE,
    },
    targets: ["src/user.controller.ts", "src/user.service.ts"],
    expectApplied: true,
  },
  {
    id: "D",
    prompt: "Add POST /users endpoint that calls UserService.createUser with CreateUserDto.",
    files: {
      "src/user.controller.ts": `import { Controller, Get, Post } from "@nestjs/common";
import { UserService } from "./user.service";

@Controller("/users")
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post("/users")
  async existing() {}
}
`,
      "src/user.service.ts": BASE_SERVICE,
      "src/create-user.dto.ts": BASE_DTO,
    },
    targets: ["src/user.controller.ts", "src/user.service.ts", "src/create-user.dto.ts"],
    expectApplied: false,
  },
  {
    id: "E",
    prompt: "Add POST /users endpoint that calls UserService.createUser with CreateUserDto.",
    files: {
      "src/user.controller.ts": BASE_CONTROLLER,
      "src/user.service.ts": BASE_SERVICE,
      "src/duplicate-user.service.ts": BASE_SERVICE,
      "src/create-user.dto.ts": BASE_DTO,
    },
    targets: ["src/user.controller.ts", "src/user.service.ts", "src/duplicate-user.service.ts", "src/create-user.dto.ts"],
    expectApplied: false,
  },
];

async function run(sc: Scenario): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "aedis-mf-validate-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    for (const [path, content] of Object.entries(sc.files)) {
      writeFileSync(join(dir, path), content, "utf-8");
    }
    const before = Object.fromEntries(sc.targets.filter((t) => sc.files[t]).map((t) => [t, readFileSync(join(dir, t), "utf-8")]));
    const t0 = Date.now();
    const plan = await planBackendScaffold({ projectRoot: dir, userRequest: sc.prompt, targetFiles: sc.targets });
    const result = await applyBackendScaffold({ projectRoot: dir, userRequest: sc.prompt, targetFiles: sc.targets });
    const durationMs = Date.now() - t0;
    const touched = result.kind === "applied" ? result.applied.map((a) => a.file) : [];
    const after = Object.fromEntries(sc.targets.filter((t) => sc.files[t]).map((t) => [t, readFileSync(join(dir, t), "utf-8")]));
    return {
      id: sc.id,
      prompt: sc.prompt,
      selectedFiles: sc.targets,
      scaffoldPlan: plan.ok ? plan.plan : null,
      planRefusal: plan.ok ? null : plan.skipped.reason,
      outcome: result.kind,
      transforms: result.kind === "applied" ? result.applied.map((a) => ({ file: a.file, type: a.transformType, summary: a.insertedSnippetSummary })) : [],
      skipped: result.kind === "skipped" ? result.skipped.map((s) => ({ file: s.file, code: s.reasonCode, reason: s.reason })) : result.skipped.map((s) => ({ file: s.file, code: s.reasonCode, reason: s.reason })),
      beforeAfterSnippet: summarizeDiff(before, after, touched.length ? touched : sc.targets),
      verifierResult: "n/a (deterministic fixture validation; tsc covered separately)",
      verdict: (sc.expectApplied && result.kind === "applied") || (!sc.expectApplied && result.kind === "skipped") ? "expected" : "unexpected",
      cost: 0,
      durationMs,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function summarizeDiff(before: Record<string, string>, after: Record<string, string>, files: readonly string[]): string {
  const parts: string[] = [];
  for (const file of [...new Set(files)]) {
    if (!(file in after)) continue;
    const b = before[file] ?? "";
    const a = after[file] ?? "";
    if (b === a) continue;
    parts.push(`${file}:\n${a.split("\n").slice(0, 18).join("\n")}`);
  }
  return parts.join("\n---\n") || "(no file mutation)";
}

async function main() {
  console.log("\n=== Multi-file scaffold deterministic validation ===\n");
  const reports: Record<string, unknown>[] = [];
  for (const sc of scenarios) {
    const r = await run(sc);
    reports.push(r);
    console.log(`--- ${sc.id} ----------------------------------------`);
    console.log(`prompt          : ${r.prompt}`);
    console.log(`selected files  : ${(r.selectedFiles as string[]).join(", ")}`);
    console.log(`scaffold plan   : ${JSON.stringify(r.scaffoldPlan ?? r.planRefusal)}`);
    console.log(`outcome         : ${r.outcome}`);
    console.log(`transforms      : ${JSON.stringify(r.transforms)}`);
    console.log(`skipped         : ${JSON.stringify(r.skipped)}`);
    console.log(`before/after    :\n${r.beforeAfterSnippet}`);
    console.log(`verifier        : ${r.verifierResult}`);
    console.log(`verdict         : ${r.verdict}`);
    console.log(`cost            : $0`);
    console.log(`duration        : ${r.durationMs}ms\n`);
  }
  const ok = reports.every((r) => r.verdict === "expected");
  console.log(`=== Summary ===  ${ok ? "ALL EXPECTATIONS MET" : "EXPECTATIONS FAILED"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
