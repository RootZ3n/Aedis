/**
 * Live-shaped validation runner for the type-extend deterministic
 * path. Builds a small fixture repo (Portum has no exported types
 * we can reliably extend without breaking its build, so we use an
 * in-tree fixture), then drives the deterministic builder facade
 * with the four scenarios A/B/C/D from the task brief.
 *
 * No model calls. Every applied/skipped result is reported.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryDeterministicBuilder } from "../core/code-transforms/deterministic-builder.js";

const FIXTURE = `// Aedis type-extend fixture
import { z } from "zod";

export interface User {
  id: string;
}

export type ApiResponse = {
  status: string;
};

export const FeatureFlagSchema = z.object({
  name: z.string(),
});

// A chained schema should be REFUSED by the deterministic layer.
export const StrictSchema = z.object({
  id: z.string(),
}).strict();
`;

interface Scenario {
  readonly id: "A" | "B" | "C" | "D";
  readonly prompt: string;
  readonly expectApplied: boolean;
}

const scenarios: readonly Scenario[] = [
  { id: "A", prompt: "add email:string to User interface in src/types.ts",                            expectApplied: true },
  { id: "B", prompt: "add optional metadata?:Record<string,string> to ApiResponse type in src/types.ts", expectApplied: true },
  { id: "C", prompt: "add enabled:boolean to FeatureFlagSchema in src/types.ts",                       expectApplied: true },
  { id: "D", prompt: "add enabled:boolean to StrictSchema in src/types.ts",                            expectApplied: false },
];

async function runScenario(sc: Scenario): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "aedis-type-validate-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/types.ts"), FIXTURE, "utf-8");
    const before = readFileSync(join(dir, "src/types.ts"), "utf-8");

    const t0 = Date.now();
    const result = await tryDeterministicBuilder({
      projectRoot: dir,
      userRequest: sc.prompt,
      targetFiles: ["src/types.ts"],
      generationId: `validate-${sc.id}`,
    });
    const duration = Date.now() - t0;
    const after = readFileSync(join(dir, "src/types.ts"), "utf-8");

    const summary: Record<string, unknown> = {
      id: sc.id,
      prompt: sc.prompt,
      shape: result.taskShape.shape,
      typeExtend: result.taskShape.typeExtend ?? null,
      outcome: result.kind,
      durationMs: duration,
      cost: 0,
      verifierResult: "n/a (no model invoked)",
    };

    if (result.kind === "applied") {
      const applied = result.applied[0];
      summary.transformType = applied.transform.transformType;
      summary.matchedSymbol = applied.transform.matchedPattern;
      summary.insertedSnippet = applied.transform.insertedSnippetSummary;
      summary.exportsBefore = applied.transform.exportDiff.original;
      summary.exportsAfter = applied.transform.exportDiff.proposed;
      summary.workspaceMutated = before !== after;
      summary.diffPreview = applied.transform.diff
        .split("\n")
        .filter((l) => l.startsWith("+") || l.startsWith("-"))
        .slice(0, 10)
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
  console.log(`\n=== Type-extend deterministic validation ===\n`);
  const reports: Record<string, unknown>[] = [];
  for (const sc of scenarios) {
    const r = await runScenario(sc);
    reports.push(r);
    console.log(`--- ${sc.id} ----------------------------------------`);
    console.log(`prompt          : ${sc.prompt}`);
    console.log(`shape           : ${r.shape}`);
    if (r.typeExtend) {
      const td = r.typeExtend as { symbol: string; property: string; propertyType: string; optional: boolean; readonly: boolean; kindHint: string };
      console.log(`parsed          : ${td.symbol}.${td.readonly ? "readonly " : ""}${td.property}${td.optional ? "?" : ""}: ${td.propertyType} (hint=${td.kindHint})`);
    }
    console.log(`outcome         : ${r.outcome}`);
    if (r.outcome === "applied") {
      console.log(`transformType   : ${r.transformType}`);
      console.log(`matchedSymbol   : ${r.matchedSymbol}`);
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
