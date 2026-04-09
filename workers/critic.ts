import type { RunState, CostEntry, Issue } from "../core/runstate.js";
import { recordDecision } from "../core/runstate.js";
import { invokeModel, type Provider } from "../core/model-invoker.js";
import { loadModelConfig } from "../server/routes/config.js";
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

// ─── Types ───────────────────────────────────────────────────────────

export interface CriticResult extends WorkerResult {
  readonly output: CriticOutput & {
    readonly status: "approved" | "rejected" | "needs-revision";
    readonly issuesList: readonly Issue[];
    readonly contract: TaskContract | null;
    readonly rawModelReview?: string;
  };
}

export interface CriticWorkerConfig {
  readonly projectRoot?: string;
  readonly eventBus?: EventBus;
  readonly runState?: RunState;
  readonly defaultModel?: string;
  readonly defaultProvider?: Provider;
}

// ─── Critic Worker ───────────────────────────────────────────────────

export class CriticWorker extends AbstractWorker {
  readonly type = "critic" as const;
  readonly name = "Critic Worker";

  private readonly projectRoot: string;
  private readonly eventBus: EventBus | null;
  private readonly runState: RunState | null;
  private readonly defaultModel: string;
  private readonly defaultProvider: Provider;

  constructor(config: CriticWorkerConfig = {}) {
    super();
    this.projectRoot = config.projectRoot ?? process.cwd();
    this.eventBus = config.eventBus ?? null;
    this.runState = config.runState ?? null;
    this.defaultModel = config.defaultModel ?? "qwen3.5:9b";
    this.defaultProvider = config.defaultProvider ?? "ollama";
  }

  async estimateCost(assignment: WorkerAssignment): Promise<CostEntry> {
    const { model } = this.getActiveModelConfig();
    return {
      model,
      inputTokens: Math.ceil((assignment.task.description.length + JSON.stringify(assignment.upstreamResults).length) / 4),
      outputTokens: 600,
      estimatedCostUsd: 0.0006,
    };
  }

  async execute(assignment: WorkerAssignment): Promise<CriticResult> {
    const startedAt = Date.now();
    const builderResult = assignment.upstreamResults.find((r) => r.workerType === "builder" && r.success);

    try {
      if (!builderResult || builderResult.output.kind !== "builder") {
        throw new Error("Critic requires a successful BuilderResult upstream");
      }

      const { model, provider } = this.getActiveModelConfig();
      const builderOutput = builderResult.output as BuilderOutput & { contract?: TaskContract };
      const changes = builderOutput.changes;
      const contract = builderOutput.contract ?? null;
      const heuristicIssues = this.runHeuristicChecks(changes, contract, assignment);
      const heuristicComments = this.toComments(heuristicIssues, changes[0]?.path ?? assignment.task.targetFiles[0] ?? "unknown");

      // Model review via unified invoker
      let rawModelReview: string | undefined;
      let modelTokensIn = 0;
      let modelTokensOut = 0;
      let modelCostUsd = 0;

      if (contract) {
        const prompt = this.buildPrompt(contract, changes, heuristicIssues, assignment, model);

        const response = await invokeModel({
          provider: provider as Provider,
          model,
          prompt,
          systemPrompt: "You are the Critic worker in Zendorium. Review code changes for correctness, style, and contract compliance. Be terse. Report blockers clearly.",
          maxTokens: 2048,
        });

        rawModelReview = response.text;
        modelTokensIn = response.tokensIn;
        modelTokensOut = response.tokensOut;
        modelCostUsd = response.costUsd;
      }

      const status: CriticResult["output"]["status"] = heuristicIssues.some((i) => i.severity === "critical")
        ? "rejected"
        : heuristicIssues.some((i) => i.severity === "error" || i.severity === "warning")
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
        this.noteDecision(assignment.task.id, `Critic flagged ${status}`, heuristicIssues.map((i) => i.message).join(" | "));
      }

      this.eventBus?.emit({
        type: "critic_review",
        payload: {
          taskId: assignment.task.id,
          workerType: this.type,
          model,
          provider,
          status,
          issues: heuristicIssues.length,
          costUsd: modelCostUsd,
        },
      });

      return this.success(assignment, output, {
        cost: {
          model,
          inputTokens: modelTokensIn,
          outputTokens: modelTokensOut,
          estimatedCostUsd: modelCostUsd,
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
      const { model } = this.getActiveModelConfig();
      return this.failure(
        assignment,
        error instanceof Error ? error.message : String(error),
        { model, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
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

  // ─── Model Resolution ────────────────────────────────────────────

  private getActiveModelConfig(): { model: string; provider: string } {
    try {
      const config = loadModelConfig(this.projectRoot);
      return { model: config.critic.model, provider: config.critic.provider };
    } catch {
      return { model: this.defaultModel, provider: this.defaultProvider };
    }
  }

  // ─── Heuristic Checks ───────────────────────────────────────────

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

  private buildPrompt(contract: TaskContract, changes: readonly FileChange[], issues: readonly Issue[], assignment: WorkerAssignment, model: string): string {
    return [
      `You are the Critic worker on model ${model}.`,
      "Review only. Do not rewrite code.",
      `Task: ${assignment.task.description}`,
      `Contract file: ${contract.file}`,
      `Forbidden changes: ${contract.forbiddenChanges.join(" | ") || "none"}`,
      `Interface rules: ${contract.interfaceRules.join(" | ")}`,
      `Heuristic issues: ${issues.map((i) => i.message).join(" | ") || "none"}`,
      `Diffs: ${changes.map((c) => c.diff ?? `${c.path} changed`).join("\n\n")}`,
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
