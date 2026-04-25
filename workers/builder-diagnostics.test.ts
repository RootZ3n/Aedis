import test from "node:test";
import assert from "node:assert/strict";
import {
  BuilderAttemptError,
  sumAttemptCosts,
  type BuilderAttemptRecord,
} from "./builder-diagnostics.js";

function rec(overrides: Partial<BuilderAttemptRecord>): BuilderAttemptRecord {
  return {
    attemptId: overrides.attemptId ?? "att-1",
    attemptIndex: overrides.attemptIndex ?? 1,
    generationId: overrides.generationId ?? "gen-1",
    targetFile: overrides.targetFile ?? "src/foo.ts",
    patchMode: overrides.patchMode ?? "full-file",
    provider: overrides.provider ?? "openrouter",
    model: overrides.model ?? "qwen3.6-plus",
    tier: overrides.tier ?? "standard",
    fellBack: overrides.fellBack ?? false,
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 50,
    estimatedCostUsd: overrides.estimatedCostUsd ?? 0.001,
    durationMs: overrides.durationMs ?? 100,
    outcome: overrides.outcome ?? "success",
    failureReason: overrides.failureReason ?? null,
    guardRejected: overrides.guardRejected ?? false,
    guardName: overrides.guardName ?? null,
    exportDiff: overrides.exportDiff ?? null,
    stale: overrides.stale ?? false,
  };
}

test("builder-diagnostics: BuilderAttemptError carries the record", () => {
  const r = rec({ outcome: "guard-export-loss", failureReason: "lost foo, bar", guardRejected: true });
  const err = new BuilderAttemptError("export loss", r);
  assert.equal(err.name, "BuilderAttemptError");
  assert.equal(err.message, "export loss");
  assert.equal(err.record.outcome, "guard-export-loss");
  assert.equal(err.record.failureReason, "lost foo, bar");
});

test("builder-diagnostics: sumAttemptCosts sums tokens and cost across mixed attempts", () => {
  const list = [
    rec({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001, outcome: "guard-export-loss" }),
    rec({ inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.002, outcome: "success" }),
  ];
  const cost = sumAttemptCosts(list);
  assert.equal(cost.inputTokens, 300);
  assert.equal(cost.outputTokens, 130);
  assert.equal(cost.estimatedCostUsd, 0.003);
});

test("builder-diagnostics: sumAttemptCosts on empty list returns zero with model=unknown", () => {
  const cost = sumAttemptCosts([]);
  assert.equal(cost.model, "unknown");
  assert.equal(cost.estimatedCostUsd, 0);
});

test("builder-diagnostics: sumAttemptCosts uses last successful model in summary", () => {
  const list = [
    rec({ model: "fast-model", outcome: "guard-export-loss", estimatedCostUsd: 0.01 }),
    rec({ model: "premium-model", outcome: "success", estimatedCostUsd: 0.05 }),
  ];
  const cost = sumAttemptCosts(list);
  assert.equal(cost.model, "premium-model");
  assert.equal(cost.estimatedCostUsd, 0.06);
});

test("builder-diagnostics: failure-only list still aggregates cost (no successful tip)", () => {
  const list = [
    rec({ model: "m1", outcome: "guard-empty-diff", estimatedCostUsd: 0.001 }),
    rec({ model: "m2", outcome: "guard-export-loss", estimatedCostUsd: 0.002 }),
  ];
  const cost = sumAttemptCosts(list);
  assert.equal(cost.model, "m2"); // last attempt's model
  assert.equal(cost.estimatedCostUsd, 0.003);
});
