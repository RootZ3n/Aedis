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
 * Run with --summary to print latest invocation results without re-running.
 * Run with --history to include all accumulated JSONL rows in the summary.
 * Run with --allow-promote only when intentionally permitting source commits.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { redactObject } from "../../core/redaction.js";
import { detectSourceNewerThanDist, getBuildMetadata } from "../../core/build-metadata.js";
import { assessStaleness } from "../../core/staleness.js";
import { loadLaneConfigFromDisk } from "../../core/lane-config.js";

import {
  type BurnResultRow,
  computeSummary,
  createFetchClient,
  DEFAULT_BURN_TIMEOUT_MS,
  filterByInvocation,
  filterScenarios,
  formatSummaryBlock,
  parseJsonlRows,
  resolveTimeoutMs,
  runScenarioOnce,
  safePad,
  safeStr,
  shouldRunLaneRescue,
} from "./harness.js";

const AEDIS_BASE = process.env["AEDIS_BASE"] ?? "http://localhost:18796";
const RESULTS_FILE = "/mnt/ai/tmp/aedis-burn-in-results.jsonl";
const PROJECT_ROOT = "/mnt/ai/aedis";
const TIMEOUT_MS = resolveTimeoutMs(process.env["AEDIS_BURN_TIMEOUT_MS"], DEFAULT_BURN_TIMEOUT_MS);

export interface Scenario {
  id: string;
  prompt: string;
  repo?: string;
  expected: {
    classification?: string[];
    shouldAsk?: boolean;
    minFilesChanged?: number;
    maxCostUsd?: number;
    /**
     * Repair-loop scenarios (burn-in-10): minimum number of distinct
     * builder dispatches the run must execute. A repair attempt
     * presents as a second builder event after a failed first one;
     * see countRepairAttempts in harness.ts.
     */
    minRepairAttempts?: number;
    /**
     * Repair-loop scenarios: at least one verifier worker event must
     * have completed (status="completed"). Without this, the scenario
     * never actually ran the validation commands it told the model to
     * run, so a "passed" outcome would be unverified.
     */
    requireCommandEvidence?: boolean;
    /**
     * Repair-loop scenarios: the final verification verdict must be
     * pass or pass-with-warnings (not fail, not "not-run"). Pin the
     * post-repair invariant — even a successful repair loop must
     * leave verification in a known-good state.
     */
    requireFinalVerifierPass?: boolean;
  };
}

// ─── Server identity (build / duplicate / stale-dist warning) ───────

export interface HealthResponse {
  workers?: Record<string, { available: boolean }>;
  all_workers_available?: boolean;
  pid?: number;
  port?: number;
  uptime_human?: string;
  startedAt?: string;
  build?: {
    version?: string;
    commit?: string;
    commitShort?: string;
    buildTime?: string;
    source?: string;
  };
}

export interface ServerIdentitySummary {
  /** One-line status: pid + commit + uptime when present, sentinels otherwise. */
  identityLine: string;
  /** Operator-facing warnings — empty when everything is identifiable. */
  warnings: readonly string[];
}

/**
 * Render a one-liner that matches a running aedis process to a known
 * dist (and flags the cases where it can't). Pure function so the test
 * suite can pin the exact strings — that's the contract the burn-in
 * preamble depends on for stale-dist detection.
 */
export function formatServerIdentity(health: HealthResponse): ServerIdentitySummary {
  const pid = typeof health.pid === "number" && health.pid > 0 ? String(health.pid) : "unknown";
  const build = health.build ?? {};
  const commit = typeof build.commitShort === "string" && build.commitShort.length > 0
    ? build.commitShort
    : "unknown";
  const buildTime = typeof build.buildTime === "string" && build.buildTime.length > 0
    ? build.buildTime
    : "unknown";
  const uptime = typeof health.uptime_human === "string" ? health.uptime_human : "unknown";
  const port = typeof health.port === "number" ? health.port : "unknown";

  const warnings: string[] = [];
  if (health.pid === undefined || health.build === undefined) {
    warnings.push(
      "server /health is missing pid/build fields — likely a stale dist (pre-build-metadata). " +
      "Restart with a fresh `npm run build && npm run start:dist` to re-enable identity checks.",
    );
  }
  if (build.commit === undefined || build.commit === "unknown") {
    warnings.push("server has no commit hash — cannot verify which dist is running");
  }
  if (build.source && build.source !== "build-info") {
    warnings.push(
      `server build metadata source is "${build.source}" — running from source (tsx) or fallback, not a built dist`,
    );
  }

  return {
    identityLine: `pid=${pid} port=${port} commit=${commit} buildTime=${buildTime} uptime=${uptime}`,
    warnings,
  };
}

/**
 * Produce a short, filename-safe tag unique per harness invocation.
 * Format: `<base36 ms>-<base36 rand>` (e.g. `l8mh2c-x9q`). Tags are
 * embedded into burn-in-01's marker so re-running the suite never
 * collides with marker comments left behind by prior PROMOTED runs
 * — the burn-in source repo itself accumulates real commits when
 * the harness was previously run with --allow-promote.
 */
export function defaultBurnInRunTag(
  now: () => number = Date.now,
  rand: () => number = Math.random,
): string {
  const ms = Math.floor(now()).toString(36);
  const r = Math.floor(rand() * 1e9).toString(36);
  return `${ms}-${r}`;
}

/**
 * Compose burn-in-01's prompt with a unique marker. Exported so the
 * test suite can pin the tag and assert the rendered prompt.
 */
export function buildBurnIn01Prompt(tag: string): string {
  return (
    `In core/run-summary.ts, find the existing top-of-file comment block. ` +
    `At the very end of that block, add a single new comment line that ` +
    `reads exactly: '// burn-in: comment-swap probe ${tag}.' ` +
    `Do not modify anything else.`
  );
}

export function buildScenarios(opts: { tag?: string } = {}): Scenario[] {
  const tag = opts.tag ?? defaultBurnInRunTag();
  return [
  // ── 1. Tiny single-line comment swap ─────────────────────────────────
  {
    id: "burn-in-01-comment-swap-tiny",
    // Kept deliberately small so the first scenario doesn't
    // accidentally exercise multi-wave behaviour. One file, one
    // comment, no neighbours. Marker carries a per-invocation tag so
    // re-runs always require a real edit even when the source repo
    // already contains markers from prior PROMOTED runs.
    prompt: buildBurnIn01Prompt(tag),
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
      "In core/change-set.ts, rename the function 'computeExecutionOrder' to 'calculateExecutionOrder' at its definition and its call site. Only modify core/change-set.ts — do not change logic or touch any other file.",
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


  // ── 9. Command-loop troubleshooting ───────────────────────────────
  // Tests that Aedis can make a change, run validation commands,
  // interpret failures, repair if needed, and rerun commands.
  {
    id: "burn-in-09-command-loop",
    prompt:
      "In core/retry-utils.ts, add a small exported function " +
      "'clampDelay(delayMs: number, maxMs: number): number' that returns " +
      "Math.min(delayMs, maxMs). Then create core/retry-utils.test.ts " +
      "with three focused tests for clampDelay: (1) returns the delay " +
      "when below max, (2) returns max when delay exceeds max, (3) returns " +
      "max when delay equals max. After making the changes, run: " +
      "npm run security:secrets, npm test, npm run build, npx tsc --noEmit. " +
      "If any command fails, inspect the output, fix the issue, and rerun " +
      "the failing command. Only modify core/retry-utils.ts and " +
      "core/retry-utils.test.ts — do not touch any other file.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "EXECUTION_ERROR"],
      minFilesChanged: 2,
      maxCostUsd: 0.40,
    },
  },

  // ── 10. Repair loop ─────────────────────────────────────────────────
  // Forces the create → validate → observe failure → repair → rerun
  // cycle. The function (`rotateString`) has a wrap-around edge case
  // (n > s.length) that the naive `s.slice(n) + s.slice(0, n)` fails
  // — the wraparound test is in the prompt, the model has to notice
  // the failure, fix the modulo math, and rerun. Files land under
  // tmp/burn-in/ which is in .gitignore so an accidental approval
  // can't commit them.
  //
  // Expectation contract (extended for repair-loop scenarios):
  //   - filesChanged >= 2 (source + test)
  //   - command evidence: verifier completed at least once
  //   - repair attempts >= 1: at least one builder dispatch beyond
  //     the first one (recovery re-dispatch on test failure)
  //   - final verifier verdict: pass or pass-with-warnings — the
  //     repair must actually leave the run in a known-good verified
  //     state, not just stop at AWAITING_APPROVAL with no checks.
  {
    id: "burn-in-10-repair-loop",
    prompt:
      "Create tmp/burn-in/rotate-string.ts and tmp/burn-in/rotate-string.test.ts. " +
      "In rotate-string.ts, export a function " +
      "`rotateString(s: string, n: number): string` that rotates `s` " +
      "left by `n` characters. Negative `n` rotates right. When `|n|` " +
      "exceeds s.length the rotation MUST wrap around (e.g. " +
      "rotateString('abc', 7) === 'bca'). Empty string returns empty. " +
      "n=0 returns input unchanged. " +
      "In rotate-string.test.ts, add four focused tests covering: " +
      "(1) rotateString('abcdef', 2) === 'cdefab', " +
      "(2) rotateString('abcdef', -1) === 'fabcde', " +
      "(3) rotateString('abc', 7) === 'bca' (wraparound), " +
      "(4) rotateString('', 5) === ''. " +
      "After making the changes, run `npm test` to validate. If any " +
      "test fails, inspect the failure, fix the implementation, and " +
      "rerun `npm test` until all four tests pass. " +
      "Only create/modify the two files under tmp/burn-in/ — do not " +
      "touch any other file.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "EXECUTION_ERROR"],
      minFilesChanged: 2,
      maxCostUsd: 0.50,
      minRepairAttempts: 1,
      requireCommandEvidence: true,
      requireFinalVerifierPass: true,
    },
  },

  // ── 11. Lane rescue (local_then_cloud only) ─────────────────────────
  // Designed to FORCE the local primary to fail so the cloud shadow
  // takes over and is selected. The prompt asks for a tiny addition
  // that the local 9B model commonly mis-handles on edge cases — same
  // shape as burn-in-10's rotateString trip wire — combined with a
  // strict-mode test so verification fails on primary's first attempt.
  // Skipped by default unless lane-config is local_then_cloud AND the
  // operator passes --allow-shadow-cost (cloud spend gate).
  {
    id: "burn-in-11-lane-rescue",
    prompt:
      "Create tmp/burn-in/parse-fraction.ts and tmp/burn-in/parse-fraction.test.ts. " +
      "In parse-fraction.ts, export `parseFraction(s: string): { numerator: number, denominator: number }` " +
      "that parses 'a/b' strings. Requirements: " +
      "(1) parseFraction('1/2') === { numerator: 1, denominator: 2 }, " +
      "(2) parseFraction('-3/4') === { numerator: -3, denominator: 4 } (negative numerator), " +
      "(3) parseFraction('1/0') MUST throw an Error whose message starts EXACTLY with " +
      "the literal string 'parseFraction: zero denominator', " +
      "(4) parseFraction('not-a-fraction') MUST throw an Error whose message starts EXACTLY with " +
      "'parseFraction: invalid format'. " +
      "Add four focused tests covering each case. Run `npm test` to " +
      "validate. If any test fails, fix and rerun until all pass. " +
      "Only create/modify the two files under tmp/burn-in/ — do not " +
      "touch any other file.",
    expected: {
      classification: ["PARTIAL_SUCCESS", "SUCCESS", "EXECUTION_ERROR"],
      minFilesChanged: 2,
      // Cloud-shadow dispatch costs more than purely local repair-loop.
      maxCostUsd: 1.00,
      requireCommandEvidence: true,
    },
  },
  ];
}

function logResult(result: BurnResultRow, invocationId?: string): void {
  if (invocationId) result.invocationId = invocationId;
  appendFileSync(RESULTS_FILE, JSON.stringify(redactObject(result)) + "\n", "utf-8");
  const cost = result.costUsd?.toFixed(4) ?? "?.????";
  const cleanup = result.cleanup === "none" ? "" : ` cleanup=${result.cleanup}(${result.cleanupOk ? "ok" : "fail"})`;
  console.log(
    `  → [${result.verdict}] ${result.scenarioId} | status=${result.status ?? "?"} phase=${result.phase ?? "—"} | $${cost} | ${result.filesChanged} files${cleanup}`,
  );
  if (result.notes.length > 0) {
    for (const n of result.notes) console.log(`     └─ ${n}`);
  }
}

/**
 * Print a formatted summary table. When `rows` is provided, uses those
 * directly (current-invocation mode). Otherwise reads from the JSONL
 * file — filtering to the latest invocation unless `showHistory` is set.
 */
function summariseResults(rows?: readonly BurnResultRow[], showHistory = false): void {
  let results: readonly BurnResultRow[];
  let parseErrors = 0;

  if (rows) {
    results = rows;
  } else {
    if (!existsSync(RESULTS_FILE)) {
      console.log("\nNo results yet.\n");
      return;
    }
    const text = readFileSync(RESULTS_FILE, "utf-8");
    const parsed = parseJsonlRows(text);
    parseErrors = parsed.parseErrors;
    results = showHistory ? parsed.rows : filterByInvocation(parsed.rows);
  }

  if (!showHistory && !rows) {
    console.log("(showing latest invocation — use --history for all)\n");
  }

  const summary = computeSummary(results, parseErrors);
  console.log(formatSummaryBlock(summary));
  for (const r of results) {
    const cost = typeof r.costUsd === "number" ? r.costUsd.toFixed(4) : "?.????";
    console.log(
      `  ${safePad(r.verdict, 16)} ${safePad(r.scenarioId, 38)} ${safePad(r.status, 22)} $${cost}`,
    );
    const notes = Array.isArray(r.notes) ? r.notes : [];
    if (notes.length > 0) for (const n of notes) console.log(`     └─ ${n}`);
  }
  console.log(`${"─".repeat(50)}\n`);
}

async function main(): Promise<void> {
  const summaryOnly = process.argv.includes("--summary");
  const allowPromote = process.argv.includes("--allow-promote");
  const showHistory = process.argv.includes("--history");
  const allowStaleServer = process.argv.includes("--allow-stale-server");
  const allowShadowCost = process.argv.includes("--allow-shadow-cost");
  if (summaryOnly) {
    summariseResults(undefined, showHistory);
    return;
  }

  const activeScenarios = filterScenarios(buildScenarios());
  const invocationId = defaultBurnInRunTag();
  // Lane-rescue gate — read lane-config once at startup so the
  // skip-with-reason decision is stable across the whole invocation.
  const laneCfg = loadLaneConfigFromDisk(PROJECT_ROOT);
  const laneRescueGate = shouldRunLaneRescue({
    laneMode: laneCfg.mode,
    ...(laneCfg.shadow?.provider ? { shadowProvider: laneCfg.shadow.provider } : {}),
    allowShadowCost,
  });

  console.log(`\n🔬 AEDIS BURN-IN HARNESS (soft)`);
  console.log(`Target:  ${AEDIS_BASE}`);
  console.log(`Project: ${PROJECT_ROOT}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms${process.env["AEDIS_BURN_TIMEOUT_MS"] ? " (env override)" : " (default)"}`);
  console.log(`Allow promote: ${allowPromote ? "yes" : "no"}`);
  console.log(`Allow stale server: ${allowStaleServer ? "yes" : "no"}`);
  console.log(`Results: ${RESULTS_FILE}`);
  console.log(`Scenarios: ${activeScenarios.length}\n`);

  const http = createFetchClient(AEDIS_BASE);

  // Health check — fail fast rather than time out N×timeout later.
  // Also surface pid/build metadata so a stale-dist or duplicate-process
  // server is obvious BEFORE the suite spends ~10 minutes against it.
  // Older servers without metadata still pass this check (warn, don't
  // fail) so the harness keeps working through the rollout window.
  try {
    const res = await http.getJson<HealthResponse>(`/health`);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const summary = formatServerIdentity(res.body);
    console.log(`Server:  ${summary.identityLine}`);
    if (summary.warnings.length > 0) {
      for (const w of summary.warnings) console.log(`         ⚠️ ${w}`);
    }
    const allUp = res.body.all_workers_available
      ?? Object.values(res.body.workers ?? {}).every((w) => w.available);
    console.log(`Health:  ${allUp ? "✅ All workers available" : "⚠️ Some workers down"}`);
    if (!allUp) {
      console.log(`Workers: ${JSON.stringify(res.body.workers ?? {})}`);
      process.exit(1);
    }
    // Stale-server gate. Computed locally because the server can't
    // know whether the running operator just edited source. Refuse by
    // default — wasting 10 min running scenarios against a stale build
    // is the trap this commit exists to prevent. Override with
    // --allow-stale-server when the staleness is intentional (e.g.
    // running last-known-good against a current checkout).
    const localBuild = getBuildMetadata({ projectRoot: PROJECT_ROOT, fresh: true });
    const freshness = detectSourceNewerThanDist(PROJECT_ROOT);
    const staleness = assessStaleness({
      ...(localBuild.commit && localBuild.commit !== "unknown"
        ? { localCommit: localBuild.commit }
        : {}),
      ...(res.body.build?.commit ? { serverCommit: res.body.build.commit } : {}),
      ...(freshness
        ? {
            distBuildTimeMs: freshness.distBuildTime,
            newestSourceMtimeMs: freshness.newestSourceMtime,
            newestSourcePath: freshness.newestSourcePath,
          }
        : {}),
      ...(res.body.startedAt ? { serverStartedAtIso: res.body.startedAt } : {}),
    });
    if (staleness.stale) {
      console.log("");
      console.log("══ STALE SERVER ══════════════════════════════════════════");
      for (const r of staleness.reasons) console.log(`✗ ${r.code}: ${r.message}`);
      if (allowStaleServer) {
        console.log("--allow-stale-server set — proceeding against stale server.");
      } else {
        console.error(
          "Refusing to run burn-in against a stale server. " +
          "Rebuild + restart, or pass --allow-stale-server.",
        );
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`❌ Cannot reach Aedis at ${AEDIS_BASE}: ${(err as Error).message}`);
    process.exit(1);
  }

  const currentResults: BurnResultRow[] = [];

  for (const scenario of activeScenarios) {
    const repo = scenario.repo ?? PROJECT_ROOT;
    console.log(`\n${"═".repeat(70)}`);
    console.log(`SCENARIO: ${scenario.id}`);
    console.log(`Prompt:   ${scenario.prompt.slice(0, 90)}${scenario.prompt.length > 90 ? "…" : ""}`);
    console.log(`Repo:     ${repo}`);
    console.log(`${"═".repeat(70)}`);

    // Lane-rescue gate: skip burn-in-11 (with reason logged) when the
    // lane-config + cost guards aren't met. Logged as SKIPPED rather
    // than failed so post-hoc summaries can distinguish "intentionally
    // not run" from "failed to run".
    if (scenario.id === "burn-in-11-lane-rescue" && !laneRescueGate.run) {
      console.log(`  ⏭ SKIPPED: ${laneRescueGate.reason}`);
      continue;
    }

    const extraNotes: string[] = [];
    const result = await runScenarioOnce({
      http,
      scenarioId: scenario.id,
      prompt: scenario.prompt,
      repoPath: repo,
      timeoutMs: TIMEOUT_MS,
      onProgress: (line) => console.log(`  ${line}`),
      extraNotes,
      allowPromote,
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
    if (scenario.expected.requireCommandEvidence === true && result.commandEvidence !== true) {
      result.notes.push(
        `⚠️ Repair-loop scenario requires command evidence (verifier completed at least once); none recorded`,
      );
    }
    if (
      scenario.expected.minRepairAttempts !== undefined &&
      (result.repairAttempts ?? 0) < scenario.expected.minRepairAttempts
    ) {
      result.notes.push(
        `⚠️ Only ${result.repairAttempts ?? 0} repair attempt(s) recorded, expected ≥ ${scenario.expected.minRepairAttempts}`,
      );
    }
    if (
      scenario.expected.requireFinalVerifierPass === true &&
      result.finalVerifierVerdict !== "pass" &&
      result.finalVerifierVerdict !== "pass-with-warnings"
    ) {
      result.notes.push(
        `⚠️ Repair-loop scenario requires final verifier pass/pass-with-warnings; got "${result.finalVerifierVerdict ?? "unknown"}"`,
      );
    }

    logResult(result, invocationId);
    currentResults.push(result);
    await new Promise((r) => setTimeout(r, 3000));
  }

  summariseResults(showHistory ? undefined : currentResults, showHistory);
}

// Only run when invoked directly — guarded so the test suite can
// import buildScenarios / buildBurnIn01Prompt without triggering the
// full polling main().
const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

export { main };
