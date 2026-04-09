import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type { RunState, CostEntry } from "../core/runstate.js";
import { recordDecision, recordFileTouch } from "../core/runstate.js";
import type { EventBus } from "../server/websocket.js";
import {
  AbstractWorker,
  type BuildDecision,
  type BuilderOutput,
  type FileChange,
  type WorkerAssignment,
  type WorkerResult,
} from "./base.js";

export interface TaskContract {
  readonly file: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly interfaceRules: readonly string[];
}

export interface ModelInvocation {
  readonly model: string;
  readonly prompt: string;
  readonly contract: TaskContract;
  readonly assignment: WorkerAssignment;
}

export interface ModelResponse {
  readonly content: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCostUsd?: number;
}

export interface BuilderResult extends WorkerResult {
  readonly output: BuilderOutput & {
    readonly contract: TaskContract;
    readonly prompt: string;
    readonly rawModelResponse: string;
  };
}

export interface BuilderWorkerConfig {
  readonly projectRoot: string;
  readonly eventBus?: EventBus;
  readonly runState?: RunState;
  readonly defaultModel?: string;
  readonly invokeModel?: (request: ModelInvocation) => Promise<ModelResponse>;
}

export class BuilderWorker extends AbstractWorker {
  readonly type = "builder" as const;
  readonly name = "Builder Worker";

  private readonly projectRoot: string;
  private readonly eventBus: EventBus | null;
  private readonly runState: RunState | null;
  private readonly defaultModel: string;
  private readonly invokeModel: ((request: ModelInvocation) => Promise<ModelResponse>) | null;

  constructor(config: BuilderWorkerConfig) {
    super();
    this.projectRoot = resolve(config.projectRoot);
    this.eventBus = config.eventBus ?? null;
    this.runState = config.runState ?? null;
    this.defaultModel = config.defaultModel ?? "qwen3.6-plus";
    this.invokeModel = config.invokeModel ?? null;
  }

  canHandle(assignment: WorkerAssignment): boolean {
    return assignment.task.targetFiles.length === 1;
  }

  async estimateCost(assignment: WorkerAssignment): Promise<CostEntry> {
    const contextChars = assignment.context.layers.reduce(
      (sum, layer) => sum + layer.files.reduce((inner, file) => inner + file.content.length, 0),
      0,
    );
    const inputTokens = Math.ceil((contextChars + assignment.task.description.length * 2) / 4);
    const outputTokens = Math.min(assignment.tokenBudget, 1800);
    return {
      model: this.defaultModel,
      inputTokens,
      outputTokens,
      estimatedCostUsd: Number(((inputTokens * 0.00000035) + (outputTokens * 0.0000012)).toFixed(6)),
    };
  }

  async execute(assignment: WorkerAssignment): Promise<BuilderResult> {
    const startedAt = Date.now();
    const taskId = assignment.task.id;

    try {
      if (!this.canHandle(assignment)) {
        throw new Error("Builder requires an exact single-file contract scope");
      }
      if (!this.invokeModel) {
        throw new Error("Builder model invoker is not configured");
      }

      const contract = this.buildContract(assignment);
      const targetPath = this.resolveTarget(contract.file);
      const relativePath = this.toRelative(targetPath);
      const originalContent = await readFile(targetPath, "utf8");
      this.logFileTouch(taskId, relativePath, "read");

      const prompt = this.buildPrompt(contract, assignment, originalContent);
      const response = await this.invokeModel({
        model: this.defaultModel,
        prompt,
        contract,
        assignment,
      });

      const updatedContent = this.extractUpdatedContent(response.content);
      this.enforceForbiddenChanges(contract, updatedContent);

      if (updatedContent === originalContent) {
        throw new Error("Model returned no effective file changes");
      }

      const diff = this.buildUnifiedDiff(relativePath, originalContent, updatedContent);
      await writeFile(targetPath, updatedContent, "utf8");
      this.logFileTouch(taskId, relativePath, "modify");
      this.noteDecision(taskId, `Applied builder patch to ${relativePath}`, `Contract goal: ${contract.goal}`);

      const changes: FileChange[] = [{
        path: relativePath,
        operation: "modify",
        diff,
        originalContent,
        content: updatedContent,
      }];

      const decisions: BuildDecision[] = [{
        description: `Applied contract-scoped update to ${relativePath}`,
        rationale: contract.goal,
        alternatives: ["Refuse patch outside scope", "Request narrower contract"],
      }];

      const cost = {
        model: this.defaultModel,
        inputTokens: response.inputTokens ?? Math.ceil(prompt.length / 4),
        outputTokens: response.outputTokens ?? Math.ceil(updatedContent.length / 4),
        estimatedCostUsd:
          response.estimatedCostUsd ??
          Number(
            (
              ((response.inputTokens ?? Math.ceil(prompt.length / 4)) * 0.00000035) +
              ((response.outputTokens ?? Math.ceil(updatedContent.length / 4)) * 0.0000012)
            ).toFixed(6),
          ),
      } satisfies CostEntry;

      const output: BuilderResult["output"] = {
        kind: "builder",
        changes,
        decisions,
        needsCriticReview: true,
        contract,
        prompt,
        rawModelResponse: response.content,
      };

      this.eventBus?.emit({
        type: "builder_complete",
        payload: {
          taskId,
          workerType: this.type,
          file: relativePath,
          model: this.defaultModel,
          costUsd: cost.estimatedCostUsd,
        },
      });

      return this.success(assignment, output, {
        cost,
        confidence: 0.78,
        touchedFiles: [
          { path: relativePath, operation: "read" },
          { path: relativePath, operation: "modify" },
        ],
        assumptions: [],
        issues: [],
        durationMs: Date.now() - startedAt,
      }) as BuilderResult;
    } catch (error) {
      this.eventBus?.emit({
        type: "task_failed",
        payload: {
          taskId,
          workerType: this.type,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return this.failure(
        assignment,
        error instanceof Error ? error.message : String(error),
        { model: this.defaultModel, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        Date.now() - startedAt,
      ) as BuilderResult;
    }
  }

  protected emptyOutput(): BuilderOutput {
    return {
      kind: "builder",
      changes: [],
      decisions: [],
      needsCriticReview: true,
    };
  }

  private buildContract(assignment: WorkerAssignment): TaskContract {
    const file = assignment.task.targetFiles[0];
    const constraints = assignment.intent.constraints.map((constraint) => constraint.description);
    const forbiddenChanges = assignment.intent.exclusions ?? [];
    const interfaceRules = [
      "Do not change public names unless the task explicitly requires it.",
      "Preserve file-local style and module shape.",
      "Do not touch files outside the exact contract file.",
    ];
    return {
      file,
      goal: assignment.task.description,
      constraints,
      forbiddenChanges,
      interfaceRules,
    };
  }

  private buildPrompt(contract: TaskContract, assignment: WorkerAssignment, originalContent: string): string {
    const context = assignment.context.layers
      .flatMap((layer) => layer.files.map((file) => `FILE: ${file.path}\n${file.content}`))
      .join("\n\n---\n\n");

    return [
      `You are the Builder worker on model ${this.defaultModel}.`,
      "You must obey the contract exactly.",
      `Target file: ${contract.file}`,
      `Goal: ${contract.goal}`,
      `Constraints: ${contract.constraints.join(" | ") || "none"}`,
      `Forbidden changes: ${contract.forbiddenChanges.join(" | ") || "none"}`,
      `Interface rules: ${contract.interfaceRules.join(" | ")}`,
      "Return ONLY the full final file content for the target file. No markdown fences. No explanations.",
      "If the contract cannot be satisfied without leaving scope, return the original file unchanged.",
      "Current file:",
      originalContent,
      context ? `\nRelevant context:\n${context}` : "",
    ].filter(Boolean).join("\n\n");
  }

  private extractUpdatedContent(raw: string): string {
    const fenced = raw.match(/```(?:\w+)?\n([\s\S]*?)```/);
    return (fenced?.[1] ?? raw).trimEnd() + "\n";
  }

  private enforceForbiddenChanges(contract: TaskContract, updatedContent: string): void {
    const lowered = updatedContent.toLowerCase();
    for (const forbidden of contract.forbiddenChanges) {
      if (!forbidden) continue;
      if (lowered.includes(forbidden.toLowerCase())) {
        throw new Error(`Builder output violates forbidden change rule: ${forbidden}`);
      }
    }
  }

  private buildUnifiedDiff(filePath: string, originalContent: string, updatedContent: string): string {
    const originalLines = originalContent.split(/\r?\n/);
    const updatedLines = updatedContent.split(/\r?\n/);
    const max = Math.max(originalLines.length, updatedLines.length);
    const body: string[] = [];
    for (let index = 0; index < max; index += 1) {
      const before = originalLines[index];
      const after = updatedLines[index];
      if (before === after) {
        if (before !== undefined) body.push(` ${before}`);
        continue;
      }
      if (before !== undefined) body.push(`-${before}`);
      if (after !== undefined) body.push(`+${after}`);
    }
    return [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      `@@ -1,${originalLines.length} +1,${updatedLines.length} @@`,
      ...body,
    ].join("\n");
  }

  private resolveTarget(file: string): string {
    const abs = resolve(this.projectRoot, file);
    const normalizedRoot = this.projectRoot.endsWith(sep) ? this.projectRoot : `${this.projectRoot}${sep}`;
    if (abs !== this.projectRoot && !abs.startsWith(normalizedRoot)) {
      throw new Error(`Builder refused out-of-scope path: ${file}`);
    }
    return abs;
  }

  private toRelative(absPath: string): string {
    return relative(this.projectRoot, absPath).replace(/\\/g, "/");
  }

  private logFileTouch(taskId: string, path: string, operation: "read" | "create" | "modify" | "delete"): void {
    if (!this.runState) return;
    recordFileTouch(this.runState, { filePath: path, operation, taskId });
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
