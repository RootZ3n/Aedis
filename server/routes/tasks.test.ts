import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReceiptStore } from "../../core/receipt-store.js";
import { taskRoutes } from "./tasks.js";

test("GET / returns recent tasks for callers that probe /tasks", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-tasks-route-"));

  try {
    const receiptStore = new ReceiptStore(projectRoot);
    await receiptStore.patchRun("run-newer", {
      prompt: "newer task",
      taskSummary: "newer task",
      status: "COMPLETE",
      finalClassification: "VERIFIED_PASS",
      completedAt: "2026-04-22T18:00:05.000Z",
      totalCost: { model: "test", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.0123 },
    });
    await receiptStore.registerTask({
      taskId: "task-newer",
      runId: "run-newer",
      prompt: "newer task",
      submittedAt: "2026-04-22T18:00:00.000Z",
    });
    await receiptStore.updateTask("task-newer", {
      status: "complete",
      completedAt: "2026-04-22T18:00:05.000Z",
    });

    await receiptStore.patchRun("run-older", {
      prompt: "older task",
      taskSummary: "older task",
      status: "FAILED",
      finalClassification: "VERIFIED_FAIL",
      completedAt: "2026-04-22T17:00:05.000Z",
      totalCost: { model: "test", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.0456 },
    });
    await receiptStore.registerTask({
      taskId: "task-older",
      runId: "run-older",
      prompt: "older task",
      submittedAt: "2026-04-22T17:00:00.000Z",
    });
    await receiptStore.updateTask("task-older", {
      status: "failed",
      completedAt: "2026-04-22T17:00:05.000Z",
    });

    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore,
      coordinator: {},
      eventBus: { emit: () => {} },
      config: { projectRoot },
    });
    await app.register(taskRoutes);

    const res = await app.inject({
      method: "GET",
      url: "/?limit=1&sort=desc",
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.count, 1);
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].task_id, "task-newer");
    assert.equal(body.tasks[0].run_id, "run-newer");
    assert.equal(body.tasks[0].verdict, "VERIFIED_PASS");
    assert.equal(body.tasks[0].cost, 0.0123);

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("POST /:id/promote resolves persisted task after restart-like state reload", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-tasks-promote-"));

  try {
    const receiptStore = new ReceiptStore(projectRoot);
    await receiptStore.patchRun("run-promote", {
      prompt: "promote persisted run",
      taskSummary: "ready",
      status: "READY_FOR_PROMOTION",
    });
    await receiptStore.registerTask({
      taskId: "task-promote",
      runId: "run-promote",
      prompt: "promote persisted run",
      submittedAt: "2026-04-22T18:00:00.000Z",
    });
    await receiptStore.updateTask("task-promote", { status: "complete" });

    let promotedRunId: string | null = null;
    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore,
      coordinator: {
        promoteToSource: async (runId: string) => {
          promotedRunId = runId;
          return { ok: true, commitSha: "abc123" };
        },
      },
      eventBus: { emit: () => {} },
      config: { projectRoot },
    });
    await app.register(taskRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/task-promote/promote",
      payload: {},
    });

    assert.equal(res.statusCode, 200);
    assert.equal(promotedRunId, "run-promote");
    const body = res.json();
    assert.equal(body.task_id, "task-promote");
    assert.equal(body.run_id, "run-promote");
    assert.equal(body.commit_sha, "abc123");

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("POST /:id/promote returns clear failure for bad persisted artifact", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-tasks-promote-bad-"));

  try {
    const receiptStore = new ReceiptStore(projectRoot);
    await receiptStore.patchRun("run-bad", {
      prompt: "bad promote",
      taskSummary: "ready",
      status: "READY_FOR_PROMOTION",
    });

    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore,
      coordinator: {
        promoteToSource: async () => ({ ok: false, error: "No patch artifact and no workspace path in receipt" }),
      },
      eventBus: { emit: () => {} },
      config: { projectRoot },
    });
    await app.register(taskRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/run-bad/promote",
      payload: {},
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error, "Promotion failed");
    assert.match(body.message, /No patch artifact/);
    assert.match(body.action, /Re-run the task|receipt/i);

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("POST /loqui/unified dispatches Tier 1 file edits through canonical build submission", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-tasks-loqui-build-"));
  const prompt = "In src/message.ts, change hello to hello from test 3";
  let capturedSubmission: { input: string; projectRoot?: string } | null = null;

  try {
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "message.ts"), `export const message = "hello";\n`);

    const receiptStore = new ReceiptStore(projectRoot);
    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore,
      coordinator: {
        submitWithGates: async (submission: { input: string; projectRoot?: string }) => {
          capturedSubmission = submission;
          return {
            kind: "executing",
            receipt: new Promise(() => {}),
          };
        },
      },
      eventBus: { emit: () => {} },
      config: { projectRoot },
    });
    await app.register(taskRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/loqui/unified",
      payload: {
        input: prompt,
        repoPath: projectRoot,
        context: { projectRoot },
      },
    });

    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.equal(body.route, "build");
    assert.equal(body.status, "running");
    assert.equal(body.prompt, prompt);
    assert.equal(capturedSubmission?.input, prompt);
    assert.equal(capturedSubmission?.projectRoot, projectRoot);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("POST /loqui legacy endpoint executes build prompts instead of answering with diagnostics", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-tasks-loqui-legacy-build-"));
  const prompt = "In src/message.ts, change hello to hello from test 3";
  let capturedSubmission: { input: string; projectRoot?: string } | null = null;

  try {
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "message.ts"), `export const message = "hello";\n`);

    const receiptStore = new ReceiptStore(projectRoot);
    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore,
      coordinator: {
        submitWithGates: async (submission: { input: string; projectRoot?: string }) => {
          capturedSubmission = submission;
          return {
            kind: "executing",
            receipt: new Promise(() => {}),
          };
        },
      },
      eventBus: { emit: () => {} },
      config: { projectRoot },
    });
    await app.register(taskRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/loqui",
      payload: {
        question: prompt,
        repoPath: projectRoot,
      },
    });

    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.equal(body.route, "build");
    assert.equal(body.status, "running");
    assert.equal(body.answer, undefined);
    assert.equal(capturedSubmission?.input, prompt);
    assert.equal(capturedSubmission?.projectRoot, projectRoot);
    assert.doesNotMatch(JSON.stringify(body), /\bfind\s+\./i);
    assert.doesNotMatch(JSON.stringify(body), /\bgit status\b/i);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("POST /loqui legacy endpoint returns one clarification for unresolved build targets", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-tasks-loqui-legacy-clarify-"));
  const prompt = "In src/message.ts, change hello to hello from test 3";
  let submitCount = 0;

  try {
    const receiptStore = new ReceiptStore(projectRoot);
    const app = fastify();
    (app as any).decorate("ctx", {
      receiptStore,
      coordinator: {
        submitWithGates: async () => {
          submitCount += 1;
          return {
            kind: "needs_clarification",
            question: "I could not find src/message.ts or a unique message.ts match. Which file should I edit?",
          };
        },
      },
      eventBus: { emit: () => {} },
      config: { projectRoot },
    });
    await app.register(taskRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/loqui",
      payload: {
        question: prompt,
        repoPath: projectRoot,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.route, "clarify");
    assert.equal(body.status, "needs_clarification");
    assert.equal(body.answer, undefined);
    assert.equal(submitCount, 1, "build prompt must reach canonical submit gate once");
    assert.match(body.clarification, /which file should i edit/i);
    assert.doesNotMatch(JSON.stringify(body), /\bfind\s+\./i);
    assert.doesNotMatch(JSON.stringify(body), /\bgit status\b/i);

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
