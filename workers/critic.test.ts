/**
 * Critic worker — declared fallback chain regression.
 *
 * Run 2b2b71d9 surfaced this gap on a real provider failure:
 *   - .aedis/model-config.json declared:
 *       critic: {
 *         provider: "ollama", model: "qwen3.5:9b",
 *         chain: [
 *           { provider: "ollama",     model: "qwen3.5:9b" },
 *           { provider: "openrouter", model: "xiaomi/mimo-v2.5" }
 *         ]
 *       }
 *   - Ollama was stopped; the primary failed.
 *   - Critic fell back — but to portum/qwen3.6-plus (the constructor-
 *     level legacy default), NOT the declared openrouter entry.
 *   - Live log "[critic] dispatching with fallback chain (1 entries)"
 *     was the smoking gun: only the primary made it through.
 *
 * Root cause: workers/critic.ts:buildInvocationChain only consulted
 * `this.fallbackModel` (constructor default). It never read the
 * declared `chain[]` from model-config.json. Builder already had this
 * (resolveBuilderChainForTier + getDeclaredFallbackChain); critic was
 * a copy-paste of the pre-declarative-chain pattern.
 *
 * Pin the post-fix invariants:
 *   1. Declared chain wins — constructor `fallbackModel` is NOT
 *      appended when a chain is declared.
 *   2. No declared chain → legacy constructor `fallbackModel` is
 *      preserved (back-compat for single-entry configs).
 *   3. Declared chain is passed through verbatim — portum is NOT
 *      silently appended unless portum appears in the chain.
 *   4. Chain entries that duplicate the primary are deduped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CriticWorker,
  truncateDiffForReview,
  summarizeChangesForCriticReview,
  MAX_DIFF_CHARS_PER_FILE,
  MAX_DIFF_CHARS_TOTAL,
} from "./critic.js";
import type { Provider } from "../core/model-invoker.js";
import type {
  WorkerAssignment,
  WorkerResult,
  BuilderOutput,
  FileChange,
} from "./base.js";
import type { TaskContract } from "./builder.js";

function makeRepoWithCriticConfig(criticAssignment: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-critic-chain-"));
  mkdirSync(join(dir, ".aedis"), { recursive: true });
  writeFileSync(
    join(dir, ".aedis/model-config.json"),
    JSON.stringify({
      scout: { model: "local", provider: "local" },
      builder: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
      critic: criticAssignment,
      verifier: { model: "local", provider: "local" },
      integrator: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
      escalation: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
      coordinator: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
    }),
    "utf-8",
  );
  return dir;
}

// Cast helper: buildInvocationChain and getDeclaredFallbackChain are
// private, but their behavior is the regression surface this file
// exists to pin. A typed-any cast is more honest than re-architecting
// the worker to expose them.
function callBuildChain(
  worker: CriticWorker,
  primaryProvider: Provider,
  primaryModel: string,
  declaredChain?: { provider: string; model: string }[],
): Array<{ provider: string; model: string }> {
  return (worker as unknown as {
    buildInvocationChain: (
      p: Provider, m: string, prompt: string, t: number,
      d?: readonly { provider: string; model: string }[],
    ) => Array<{ provider: string; model: string }>;
  }).buildInvocationChain(primaryProvider, primaryModel, "test prompt", 1024, declaredChain);
}

function callGetDeclaredChain(worker: CriticWorker, configRoot: string): Array<{ provider: string; model: string }> {
  return (worker as unknown as {
    getDeclaredFallbackChain: (root: string) => readonly { provider: string; model: string }[];
  }).getDeclaredFallbackChain(configRoot) as Array<{ provider: string; model: string }>;
}

// ─── buildInvocationChain: declared-vs-legacy dispatch ──────────────

test("critic buildInvocationChain: declared chain wins; constructor fallbackModel is NOT appended", () => {
  // The exact run-2b2b71d9 shape: ollama primary, declared openrouter
  // chain entry. portum (the constructor default) must NOT appear.
  const worker = new CriticWorker({
    fallbackModel: { provider: "portum" as Provider, model: "qwen3.6-plus" },
  });
  const chain = callBuildChain(worker, "ollama", "qwen3.5:9b", [
    { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  ]);
  assert.deepEqual(
    chain.map((c) => `${c.provider}/${c.model}`),
    ["ollama/qwen3.5:9b", "openrouter/xiaomi/mimo-v2.5"],
    "declared openrouter must follow primary; portum must NOT be silently appended",
  );
});

test("critic buildInvocationChain: no declared chain → legacy fallbackModel is preserved", () => {
  // Back-compat: configs that don't declare chain[] should still get
  // their constructor-level fallback so single-entry model-config.json
  // files don't regress.
  const worker = new CriticWorker({
    fallbackModel: { provider: "ollama" as Provider, model: "qwen3.5:9b" },
  });
  const chain = callBuildChain(worker, "openrouter", "xiaomi/mimo-v2.5", undefined);
  assert.deepEqual(
    chain.map((c) => `${c.provider}/${c.model}`),
    ["openrouter/xiaomi/mimo-v2.5", "ollama/qwen3.5:9b"],
    "legacy fallback must be appended when no declared chain is provided",
  );
});

test("critic buildInvocationChain: empty declared chain ([]) also falls back to legacy fallbackModel", () => {
  // [] from getDeclaredFallbackChain means "no chain declared OR config
  // unreadable." Treat the same as undefined — preserve back-compat.
  const worker = new CriticWorker({
    fallbackModel: { provider: "ollama" as Provider, model: "qwen3.5:9b" },
  });
  const chain = callBuildChain(worker, "openrouter", "xiaomi/mimo-v2.5", []);
  assert.deepEqual(
    chain.map((c) => `${c.provider}/${c.model}`),
    ["openrouter/xiaomi/mimo-v2.5", "ollama/qwen3.5:9b"],
  );
});

test("critic buildInvocationChain: chain entry that duplicates the primary is deduped", () => {
  // A self-referencing declaration (e.g. user listed primary in chain)
  // must NOT cause an immediate retry of the same provider/model.
  const worker = new CriticWorker({
    fallbackModel: { provider: "portum" as Provider, model: "qwen3.6-plus" },
  });
  const chain = callBuildChain(worker, "ollama", "qwen3.5:9b", [
    { provider: "ollama", model: "qwen3.5:9b" }, // dup of primary
    { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  ]);
  assert.deepEqual(
    chain.map((c) => `${c.provider}/${c.model}`),
    ["ollama/qwen3.5:9b", "openrouter/xiaomi/mimo-v2.5"],
  );
});

test("critic buildInvocationChain: declared chain with multiple entries threads through in order", () => {
  const worker = new CriticWorker();
  const chain = callBuildChain(worker, "ollama", "qwen3.5:9b", [
    { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    { provider: "minimax", model: "minimax-coding" },
    { provider: "zai", model: "glm-5.1" },
  ]);
  assert.deepEqual(
    chain.map((c) => `${c.provider}/${c.model}`),
    [
      "ollama/qwen3.5:9b",
      "openrouter/xiaomi/mimo-v2.5",
      "minimax/minimax-coding",
      "zai/glm-5.1",
    ],
  );
});

test("critic buildInvocationChain: portum is only present if portum is declared in the chain", () => {
  // Defense: prove portum is data-driven, not a hidden default. The
  // run-2b2b71d9 surprise was portum showing up despite never being
  // declared. With the fix, portum only appears when the user puts it
  // in the chain explicitly.
  const worker = new CriticWorker({
    fallbackModel: { provider: "portum" as Provider, model: "qwen3.6-plus" }, // legacy default
  });
  const chainNoPortum = callBuildChain(worker, "ollama", "qwen3.5:9b", [
    { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  ]);
  assert.equal(
    chainNoPortum.some((c) => c.provider === "portum"),
    false,
    "portum must NOT appear when not declared (constructor default is suppressed by the declared chain)",
  );

  const chainWithPortum = callBuildChain(worker, "ollama", "qwen3.5:9b", [
    { provider: "portum" as Provider, model: "qwen3.6-plus" },
    { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  ]);
  assert.equal(
    chainWithPortum.some((c) => c.provider === "portum"),
    true,
    "portum must appear when explicitly declared in the chain",
  );
});

// ─── getDeclaredFallbackChain: end-to-end via model-config.json ─────

test("critic getDeclaredFallbackChain: reads declared chain tail from .aedis/model-config.json", () => {
  // Reproduce the exact run-2b2b71d9 config shape.
  const repo = makeRepoWithCriticConfig({
    provider: "ollama",
    model: "qwen3.5:9b",
    chain: [
      { provider: "ollama", model: "qwen3.5:9b" },
      { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    ],
  });
  try {
    const worker = new CriticWorker();
    const tail = callGetDeclaredChain(worker, repo);
    // Tail = entries AFTER the primary. Primary (ollama) is the head
    // and is added separately by buildInvocationChain.
    assert.deepEqual(
      tail.map((c) => `${c.provider}/${c.model}`),
      ["openrouter/xiaomi/mimo-v2.5"],
      "declared chain tail must be one entry: the openrouter fallback",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("critic getDeclaredFallbackChain: returns [] when no chain is declared (legacy single-assignment)", () => {
  const repo = makeRepoWithCriticConfig({
    provider: "openrouter",
    model: "xiaomi/mimo-v2.5",
  });
  try {
    const worker = new CriticWorker();
    const tail = callGetDeclaredChain(worker, repo);
    assert.deepEqual(tail, [], "single-assignment config must produce empty tail (legacy fallback path stays alive)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("critic getDeclaredFallbackChain: returns [] when configRoot is unreadable", () => {
  // Defensive: if the config file can't be loaded (missing dir,
  // permissions, corrupted JSON), getDeclaredFallbackChain must NOT
  // throw — it returns [] so buildInvocationChain falls back to the
  // legacy constructor default.
  const worker = new CriticWorker();
  const tail = callGetDeclaredChain(worker, "/nonexistent/path/" + Date.now());
  assert.deepEqual(tail, []);
});

// ─── Cancellation propagation: providerAttempts must surface cancel ───
//
// Run 097adb9c surfaced this bug: a cancelled in-flight model call left
// providerAttempts[] empty in the receipt, so operators couldn't see
// "we attempted provider X and it was aborted." The fix wraps the
// invokeModelWithFallback call site in a try/catch that extracts
// err.attempts from a thrown InvokerError before re-throwing.
//
// End-to-end test: pre-aborted signal → CriticWorker.execute() catches
// the cancellation → WorkerResult.providerAttempts contains the
// cancelled attempt(s). Without the fix, providerAttempts would be [].

function buildCriticAssignmentWithBuilderUpstream(
  projectRoot: string,
  signal: AbortSignal,
): WorkerAssignment {
  const targetFile = "core/foo.ts";
  const change: FileChange = {
    path: targetFile,
    operation: "modify",
    content: "export const foo = 2;\n",
    originalContent: "export const foo = 1;\n",
  };
  const contract: TaskContract = {
    file: targetFile,
    scopeFiles: [targetFile],
    siblingFiles: [],
    mode: "single-file",
    goal: "Update foo constant",
    constraints: [],
    forbiddenChanges: [],
    interfaceRules: [],
  };
  const builderOutput: BuilderOutput & { contract: TaskContract } = {
    kind: "builder",
    changes: [change],
    decisions: [],
    needsCriticReview: true,
    contract,
  };
  const builderResult: WorkerResult = {
    success: true,
    workerType: "builder",
    taskId: "task-builder-upstream",
    output: builderOutput,
    cost: { model: "xiaomi/mimo-v2.5", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    confidence: 0.9,
    touchedFiles: [{ path: targetFile, operation: "modify" }],
    assumptions: [],
    issues: [],
    durationMs: 1,
  };
  return {
    task: {
      id: "critic-task-001",
      description: "Critic on foo",
      targetFiles: [targetFile],
      type: "critic",
      status: "pending",
      dependencies: [],
      result: null,
      cost: null,
    } as unknown as WorkerAssignment["task"],
    intent: {
      id: "intent-001",
      runId: "run-cancel-test",
      userRequest: "modify foo",
    } as unknown as WorkerAssignment["intent"],
    context: { layers: [] } as unknown as WorkerAssignment["context"],
    upstreamResults: [builderResult],
    tier: "standard",
    tokenBudget: 1024,
    projectRoot,
    sourceRepo: projectRoot,
    signal,
  } as WorkerAssignment;
}

test("CriticWorker.execute: pre-aborted signal still surfaces cancelled attempt in WorkerResult.providerAttempts (run 097adb9c regression)", async () => {
  const repo = makeRepoWithCriticConfig({
    provider: "openrouter",
    model: "xiaomi/mimo-v2.5",
  });
  try {
    process.env.OPENROUTER_API_KEY = "test"; // required for chain build
    const worker = new CriticWorker({ projectRoot: repo });

    // Pre-abort BEFORE dispatch so invokeModelWithFallback short-
    // circuits in its first chain entry and throws InvokerError with
    // attempts populated. The worker's catch must extract those attempts
    // and surface them in the failed WorkerResult — that's the fix.
    const ctrl = new AbortController();
    ctrl.abort();
    const assignment = buildCriticAssignmentWithBuilderUpstream(repo, ctrl.signal);

    const result = await worker.execute(assignment);

    assert.equal(result.success, false, "execute must fail when signal is pre-aborted");
    assert.ok(
      result.providerAttempts && result.providerAttempts.length > 0,
      `providerAttempts must be populated even on cancellation; got ${JSON.stringify(result.providerAttempts)}`,
    );
    const cancelled = result.providerAttempts!.filter((a) => a.outcome === "cancelled");
    assert.ok(
      cancelled.length > 0,
      `at least one cancelled attempt must be recorded; got outcomes=${result.providerAttempts!.map((a) => a.outcome).join(",")}`,
    );
    assert.equal(cancelled[0]!.provider, "openrouter");
    assert.equal(cancelled[0]!.model, "xiaomi/mimo-v2.5");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("critic getDeclaredFallbackChain: end-to-end matches run-2b2b71d9 expected shape", () => {
  // Compose the two pieces: read the chain from a real config file,
  // then thread it through buildInvocationChain. Result must be the
  // exact 2-entry chain the run-2b2b71d9 config asked for. No portum,
  // no surprises.
  const repo = makeRepoWithCriticConfig({
    provider: "ollama",
    model: "qwen3.5:9b",
    chain: [
      { provider: "ollama", model: "qwen3.5:9b" },
      { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    ],
  });
  try {
    const worker = new CriticWorker({
      // Constructor default deliberately set to portum to prove the
      // declared chain suppresses it (this is the fix's whole point).
      fallbackModel: { provider: "portum" as Provider, model: "qwen3.6-plus" },
    });
    const tail = callGetDeclaredChain(worker, repo);
    const chain = callBuildChain(worker, "ollama", "qwen3.5:9b", tail);
    assert.deepEqual(
      chain.map((c) => `${c.provider}/${c.model}`),
      ["ollama/qwen3.5:9b", "openrouter/xiaomi/mimo-v2.5"],
      "end-to-end chain must be exactly the 2 entries the user declared — no portum",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── Critic prompt truncation ────────────────────────────────────────
//
// Production observation: a Critic dispatch timed out at 180s on a
// valid Builder output. The prompt assembler had no cap on per-file or
// total diff size, so a multi-file refactor produced a prompt large
// enough that the upstream stage timeout fired while the model was
// still streaming. truncateDiffForReview / summarizeChangesForCriticReview
// bound the prompt; these tests pin the contract so it stays bounded.

test("critic truncateDiffForReview: small diffs pass through unchanged", () => {
  const small = "diff --git a/foo.ts b/foo.ts\n@@\n-old\n+new\n";
  const out = truncateDiffForReview(small, 1000);
  assert.equal(out, small, "small diffs must pass through verbatim");
});

test("critic truncateDiffForReview: oversized diffs get head + tail with elision marker", () => {
  const huge = "X".repeat(20_000);
  const out = truncateDiffForReview(huge, 1000);
  assert.ok(out.length < 2000, `truncated diff must be near the budget; got ${out.length}`);
  assert.match(
    out,
    /chars truncated for critic review/,
    "truncated diff must contain the elision marker so a human reviewer knows context was elided",
  );
  assert.ok(out.startsWith("X"), "head must be preserved");
  assert.ok(out.endsWith("X"), "tail must be preserved");
});

test("critic truncateDiffForReview: undefined and empty inputs are handled safely", () => {
  assert.equal(truncateDiffForReview(undefined, 1000), "(no diff)");
  assert.equal(truncateDiffForReview(null, 1000), "(no diff)");
  assert.equal(truncateDiffForReview("anything", 0), "(diff omitted — review budget exhausted)");
});

test("critic summarizeChangesForCriticReview: total budget is respected across many files", () => {
  // 50 files, each with a 1000-char diff. Without a total cap the
  // resulting prompt fragment would be ~50KB; the cap is
  // MAX_DIFF_CHARS_TOTAL plus per-file labels and elision markers.
  const filler = "Y".repeat(1000);
  const changes = Array.from({ length: 50 }, (_, i) => ({
    path: `core/file-${i}.ts`,
    diff: filler,
  }));
  const summary = summarizeChangesForCriticReview(changes);
  // Allow some overhead per entry for "path:" labels and elision text,
  // but the sum of diff bodies must be near MAX_DIFF_CHARS_TOTAL.
  assert.ok(
    summary.length < MAX_DIFF_CHARS_TOTAL * 2,
    `summary must be bounded; got ${summary.length} chars (cap=${MAX_DIFF_CHARS_TOTAL})`,
  );
  assert.match(
    summary,
    /diff omitted — total review budget exhausted/,
    "files past the budget must be marked as omitted, not silently dropped",
  );
});

test("critic summarizeChangesForCriticReview: per-file cap kicks in even when total budget allows more", () => {
  // One file with a diff larger than MAX_DIFF_CHARS_PER_FILE — should
  // be truncated even though the total budget could accommodate it.
  const huge = "Z".repeat(MAX_DIFF_CHARS_PER_FILE * 3);
  const summary = summarizeChangesForCriticReview([{ path: "core/big.ts", diff: huge }]);
  assert.ok(
    summary.length < MAX_DIFF_CHARS_PER_FILE * 2,
    `single oversized file must be capped; got ${summary.length} chars (per-file cap=${MAX_DIFF_CHARS_PER_FILE})`,
  );
  assert.match(summary, /chars truncated for critic review/);
});

// ─── Critic compact-prompt retry shape ──────────────────────────────
//
// The retry-with-reduced-context path uses buildCompactPrompt instead
// of buildPrompt. buildCompactPrompt strips diff bodies entirely,
// keeps a manifest of paths + operations, and pulls the acceptance
// criteria from the intent's charter so the model still has the
// review surface even without the diff. Tested via a typed-any cast
// (same pattern as buildInvocationChain above).

interface CompactPromptCallable {
  buildCompactPrompt: (
    contract: TaskContract,
    changes: readonly FileChange[],
    issues: readonly { severity: string; message: string }[],
    assignment: WorkerAssignment,
    model: string,
  ) => string;
  buildPrompt: (
    contract: TaskContract,
    changes: readonly FileChange[],
    issues: readonly { severity: string; message: string }[],
    assignment: WorkerAssignment,
    model: string,
  ) => string;
}

function makeAssignmentWithIntent(criteria: readonly string[]): WorkerAssignment {
  // Minimal WorkerAssignment shape — only the fields buildCompactPrompt
  // / buildPrompt actually read. The rest stay defaulted via casts so
  // the test does not have to fabricate an entire RunState.
  return {
    task: {
      id: "t1",
      parentTaskId: null,
      workerType: "critic",
      description: "Review changes for the Token alias refactor",
      targetFiles: ["core/types.ts"],
      status: "active",
      assignedTo: null,
      result: null,
      startedAt: null,
      completedAt: null,
      costAccrued: null,
    },
    intent: {
      id: "intent-1", runId: "run-1", version: 1, parentId: null,
      createdAt: new Date().toISOString(),
      userRequest: "introduce a Token alias",
      charter: {
        objective: "introduce a Token alias",
        successCriteria: criteria,
        deliverables: [],
        qualityBar: "standard",
      },
      constraints: [],
      acceptedAssumptions: [],
      exclusions: [],
      revisionReason: null,
    },
    context: { layers: [] } as unknown as WorkerAssignment["context"],
    upstreamResults: [],
    tier: "fast",
    tokenBudget: 1024,
  } as unknown as WorkerAssignment;
}

test("critic buildCompactPrompt: strips diff bodies and includes manifest + acceptance criteria", () => {
  const worker = new CriticWorker({ defaultModel: "test", defaultProvider: "ollama" });
  const compact = (worker as unknown as CompactPromptCallable);
  const huge = "Z".repeat(8000);
  const changes: FileChange[] = [
    { path: "core/types.ts", operation: "modify", diff: huge, content: huge, originalContent: "" },
    { path: "core/consumer.ts", operation: "modify", diff: huge, content: huge, originalContent: "" },
  ];
  const contract: TaskContract = {
    file: "core/types.ts",
    forbiddenChanges: [],
    interfaceRules: ["public Token alias must remain exported"],
    expectedSignatures: [],
  } as unknown as TaskContract;
  const assignment = makeAssignmentWithIntent([
    "Token alias is exported from core/types.ts",
    "core/consumer.ts imports Token from core/types.ts",
  ]);
  const out = compact.buildCompactPrompt(contract, changes, [], assignment, "test-model");
  // Manifest must list both files with their operations.
  assert.match(out, /core\/types\.ts \(modify\)/);
  assert.match(out, /core\/consumer\.ts \(modify\)/);
  // Acceptance criteria from the intent must be reflected.
  assert.match(out, /Token alias is exported from core\/types\.ts/);
  assert.match(out, /core\/consumer\.ts imports Token/);
  // Diff bodies must NOT leak into the compact prompt.
  assert.ok(
    !out.includes(huge),
    "compact prompt must NOT include raw diff bodies; that defeats the size reduction",
  );
});

test("critic buildCompactPrompt: noticeably smaller than buildPrompt on the same changeset", () => {
  const worker = new CriticWorker({ defaultModel: "test", defaultProvider: "ollama" });
  const dual = (worker as unknown as CompactPromptCallable);
  const huge = "X".repeat(20_000);
  const changes: FileChange[] = [
    { path: "core/a.ts", operation: "modify", diff: huge, content: huge, originalContent: "" },
    { path: "core/b.ts", operation: "modify", diff: huge, content: huge, originalContent: "" },
    { path: "core/c.ts", operation: "modify", diff: huge, content: huge, originalContent: "" },
  ];
  const contract: TaskContract = {
    file: "core/a.ts",
    forbiddenChanges: [],
    interfaceRules: [],
    expectedSignatures: [],
  } as unknown as TaskContract;
  const assignment = makeAssignmentWithIntent(["criterion 1"]);
  const full = dual.buildPrompt(contract, changes, [], assignment, "m");
  const compact = dual.buildCompactPrompt(contract, changes, [], assignment, "m");
  assert.ok(
    compact.length * 4 < full.length,
    `compact prompt must be at least 4× smaller than the full prompt on a 60KB diff change-set; got compact=${compact.length} full=${full.length}`,
  );
});

// ─── Critic model override from .aedis/model-config.json ─────────────
//
// The Critic resolves its primary model via getActiveModelConfig, which
// reads .aedis/model-config.json on the source repo. This is the
// existing routing surface — repos that want a fast/cheap model for
// Critic just set it there; Builder is unaffected because it reads its
// own builder.{model,provider} entry from the same config.

test("critic getActiveModelConfig: per-repo override is respected for critic without affecting builder", () => {
  const repo = mkdtempSync(join(tmpdir(), "aedis-critic-override-"));
  mkdirSync(join(repo, ".aedis"), { recursive: true });
  writeFileSync(
    join(repo, ".aedis/model-config.json"),
    JSON.stringify({
      scout: { model: "local", provider: "local" },
      builder: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
      critic: { model: "qwen3.5:9b", provider: "ollama" },
      verifier: { model: "local", provider: "local" },
      integrator: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
      escalation: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
      coordinator: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
    }),
    "utf-8",
  );

  try {
    const worker = new CriticWorker({
      defaultModel: "constructor-default",
      defaultProvider: "openrouter",
    });
    // Private getActiveModelConfig is the resolution surface; cast to
    // call directly. Mirrors the existing test pattern.
    const resolved = (worker as unknown as {
      getActiveModelConfig: (root: string) => { model: string; provider: string };
    }).getActiveModelConfig(repo);
    assert.equal(
      resolved.model,
      "qwen3.5:9b",
      "critic must resolve its model from .aedis/model-config.json — not the constructor default",
    );
    assert.equal(
      resolved.provider,
      "ollama",
      "critic provider override from model-config must be respected",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
