/**
 * Live-shaped validation for decorated-member deterministic transforms.
 * Runs the four scenarios A/B/C/D from the brief against an in-tree
 * NestJS-shaped fixture using disposable copies.
 *
 * No model calls. Each scenario reports prompt, target file, transform
 * type, matched class/member/constructor, before/after snippet,
 * verdict, cost, duration.
 */

import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryDeterministicBuilder } from "../core/code-transforms/deterministic-builder.js";

const FIXTURE = `// Aedis decorated-member fixture (NestJS-style)
import { Controller, Get, Injectable } from "@nestjs/common";

@Controller("/users")
export class UserController {
  @Inject() readonly service: UserService;

  constructor(
    private readonly repo: UserRepository,
  ) {}

  @Get("/user")
  @UseGuards(AuthGuard)
  getUser() {
    return null;
  }
}

@Injectable()
export class UserService {
  findAll() {
    return [];
  }
}

// Malformed decorator: unbalanced parens — deterministic must REFUSE.
export class BrokenController {
  @Inject(
  service: UserService;

  doStuff() {}
}
`;

interface Scenario {
  readonly id: "A" | "B" | "C" | "D";
  readonly prompt: string;
  readonly expectApplied: boolean;
}

const scenarios: readonly Scenario[] = [
  {
    id: "A",
    prompt: "add GET /users method getUsers to UserController in src/controllers.ts",
    expectApplied: true,
  },
  {
    id: "B",
    prompt: "add POST /users method createUser to UserController in src/controllers.ts",
    expectApplied: true,
  },
  {
    id: "C",
    prompt: "add @Inject() private readonly logger: Logger to UserService in src/controllers.ts",
    expectApplied: true,
  },
  {
    id: "D",
    prompt: "add GET /user method duplicateUser to UserController in src/controllers.ts",
    expectApplied: false,
  },
];

async function runScenario(sc: Scenario): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "aedis-deco-validate-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/controllers.ts"), FIXTURE, "utf-8");
    const before = readFileSync(join(dir, "src/controllers.ts"), "utf-8");

    const t0 = Date.now();
    const result = await tryDeterministicBuilder({
      projectRoot: dir,
      userRequest: sc.prompt,
      targetFiles: ["src/controllers.ts"],
      generationId: `validate-${sc.id}`,
    });
    const duration = Date.now() - t0;
    const after = readFileSync(join(dir, "src/controllers.ts"), "utf-8");

    const summary: Record<string, unknown> = {
      id: sc.id,
      prompt: sc.prompt,
      shape: result.taskShape.shape,
      classExtend: result.taskShape.classExtend ?? null,
      outcome: result.kind,
      durationMs: duration,
      cost: 0,
      verifierResult: "n/a (no model invoked)",
    };

    if (result.kind === "applied") {
      const applied = result.applied[0];
      summary.transformType = applied.transform.transformType;
      summary.matchedClass = applied.transform.matchedPattern;
      summary.insertedSnippet = applied.transform.insertedSnippetSummary;
      summary.importChanged = /import \{ Controller, Get, Injectable, Post \} from "@nestjs\/common";/.test(after) ||
        /import \{ Controller, Get, Injectable, Inject \} from "@nestjs\/common";/.test(after);
      summary.workspaceMutated = before !== after;
      summary.diffPreview = applied.transform.diff
        .split("\n")
        .filter((l) => l.startsWith("+") || l.startsWith("-"))
        .slice(0, 14)
        .join("\n");
      summary.verdict = "applied";
    } else {
      summary.fallbackReason = result.reason;
      summary.skipped = result.skipped.map((s) => ({
        file: s.file, code: s.reasonCode, reason: s.reason,
      }));
      summary.workspaceMutated = before !== after;
      summary.verdict = "skipped — falls through to LLM Builder";
    }
    summary.expectationMet =
      (sc.expectApplied && result.kind === "applied") ||
      (!sc.expectApplied && result.kind === "skipped");
    return summary;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`\n=== Decorated-class deterministic validation ===\n`);
  const reports: Record<string, unknown>[] = [];
  for (const sc of scenarios) {
    const r = await runScenario(sc);
    reports.push(r);
    console.log(`--- ${sc.id} ----------------------------------------`);
    console.log(`prompt          : ${sc.prompt}`);
    console.log(`shape           : ${r.shape}`);
    if (r.classExtend) {
      const cd = r.classExtend as { className: string; memberKind: string; memberName: string; memberType: string; parameters: string; visibility: string | undefined; isStatic: boolean; isReadonly: boolean; isAsync: boolean };
      const mods = [cd.visibility, cd.isStatic ? "static" : null, cd.isAsync ? "async" : null, cd.isReadonly ? "readonly" : null].filter(Boolean).join(" ");
      console.log(
        `parsed          : ${cd.className}.${cd.memberKind} "${cd.memberName}"` +
        (cd.memberKind === "method" ? `(${cd.parameters})${cd.memberType ? ": " + cd.memberType : ""}` : `: ${cd.memberType}`) +
        (mods ? `  [${mods}]` : ""),
      );
    }
    console.log(`outcome         : ${r.outcome}`);
    if (r.outcome === "applied") {
      console.log(`transformType   : ${r.transformType}`);
      console.log(`matchedClass    : ${r.matchedClass}`);
      console.log(`inserted        : ${r.insertedSnippet}`);
      console.log(`import changed  : ${r.importChanged}`);
      console.log(`workspace mut.  : ${r.workspaceMutated}`);
      console.log(`diff (preview)  :`);
      console.log(r.diffPreview);
    } else {
      console.log(`fallbackReason  : ${r.fallbackReason}`);
      for (const s of (r.skipped as Array<{ file: string; code: string; reason: string }>)) {
        console.log(`  skipped target → ${s.file}: ${s.code} — ${s.reason}`);
      }
    }
    console.log(`duration        : ${r.durationMs}ms`);
    console.log(`cost            : $0 (deterministic — no model invoked)`);
    console.log(`expectation met : ${r.expectationMet}`);
    console.log("");
  }
  const allMet = reports.every((r) => r.expectationMet);
  console.log(`=== Summary ===  ${allMet ? "ALL EXPECTATIONS MET" : "EXPECTATIONS FAILED"}`);
  process.exit(allMet ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
