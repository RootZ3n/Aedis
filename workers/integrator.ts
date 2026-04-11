import type { RunState, CostEntry, Issue } from "../core/runstate.js";
import { recordCoherenceCheck, recordDecision } from "../core/runstate.js";
import {
  IntegrationJudge,
  type JudgmentReport,
} from "../core/integration-judge.js";
import type { EventBus } from "../server/websocket.js";
import {
  AbstractWorker,
  type CoherenceCheckResult,
  type ConflictResolution,
  type FileChange,
  type IntegratorOutput,
  type WorkerAssignment,
  type WorkerResult,
} from "./base.js";

export interface IntegratorResult extends WorkerResult {
  readonly output: IntegratorOutput & {
    readonly status: "coherent" | "needs-revision" | "blocked";
    readonly judgmentReport: JudgmentReport;
  };
}

export interface IntegratorWorkerConfig {
  readonly eventBus?: EventBus;
  readonly runState?: RunState;
}

export class IntegratorWorker extends AbstractWorker {
  readonly type = "integrator" as const;
  readonly name = "Integrator Worker";

  private readonly eventBus: EventBus | null;
  private readonly runState: RunState | null;
  private readonly judge: IntegrationJudge;

  constructor(config: IntegratorWorkerConfig = {}) {
    super();
    this.eventBus = config.eventBus ?? null;
    this.runState = config.runState ?? null;
    this.judge = new IntegrationJudge();
  }

  async estimateCost(_assignment: WorkerAssignment): Promise<CostEntry> {
    return { model: "integration-judge", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }

  async execute(assignment: WorkerAssignment): Promise<IntegratorResult> {
    const startedAt = Date.now();
    try {
      const runState = this.resolveRunState(assignment);
      if (!runState) {
        throw new Error("Integrator requires RunState for coherence tracking");
      }
      const approvedBuilderResults = assignment.upstreamResults.filter(
        (result) => result.workerType === "builder" && result.success,
      );
      if (approvedBuilderResults.length === 0) {
        throw new Error("Integrator requires approved BuilderResults");
      }

      const changes = approvedBuilderResults.flatMap((result) =>
        result.output.kind === "builder" ? [...result.output.changes] : [],
      );
      const judgmentReport = this.judge.judge(
        assignment.intent,
        runState,
        changes,
        assignment.upstreamResults,
        "pre-apply",
      );

      const coherenceCheck: CoherenceCheckResult = {
        passed: judgmentReport.passed,
        checks: judgmentReport.checks.map((check) => ({
          name: check.name,
          passed: check.passed,
          message: check.details,
        })),
      };

      const status: IntegratorResult["output"]["status"] = judgmentReport.passed
        ? "coherent"
        : judgmentReport.blockers.length > 0
          ? "blocked"
          : "needs-revision";

      const output: IntegratorResult["output"] = {
        kind: "integrator",
        finalChanges: changes,
        conflictsResolved: this.inferConflicts(changes),
        coherenceCheck,
        readyToApply: judgmentReport.passed,
        status,
        judgmentReport,
      };

      recordCoherenceCheck(runState, {
        phase: "post-build",
        passed: judgmentReport.passed,
        checks: coherenceCheck.checks,
      });
      recordDecision(runState, {
        description: `Integrator reported ${status}`,
        madeBy: this.name,
        taskId: assignment.task.id,
        alternatives: ["Request narrower task split", "Escalate review tier"],
        rationale: judgmentReport.summary,
      });

      this.eventBus?.emit({
        type: "integration_check",
        payload: {
          taskId: assignment.task.id,
          workerType: this.type,
          status,
          coherence: judgmentReport.coherenceScore,
        },
      });

      return this.success(assignment, output, {
        cost: { model: "integration-judge", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        confidence: judgmentReport.coherenceScore,
        touchedFiles: changes.map((change) => ({ path: change.path, operation: "read" as const })),
        issues: this.toIssues(judgmentReport),
        durationMs: Date.now() - startedAt,
      }) as IntegratorResult;
    } catch (error) {
      this.eventBus?.emit({
        type: "task_failed",
        payload: {
          taskId: assignment.task.id,
          workerType: this.type,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return this.failure(
        assignment,
        error instanceof Error ? error.message : String(error),
        { model: "integration-judge", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        Date.now() - startedAt,
      ) as IntegratorResult;
    }
  }

  protected emptyOutput(): IntegratorOutput {
    return {
      kind: "integrator",
      finalChanges: [],
      conflictsResolved: [],
      coherenceCheck: { passed: false, checks: [] },
      readyToApply: false,
    };
  }

  private inferConflicts(changes: readonly FileChange[]): ConflictResolution[] {
    const seen = new Set<string>();
    const conflicts: ConflictResolution[] = [];
    for (const change of changes) {
      if (seen.has(change.path)) {
        conflicts.push({
          file: change.path,
          description: "Multiple changes touched the same file; manual review recommended",
          strategy: "manual-merge",
        });
      }
      seen.add(change.path);
    }
    return conflicts;
  }

  private toIssues(report: JudgmentReport): Issue[] {
    return [
      ...report.blockers.map((issue) => ({ severity: "critical" as const, message: issue.message, file: issue.files[0] })),
      ...report.warnings.map((issue) => ({ severity: "warning" as const, message: issue.message, file: issue.files[0] })),
    ];
  }

  /**
   * Resolve the RunState for this execution.
   *
   * Lookup order:
   *   1. assignment.runState — attached by Coordinator.dispatchNode right
   *      after building the assignment via trustRouter.buildAssignment.
   *      This is the per-run canonical source for production runs.
   *   2. this.runState — the constructor-time fallback. Almost always null
   *      in production because workers are constructed at boot before any
   *      run exists. Used by tests and stand-alone harnesses that pass a
   *      RunState explicitly to the constructor.
   *
   * Uses structural typing (the cast through `unknown`) so we don't need
   * to add a `runState` field to WorkerAssignment in workers/base.ts.
   * The Coordinator attaches the field via the same cast pattern, and
   * TypeScript's structural typing covers the read on this side.
   */
  private resolveRunState(assignment: WorkerAssignment): RunState | null {
    const attached = (assignment as unknown as { runState?: RunState }).runState;
    if (attached) return attached;
    return this.runState;
  }
}
