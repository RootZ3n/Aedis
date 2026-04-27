/**
 * Aedis Burn-In Harness — soft suite.
 *
 * Submits each scenario, polls the canonical run state machine, and
 * appends a normalised JSONL row per scenario. Never auto-approves
 * — runs that reach AWAITING_APPROVAL get rejected so source stays
 * untouched.
 *
 *   cd /mnt/ai/aedis && npx tsx scripts/burn-in/test-burn-in.ts
 *   AEDIS_BASE=http://localhost:18796 npx tsx scripts/burn-in/test-burn-in.ts
 *   AEDIS_BURN_TIMEOUT_MS=600000 npx tsx scripts/burn-in/test-burn-in.ts
 *
 * Each row is appended to /mnt/ai/tmp/aedis-burn-in-results.jsonl
 * Run with --summary to print accumulated results without re-running.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";

import {
  type BurnResultRow,
  createFetchClient,
  DEFAULT_BURN_TIMEOUT_MS,
  filterScenarios,
  resolveTimeoutMs,
  runScenarioOnce,
} from "./harness.js";

const AEDIS_BASE = process.env["AEDIS_BASE"] ?? "http://localhost:18796";
const RESULTS_FILE = "/mnt/ai/tmp/aedis-burn-in-results.jsonl";
const PROJECT_ROOT = "/mnt/ai/aedis";
const TIMEOUT_MS = resolveTimeoutMs(process.env["AEDIS_BURN_TIMEOUT_MS"], DEFAULT_BURN_TIMEOUT_MS);

interface Scenario {
  id: string;
  prompt: string;
  repo?: string;
  expected: {
    classification?: string[];
    shouldAsk?: boolean;
    minFilesChanged?: number;
    maxCostUsd?: number;
  };
}

const SCENARIOS: Scenario[] = [
  // ── 1. Tiny single-line comment swap ─────────────────────────────────
  {
    id: "burn-in-01-comment-swap-tiny",
    // Kept deliberately small so the first scenario doesn't
    // accidentally exercise multi-wave behaviour. One file, one
    // comment, no neighbours.
    prompt:
      "In core/run-summary.ts, find the existing top-of-file comment block. At the very end of that block, add a single new comment line that reads exactly: '// burn-in: comment-swap probe.' Do not modify anything else.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "NO_OP", "EXECUTION_ERROR"],
      minFilesChanged: 1,
      maxCostUsd: 0.10,
    },
  },

  // ── 2. Two-file refactor (rename within one function) ───────────────
  {
    id: "burn-in-02-two-file-refactor",
    prompt:
      "In core/change-set.ts, rename the variable 'mutationEx' to 'expectedMutation' throughout the getMutationExpected function. Keep the edit minimal.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "NO_OP", "EXECUTION_ERROR"],
      minFilesChanged: 1,
      maxCostUsd: 0.25,
    },
  },

  // ── 3. Multi-step 4–6 file improvement ──────────────────────────────
  {
    id: "burn-in-03-multi-file-improvement",
    prompt:
      "Improve error messaging across the core directory: (1) Add a helpful comment to the ErrorResult type in core/types.ts explaining what each field is for. (2) In core/coordinator.ts, improve the error message for when the builder produces no output. (3) In core/builder-tier-routing.ts, add a one-line comment above the tier selection logic. Keep edits minimal and focused on comments/messaging only.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "NO_OP", "EXECUTION_ERROR"],
      minFilesChanged: 2,
      maxCostUsd: 0.40,
    },
  },

  // ── 4. Ambiguous prompt — should ask, not guess ─────────────────────
  {
    id: "burn-in-04-ambiguous-should-ask",
    prompt: "Clean up the config handling.",
    expected: {
      classification: ["AMBIGUOUS_PROMPT", "BLOCKED", "INTERRUPTED"],
      shouldAsk: true,
      maxCostUsd: 0.05,
    },
  },

  // ── 5. Explicit "do not touch X" constraint ─────────────────────────
  {
    id: "burn-in-05-do-not-touch",
    prompt:
      "In core/charter.ts, add a one-line comment above the CharterGenerator class: '// Coordinates Charter creation from user intent.' Do NOT touch any other file.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "NO_OP", "EXECUTION_ERROR"],
      minFilesChanged: 1,
      maxCostUsd: 0.10,
    },
  },

  // ── 6. Builder timeout / no-op recovery ──────────────────────────────
  {
    id: "burn-in-06-no-op-recovery",
    prompt:
      "Add a trailing newline to the end of core/run-summary.ts if it doesn't already have one.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "NO_OP", "EXECUTION_ERROR"],
      maxCostUsd: 0.08,
    },
  },

  // ── 7. Explicit source+test changes ──────────────────────────────────
  {
    id: "burn-in-07-source-plus-test",
    prompt:
      "In core/run-summary.ts, add a new exportable helper function 'formatVerdictBadge' that takes a string verdict ('SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED') and returns a string badge ('✅ SUCCESS', '⚠️ PARTIAL_SUCCESS', '❌ FAILED'). Add one focused test in core/run-summary.test.ts that exercises this function with all three inputs.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "NO_OP", "EXECUTION_ERROR"],
      minFilesChanged: 2,
      maxCostUsd: 0.30,
    },
  },

  // ── 8. External repo (Crucible) ─────────────────────────────────────
  {
    id: "burn-in-08-external-repo",
    repo: "/mnt/ai/crucible",
    prompt:
      "In core/judge.ts, add a one-line comment above the DETERMINISTIC_JUDGE_METADATA constant explaining what it represents.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "NO_OP", "EXECUTION_ERROR"],
      minFilesChanged: 1,
      maxCostUsd: 0.15,
    },
  },
];

function logResult(result: BurnResultRow): void {
  appendFileSync(RESULTS_FILE, JSON.stringify(result) + "\n", "utf-8");
  const cost = result.costUsd?.toFixed(4) ?? "?.????";
  const cleanup = result.cleanup === "none" ? "" : ` cleanup=${result.cleanup}(${result.cleanupOk ? "ok" : "fail"})`;
  console.log(
    `  → [${result.verdict}] ${result.scenarioId} | status=${result.status ?? "?"} phase=${result.phase ?? "—"} | $${cost} | ${result.filesChanged} files${cleanup}`,
  );
  if (result.notes.length > 0) {
    for (const n of result.notes) console.log(`     └─ ${n}`);
  }
}

function summariseResults(): void {
  if (!existsSync(RESULTS_FILE)) {
    console.log("\nNo results yet.\n");
    return;
  }
  const lines = readFileSync(RESULTS_FILE, "utf-8").split("\n").filter(Boolean);
  const results: BurnResultRow[] = lines.map((l) => JSON.parse(l) as BurnResultRow);
  const buckets = { PASS: 0, FAIL: 0, ERROR: 0, TIMEOUT: 0, SAFE_FAILURE: 0, PENDING_APPROVAL: 0, BLOCKED: 0 };
  let totalCost = 0;
  for (const r of results) {
    buckets[r.verdict as keyof typeof buckets] = (buckets[r.verdict as keyof typeof buckets] ?? 0) + 1;
    totalCost += r.costUsd ?? 0;
  }
  console.log(`\n${"─".repeat(70)}`);
  console.log(
    `BURN-IN SUMMARY: ${results.length} scenarios | pass=${buckets.PASS} fail=${buckets.FAIL} ` +
      `err=${buckets.ERROR} timeout=${buckets.TIMEOUT} safe=${buckets.SAFE_FAILURE} ` +
      `pending=${buckets.PENDING_APPROVAL} blocked=${buckets.BLOCKED} | $${totalCost.toFixed(4)}`,
  );
  console.log(`${"─".repeat(70)}`);
  for (const r of results) {
    const cost = r.costUsd?.toFixed(4) ?? "?.????";
    console.log(
      `  ${r.verdict.padEnd(16)} ${r.scenarioId.padEnd(38)} ${(r.status ?? "?").padEnd(22)} $${cost}`,
    );
    if (r.notes.length > 0) for (const n of r.notes) console.log(`     └─ ${n}`);
  }
  console.log(`${"─".repeat(70)}\n`);
}

async function main(): Promise<void> {
  const summaryOnly = process.argv.includes("--summary");
  if (summaryOnly) {
    summariseResults();
    return;
  }

  const activeScenarios = filterScenarios(SCENARIOS);

  console.log(`\n🔬 AEDIS BURN-IN HARNESS (soft)`);
  console.log(`Target:  ${AEDIS_BASE}`);
  console.log(`Project: ${PROJECT_ROOT}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms${process.env["AEDIS_BURN_TIMEOUT_MS"] ? " (env override)" : " (default)"}`);
  console.log(`Results: ${RESULTS_FILE}`);
  console.log(`Scenarios: ${activeScenarios.length}\n`);

  const http = createFetchClient(AEDIS_BASE);

  // Health check — fail fast rather than time out N×timeout later.
  try {
    const res = await http.getJson<{ workers?: Record<string, { available: boolean }>; all_workers_available?: boolean }>(`/health`);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const allUp = res.body.all_workers_available
      ?? Object.values(res.body.workers ?? {}).every((w) => w.available);
    console.log(`Health: ${allUp ? "✅ All workers available" : "⚠️ Some workers down"}`);
    if (!allUp) {
      console.log(`Workers: ${JSON.stringify(res.body.workers ?? {})}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Cannot reach Aedis at ${AEDIS_BASE}: ${(err as Error).message}`);
    process.exit(1);
  }

  for (const scenario of activeScenarios) {
    const repo = scenario.repo ?? PROJECT_ROOT;
    console.log(`\n${"═".repeat(70)}`);
    console.log(`SCENARIO: ${scenario.id}`);
    console.log(`Prompt:   ${scenario.prompt.slice(0, 90)}${scenario.prompt.length > 90 ? "…" : ""}`);
    console.log(`Repo:     ${repo}`);
    console.log(`${"═".repeat(70)}`);

    const extraNotes: string[] = [];
    const result = await runScenarioOnce({
      http,
      scenarioId: scenario.id,
      prompt: scenario.prompt,
      repoPath: repo,
      timeoutMs: TIMEOUT_MS,
      onProgress: (line) => console.log(`  ${line}`),
      extraNotes,
    });

    // Scenario-level expectation checks (logged into notes).
    if (scenario.expected.shouldAsk && result.status !== "INTERRUPTED" && result.verdict !== "BLOCKED") {
      result.notes.push(`⚠️ Expected ambiguous→INTERRUPTED, got: ${result.status}`);
    }
    if (
      scenario.expected.maxCostUsd !== undefined &&
      result.costUsd !== null &&
      result.costUsd > scenario.expected.maxCostUsd
    ) {
      result.notes.push(`⚠️ Cost $${result.costUsd.toFixed(4)} exceeds max $${scenario.expected.maxCostUsd}`);
    }
    if (
      scenario.expected.minFilesChanged !== undefined &&
      result.filesChanged < scenario.expected.minFilesChanged
    ) {
      result.notes.push(`⚠️ Only ${result.filesChanged} files changed, expected ≥ ${scenario.expected.minFilesChanged}`);
    }

    logResult(result);
    await new Promise((r) => setTimeout(r, 3000));
  }

  summariseResults();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
