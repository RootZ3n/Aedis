/**
 * Reliability Harness — measure, not guess.
 *
 * Runs a curated batch of real tasks through Aedis, classifies each
 * result as success / weak_success / failure, and persists the trial
 * so regressions between runs can be detected.
 *
 * Layering:
 *   - TaskRunner (reliability-runner.ts) is the I/O boundary: submit
 *     a task, return the receipt. Stubbed in tests.
 *   - This module is pure logic: classification, metrics aggregation,
 *     regression detection, persistence. No HTTP, no coordinator.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { TaskRunner, RunnerReceipt } from "./reliability-runner.js";

// ─── Task / result shapes ────────────────────────────────────────────

export type Difficulty = "trivial" | "easy" | "medium" | "hard";

export type TaskType =
  | "bugfix"
  | "feature"
  | "refactor"
  | "extend"
  | "security"
  | "coverage"
  | "upgrade"
  | "perf";

export type Outcome = "success" | "weak_success" | "failure";

export type ErrorType =
  | "none"
  | "empty_diff"
  | "content_identity"
  | "compile_fail"
  | "test_fail"
  | "lint_fail"
  | "verification_low"
  | "execution_unverified"
  | "merge_blocked"
  | "worker_issue"
  | "runtime_exception"
  | "timeout"
  | "ambiguous_prompt"
  | "needs_decomposition"
  | "graph_empty"
  | "unknown";

export interface ReliabilityTask {
  /** Stable ID across trials. Name it semantically, not randomly. */
  readonly id: string;
  readonly taskType: TaskType;
  readonly repoPath: string;
  readonly difficulty: Difficulty;
  readonly prompt: string;
  /** Success signals. Optional — classifier tolerates absence. */
  readonly expectedFiles?: readonly string[];
  readonly minDiffLines?: number;
  /** Hard timeout for the whole task, including poll wait. */
  readonly timeoutMs?: number;
}

export interface TaskResult {
  readonly taskId: string;
  readonly trialId: string;
  readonly taskType: TaskType;
  readonly difficulty: Difficulty;
  readonly repoPath: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly outcome: Outcome;
  readonly errorType: ErrorType;
  readonly verificationConfidence: number;
  readonly iterations: number;
  readonly costUsd: number;
  readonly commitSha: string | null;
  readonly filesChanged: readonly string[];
  readonly rawVerdict: string;
  readonly notes: readonly string[];
}

export interface TrialMetrics {
  readonly total: number;
  readonly successes: number;
  readonly weakSuccesses: number;
  readonly failures: number;
  /** success + weak_success / total */
  readonly successRate: number;
  /** success only / total */
  readonly strictSuccessRate: number;
  readonly avgIterations: number;
  readonly avgCostUsd: number;
  /** cost of all tasks divided by strict successes (Infinity if zero). */
  readonly costPerSuccessUsd: number;
  readonly byTaskType: Record<
    string,
    {
      count: number;
      successRate: number;
      avgCostUsd: number;
    }
  >;
  readonly errorClusters: readonly {
    errorType: ErrorType;
    count: number;
    taskIds: readonly string[];
  }[];
}

export interface Trial {
  readonly trialId: string;
  readonly label: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly aedisVersion: string | null;
  readonly results: readonly TaskResult[];
  readonly metrics: TrialMetrics;
}

export type RegressionSeverity =
  | "regression"
  | "degradation"
  | "recovery"
  | "improvement";

export interface RegressionEntry {
  readonly taskId: string;
  readonly previousOutcome: Outcome;
  readonly currentOutcome: Outcome;
  readonly previousTrialId: string;
  readonly currentTrialId: string;
  readonly severity: RegressionSeverity;
}

export interface RegressionReport {
  readonly previousTrialId: string;
  readonly currentTrialId: string;
  readonly entries: readonly RegressionEntry[];
  readonly regressed: number;
  readonly recovered: number;
  readonly degraded: number;
  readonly improved: number;
  readonly newTasks: readonly string[];
  readonly droppedTasks: readonly string[];
}

function matchesExpectedFile(changed: string, expected: string): boolean {
  const normalize = (value: string) =>
    value.replace(/\\/g, "/").replace(/^\.\//, "");
  const c = normalize(changed);
  const e = normalize(expected);
  return c === e || c.endsWith("/" + e) || e.endsWith("/" + c);
}

// ─── Classification ──────────────────────────────────────────────────

/**
 * Classify a raw Aedis receipt plus the task spec into a TaskResult.
 *
 * This is the single place where "what counts as success" is decided —
 * if the criteria drift, update here, not in callers.
 */
export function classifyResult(args: {
  task: ReliabilityTask;
  trialId: string;
  receipt: RunnerReceipt | null;
  error: { type: ErrorType; message: string } | null;
  startedAt: string;
  finishedAt: string;
}): TaskResult {
  const { task, trialId, receipt, error, startedAt, finishedAt } = args;
  const notes: string[] = [];
  const durationMs =
    new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  // Submission-time error: no receipt, we never got a verdict.
  if (error || !receipt) {
    return {
      taskId: task.id,
      trialId,
      taskType: task.taskType,
      difficulty: task.difficulty,
      repoPath: task.repoPath,
      startedAt,
      finishedAt,
      durationMs,
      outcome: "failure",
      errorType: error?.type ?? "unknown",
      verificationConfidence: 0,
      iterations: 0,
      costUsd: 0,
      commitSha: null,
      filesChanged: [],
      rawVerdict: error?.type === "timeout" ? "timeout" : "no-receipt",
      notes: error ? [error.message] : ["no receipt returned"],
    };
  }

  const verdict = receipt.verdict ?? "unknown";
  const confidence = clamp01(receipt.verificationConfidence ?? 0);
  const filesChanged = receipt.filesChanged ?? [];
  const iterations = receipt.iterations ?? 1;
  const costUsd = Number(receipt.costUsd ?? 0);

  // Outcome starts from verdict, then downgrade on signal failures.
  let outcome: Outcome;
  let errorType: ErrorType = "none";

  if (verdict === "failed" || verdict === "aborted") {
    outcome = "failure";
    errorType = receipt.errorType ?? pickErrorType(receipt);
    // Always preserve the raw failure code + gate reason on notes so
    // dashboards can cluster on them even when we mapped to "unknown".
    if (receipt.failureCode) {
      notes.push(`failureCode=${receipt.failureCode}`);
    }
    if (receipt.executionGateReason) {
      notes.push(`executionGateReason=${receipt.executionGateReason.slice(0, 140)}`);
    }
  } else if (!receipt.executionVerified) {
    outcome = "failure";
    errorType = "execution_unverified";
    notes.push("execution gate did not verify real work");
  } else if (filesChanged.length === 0) {
    outcome = "failure";
    errorType = "empty_diff";
    notes.push("no files changed on disk");
  } else {
    // Verdict success/partial and we have some evidence of work.
    outcome = verdict === "partial" ? "weak_success" : "success";

    // Task-level signal checks downgrade strict → weak.
    if (task.expectedFiles && task.expectedFiles.length > 0) {
      const missing = task.expectedFiles.filter(
        (f) => !filesChanged.some((c) => matchesExpectedFile(c, f))
      );
      const touchedAny = missing.length < task.expectedFiles.length;
      if (missing.length > 0) {
        outcome = "weak_success";
        notes.push(`expected files not touched: ${missing.join(", ")}`);
      }
      // Phase 10.3 — scout-bias warning on simple targeted tasks.
      // When the task is scoped to a small target set and the builder
      // touched files OUTSIDE those targets on top of any it hit,
      // surface a diagnostic note. Does not change the outcome — the
      // harness already downgrades "expected not touched" above.
      // This adds visibility to the complementary pattern: "builder
      // wandered past the declared scope." Aligns with the builder's
      // new prompt-level targeting bias so the two signals reinforce.
      const extras = filesChanged.filter(
        (c) => !task.expectedFiles!.some((f) => matchesExpectedFile(c, f)),
      );
      const simpleTargeted =
        task.expectedFiles.length <= 2 &&
        (task.difficulty === "trivial" || task.difficulty === "easy");
      if (simpleTargeted && extras.length > 0) {
        notes.push(
          `scout-bias: simple task touched ${extras.length} file(s) outside declared targets: ${extras.slice(0, 3).join(", ")}${extras.length > 3 ? "…" : ""}`,
        );
      }
      // Phase 10.1 — bugfix must-modify. A bugfix task with an
      // explicit target must produce a change on at least one of the
      // declared files. A success verdict that touches unrelated
      // files is silent failure; promote it to a real failure with
      // empty_diff so it clusters with other "builder produced no
      // useful change" outcomes and the dashboard reflects it.
      if (task.taskType === "bugfix" && !touchedAny) {
        outcome = "failure";
        errorType = "empty_diff";
        notes.push(
          `bugfix must-modify: none of the declared target files (${task.expectedFiles.join(", ")}) was modified — verdict=${verdict} forced to failure`,
        );
      }
    }
    if (
      outcome !== "failure" &&
      task.minDiffLines !== undefined &&
      (receipt.diffLines ?? 0) < task.minDiffLines
    ) {
      outcome = "weak_success";
      notes.push(
        `diff ${receipt.diffLines ?? 0} < min ${task.minDiffLines}`
      );
    }
    if (outcome !== "failure" && confidence > 0 && confidence < 0.5) {
      outcome = outcome === "success" ? "weak_success" : outcome;
      errorType = "verification_low";
      notes.push(`verification confidence ${confidence.toFixed(2)}`);
    }
  }

  return {
    taskId: task.id,
    trialId,
    taskType: task.taskType,
    difficulty: task.difficulty,
    repoPath: task.repoPath,
    startedAt,
    finishedAt,
    durationMs,
    outcome,
    errorType,
    verificationConfidence: confidence,
    iterations,
    costUsd,
    commitSha: receipt.commitSha ?? null,
    filesChanged: [...filesChanged],
    rawVerdict: verdict,
    notes,
  };
}

/**
 * Map the coordinator's humanSummary.failureExplanation.code to the
 * harness's ErrorType. Codes Aedis produces live in
 * core/failure-explainer.ts — keep this mapping in sync with the
 * codes defined there. Unrecognized codes return null so the caller
 * can fall back to other signals.
 */
function errorTypeForFailureCode(code: string | undefined): ErrorType | null {
  if (!code) return null;
  switch (code) {
    // Execution-gate outcomes
    case "no-op":
      return "empty_diff";
    case "runtime-error":
    case "permission-denied":
    case "path-collision":
    case "missing-path":
    case "auth-missing":
      return "runtime_exception";
    // empty-graph means the planner produced zero actionable nodes —
    // a planner-side failure that's structurally distinct from
    // ambiguous_prompt (which is the clarification gate refusing a
    // genuinely under-specified request). Keeping them separate so
    // dashboards can distinguish "the user gave a vague prompt" from
    // "the planner couldn't materialize work despite a clear prompt."
    case "empty-graph":
      return "graph_empty";
    case "timeout":
      return "timeout";
    // Merge-gate outcomes
    case "merge-blocked":
    case "merge-invariant":
      return "merge_blocked";
    // Bugfix must-modify — the builder only changed tests (or
    // nothing) while the user asked to fix a bug. Semantically an
    // empty-diff against the real target, so we reuse the existing
    // empty_diff cluster rather than proliferate buckets.
    case "bugfix-target-not-modified":
      return "empty_diff";
    case "merge-typecheck":
      return "compile_fail";
    case "merge-lint":
      return "lint_fail";
    // Verifier outcomes
    case "verification-fail":
      return "verification_low";
    case "verify-typecheck":
      return "compile_fail";
    case "verify-test":
      return "test_fail";
    // Worker/graph failures
    case "worker-issue":
    case "failed-nodes":
      return "worker_issue";
    // Explicit aborted/unknown codes fall through — callers decide.
    case "aborted":
    case "unknown":
      return null;
    default:
      return null;
  }
}

function pickErrorType(receipt: RunnerReceipt): ErrorType {
  if (receipt.errorType) return receipt.errorType;
  // Phase 9 — consult the coordinator's own failure taxonomy first.
  // This is the single biggest win against the "unknown" bucket.
  const mapped = errorTypeForFailureCode(receipt.failureCode);
  if (mapped) return mapped;
  // The execution gate's verdict is authoritative when verdict=failed
  // but the coordinator didn't emit a humanSummary — e.g. the gate
  // rejected with no_op before verification ran.
  if (!receipt.executionVerified) return "execution_unverified";
  if (receipt.compileFailed) return "compile_fail";
  if (receipt.lintFailed) return "lint_fail";
  if (receipt.testsFailed) return "test_fail";
  if (receipt.verificationFailed) return "verification_low";
  return "unknown";
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ─── Metrics aggregation ─────────────────────────────────────────────

export function computeMetrics(results: readonly TaskResult[]): TrialMetrics {
  const total = results.length;
  const successes = results.filter((r) => r.outcome === "success").length;
  const weak = results.filter((r) => r.outcome === "weak_success").length;
  const failures = results.filter((r) => r.outcome === "failure").length;

  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const totalIters = results.reduce((s, r) => s + r.iterations, 0);

  const acc: Record<string, { count: number; ok: number; cost: number }> = {};
  for (const r of results) {
    const b = acc[r.taskType] ?? { count: 0, ok: 0, cost: 0 };
    b.count += 1;
    if (r.outcome !== "failure") b.ok += 1;
    b.cost += r.costUsd;
    acc[r.taskType] = b;
  }
  const byTaskType: TrialMetrics["byTaskType"] = {};
  for (const [k, b] of Object.entries(acc)) {
    byTaskType[k] = {
      count: b.count,
      successRate: b.count === 0 ? 0 : b.ok / b.count,
      avgCostUsd: b.count === 0 ? 0 : b.cost / b.count,
    };
  }

  const clusters = new Map<ErrorType, string[]>();
  for (const r of results) {
    if (r.outcome === "success") continue;
    const bucket = clusters.get(r.errorType) ?? [];
    bucket.push(r.taskId);
    clusters.set(r.errorType, bucket);
  }
  const errorClusters = [...clusters.entries()]
    .map(([errorType, taskIds]) => ({
      errorType,
      count: taskIds.length,
      taskIds,
    }))
    .sort((a, b) => b.count - a.count);

  const costPerSuccess =
    successes === 0 ? Number.POSITIVE_INFINITY : totalCost / successes;

  return {
    total,
    successes,
    weakSuccesses: weak,
    failures,
    successRate: total === 0 ? 0 : (successes + weak) / total,
    strictSuccessRate: total === 0 ? 0 : successes / total,
    avgIterations: total === 0 ? 0 : totalIters / total,
    avgCostUsd: total === 0 ? 0 : totalCost / total,
    costPerSuccessUsd: costPerSuccess,
    byTaskType,
    errorClusters,
  };
}

// ─── Regression detection ────────────────────────────────────────────

const OUTCOME_RANK: Record<Outcome, number> = {
  success: 2,
  weak_success: 1,
  failure: 0,
};

export function detectRegressions(
  previous: Trial,
  current: Trial
): RegressionReport {
  const prevByTask = new Map(previous.results.map((r) => [r.taskId, r]));
  const currByTask = new Map(current.results.map((r) => [r.taskId, r]));

  const entries: RegressionEntry[] = [];
  for (const [taskId, curr] of currByTask) {
    const prev = prevByTask.get(taskId);
    if (!prev) continue;
    if (prev.outcome === curr.outcome) continue;

    const delta = OUTCOME_RANK[curr.outcome] - OUTCOME_RANK[prev.outcome];
    let severity: RegressionSeverity;
    if (prev.outcome === "success" && curr.outcome === "failure") {
      severity = "regression";
    } else if (prev.outcome === "failure" && curr.outcome === "success") {
      severity = "recovery";
    } else if (delta < 0) {
      severity = "degradation";
    } else {
      severity = "improvement";
    }

    entries.push({
      taskId,
      previousOutcome: prev.outcome,
      currentOutcome: curr.outcome,
      previousTrialId: previous.trialId,
      currentTrialId: current.trialId,
      severity,
    });
  }

  const newTasks = [...currByTask.keys()].filter((id) => !prevByTask.has(id));
  const droppedTasks = [...prevByTask.keys()].filter((id) => !currByTask.has(id));

  return {
    previousTrialId: previous.trialId,
    currentTrialId: current.trialId,
    entries,
    regressed: entries.filter((e) => e.severity === "regression").length,
    recovered: entries.filter((e) => e.severity === "recovery").length,
    degraded: entries.filter((e) => e.severity === "degradation").length,
    improved: entries.filter((e) => e.severity === "improvement").length,
    newTasks,
    droppedTasks,
  };
}

// ─── Trial runner (batch execution) ──────────────────────────────────

export interface RunTrialOptions {
  readonly runner: TaskRunner;
  readonly tasks: readonly ReliabilityTask[];
  readonly label?: string;
  readonly aedisVersion?: string | null;
  /** Invoked after each task so callers can log progress. */
  readonly onProgress?: (result: TaskResult, index: number) => void;
  /**
   * Inject a clock for deterministic tests. Defaults to Date.now().
   * Returns ms-since-epoch.
   */
  readonly now?: () => number;
}

export async function runTrial(opts: RunTrialOptions): Promise<Trial> {
  const now = opts.now ?? (() => Date.now());
  const trialId = `trial-${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date(now()).toISOString();
  const results: TaskResult[] = [];

  for (let i = 0; i < opts.tasks.length; i++) {
    const task = opts.tasks[i];
    let result = await runOnce(task, opts.runner, trialId, now);

    // Phase 10.2 — empty-diff salvage retry. A simple targeted task
    // that came back with no file changes gets ONE more attempt,
    // with an intentionally stricter prompt. Bounded to a single
    // retry; if it still fails, take the salvaged result (which
    // carries the true final outcome) and annotate notes.
    if (isSalvageCandidate(task, result)) {
      const salvagePrompt = buildSalvagePrompt(task);
      // [DEBUG P12-trace] remove once the salvage reclassification
      // investigation is closed. Logs the salvage-prompt head so we
      // can correlate a downstream needs_decomposition / empty_diff
      // with the exact text submitted on retry.
      console.error(
        `[DEBUG P12-trace] salvage retry firing for ${task.id}: first=${result.outcome}/${result.errorType}, ` +
          `salvage prompt[0..140]="${salvagePrompt.replace(/\n/g, " ").slice(0, 140)}"`,
      );
      const salvageTask: ReliabilityTask = {
        ...task,
        prompt: salvagePrompt,
      };
      const retry = await runOnce(salvageTask, opts.runner, trialId, now);
      console.error(
        `[DEBUG P12-trace] salvage retry for ${task.id} returned: ${retry.outcome}/${retry.errorType} (files=${retry.filesChanged.length})`,
      );
      const annotated: TaskResult = {
        ...retry,
        notes: [
          ...retry.notes,
          "salvage-retry: first attempt produced empty_diff; retried once with stricter directive",
          `salvage-first-outcome: ${result.outcome}/${result.errorType}`,
          `salvage-first-files: ${result.filesChanged.length}`,
        ],
      };
      result = annotated;
    }

    results.push(result);
    opts.onProgress?.(result, i);
  }

  const finishedAt = new Date(now()).toISOString();
  return {
    trialId,
    label: opts.label ?? "ad-hoc",
    startedAt,
    finishedAt,
    aedisVersion: opts.aedisVersion ?? null,
    results,
    metrics: computeMetrics(results),
  };
}

/**
 * Phase 10.2 — execute one task through the runner and classify the
 * result. Split out from runTrial so the salvage-retry path can
 * reuse the same submit + classify flow.
 */
async function runOnce(
  task: ReliabilityTask,
  runner: TaskRunner,
  trialId: string,
  now: () => number,
): Promise<TaskResult> {
  const taskStart = new Date(now()).toISOString();
  let receipt: RunnerReceipt | null = null;
  let runErr: { type: ErrorType; message: string } | null = null;
  try {
    receipt = await runner.run(task);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const type: ErrorType = /timeout|timed out/i.test(msg)
      ? "timeout"
      : "runtime_exception";
    runErr = { type, message: msg };
  }
  const taskEnd = new Date(now()).toISOString();
  return classifyResult({
    task,
    trialId,
    receipt,
    error: runErr,
    startedAt: taskStart,
    finishedAt: taskEnd,
  });
}

/**
 * Phase 10.2 — a task is a salvage candidate when the first attempt
 * produced empty_diff AND the scope is narrow enough that a single
 * retry has a reasonable chance of succeeding. Restricted to simple
 * bugfix/feature-shaped tasks so we don't waste budget on
 * architectural or multi-file work that's supposed to be hard.
 */
export function isSalvageCandidate(
  task: ReliabilityTask,
  result: TaskResult,
): boolean {
  if (result.outcome !== "failure") return false;
  if (result.errorType !== "empty_diff") return false;
  if (/^RETRY:\s*the previous attempt modified zero files/i.test(task.prompt)) return false;
  if (task.difficulty !== "trivial" && task.difficulty !== "easy") return false;
  if (task.taskType !== "bugfix" && task.taskType !== "feature") return false;
  if (!task.expectedFiles || task.expectedFiles.length === 0) return false;
  if (task.expectedFiles.length > 2) return false;
  return true;
}

/**
 * Phase 10.2 — intentionally different retry prompt. The first
 * attempt's failure mode is "builder returned without modifying
 * anything." The retry foregrounds that fact, names the declared
 * target explicitly, and tells the model to apply the smallest
 * concrete patch. Must not weaken ambiguous_prompt detection — this
 * only runs when the task already had expectedFiles set, meaning
 * the charter had a target and the run completed a full pipeline.
 */
export function buildSalvagePrompt(task: ReliabilityTask): string {
  const targets = (task.expectedFiles ?? []).join(", ");
  return [
    `RETRY: the previous attempt modified zero files. Produce an actual code change this time.`,
    `Target file(s): ${targets}. Do not return commentary or a summary — return only the edited file contents.`,
    `Apply a minimal concrete patch that addresses the request below.`,
    ``,
    task.prompt,
  ].join("\n");
}

// ─── Persistence ─────────────────────────────────────────────────────

export function reliabilityDir(projectRoot: string): string {
  return join(projectRoot, "state", "reliability");
}

function trialsDir(projectRoot: string): string {
  return join(reliabilityDir(projectRoot), "trials");
}

function latestPath(projectRoot: string): string {
  return join(reliabilityDir(projectRoot), "latest.json");
}

export async function persistTrial(
  projectRoot: string,
  trial: Trial
): Promise<string> {
  await mkdir(trialsDir(projectRoot), { recursive: true });
  const path = join(trialsDir(projectRoot), `${trial.trialId}.json`);
  await writeFile(path, JSON.stringify(trial, null, 2), "utf8");
  await writeFile(latestPath(projectRoot), JSON.stringify(trial, null, 2), "utf8");
  return path;
}

export async function loadTrial(
  projectRoot: string,
  trialId: string
): Promise<Trial | null> {
  const path = join(trialsDir(projectRoot), `${trialId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Trial;
  } catch {
    return null;
  }
}

export async function listTrials(projectRoot: string): Promise<
  { trialId: string; label: string; startedAt: string; metrics: TrialMetrics }[]
> {
  const dir = trialsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  const out: Awaited<ReturnType<typeof listTrials>> = [];
  for (const name of names) {
    try {
      const t = JSON.parse(
        await readFile(join(dir, name), "utf8")
      ) as Trial;
      out.push({
        trialId: t.trialId,
        label: t.label,
        startedAt: t.startedAt,
        metrics: t.metrics,
      });
    } catch {
      // corrupt trial file; skip
    }
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return out;
}

export async function loadLatestTrial(
  projectRoot: string
): Promise<Trial | null> {
  const path = latestPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Trial;
  } catch {
    return null;
  }
}

/**
 * Load the most recent trial before the given trial's startedAt.
 * Used to pick a regression baseline when the caller just says "diff
 * against the previous run."
 */
export async function loadPreviousTrial(
  projectRoot: string,
  current: Trial
): Promise<Trial | null> {
  const all = await listTrials(projectRoot);
  const priors = all.filter(
    (t) => t.trialId !== current.trialId && t.startedAt < current.startedAt
  );
  if (priors.length === 0) return null;
  return loadTrial(projectRoot, priors[0].trialId);
}
