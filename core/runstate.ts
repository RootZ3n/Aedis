/**
 * RunState — Full build run lifecycle tracker.
 *
 * Tracks every task, assumption, file touch, decision, and cost through
 * a build run. The RunState is the audit trail — if it didn't get recorded
 * here, it didn't happen.
 */

import { randomUUID } from "crypto";

// ─── Core Types ──────────────────────────────────────────────────────

export type RunPhase =
  | "charter"             // CharterGenerator producing the objective
  | "planning"            // Coordinator decomposing into tasks
  | "scouting"            // Scout workers gathering context
  | "building"            // Builder workers producing code
  | "reviewing"           // Critic workers reviewing output
  | "verifying"           // Verifier workers running tests/checks
  | "integrating"         // Integrator worker merging results
  | "awaiting_approval"   // Run paused — changes ready, waiting for human approval
  | "complete"            // Run finished successfully
  | "failed"              // Run terminated with error
  | "rejected"            // Run rejected by human during approval
  | "commit_failed"       // Merge gate approved but git commit failed
  | "rolled_back"         // Changes were rolled back after failure
  | "aborted";            // Run cancelled by user or governance

/**
 * Multi-file run outcome — richer than the binary success/failed
 * verdict. Used in receipts to clearly communicate what happened.
 */
export type MultiFileRunOutcome =
  | "complete"              // All scope items succeeded and verified
  | "partial"               // Some scope items succeeded, others failed/skipped
  | "blocked"               // Run blocked by governance gate (merge gate, approval)
  | "review_required"       // Run finished but confidence too low for auto-apply
  | "awaiting_approval"     // Run paused — changes ready, waiting for human approval
  | "rejected"              // Run rejected by human during approval
  | "commit_failed"         // Merge gate approved but git commit failed
  | "rolled_back"           // Changes were reverted due to failure
  | "failed";              // Run terminated with error

/**
 * Per-file outcome for multi-file receipts. Each file in the change
 * manifest gets one of these at run completion.
 */
export interface PerFileOutcome {
  readonly path: string;
  readonly outcome: "succeeded" | "failed" | "skipped" | "rolled_back";
  readonly reason: string;
  readonly waveId: number | null;
  readonly workerTaskId: string | null;
}

export type TaskStatus = "pending" | "active" | "completed" | "failed" | "skipped";

export interface RunTask {
  readonly id: string;
  readonly parentTaskId: string | null;
  readonly workerType: string;
  readonly description: string;
  readonly targetFiles: readonly string[];
  status: TaskStatus;
  assignedTo: string | null;
  result: TaskResult | null;
  startedAt: string | null;
  completedAt: string | null;
  costAccrued: CostEntry | null;
}

export interface TaskResult {
  readonly success: boolean;
  readonly output: string;
  readonly artifacts: readonly string[];
  readonly issues: readonly Issue[];
}

export interface Issue {
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

export interface CostEntry {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

export interface AcceptedAssumption {
  readonly statement: string;
  readonly acceptedBy: string;
  readonly acceptedAt: string;
  readonly taskId: string | null;
}

export interface FileTouch {
  readonly filePath: string;
  readonly operation: "read" | "create" | "modify" | "delete";
  readonly taskId: string;
  readonly timestamp: string;
}

export interface Decision {
  readonly id: string;
  readonly description: string;
  readonly madeBy: string;
  readonly taskId: string | null;
  readonly timestamp: string;
  readonly alternatives: readonly string[];
  readonly rationale: string;
}

export interface CoherenceCheck {
  readonly phase: "pre-build" | "post-build";
  readonly passed: boolean;
  readonly checks: readonly CoherenceResult[];
  readonly timestamp: string;
}

export interface CoherenceResult {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
}

// ─── RunState ────────────────────────────────────────────────────────

export interface RunState {
  readonly id: string;
  readonly intentId: string;
  readonly startedAt: string;
  phase: RunPhase;
  tasks: RunTask[];
  assumptions: AcceptedAssumption[];
  filesTouched: FileTouch[];
  decisions: Decision[];
  coherenceChecks: CoherenceCheck[];
  totalCost: CostEntry;
  completedAt: string | null;
  failureReason: string | null;
  /**
   * Per-file outcomes for multi-file runs. Populated at run completion
   * by the Coordinator. Empty for single-file runs.
   */
  fileOutcomes: PerFileOutcome[];
  /**
   * Structured multi-file outcome. Null for single-file runs or
   * runs that haven't completed yet.
   */
  multiFileOutcome: MultiFileRunOutcome | null;
}

// ─── Factory ─────────────────────────────────────────────────────────

export function createRunState(intentId: string, runId?: string): RunState {
  return {
    id: runId ?? randomUUID(),
    intentId,
    startedAt: new Date().toISOString(),
    phase: "charter",
    tasks: [],
    assumptions: [],
    filesTouched: [],
    decisions: [],
    coherenceChecks: [],
    totalCost: { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    completedAt: null,
    failureReason: null,
    fileOutcomes: [],
    multiFileOutcome: null,
  };
}

// ─── State Mutations (all return void, mutate in place for perf) ─────

export function advancePhase(run: RunState, phase: RunPhase): void {
  const order: RunPhase[] = [
    "charter", "planning", "scouting", "building",
    "reviewing", "verifying", "integrating", "complete",
  ];
  const terminalPhases: RunPhase[] = ["complete", "failed", "rejected", "commit_failed", "rolled_back", "aborted"];

  if (terminalPhases.includes(run.phase)) {
    throw new RunStateError(`Cannot advance from terminal phase "${run.phase}"`);
  }

  // Allow jumping to terminal phases and awaiting_approval from anywhere
  if (terminalPhases.includes(phase) || phase === "awaiting_approval") {
    run.phase = phase;
    if (terminalPhases.includes(phase)) {
      run.completedAt = new Date().toISOString();
    }
    return;
  }

  const currentIdx = order.indexOf(run.phase);
  const nextIdx = order.indexOf(phase);
  if (nextIdx <= currentIdx) {
    throw new RunStateError(
      `Cannot go backwards: "${run.phase}" → "${phase}"`
    );
  }

  run.phase = phase;
}

export function addTask(run: RunState, task: Omit<RunTask, "id" | "status" | "assignedTo" | "result" | "startedAt" | "completedAt" | "costAccrued">): RunTask {
  const newTask: RunTask = {
    ...task,
    id: randomUUID(),
    status: "pending",
    assignedTo: null,
    result: null,
    startedAt: null,
    completedAt: null,
    costAccrued: null,
  };
  run.tasks.push(newTask);
  return newTask;
}

export function startTask(run: RunState, taskId: string, assignedTo: string): void {
  const task = findTask(run, taskId);
  if (task.status !== "pending") {
    throw new RunStateError(`Task ${taskId} is "${task.status}", cannot start`);
  }
  task.status = "active";
  task.assignedTo = assignedTo;
  task.startedAt = new Date().toISOString();
}

export function completeTask(run: RunState, taskId: string, result: TaskResult, cost?: CostEntry): void {
  const task = findTask(run, taskId);
  if (task.status !== "active") {
    throw new RunStateError(`Task ${taskId} is "${task.status}", cannot complete`);
  }
  task.status = result.success ? "completed" : "failed";
  task.result = result;
  task.completedAt = new Date().toISOString();
  if (cost) {
    task.costAccrued = cost;
    accrueCost(run, cost);
  }
}

export function skipTask(run: RunState, taskId: string, reason: string): void {
  const task = findTask(run, taskId);
  if (task.status !== "pending") {
    throw new RunStateError(`Task ${taskId} is "${task.status}", cannot skip`);
  }
  task.status = "skipped";
  task.result = { success: true, output: `Skipped: ${reason}`, artifacts: [], issues: [] };
  task.completedAt = new Date().toISOString();
}

export function recordAssumption(run: RunState, assumption: Omit<AcceptedAssumption, "acceptedAt">): void {
  run.assumptions.push({
    ...assumption,
    acceptedAt: new Date().toISOString(),
  });
}

export function recordFileTouch(run: RunState, touch: Omit<FileTouch, "timestamp">): void {
  run.filesTouched.push({
    ...touch,
    timestamp: new Date().toISOString(),
  });
}

export function recordDecision(run: RunState, decision: Omit<Decision, "id" | "timestamp">): void {
  run.decisions.push({
    ...decision,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

export function recordCoherenceCheck(run: RunState, check: Omit<CoherenceCheck, "timestamp">): void {
  run.coherenceChecks.push({
    ...check,
    timestamp: new Date().toISOString(),
  });
}

export function failRun(run: RunState, reason: string): void {
  run.failureReason = reason;
  advancePhase(run, "failed");
}

export function abortRun(run: RunState, reason: string): void {
  run.failureReason = reason;
  advancePhase(run, "aborted");
}

// ─── Queries ─────────────────────────────────────────────────────────

export function getActiveTasks(run: RunState): RunTask[] {
  return run.tasks.filter((t) => t.status === "active");
}

export function getPendingTasks(run: RunState): RunTask[] {
  return run.tasks.filter((t) => t.status === "pending");
}

export function getCompletedTasks(run: RunState): RunTask[] {
  return run.tasks.filter((t) => t.status === "completed");
}

export function getFailedTasks(run: RunState): RunTask[] {
  return run.tasks.filter((t) => t.status === "failed");
}

export function getTasksByWorker(run: RunState, workerType: string): RunTask[] {
  return run.tasks.filter((t) => t.workerType === workerType);
}

export function getFilesTouchedByTask(run: RunState, taskId: string): FileTouch[] {
  return run.filesTouched.filter((f) => f.taskId === taskId);
}

export function getAllTouchedFiles(run: RunState): string[] {
  return [...new Set(run.filesTouched.map((f) => f.filePath))];
}

export function getRunSummary(run: RunState): RunSummary {
  const taskCounts = {
    total: run.tasks.length,
    pending: run.tasks.filter((t) => t.status === "pending").length,
    active: run.tasks.filter((t) => t.status === "active").length,
    completed: run.tasks.filter((t) => t.status === "completed").length,
    failed: run.tasks.filter((t) => t.status === "failed").length,
    skipped: run.tasks.filter((t) => t.status === "skipped").length,
  };

  const issues = run.tasks
    .filter((t) => t.result)
    .flatMap((t) => t.result!.issues);

  return {
    runId: run.id,
    intentId: run.intentId,
    phase: run.phase,
    taskCounts,
    totalCost: run.totalCost,
    filesModified: getAllTouchedFiles(run).length,
    assumptions: run.assumptions.length,
    decisions: run.decisions.length,
    issues: {
      info: issues.filter((i) => i.severity === "info").length,
      warning: issues.filter((i) => i.severity === "warning").length,
      error: issues.filter((i) => i.severity === "error").length,
      critical: issues.filter((i) => i.severity === "critical").length,
    },
    duration: run.completedAt
      ? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
      : Date.now() - new Date(run.startedAt).getTime(),
  };
}

export interface RunSummary {
  runId: string;
  intentId: string;
  phase: RunPhase;
  taskCounts: {
    total: number;
    pending: number;
    active: number;
    completed: number;
    failed: number;
    skipped: number;
  };
  totalCost: CostEntry;
  filesModified: number;
  assumptions: number;
  decisions: number;
  issues: { info: number; warning: number; error: number; critical: number };
  duration: number;
}

// ─── Multi-File Outcome Helpers ──────────────────────────────────────

export function recordFileOutcome(run: RunState, outcome: PerFileOutcome): void {
  const idx = run.fileOutcomes.findIndex((o) => o.path === outcome.path);
  if (idx >= 0) {
    run.fileOutcomes[idx] = outcome;
  } else {
    run.fileOutcomes.push(outcome);
  }
}

/**
 * Compute the multi-file run outcome from the current state.
 * Called by the Coordinator at run completion to produce a
 * structured outcome for receipts.
 */
export function computeMultiFileOutcome(run: RunState): MultiFileRunOutcome {
  if (run.phase === "aborted") return "failed";
  if (run.phase === "awaiting_approval") return "awaiting_approval";
  if (run.phase === "rejected") return "rejected";
  if (run.phase === "commit_failed") return "commit_failed";
  if (run.phase === "rolled_back") return "rolled_back";
  if (run.failureReason) return "failed";

  const outcomes = run.fileOutcomes;
  if (outcomes.length === 0) {
    return run.phase === "complete" ? "complete" : "failed";
  }

  const allRolledBack = outcomes.every((o) => o.outcome === "rolled_back");
  if (allRolledBack) return "rolled_back";

  const anyFailed = outcomes.some((o) => o.outcome === "failed");
  const anySucceeded = outcomes.some((o) => o.outcome === "succeeded");

  if (anyFailed && anySucceeded) return "partial";
  if (anyFailed && !anySucceeded) return "failed";

  return "complete";
}

/**
 * Set the multi-file outcome on the run state. Should be called
 * once at run completion.
 */
export function finalizeMultiFileOutcome(run: RunState): void {
  run.multiFileOutcome = computeMultiFileOutcome(run);
}

// ─── Internals ───────────────────────────────────────────────────────

function findTask(run: RunState, taskId: string): RunTask {
  const task = run.tasks.find((t) => t.id === taskId);
  if (!task) throw new RunStateError(`Task "${taskId}" not found`);
  return task;
}

function accrueCost(run: RunState, cost: CostEntry): void {
  (run as any).totalCost = {
    model: cost.model || run.totalCost.model,
    inputTokens: run.totalCost.inputTokens + cost.inputTokens,
    outputTokens: run.totalCost.outputTokens + cost.outputTokens,
    estimatedCostUsd: run.totalCost.estimatedCostUsd + cost.estimatedCostUsd,
  };
}

// ─── Errors ──────────────────────────────────────────────────────────

export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStateError";
  }
}
