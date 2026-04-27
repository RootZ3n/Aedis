/**
 * Aedis Hard Burn-In Harness — 20 scenarios targeting critical paths
 * Run: npx tsx test-burn-in-hard.ts
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = "http://localhost:18796";
const RESULTS_FILE = "/mnt/ai/tmp/aedis-burn-in-hard.jsonl";
const TIMEOUT_MS = 720_000; // 8 minutes per scenario

const SCENARIOS = [
  // ── 1. BASIC CREATE ──────────────────────────────────────────────
  {
    id: "h01-create-small-file",
    description: "Create a new helper file",
    prompt:
      'Create a new file at src/utils/aedis-test-helper.ts containing a single exported function "helloAedis" that returns the string "hello from Aedis". Do not modify any other files.',
    repoPath: "/mnt/ai/aedis",
  },

  // ── 2. BASIC MODIFY ──────────────────────────────────────────────
  {
    id: "h02-modify-add-export",
    description: "Add an exported function to an existing file",
    prompt:
      "In core/run-summary.ts, add a new exported helper function 'getAedisVersion()' that returns the string '1.0.0'. Place it before the existing exports.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 3. BASIC DELETE ──────────────────────────────────────────────
  {
    id: "h03-delete-unused-export",
    description: "Delete a dead export",
    prompt:
      "Delete the function 'buildIntentGraph' from core/multi-file-planner.ts if it exists and is unused. If it is exported and used elsewhere, do nothing.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 4. MULTI-FILE (2 files) ──────────────────────────────────────
  {
    id: "h04-two-file-refactor",
    description: "Rename a function across two files",
    prompt:
      "Rename the exported function 'buildChangeSet' in core/change-set.ts to 'constructChangeSet'. Update every reference to it in core/change-set.ts and core/coordinator.ts.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 5. MULTI-FILE (3+ files) ─────────────────────────────────────
  {
    id: "h05-cross-file-rename",
    description: "Rename an exported symbol across multiple files",
    prompt:
      "Rename the type 'FileChange' to 'ArtifactChange' in core/change-set.ts. Update all imports and usages in core/change-set.ts, core/coordinator.ts, and core/run-summary.ts.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 6. TYPE-ERROR INJECTION ──────────────────────────────────────
  {
    id: "h06-inject-type-error",
    description: "Introduce a TypeScript error and verify it is caught",
    prompt:
      "In core/run-summary.ts, add this invalid line inside the runSummary function: const x: string = 123; // type error — intentionally wrong",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 7. FIX A REAL TYPE ERROR ─────────────────────────────────────
  {
    id: "h07-fix-real-type-error",
    description: "Fix an existing bug (prefer cleaner to hard)",
    prompt:
      "In core/intent.ts, the Deliverable type is missing a 'test' variant that the coordinator needs. Add 'test' to the Deliverable.type union. Then verify the fix compiles: run tsc --noEmit in /mnt/ai/aedis and confirm no new errors.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 8. TEST PAIR (source + test) ────────────────────────────────
  {
    id: "h08-source-plus-test",
    description: "Add feature with test coverage",
    prompt:
      "In core/run-summary.ts, add a new exported function 'formatVerdictBadge(status: string): string' that returns a formatted badge. Then add a corresponding test in core/run-summary.test.ts that verifies it works for 'pass' and 'fail' inputs.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 9. REFACTOR (improvement, no spec change) ────────────────────
  {
    id: "h09-refactor-comment-cleanup",
    description: "Improve code quality without behavior change",
    prompt:
      "In core/charter.ts, look for any TODO comments or placeholder comments (text containing 'TODO' or 'FIXME' or 'HACK') and replace each with a brief real description of what needs to be done.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 10. CONSTRAINT: DO NOT TOUCH ─────────────────────────────────
  {
    id: "h10-do-not-touch",
    description: "Respect exclusion constraints",
    prompt:
      "In core/charter.ts, add a trailing comment '// extra: Coordinated by Aedis' at the end of the file. Do NOT modify core/change-set.ts or core/run-summary.ts.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 11. AMBIGUOUS → SHOULD CLARIFY ──────────────────────────────
  {
    id: "h11-ambiguous-should-ask",
    description: "Vague request triggers clarify mode",
    prompt: "Clean up the config file.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 12. NO-OP RECOVERY ───────────────────────────────────────────
  {
    id: "h12-no-op-recovery",
    description: "Builder produces no-op, system recovers",
    prompt:
      "Add a trailing newline to the end of core/run-summary.ts if it does not already have one.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 13. LARGE FILE MODIFICATION ──────────────────────────────────
  {
    id: "h13-large-file-target",
    description: "Handle a large target file",
    prompt:
      "In core/coordinator.ts, add a comment '// Aedis burn-in test' on a new line before the 'export interface Deliverable' declaration.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 14. EXTERNAL REPO ────────────────────────────────────────────
  {
    id: "h14-external-repo",
    description: "Operate on a different repo",
    prompt:
      "In core/judge.ts in /mnt/ai/crucible, add a comment '// Coordinated by Aedis' above the DETERMINISTIC_JUDGE_METADATA constant.",
    repoPath: "/mnt/ai/crucible",
  },

  // ── 15. VERIFICATION: NO REGRESSION ─────────────────────────────
  {
    id: "h15-no-regression",
    description: "Verify existing code still passes typecheck",
    prompt:
      "Run TypeScript type check (tsc --noEmit) in /mnt/ai/aedis and confirm there are no new errors introduced by recent changes. Report the count of errors.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 16. CREATE + DELETE PAIR ─────────────────────────────────────
  {
    id: "h16-create-delete-pair",
    description: "Create a file then delete it in two steps",
    prompt:
      'Step 1: Create a new file src/utils/temp-aedis-file.ts containing export const TEMP = "temporary";\nStep 2: Delete that same file. Report what you did.',
    repoPath: "/mnt/ai/aedis",
  },

  // ── 17. SCOPE BLEED DETECTION ────────────────────────────────────
  {
    id: "h17-scope-bleed",
    description: "Verify only targeted files are modified",
    prompt:
      "In core/run-summary.ts, add a comment '// scope-bleed-test' at the end of the file. Do NOT modify any other files.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 18. BUILDER ERROR RECOVERY ──────────────────────────────────
  {
    id: "h18-builder-error-recovery",
    description: "System handles builder errors gracefully",
    prompt:
      "In core/nonexistent-file-xyz.ts, try to add a function. This file does not exist so you must create it.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 19. CROSS-FILE CONSISTENCY ───────────────────────────────────
  {
    id: "h19-cross-file-consistency",
    description: "Maintain consistency across multiple files",
    prompt:
      "In core/change-set.ts, find the MAX_PATH_LENGTH constant. In core/coordinator.ts, find if it uses MAX_PATH_LENGTH. If both exist and are consistent, add a comment '// cross-file consistency verified' in core/change-set.ts near that constant. If they are inconsistent, report it.",
    repoPath: "/mnt/ai/aedis",
  },

  // ── 20. STRESS: MANY SMALL CHANGES ──────────────────────────────
  {
    id: "h20-many-small-changes",
    description: "Handle many small changes across many files",
    prompt:
      "Make all of the following changes in a single run:\n1. Add '// burn-in' comment to src/index.ts\n2. Add '// burn-in' comment to server/index.ts\n3. Add '// burn-in' comment to core/run-summary.ts\n4. Add '// burn-in' comment to core/charter.ts",
    repoPath: "/mnt/ai/aedis",
  },
] as const;

// ─── Harness ─────────────────────────────────────────────────────────────────

interface ScenarioResult {
  scenarioId: string;
  description: string;
  status_: "PASS" | "FAIL" | "ERROR" | "TIMEOUT";
  status: string | null;
  runId: string | null;
  taskId: string | null;
  costUsd: number | null;
  filesChanged: number;
  errors: string[];
  failureCode: string | null;
  failureRootCause: string | null;
  durationMs: number;
}

async function submitTask(
  prompt: string,
  repoPath: string
): Promise<{ taskId: string; runId: string }> {
  const res = await fetch(`${TARGET}/tasks`, {
    method: "POST",
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, repoPath }),
  });
  const json = await res.json();
  return { taskId: json.task_id, runId: json.run_id };
}

async function pollRun(
  runId: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${TARGET}/api/runs/${runId}`);
    const json = await res.json();
    const status: string = json.status;
    if (status === "COMPLETE" || status === "EXECUTION_ERROR" || status === "INTERRUPTED") {
      return json;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return { status: "TIMEOUT", runId };
}

async function runScenario(
  scenario: (typeof SCENARIOS)[number]
): Promise<ScenarioResult> {
  const start = Date.now();
  const result: ScenarioResult = {
    scenarioId: scenario.id,
    description: scenario.description,
    status_: "ERROR",
    status: null,
    runId: null,
    taskId: null,
    costUsd: null,
    filesChanged: 0,
    errors: [],
    failureCode: null,
    failureRootCause: null,
    durationMs: 0,
  };

  try {
    const { taskId, runId } = await submitTask(scenario.prompt, scenario.repoPath);
    result.taskId = taskId;
    result.runId = runId;

    const run = await pollRun(runId, TIMEOUT_MS);
    result.status = run.status as string;
    result.costUsd = run.totalCostUsd ?? null;
    result.filesChanged = (run.filesChanged as unknown[] ?? []).length;

    const errors = (run.errors as { message: string }[] ?? []).map(
      (e) => e.message
    );
    result.errors = errors;

    if (run.status === "COMPLETE") {
      result.status_ = run.classification === "PASS" ? "PASS" : "FAIL";
      result.failureCode = (run.classification as string) ?? null;
    } else if (run.status === "EXECUTION_ERROR") {
      result.failureCode = (run.classification as string) ?? "EXECUTION_ERROR";
      result.failureRootCause = errors[0] ?? null;
      result.status_ = "FAIL";
    } else if (run.status === "TIMEOUT") {
      result.status_ = "TIMEOUT";
      result.failureCode = "timeout";
      result.failureRootCause = `Run timed out after ${TIMEOUT_MS}ms`;
    } else {
      result.status_ = "ERROR";
    }
  } catch (err: unknown) {
    result.errors.push(String(err));
    result.failureRootCause = String(err);
  }

  result.durationMs = Date.now() - start;
  return result;
}

async function main() {
  console.log(`🔥 AEDIS HARD BURN-IN — ${SCENARIOS.length} scenarios`);
  console.log(`Target: ${TARGET} | Results: ${RESULTS_FILE}\n`);

  // Quick health check
  const health = await fetch(`${TARGET}/health`).then((r) => r.json());
  if (!health.all_workers_available) {
    console.error("❌ Workers not available:", health);
    process.exit(1);
  }
  console.log("✅ Workers available\n");

  const results: ScenarioResult[] = [];

  for (const scenario of SCENARIOS) {
    process.stdout.write(
      `  [${SCENARIOS.indexOf(scenario) + 1}/${SCENARIOS.length}] ${scenario.id}... `
    );
    const result = await runScenario(scenario);
    results.push(result);

    const icon =
      result.status_ === "PASS"
        ? "✅"
        : result.status_ === "FAIL"
        ? "❌"
        : result.status_ === "TIMEOUT"
        ? "⏰"
        : "💥";
    const cost = result.costUsd != null ? ` \$${result.costUsd.toFixed(4)}` : "";
    console.log(
      `${icon} ${result.status_} | ${result.status ?? "?"} | ${result.filesChanged} files | ${result.durationMs}ms${cost}`
    );
    if (result.errors.length > 0) {
      console.log(`       ↳ ${result.errors[0].slice(0, 120)}`);
    }

    // Small delay between runs
    await new Promise((r) => setTimeout(r, 2000));
  }

  // ── Write results ────────────────────────────────────────────────
  const totalCost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const pass = results.filter((r) => r.status_ === "PASS").length;
  const fail = results.filter((r) => r.status_ === "FAIL").length;
  const error = results.filter((r) => r.status_ === "ERROR" || r.status_ === "TIMEOUT").length;

  writeFileSync(RESULTS_FILE, "");
  for (const r of results) {
    writeFileSync(RESULTS_FILE, JSON.stringify(r) + "\n", { flag: "a" });
  }

  console.log(`\n─────────────────────────────────────────────────────────────`);
  console.log(`🔥 BURN-IN DONE: ${SCENARIOS.length} scenarios | ${pass} pass | ${fail} fail | ${error} error | \$${totalCost.toFixed(4)} total`);
  console.log(`─────────────────────────────────────────────────────────────`);
  console.log(`Results: ${RESULTS_FILE}`);
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exit(1);
});
