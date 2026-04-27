/**
 * Aedis Burn-In Harness v2
 * Tests Aedis against the 8 recommended burn-in scenarios.
 *
 * Usage:
 *   cd /mnt/ai/aedis && npx tsx test-burn-in.ts
 *   AEDIS_BASE=http://localhost:18796 npx tsx test-burn-in.ts
 *
 * Each result is appended to /mnt/ai/tmp/aedis-burn-in-results.jsonl
 * Run with --summary to see accumulated results without re-running tests.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const AEDIS_BASE = process.env["AEDIS_BASE"] ?? "http://localhost:18796";
const RESULTS_FILE = "/mnt/ai/tmp/aedis-burn-in-results.jsonl";
const PROJECT_ROOT = "/mnt/ai/aedis"; // test against itself

// ─── Scenario Definitions ───────────────────────────────────────────────────

interface Scenario {
  id: string;
  prompt: string;
  repo?: string;
  expected: {
    classification?: string[]; // acceptable verdicts
    shouldAsk?: boolean; // ambiguous → should ask for clarification
    shouldBlock?: boolean; // ts-breaking → should be blocked
    minFilesChanged?: number;
    maxCostUsd?: number;
  };
}

const SCENARIOS: Scenario[] = [
  // ── 1. Small bugfix + test ──────────────────────────────────────────────
  {
    id: "burn-in-01-bugfix-test",
    prompt:
      "In core/change-set.ts, the FileInclusion type has a comment that says '// TODO: split mutations by type' but the comment is misleading. Replace it with: '// Mutation expectation for the merge gate. True = output must differ from input.' Keep the edit minimal.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "NO_OP", "EXECUTION_ERROR"],
      minFilesChanged: 1,
      maxCostUsd: 0.15,
    },
  },

  // ── 2. Two-file refactor ─────────────────────────────────────────────────
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

  // ── 3. Multi-step 4–6 file improvement ──────────────────────────────────
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

  // ── 4. Ambiguous prompt — should ask, not guess ─────────────────────────
  {
    id: "burn-in-04-ambiguous-should-ask",
    prompt: "Clean up the config handling.",
    expected: {
      classification: ["AMBIGUOUS_PROMPT", "BLOCKED", "INTERRUPTED"],
      shouldAsk: true,
      maxCostUsd: 0.05,
    },
  },

  // ── 5. Explicit "do not touch X" constraint ─────────────────────────────
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

  // ── 6. Builder timeout / no-op recovery ──────────────────────────────────
  {
    id: "burn-in-06-no-op-recovery",
    prompt:
      "Add a trailing newline to the end of core/run-summary.ts if it doesn't already have one.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "NO_OP", "EXECUTION_ERROR"],
      maxCostUsd: 0.08,
    },
  },

  // ── 7. Explicit source+test changes ──────────────────────────────────────
  {
    id: "burn-in-07-source-plus-test",
    prompt:
      "In core/run-summary.ts, add a new exportable helper function 'formatVerdictBadge' that takes a string verdict ('SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED') and returns a string badge ('✅ SUCCESS', '⚠️ PARTIAL_SUCCESS', '❌ FAILED'). Add one focused test in core/run-summary.test.ts that exercises this function with all three inputs.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "NO_OP", "EXECUTION_ERROR"],
      minFilesChanged: 2, // run-summary.ts + test file
      maxCostUsd: 0.30,
    },
  },

  // ── 8. External repo (Crucible) ─────────────────────────────────────────
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

// ─── Aedis API Client ───────────────────────────────────────────────────────

interface SubmitResponse {
  task_id: string;
  run_id: string;
  status: string;
  prompt: string;
  repo_path: string;
}

interface RunStatus {
  id: string;
  taskId: string;
  runId: string;
  status: string;
  phase: string | null;
  totalCostUsd: number;
  classification: string | null;
  summary: {
    headline: string | null;
    narrative: string | null;
    changes?: Array<{ path: string }>;
    failureExplanation?: {
      code: string;
      stage: string;
      rootCause: string;
      suggestedFix: string;
      evidence: string[];
    };
  };
  errors: Array<{ source: string; message: string }>;
  executionVerified: boolean | null;
}

async function aedisSubmit(prompt: string, repoPath: string): Promise<SubmitResponse> {
  const res = await fetch(`${AEDIS_BASE}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, repoPath }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Aedis POST /tasks failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<SubmitResponse>;
}

async function aedisStatus(runId: string): Promise<RunStatus> {
  const res = await fetch(`${AEDIS_BASE}/api/runs/${runId}`);
  if (!res.ok) throw new Error(`Status fetch failed ${res.status}`);
  return res.json() as Promise<RunStatus>;
}

async function aedisApprove(runId: string): Promise<void> {
  const res = await fetch(`${AEDIS_BASE}/api/runs/${runId}/approve`, { method: "POST" });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Approve failed ${res.status}: ${text}`);
  }
}

async function aedisCancel(runId: string): Promise<void> {
  const res = await fetch(`${AEDIS_BASE}/api/runs/${runId}/cancel`, { method: "POST" });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Cancel failed ${res.status}: ${text}`);
  }
}

const TERMINAL_STATUSES = new Set([
  "COMPLETE", "COMPLETED", "PROMOTED", "READY_FOR_PROMOTION",
  "EXECUTION_ERROR", "ERROR", "ABORTED", "FAILED",
  "INTERRUPTED", "CANCELLED",
]);

async function aedisWaitForCompletion(
  runId: string,
  taskId: string,
  timeoutMs = 300_000,
): Promise<RunStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: RunStatus | null = null;
  let approvalAttempts = 0;

  while (Date.now() < deadline) {
    const status = await aedisStatus(runId);
    lastStatus = status;
    const phase = status.status ?? status.phase ?? "";
    const phaseUpper = phase.toUpperCase();

    if (TERMINAL_STATUSES.has(phaseUpper)) {
      return status;
    }

    // Handle approval states — auto-approve once
    if (phaseUpper === "AWAITING_APPROVAL" || phaseUpper === "PENDING_APPROVAL" || phaseUpper === "READY_FOR_PROMOTION") {
      approvalAttempts++;
      if (approvalAttempts === 1) {
        console.log(`  ⏳ Phase=${phase} — auto-approving...`);
        await aedisApprove(runId);
        await sleep(3000);
        continue;
      }
      // If still waiting after approve, keep polling
      await sleep(5000);
      continue;
    }

    await sleep(5000);
  }

  throw new Error(`Timeout waiting for run ${runId} after ${timeoutMs}ms (last status: ${lastStatus?.status})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Result Logging ─────────────────────────────────────────────────────────

interface RunResult {
  scenarioId: string;
  timestamp: string;
  prompt: string;
  repo: string;
  submitted: boolean;
  taskId: string;
  runId: string;
  error: string | null;
  status: string | null;
  classification: string | null;
  costUsd: number | null;
  confidence: number | null;
  durationMs: number | null;
  filesChanged: number | null;
  failureCode: string | null;
  failureRootCause: string | null;
  narrative: string | null;
  status_: "PASS" | "FAIL" | "ERROR";
  notes: string[];
}

function logResult(result: RunResult): void {
  const line = JSON.stringify(result);
  appendFileSync(RESULTS_FILE, line + "\n", "utf-8");
  const cost = result.costUsd?.toFixed(4) ?? "?.????";
  console.log(`  → [${result.status_}] ${result.scenarioId} | ${result.status ?? "?"} | $${cost} | ${result.classification ?? "?"} | ${result.filesChanged ?? "?"} files`);
  if (result.notes.length > 0) {
    for (const n of result.notes) console.log(`     └─ ${n}`);
  }
}

function summarizeResults(): void {
  if (!existsSync(RESULTS_FILE)) {
    console.log("\nNo results yet.\n");
    return;
  }
  const lines = readFileSync(RESULTS_FILE, "utf-8").split("\n").filter(Boolean);
  const results: RunResult[] = lines.map((l) => JSON.parse(l));

  const pass = results.filter((r) => r.status_ === "PASS").length;
  const fail = results.filter((r) => r.status_ === "FAIL").length;
  const err = results.filter((r) => r.status_ === "ERROR").length;
  const totalCost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`BURN-IN SUMMARY: ${results.length} scenarios | ${pass} pass | ${fail} fail | ${err} error | $${totalCost.toFixed(4)} total`);
  console.log(`${"─".repeat(70)}`);

  for (const r of results) {
    const icon = r.status_ === "PASS" ? "✅" : r.status_ === "FAIL" ? "❌" : "💥";
    const cost = r.costUsd?.toFixed(4) ?? "?.????";
    console.log(`  ${icon} ${r.scenarioId.padEnd(38)} ${(r.status ?? "?").padEnd(25)} $${cost}  ${r.classification ?? "?"}`);
    if (r.notes.length > 0) {
      for (const n of r.notes) console.log(`     └─ ${n}`);
    }
  }
  console.log(`${"─".repeat(70)}\n`);
}

// ─── Scenario Runner ────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<RunResult> {
  const repo = scenario.repo ?? PROJECT_ROOT;
  const startMs = Date.now();
  const notes: string[] = [];

  console.log(`\n${"═".repeat(70)}`);
  console.log(`SCENARIO: ${scenario.id}`);
  console.log(`Prompt: ${scenario.prompt.slice(0, 90)}${scenario.prompt.length > 90 ? "..." : ""}`);
  console.log(`Repo: ${repo}`);
  console.log(`${"═".repeat(70)}`);

  let submitted = false;
  let taskId = "";
  let runId = "";
  let error: string | null = null;
  let status: string | null = null;
  let classification: string | null = null;
  let costUsd: number | null = null;
  let durationMs: number | null = null;
  let filesChanged: number | null = null;
  let failureCode: string | null = null;
  let failureRootCause: string | null = null;
  let narrative: string | null = null;
  let resultStatus: RunResult["status_"] = "ERROR";

  try {
    // Submit
    const submitResp = await aedisSubmit(scenario.prompt, repo);
    taskId = submitResp.task_id ?? "";
    runId = submitResp.run_id ?? submitResp.id ?? "";
    submitted = true;
    console.log(`  📮 Submitted: task=${taskId} run=${runId}`);

    // Wait for completion
    const finalStatus = await aedisWaitForCompletion(runId, taskId);

    status = finalStatus.status ?? null;
    classification = finalStatus.classification ?? null;
    costUsd = finalStatus.totalCostUsd ?? null;
    durationMs = Date.now() - startMs;
    filesChanged = finalStatus.summary.changes?.length ?? null;
    failureCode = finalStatus.summary.failureExplanation?.code ?? null;
    failureRootCause = finalStatus.summary.failureExplanation?.rootCause ?? null;
    narrative = finalStatus.summary.narrative ?? finalStatus.summary.headline ?? null;

    // Determine pass/fail
    const phaseUpper = (status ?? "").toUpperCase();
    const isSuccess = ["PROMOTED", "COMPLETE", "COMPLETED", "READY_FOR_PROMOTION"].includes(phaseUpper);
    const isFailure = ["EXECUTION_ERROR", "NO_OP", "PARTIAL_SUCCESS", "FAILED", "ABORTED"].includes(phaseUpper) ||
      (phaseUpper === "INTERRUPTED" && scenario.expected?.shouldAsk);

    if (isSuccess) {
      resultStatus = "PASS";
    } else if (isFailure) {
      resultStatus = "FAIL";
    } else {
      resultStatus = "FAIL";
      notes.push(`Unexpected terminal phase: ${status}`);
    }

    // Check constraints
    if (scenario.expected.shouldAsk && status !== "INTERRUPTED") {
      notes.push(`⚠️ Expected ambiguous→INTERRUPTED(clarify), got: ${status}`);
    }
    if (scenario.expected.maxCostUsd && costUsd && costUsd > scenario.expected.maxCostUsd) {
      notes.push(`⚠️ Cost $${costUsd.toFixed(4)} exceeds max $${scenario.expected.maxCostUsd}`);
    }
    if (scenario.expected.minFilesChanged && filesChanged !== null && filesChanged < (scenario.expected.minFilesChanged ?? 0)) {
      notes.push(`⚠️ Only ${filesChanged} files changed, expected >= ${scenario.expected.minFilesChanged}`);
    }

    console.log(`  ✅ Done: status=${status} class=${classification} cost=$${costUsd?.toFixed(4) ?? "?"} files=${filesChanged ?? "?"} time=${durationMs}ms`);
    if (failureCode) console.log(`     failure: ${failureCode} — ${failureRootCause?.slice(0, 80)}`);

  } catch (err) {
    error = String(err);
    resultStatus = "ERROR";
    durationMs = Date.now() - startMs;
    console.error(`  💥 Error: ${error}`);
    if (runId) {
      try { await aedisCancel(runId); } catch { /* ignore */ }
    }
  }

  return {
    scenarioId: scenario.id,
    timestamp: new Date().toISOString(),
    prompt: scenario.prompt,
    repo,
    submitted,
    taskId,
    runId,
    error,
    status,
    classification,
    costUsd,
    confidence: null,
    durationMs,
    filesChanged,
    failureCode,
    failureRootCause,
    narrative,
    status_: resultStatus,
    notes,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const summary = process.argv.includes("--summary");
  if (summary) {
    summarizeResults();
    return;
  }

  console.log(`\n🔬 AEDIS BURN-IN HARNESS`);
  console.log(`Target: ${AEDIS_BASE}`);
  console.log(`Project: ${PROJECT_ROOT}`);
  console.log(`Scenarios: ${SCENARIOS.length}`);
  console.log(`Results: ${RESULTS_FILE}\n`);

  // Health check
  try {
    const healthRes = await fetch(`${AEDIS_BASE}/health`);
    const health = await healthRes.json() as Record<string, unknown>;
    const workers = health.workers as Record<string, { available: boolean; count: number }>;
    const allUp = Object.values(workers).every((w) => w.available);
    console.log(`Health: ${allUp ? "✅ All workers available" : "⚠️ Some workers down"}`);
    console.log(`Workers:`, JSON.stringify(workers));
    if (!allUp) process.exit(1);
  } catch (err) {
    console.error(`❌ Cannot reach Aedis at ${AEDIS_BASE}: ${err}`);
    process.exit(1);
  }

  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario);
    logResult(result);
    await sleep(3000); // 3s between runs to avoid flooding
  }

  summarizeResults();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
