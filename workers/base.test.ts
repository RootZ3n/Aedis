import test from "node:test";
import assert from "node:assert/strict";

import {
  AbstractWorker,
  type WorkerAssignment,
  type WorkerOutput,
  type WorkerResult,
  type WorkerType,
} from "./base.js";
import type { CostEntry } from "../core/runstate.js";
import type { InvokeAttempt } from "../core/model-invoker.js";

class TestWorker extends AbstractWorker {
  readonly type: WorkerType = "builder";
  readonly name = "test-worker";

  async execute(_assignment: WorkerAssignment): Promise<WorkerResult> {
    throw new Error("not used");
  }

  async estimateCost(_assignment: WorkerAssignment): Promise<CostEntry> {
    return this.zeroCost();
  }

  protected emptyOutput(): WorkerOutput {
    return { kind: "builder", changes: [], decisions: [], needsCriticReview: false };
  }

  // Expose protected helpers for direct testing of the providerAttempts wiring.
  callSuccess(
    assignment: WorkerAssignment,
    output: WorkerOutput,
    opts: Parameters<TestWorker["forwardSuccess"]>[2],
  ): WorkerResult {
    return this.forwardSuccess(assignment, output, opts);
  }
  callFailure(
    assignment: WorkerAssignment,
    error: string,
    cost: CostEntry,
    durationMs: number,
    providerAttempts?: readonly InvokeAttempt[],
  ): WorkerResult {
    return this.failure(assignment, error, cost, durationMs, providerAttempts);
  }
  forwardSuccess(
    assignment: WorkerAssignment,
    output: WorkerOutput,
    opts: Parameters<AbstractWorker["success"]>[2],
  ): WorkerResult {
    return this.success(assignment, output, opts);
  }
}

function fakeAssignment(): WorkerAssignment {
  return {
    task: { id: "task-1", description: "", workerType: "builder", parentTaskId: null, targetFiles: [], status: "pending", attempts: 0, cost: { model: "", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } } as unknown as WorkerAssignment["task"],
    intent: {} as WorkerAssignment["intent"],
    context: { layers: [] } as unknown as WorkerAssignment["context"],
    upstreamResults: [],
    tier: "standard",
    tokenBudget: 1000,
  } as WorkerAssignment;
}

const SAMPLE_ATTEMPTS: readonly InvokeAttempt[] = [
  { provider: "openrouter", model: "qwen3.6-plus", outcome: "empty_response", durationMs: 350, costUsd: 0, errorMsg: "empty content" },
  { provider: "ollama", model: "qwen3.5:9b", outcome: "ok", durationMs: 420, costUsd: 0, tokensIn: 100, tokensOut: 80 },
];

test("AbstractWorker.success threads providerAttempts onto WorkerResult when opts include them", () => {
  const w = new TestWorker();
  const cost: CostEntry = { model: "qwen3.5:9b", inputTokens: 100, outputTokens: 80, estimatedCostUsd: 0 };
  const result = w.callSuccess(fakeAssignment(), w["emptyOutput"](), {
    cost,
    confidence: 0.9,
    touchedFiles: [],
    durationMs: 100,
    providerAttempts: SAMPLE_ATTEMPTS,
  });
  assert.equal(result.success, true);
  assert.ok(result.providerAttempts, "providerAttempts should be present");
  assert.equal(result.providerAttempts!.length, 2);
  assert.equal(result.providerAttempts![0]!.outcome, "empty_response");
  assert.equal(result.providerAttempts![1]!.outcome, "ok");
});

test("AbstractWorker.success omits providerAttempts when opts.providerAttempts is empty", () => {
  const w = new TestWorker();
  const cost: CostEntry = { model: "qwen3.5:9b", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const result = w.callSuccess(fakeAssignment(), w["emptyOutput"](), {
    cost,
    confidence: 0.9,
    touchedFiles: [],
    durationMs: 100,
    providerAttempts: [],
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result, "providerAttempts"), false, "providerAttempts must not be set when empty");
});

test("AbstractWorker.failure threads providerAttempts onto a failed WorkerResult", () => {
  const w = new TestWorker();
  const cost: CostEntry = { model: "qwen3.6-plus", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const cancelledAttempts: readonly InvokeAttempt[] = [
    { provider: "openrouter", model: "qwen3.6-plus", outcome: "cancelled", durationMs: 0, costUsd: 0, errorMsg: "cancelled before dispatch" },
  ];
  const result = w.callFailure(fakeAssignment(), "boom", cost, 5, cancelledAttempts);
  assert.equal(result.success, false);
  assert.ok(result.providerAttempts, "providerAttempts should be present on failure");
  assert.equal(result.providerAttempts!.length, 1);
  assert.equal(result.providerAttempts![0]!.outcome, "cancelled");
});

test("AbstractWorker.failure omits providerAttempts when none provided", () => {
  const w = new TestWorker();
  const cost: CostEntry = { model: "qwen3.6-plus", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const result = w.callFailure(fakeAssignment(), "boom", cost, 5);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "providerAttempts"), false);
});
