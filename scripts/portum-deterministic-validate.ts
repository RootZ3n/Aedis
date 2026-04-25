/**
 * Live-shaped validation runner — drives the deterministic builder
 * pipeline against a disposable clone of /mnt/ai/portum and produces
 * the validation report Phase 5 asks for.
 *
 * Does NOT call any model. The Coordinator's deterministic pre-pass
 * is the entire decision layer; this script just feeds it three
 * route-add prompts and inspects what landed on disk.
 *
 * Usage:
 *   npx tsx scripts/portum-deterministic-validate.ts
 *
 * The source repo at /mnt/ai/portum is never written to.
 */

import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tryDeterministicBuilder } from "../core/code-transforms/deterministic-builder.js";
import { extractNamedExports } from "../workers/builder.js";

const SOURCE = "/mnt/ai/portum";

interface Scenario {
  readonly id: "A" | "B" | "C";
  readonly prompt: string;
  readonly targetFiles: readonly string[];
}

const scenarios: readonly Scenario[] = [
  { id: "A", prompt: "add a GET /healthz endpoint",                              targetFiles: ["src/server.ts"] },
  { id: "B", prompt: "add a GET /models endpoint that returns provider names",   targetFiles: ["src/server.ts"] },
  { id: "C", prompt: "add a POST /chat endpoint",                                targetFiles: ["src/server.ts", "src/router.ts"] },
];

function clonePortum(): string {
  const dest = mkdtempSync(join(tmpdir(), "portum-clone-"));
  // Copy via git clone --local --no-hardlinks so we get a real working
  // tree without touching the source.
  execFileSync("git", ["clone", "--local", "--no-hardlinks", "--quiet", SOURCE, dest], { stdio: "ignore" });
  return dest;
}

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`Source repo ${SOURCE} not present; aborting.`);
    process.exit(1);
  }
  console.log(`\n=== Portum deterministic validation ===`);
  console.log(`Source: ${SOURCE} (NEVER mutated)\n`);
  const reports: Record<string, unknown>[] = [];

  for (const sc of scenarios) {
    const clone = clonePortum();
    try {
      const exportsBefore: Record<string, string[]> = {};
      for (const f of sc.targetFiles) {
        const path = join(clone, f);
        if (existsSync(path)) {
          exportsBefore[f] = extractNamedExports(readFileSync(path, "utf-8"));
        }
      }
      const t0 = Date.now();
      const result = await tryDeterministicBuilder({
        projectRoot: clone,
        userRequest: sc.prompt,
        targetFiles: sc.targetFiles,
        generationId: `validate-${sc.id}`,
      });
      const duration = Date.now() - t0;

      const summary: Record<string, unknown> = {
        id: sc.id,
        prompt: sc.prompt,
        targetFiles: sc.targetFiles,
        outcome: result.kind,
        durationMs: duration,
        taskShape: result.taskShape.shape,
        httpVerbs: result.taskShape.httpVerbs,
        httpPaths: result.taskShape.httpPaths,
      };

      if (result.kind === "applied") {
        const applied = result.applied;
        summary.appliedFiles = applied.map((a) => a.file);
        summary.matchedPatterns = applied.map((a) => a.transform.matchedPattern);
        summary.insertedSummaries = applied.map((a) => a.transform.insertedSnippetSummary);
        summary.exportsBefore = exportsBefore;
        summary.exportsAfter = Object.fromEntries(
          applied.map((a) => [a.file, [...a.transform.exportDiff.proposed]]),
        );
        summary.missingExports = Object.fromEntries(
          applied.map((a) => [a.file, [...a.transform.exportDiff.missing]]),
        );
        summary.addedExports = Object.fromEntries(
          applied.map((a) => [a.file, [...a.transform.exportDiff.added]]),
        );
        summary.attemptCost = applied.reduce((s, a) => s + a.attemptRecord.estimatedCostUsd, 0);
        summary.skippedFiles = result.skipped.map((s) => ({ file: s.file, reason: s.reasonCode }));
        summary.verdict = "applied";
      } else {
        summary.skippedFiles = result.skipped.map((s) => ({ file: s.file, reason: s.reasonCode, detail: s.reason }));
        summary.fallbackReason = result.reason;
        summary.verdict = "skipped-falls-through-to-LLM";
      }
      reports.push(summary);

      // Print per-scenario report.
      console.log(`--- ${sc.id} ----------------------------------------`);
      console.log(`prompt          : ${sc.prompt}`);
      console.log(`targetFiles     : ${sc.targetFiles.join(", ")}`);
      console.log(`shape           : ${result.taskShape.shape} (${result.taskShape.httpVerbs.join("/")} ${result.taskShape.httpPaths.join(", ")})`);
      console.log(`outcome         : ${result.kind}`);
      if (result.kind === "applied") {
        for (const a of result.applied) {
          console.log(`  applied → ${a.file}`);
          console.log(`    pattern : ${a.transform.matchedPattern}`);
          console.log(`    snippet : ${a.transform.insertedSnippetSummary}`);
          console.log(`    notes   : ${a.transform.notes}`);
          console.log(`    exports before/after : ${a.transform.exportDiff.original.length} / ${a.transform.exportDiff.proposed.length}`);
          console.log(`    missing  : ${a.transform.exportDiff.missing.join(", ") || "(none)"}`);
          console.log(`    added    : ${a.transform.exportDiff.added.join(", ") || "(none)"}`);
        }
        for (const s of result.skipped) {
          console.log(`  skipped → ${s.file}: ${s.reasonCode} — ${s.reason}`);
        }
      } else {
        console.log(`  reason : ${result.reason}`);
        for (const s of result.skipped) {
          console.log(`    skipped target → ${s.file}: ${s.reasonCode} — ${s.reason}`);
        }
      }
      console.log(`duration        : ${duration}ms`);
      console.log(`cost            : $0 (deterministic — no model invoked)`);
      console.log("");

      // Verify source was not touched.
      const sourceServer = readFileSync(join(SOURCE, "src/server.ts"), "utf-8");
      const cloneServer = existsSync(join(clone, "src/server.ts"))
        ? readFileSync(join(clone, "src/server.ts"), "utf-8")
        : "";
      if (result.kind === "applied" && sc.targetFiles.includes("src/server.ts")) {
        if (sourceServer === cloneServer) {
          console.log(`SAFETY  : clone unchanged but transform reported applied — investigation needed`);
        }
      }
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  }

  console.log(`=== Summary ===`);
  console.log(JSON.stringify(reports, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
