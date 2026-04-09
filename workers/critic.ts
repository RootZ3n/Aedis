import type { RunState, CostEntry, Issue } from "../core/runstate.js";
import { recordDecision } from "../core/runstate.js";
import type { EventBus } from "../server/websocket.js";
import {
  AbstractWorker,
  type BuilderOutput,
  type CriticOutput,
  type FileChange,
  type ReviewComment,
  type WorkerAssignment,
  type WorkerResult,
} from "./base.js";
import type { ModelInvocation, ModelResponse, TaskContract } from "./builder.js";

export interface CriticResult extends WorkerResult {
  readonly output: CriticOutput & {
    readonly status: "approved" | "rejected" | "needs-revision";
    readonly issuesList: readonly Issue[];
    readonly contract: TaskContract | null;
    readonly rawModelReview?: string;
  };
}

export interface CriticWorkerConfig {
  readonly eventBus?: EventBus;
  readonly runState?: RunState;
  readonly defaultModel?: string;
  readonly invokeModel?: (request: ModelInvocation) => Promise<ModelResponse>;
}

export class CriticWorker extends AbstractWorker {
  readonly type = "critic" as const;
  readonly name = "Critic Worker";

  private readonly eventBus: EventBus | null;
  private readonly runState: RunState | null;
  private readonly defaultModel: string;
  private readonly invokeModel: ((request: ModelInvocation) => Promise<ModelResponse>) | null;

  constructor(config: CriticWorkerConfig = {}) {
    super();
    this.eventBus = config.eventBus ?? null;
    this.runState = config.runState ?? null;
    this.defaultModel = config.defaultModel ?? "qwen3.5:9b";
    this.invokeModel = config.invokeModel ?? null;
  }

  async estimateCost(assignment: WorkerAssignment): Promise<CostEntry> {
    return {
      model: this.defaultModel,
      inputTokens: Math.ceil((assignment.task.description.length + JSON.stringify(assignment.upstreamResults).length) / 4),
      outputTokens: 600,
      estimatedCostUsd: 0.0006,
    };
  }

  async execute(assignment: WorkerAssignment): Promise<CriticResult> {
    const startedAt = Date.now();
    const builderResult = assignment.upstreamResults.find((result) => result.workerType === "builder" && result.success);

    try {
      if (!builderResult || builderResult.output.kind !== "builder") {
        throw new Error("Critic requires a successful BuilderResult upstream");
      }

      const builderOutput = builderResult.output as BuilderOutput & { contract?: TaskContract };
      const changes = builderOutput.changes;
      const contract = builderOutput.contract ?? null;
      const heuristicIssues = this.runHeuristicChecks(changes, contract, assignment);
      const heuristicComments = this.toComments(heuristicIssues, changes[0]?.path ?? assignment.task.targetFiles[0] ?? "unknown");

      let rawModelReview: string | undefined;
      if (this.invokeModel && contract) {
        const prompt = this.buildPrompt(contract, changes, heuristicIssues, assignment);
        const modelResponse = await this.invokeModel({
          model: this.defaultModel,
          prompt,
          contract,
          assignment,
        });
        rawModelReview = modelResponse.content;
      }

      const status: CriticResult["output"]["status"] = heuristicIssues.some((issue) => issue.severity === "critical")
        ? "rejected"
        : heuristicIssues.some((issue) => issue.severity === "error" || issue.severity === "warning")
          ? "needs-revision"
          : "approved";

      const output: CriticResult["output"] = {
        kind: "critic",
        verdict: status === "approved" ? "approve" : status === "needs-revision" ? "request-changes" : "reject",
        comments: heuristicComments,
        suggestedChanges: [],
        intentAlignment: status === "approved" ? 0.92 : status === "needs-revision" ? 0.68 : 0.3,
        status,
        issuesList: heuristicIssues,
        contract,
        rawModelReview,
      };

      if (status !== "approved") {
        this.noteDecision(assignment.task.id, `Critic flagged ${status}`, heuristicIssues.map((issue) => issue.message).join(" | "));
      }

      this.eventBus?.emit({
        type: "critic_review",
        payload: {
          taskId: assignment.task.id,
          workerType: this.type,
          status,
          issues: heuristicIssues.length,
        },
      });

      return this.success(assignment, output, {
        cost: {
          model: this.defaultModel,
          inputTokens: Math.ceil((JSON.stringify(builderOutput).length + assignment.task.description.length) / 4),
          outputTokens: rawModelReview ? Math.ceil(rawModelReview.length / 4) : 0,
          estimatedCostUsd: rawModelReview ? 0.0007 : 0,
        },
        confidence: status === "approved" ? 0.84 : 0.71,
        touchedFiles: [],
        issues: heuristicIssues,
        durationMs: Date.now() - startedAt,
      }) as CriticResult;
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
        { model: this.defaultModel, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        Date.now() - startedAt,
      ) as CriticResult;
    }
  }

  protected emptyOutput(): CriticOutput {
    return {
      kind: "critic",
      verdict: "request-changes",
      comments: [],
      suggestedChanges: [],
      intentAlignment: 0,
    };
  }

  private runHeuristicChecks(changes: readonly FileChange[], contract: TaskContract | null, assignment: WorkerAssignment): Issue[] {
    const issues: Issue[] = [];
    const allowedFiles = new Set(assignment.task.targetFiles);

    for (const change of changes) {
      if (!allowedFiles.has(change.path)) {
        issues.push({ severity: "critical", message: `Scope drift: ${change.path} is outside contract scope`, file: change.path });
      }
      if (change.diff?.includes("TODO") || change.content?.includes("TODO")) {
        issues.push({ severity: "warning", message: "Builder left TODO markers in output", file: change.path });
      }
      if (change.diff?.match(/^\+\s*console\.log/m) || change.content?.match(/console\.log\(/)) {
        issues.push({ severity: "warning", message: "Debug logging added without contract approval", file: change.path });
      }
      if (!change.diff || change.diff.trim().length < 24) {
        issues.push({ severity: "error", message: "Builder change lacks a meaningful diff", file: change.path });
      }
    }

    if (contract) {
      for (const forbidden of contract.forbiddenChanges) {
        for (const change of changes) {
          if (change.content?.toLowerCase().includes(forbidden.toLowerCase())) {
            issues.push({ severity: "critical", message: `Forbidden edit detected: ${forbidden}`, file: change.path });
          }
        }
      }
    }

    if (assignment.task.description.toLowerCase().includes("read only") && changes.length > 0) {
      issues.push({ severity: "critical", message: "Contract violation: builder changed files for a read-only task" });
    }

    return issues;
  }

  private toComments(issues: readonly Issue[], file: string): ReviewComment[] {
    return issues.map((issue) => ({
      file: issue.file ?? file,
      line: issue.line,
      severity: issue.severity === "critical" ? "blocker" : issue.severity === "error" ? "concern" : issue.severity === "warning" ? "suggestion" : "nit",
      message: issue.message,
    }));
  }

  private buildPrompt(contract: TaskContract, changes: readonly FileChange[], issues: readonly Issue[], assignment: WorkerAssignment): string {
    return [
      `You are the Critic worker on model ${this.defaultModel}.`,
      "Review only. Do not rewrite code.",
      `Task: ${assignment.task.description}`,
      `Contract file: ${contract.file}`,
      `Forbidden changes: ${contract.forbiddenChanges.join(" | ") || "none"}`,
      `Interface rules: ${contract.interfaceRules.join(" | ")}`,
      `Heuristic issues: ${issues.map((issue) => issue.message).join(" | ") || "none"}`,
      `Diffs: ${changes.map((change) => change.diff ?? `${change.path} changed`).join("\n\n")}`,
      "Return a terse review summary and any blockers.",
    ].join("\n\n");
  }

  private noteDecision(taskId: string, description: string, rationale: string): void {
    if (!this.runState) return;
    recordDecision(this.runState, {
      description,
      madeBy: this.name,
      taskId,
      alternatives: [],
      rationale,
    });
  }
}
