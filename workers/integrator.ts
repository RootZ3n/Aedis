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

  constructor(config: IntegratorWorkerConfig = {}) {
    super();
    this.eventBus = config.eventBus ?? null;
    // NOTE: this.runState is almost always null in production. Workers are
    // constructed once at boot via WorkerRegistry, BEFORE any run exists,
    // so config.runState is null at construction time. The per-run RunState
    // must flow through the WorkerAssignment instead — see the inline
    // resolution in execute() which reads assignment.runState first and
    // falls back to this constructor field.
    this.runState = config.runState ?? null;
    // IntegrationJudge used to be a constructor field. It's now constructed
    // fresh per execute() call so it can pick up the per-task projectRoot
    // from assignment.projectRoot — workers are boot-time singletons in
    // WorkerRegistry, so a constructor-time judge would be locked to the
    // wrong projectRoot for any --repo override. See execute() below.
  }

  async estimateCost(_assignment: WorkerAssignment): Promise<CostEntry> {
    return { model: "integration-judge", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }

  async execute(assignment: WorkerAssignment): Promise<IntegratorResult> {
    const startedAt = Date.now();
    try {
      // Resolve the active RunState. Coordinator.dispatchNode populates
      // assignment.runState (a typed optional field on WorkerAssignment)
      // for every production dispatch. Falls back to this.runState which
      // is the constructor-time field used by tests and stand-alone
      // harnesses that bypass the registry.
      const runState = assignment.runState ?? this.runState;
      if (!runState) {
        throw new Error("Integrator requires RunState for coherence tracking");
      }

      // Resolve approved (successful) Builder results from the run.
      // Coordinator.dispatchNode populates assignment.workerResults (a
      // snapshot of active.workerResults) for every production dispatch
      // — that's the canonical source because the Integrator's direct
      // upstream in the task graph is Verifier (scout→builder→critic→
      // verifier→integrator), so the upstreamResults walk for
      // `workerType === "builder"` returns empty in production. The
      // upstreamResults walk is preserved as a fallback for tests and
      // alternate graph topologies that wire Builder directly to Integrator.
      // Both code paths filter for `workerType === "builder"` AND
      // `success === true` — the Integrator must only operate on approved
      // Builder runs, never on failed ones.
      const builderResultsSource = (assignment.workerResults && assignment.workerResults.length > 0)
        ? assignment.workerResults
        : assignment.upstreamResults;
      const approvedBuilderResults = builderResultsSource.filter(
        (result) => result.workerType === "builder" && result.success,
      );
      if (approvedBuilderResults.length === 0) {
        throw new Error(
          "Integrator requires approved BuilderResults but found none — neither " +
          "Coordinator-attached assignment.workerResults nor any direct " +
          "upstreamResults of kind 'builder' with success=true. Check that " +
          "Coordinator.dispatchNode populates assignment.workerResults, " +
          "or that at least one Builder ran successfully in this run."
        );
      }

      const changes = approvedBuilderResults.flatMap((result) =>
        result.output.kind === "builder" ? [...result.output.changes] : [],
      );

      // Construct the IntegrationJudge fresh per execute() call so it
      // honors the per-task projectRoot from assignment.projectRoot.
      // The judge's checkIntentAlignment normalizes deliverable paths
      // against this projectRoot — without it, paths from the Charter
      // (which may be absolute, relative, or basenames) won't match the
      // Builder's relative-to-projectRoot change paths and the judge
      // fails on every successful build.
      //
      // When assignment.projectRoot is undefined (test/standalone path),
      // the IntegrationJudge falls back to its process.cwd() default in
      // its DEFAULT_CONFIG.
      const judge = new IntegrationJudge(
        assignment.projectRoot ? { projectRoot: assignment.projectRoot } : {}
      );

      const judgmentReport = judge.judge(
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
          runId: (assignment.intent as { runId?: string; id?: string })?.runId
            ?? (assignment.intent as { runId?: string; id?: string })?.id
            ?? assignment.task.id,
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
}
