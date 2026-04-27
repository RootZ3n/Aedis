/**
 * Aedis Hard Burn-In Harness — 20 scenarios targeting critical paths.
 *
 * Same polling + classification core as the soft suite (see
 * scripts/burn-in/harness.ts) — never auto-promotes, always cleans up
 * paused runs, records phase + status + failure summary in JSONL.
 *
 *   cd /mnt/ai/aedis && npx tsx scripts/burn-in/test-burn-in-hard.ts
 *   AEDIS_BURN_TIMEOUT_MS=1200000 npx tsx scripts/burn-in/test-burn-in-hard.ts
 *   npx tsx scripts/burn-in/test-burn-in-hard.ts --allow-promote
 */

import { writeFileSync } from "node:fs";

import {
  type BurnResultRow,
  computeSummary,
  createFetchClient,
  DEFAULT_BURN_TIMEOUT_MS,
  filterScenarios,
  formatSummaryBlock,
  resolveTimeoutMs,
  runScenarioOnce,
  safeStr,
} from "./harness.js";

const TARGET = process.env["AEDIS_BASE"] ?? "http://localhost:18796";
const RESULTS_FILE = "/mnt/ai/tmp/aedis-burn-in-hard.jsonl";
const TIMEOUT_MS = resolveTimeoutMs(process.env["AEDIS_BURN_TIMEOUT_MS"], DEFAULT_BURN_TIMEOUT_MS);

const SCENARIOS = [
  {
    id: "h01-create-small-file",
    description: "Create a new helper file",
    prompt:
      'Create a new file at src/utils/aedis-test-helper.ts containing a single exported function "helloAedis" that returns the string "hello from Aedis". Do not modify any other files.',
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h02-modify-add-export",
    description: "Add an exported function to an existing file",
    prompt:
      "In core/run-summary.ts, add a new exported helper function 'getAedisVersion()' that returns the string '1.0.0'. Place it before the existing exports.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h03-delete-unused-export",
    description: "Delete a dead export",
    prompt:
      "Delete the function 'buildIntentGraph' from core/multi-file-planner.ts if it exists and is unused. If it is exported and used elsewhere, do nothing.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h04-two-file-refactor",
    description: "Rename a function across two files",
    prompt:
      "Rename the exported function 'buildChangeSet' in core/change-set.ts to 'constructChangeSet'. Update every reference to it in core/change-set.ts and core/coordinator.ts.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h05-cross-file-rename",
    description: "Rename an exported symbol across multiple files",
    prompt:
      "Rename the type 'FileChange' to 'ArtifactChange' in core/change-set.ts. Update all imports and usages in core/change-set.ts, core/coordinator.ts, and core/run-summary.ts.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h06-inject-type-error",
    description: "Introduce a TypeScript error and verify it is caught",
    prompt:
      "In core/run-summary.ts, add this invalid line inside the runSummary function: const x: string = 123; // type error — intentionally wrong",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h07-fix-real-type-error",
    description: "Fix an existing bug (prefer cleaner to hard)",
    prompt:
      "In core/intent.ts, the Deliverable type is missing a 'test' variant that the coordinator needs. Add 'test' to the Deliverable.type union. Then verify the fix compiles: run tsc --noEmit in /mnt/ai/aedis and confirm no new errors.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h08-source-plus-test",
    description: "Add feature with test coverage",
    prompt:
      "In core/run-summary.ts, add a new exported function 'formatVerdictBadge(status: string): string' that returns a formatted badge. Then add a corresponding test in core/run-summary.test.ts that verifies it works for 'pass' and 'fail' inputs.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h09-refactor-comment-cleanup",
    description: "Improve code quality without behavior change",
    prompt:
      "In core/charter.ts, look for any TODO comments or placeholder comments (text containing 'TODO' or 'FIXME' or 'HACK') and replace each with a brief real description of what needs to be done.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h10-do-not-touch",
    description: "Respect exclusion constraints",
    prompt:
      "In core/charter.ts, add a trailing comment '// extra: Coordinated by Aedis' at the end of the file. Do NOT modify core/change-set.ts or core/run-summary.ts.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h11-ambiguous-should-ask",
    description: "Vague request triggers clarify mode",
    prompt: "Clean up the config file.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h12-no-op-recovery",
    description: "Builder produces no-op, system recovers",
    prompt:
      "Add a trailing newline to the end of core/run-summary.ts if it does not already have one.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h13-large-file-target",
    description: "Handle a large target file",
    prompt:
      "In core/coordinator.ts, add a comment '// Aedis burn-in test' on a new line before the 'export interface Deliverable' declaration.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h14-external-repo",
    description: "Operate on a different repo",
    prompt:
      "In core/judge.ts in /mnt/ai/crucible, add a comment '// Coordinated by Aedis' above the DETERMINISTIC_JUDGE_METADATA constant.",
    repoPath: "/mnt/ai/crucible",
  },
  {
    id: "h15-no-regression",
    description: "Verify existing code still passes typecheck",
    prompt:
      "Run TypeScript type check (tsc --noEmit) in /mnt/ai/aedis and confirm there are no new errors introduced by recent changes. Report the count of errors.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h16-create-delete-pair",
    description: "Create a file then delete it in two steps",
    prompt:
      'Step 1: Create a new file src/utils/temp-aedis-file.ts containing export const TEMP = "temporary";\nStep 2: Delete that same file. Report what you did.',
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h17-scope-bleed",
    description: "Verify only targeted files are modified",
    prompt:
      "In core/run-summary.ts, add a comment '// scope-bleed-test' at the end of the file. Do NOT modify any other files.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h18-builder-error-recovery",
    description: "System handles builder errors gracefully",
    prompt:
      "In core/nonexistent-file-xyz.ts, try to add a function. This file does not exist so you must create it.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h19-cross-file-consistency",
    description: "Maintain consistency across multiple files",
    prompt:
      "In core/change-set.ts, find the MAX_PATH_LENGTH constant. In core/coordinator.ts, find if it uses MAX_PATH_LENGTH. If both exist and are consistent, add a comment '// cross-file consistency verified' in core/change-set.ts near that constant. If they are inconsistent, report it.",
    repoPath: "/mnt/ai/aedis",
  },
  {
    id: "h20-many-small-changes",
    description: "Handle many small changes across many files",
    prompt:
      "Make all of the following changes in a single run:\n1. Add '// burn-in' comment to src/index.ts\n2. Add '// burn-in' comment to server/index.ts\n3. Add '// burn-in' comment to core/run-summary.ts\n4. Add '// burn-in' comment to core/charter.ts",
    repoPath: "/mnt/ai/aedis",
  },
] as const;

async function main(): Promise<void> {
  const allowPromote = process.argv.includes("--allow-promote");
  const activeScenarios = filterScenarios(SCENARIOS);

  console.log(`🔥 AEDIS HARD BURN-IN — ${activeScenarios.length} scenarios`);
  console.log(`Target:  ${TARGET}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms${process.env["AEDIS_BURN_TIMEOUT_MS"] ? " (env override)" : " (default)"}`);
  console.log(`Allow promote: ${allowPromote ? "yes" : "no"}`);
  console.log(`Results: ${RESULTS_FILE}\n`);

  const http = createFetchClient(TARGET);

  // Health check
  try {
    const res = await http.getJson<{ all_workers_available?: boolean; workers?: Record<string, unknown> }>(`/health`);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    if (res.body.all_workers_available === false) {
      console.error("❌ Workers not available:", JSON.stringify(res.body.workers ?? {}));
      process.exit(1);
    }
    console.log("✅ Workers available\n");
  } catch (err) {
    console.error(`❌ Cannot reach Aedis at ${TARGET}: ${(err as Error).message}`);
    process.exit(1);
  }

  // Truncate at start of run so the JSONL holds this run's results
  // exclusively (matches prior behaviour of the hard suite).
  writeFileSync(RESULTS_FILE, "", "utf-8");

  const results: BurnResultRow[] = [];
  for (let i = 0; i < activeScenarios.length; i++) {
    const s = activeScenarios[i];
    process.stdout.write(`  [${i + 1}/${activeScenarios.length}] ${s.id}... `);
    const r = await runScenarioOnce({
      http,
      scenarioId: s.id,
      prompt: s.prompt,
      repoPath: s.repoPath,
      timeoutMs: TIMEOUT_MS,
      onProgress: (line) => console.log(`\n     ${line}`),
      extraNotes: [s.description],
      allowPromote,
    });
    results.push(r);
    const cost = r.costUsd != null ? ` $${r.costUsd.toFixed(4)}` : "";
    const cleanup = r.cleanup === "none" ? "" : ` cleanup=${safeStr(r.cleanup)}(${r.cleanupOk ? "ok" : "fail"})`;
    console.log(
      `${safeStr(r.verdict)} | ${safeStr(r.status, "?")} | phase=${safeStr(r.phase)} | ${r.filesChanged ?? 0} files | ${r.durationMs ?? 0}ms${cost}${cleanup}`,
    );
    const errors = Array.isArray(r.errors) ? r.errors : [];
    if (errors.length > 0) console.log(`       ↳ ${safeStr(errors[0]).slice(0, 120)}`);
    writeFileSync(RESULTS_FILE, JSON.stringify(r) + "\n", { flag: "a" });
    await new Promise((res) => setTimeout(res, 2000));
  }

  const summary = computeSummary(results);
  console.log(formatSummaryBlock(summary));
  console.log(`Results: ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exit(1);
});
