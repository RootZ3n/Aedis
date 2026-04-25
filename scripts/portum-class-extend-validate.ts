/**
 * Live-shaped validation for the class-extend deterministic path.
 * Drives the deterministic builder against an in-tree fixture for
 * the four scenarios A/B/C/D from the brief.
 *
 * No model calls. Each scenario reports prompt, selected file,
 * matched class, transform attempted, before/after snippet, verdict,
 * cost, duration.
 */

import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryDeterministicBuilder } from "../core/code-transforms/deterministic-builder.js";
import { extractNamedExports } from "../workers/builder.js";

const FIXTURE = `// Aedis class-extend fixture
export class UserService {
  constructor() {}

  getUser() {
    return null;
  }
}

export class UtilClass {
  doThing() {}
}

// A class with member decorators — deterministic now supports safe insertion.
export class DecoratedController {
  @Inject() service: UserService;

  @Get()
  list() {}
}
`;

interface Scenario {
  readonly id: "A" | "B" | "C" | "D";
  readonly prompt: string;
  readonly expectApplied: boolean;
}

const scenarios: readonly Scenario[] = [
  { id: "A", prompt: "add private logger:Logger to UserService in src/services.ts",                              expectApplied: true },
  { id: "B", prompt: "add async createUser(user:User):Promise<void> method to UserService in src/services.ts",   expectApplied: true },
  { id: "C", prompt: "add static of(value:string):UtilClass method to UtilClass in src/services.ts",             expectApplied: true },
  { id: "D", prompt: "add private logger:Logger to DecoratedController in src/services.ts",                       expectApplied: true },
];

async function runScenario(sc: Scenario): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "aedis-class-validate-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/services.ts"), FIXTURE, "utf-8");
    const before = readFileSync(join(dir, "src/services.ts"), "utf-8");
    const exportsBefore = extractNamedExports(before);

    const t0 = Date.now();
    const result = await tryDeterministicBuilder({
      projectRoot: dir,
      userRequest: sc.prompt,
      targetFiles: ["src/services.ts"],
      generationId: `validate-${sc.id}`,
    });
    const duration = Date.now() - t0;
    const after = readFileSync(join(dir, "src/services.ts"), "utf-8");
    const exportsAfter = extractNamedExports(after);

    const summary: Record<string, unknown> = {
      id: sc.id,
      prompt: sc.prompt,
      shape: result.taskShape.shape,
      classExtend: result.taskShape.classExtend ?? null,
      outcome: result.kind,
      durationMs: duration,
      cost: 0,
      verifierResult: "n/a (no model invoked)",
      exportsBefore,
      exportsAfter,
    };

    if (result.kind === "applied") {
      const applied = result.applied[0];
      summary.transformType = applied.transform.transformType;
      summary.matchedClass = applied.transform.matchedPattern;
      summary.insertedSnippet = applied.transform.insertedSnippetSummary;
      summary.workspaceMutated = before !== after;
      summary.diffPreview = applied.transform.diff
        .split("\n")
        .filter((l) => l.startsWith("+") || l.startsWith("-"))
        .slice(0, 12)
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
  console.log(`\n=== Class-extend deterministic validation ===\n`);
  const reports: Record<string, unknown>[] = [];
  for (const sc of scenarios) {
    const r = await runScenario(sc);
    reports.push(r);
    console.log(`--- ${sc.id} ----------------------------------------`);
    console.log(`prompt          : ${sc.prompt}`);
    console.log(`shape           : ${r.shape}`);
    if (r.classExtend) {
      const cd = r.classExtend as { className: string; memberKind: string; memberName: string; memberType: string; parameters: string; visibility: string | undefined; isStatic: boolean; isReadonly: boolean; isAsync: boolean };
      console.log(
        `parsed          : ${cd.className}.${[cd.visibility, cd.isStatic ? "static" : null, cd.isAsync ? "async" : null, cd.isReadonly ? "readonly" : null].filter(Boolean).join(" ")} ${cd.memberKind} ${cd.memberName}` +
        (cd.memberKind === "method" ? `(${cd.parameters})${cd.memberType ? ": " + cd.memberType : ""}` : `: ${cd.memberType}`),
      );
    }
    console.log(`outcome         : ${r.outcome}`);
    if (r.outcome === "applied") {
      console.log(`transformType   : ${r.transformType}`);
      console.log(`matchedClass    : ${r.matchedClass}`);
      console.log(`inserted        : ${r.insertedSnippet}`);
      console.log(`exports before  : ${JSON.stringify(r.exportsBefore)}`);
      console.log(`exports after   : ${JSON.stringify(r.exportsAfter)}`);
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
