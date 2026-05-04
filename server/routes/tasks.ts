/**
 * Task routes — Submit, query, and cancel build tasks.
 *
 * POST /tasks       — Submit a new task, returns { task_id, run_id }
 * GET  /tasks/:id   — Status + current run state
 * GET  /tasks/:id/receipts — Full receipt bundle
 * POST /tasks/:id/cancel — Cancel a running task
 * DELETE /tasks/:id — Cancel a running task
 */

import { randomUUID } from "crypto";
import { existsSync } from "fs";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { askLoqui } from "../../core/loqui.js";
import { routeLoquiInput, type LoquiRouteDecision } from "../../core/loqui-router.js";
import { redactText, redactError } from "../../core/redaction.js";
import type { LoquiIntentContext } from "../../core/loqui-intent.js";
import { generateDryRun } from "../../core/dry-run.js";
import { detectPlanAssist } from "../../core/plan-assist.js";
import { detectPlanAssistWithScouts } from "../../core/plan-assist-with-scouts.js";
import type { RunReceipt } from "../../core/coordinator.js";
import type { ServerContext } from "../index.js";

// ─── Request/Response Schemas ────────────────────────────────────────

interface SubmitBody {
  /** Natural language prompt — also accepted as "input" */
  prompt?: string;
  input?: string;
  /** Repo path to operate on */
  repoPath?: string;
  exclusions?: string[];
  quality_bar?: "minimal" | "standard" | "hardened";
}

interface TaskParams {
  id: string;
}

interface LoquiBody {
  question: string;
  repoPath: string;
}

/**
 * Unified Loqui route request body. A single freeform input stream
 * that the classifier will route to build / answer / resume /
 * clarify. The `context` field is optional — the UI passes it when
 * it knows about a prior run so the classifier can emit resume_run
 * or status intents safely (see core/loqui-intent.ts Rule B).
 */
interface LoquiUnifiedBody {
  input: string;
  repoPath: string;
  context?: LoquiIntentContext;
}

// ─── In-memory run tracker (bridges POST → Coordinator → WS) ────────

interface TrackedRun {
  taskId: string;
  runId: string;
  status: "queued" | "running" | "complete" | "partial" | "failed" | "cancelled";
  prompt: string;
  submittedAt: string;
  completedAt: string | null;
  receipt: unknown | null;
  error: string | null;
}

const trackedRuns = new Map<string, TrackedRun>();

/**
 * In-memory map of Loqui route decisions, keyed by the Coordinator
 * runId. Populated by /tasks/loqui/unified at submit time so /runs/:id
 * can surface the original intent badge / confidence / signals long
 * after the chat panel has scrolled away. Pure observability — never
 * gates anything; safe to forget across restarts (the UI degrades to
 * "decision unavailable").
 */
const loquiDecisionsByRunId = new Map<string, LoquiRouteDecision>();
const loquiDecisionsByTaskId = new Map<string, LoquiRouteDecision>();

export function recordLoquiDecisionForRun(
  decision: LoquiRouteDecision,
  ids: { runId?: string | null; taskId?: string | null },
): void {
  if (ids.runId) loquiDecisionsByRunId.set(ids.runId, decision);
  if (ids.taskId) loquiDecisionsByTaskId.set(ids.taskId, decision);
}

export function getLoquiDecisionForRun(id: string): LoquiRouteDecision | undefined {
  return loquiDecisionsByRunId.get(id) ?? loquiDecisionsByTaskId.get(id);
}

export function getTrackedRun(taskId: string): TrackedRun | undefined {
  return trackedRuns.get(taskId);
}

/**
 * Snapshot of every tracked run, newest first. Read-only — returns
 * a fresh array so callers can iterate / sort / slice without
 * touching the internal Map. Used by the external API layer
 * (Metrics + External API v1) so /metrics, /runs, and /runs/:id
 * can aggregate across the same registry that /tasks writes to,
 * without importing the private Map or creating a second source
 * of truth.
 */
export function getAllTrackedRuns(): readonly TrackedRun[] {
  const out = [...trackedRuns.values()];
  out.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
  return out;
}

/** Exported type for the external API routes. */
export type { TrackedRun };

/**
 * Register a tracked run for an approved decomposition plan and wire
 * the receipt-promise → tracker-status bridge. Mirrors the inline
 * logic in POST /tasks/:id/approve so the new POST /plans/:id/approve
 * route can reuse it without duplicating the bookkeeping.
 *
 * Returns the assigned taskId and a placeholder runId; both are
 * updated when the receipt resolves so polling endpoints see the
 * real Coordinator runId.
 */
export function registerTrackedPlanRun(
  planId: string,
  receiptPromise: Promise<RunReceipt>,
  ctx: ServerContext,
): { taskId: string; runId: string } {
  const taskId = `task_${randomUUID().slice(0, 8)}`;
  const runId = randomUUID();
  const submittedAt = new Date().toISOString();
  const tracked: TrackedRun = {
    taskId,
    runId,
    status: "running",
    prompt: `(approved plan ${planId})`,
    submittedAt,
    completedAt: null,
    receipt: null,
    error: null,
  };
  trackedRuns.set(taskId, tracked);

  receiptPromise.then((receipt) => {
    tracked.runId = receipt.runId;
    tracked.status =
      receipt.verdict === "success" ? "complete" :
      receipt.verdict === "partial" ? "partial" :
      receipt.verdict === "aborted" ? "cancelled" : "failed";
    tracked.completedAt = new Date().toISOString();
    tracked.receipt = receipt;
    ctx.eventBus.emit({
      type: "run_complete",
      payload: {
        taskId,
        runId: receipt.runId,
        verdict: receipt.verdict,
        totalCostUsd: receipt.totalCost.estimatedCostUsd,
        durationMs: receipt.durationMs,
        executionVerified: receipt.executionVerified,
        executionReason: receipt.executionGateReason,
      },
    });
  }).catch((err) => {
    tracked.status = "failed";
    tracked.completedAt = new Date().toISOString();
    tracked.error = redactText(err instanceof Error ? err.message : String(err));
  });

  return { taskId, runId };
}

/**
 * Result from submitBuildTask — may be a running build, a clarification
 * request, or a decomposition plan.
 */
type BuildSubmitResult =
  | { kind: "running"; taskId: string; runId: string; prompt: string; repoPath: string | null }
  | { kind: "needs_clarification"; question: string }
  | { kind: "needs_decomposition"; taskId: string; plan: unknown; message: string }
  | { kind: "blocked"; reason: string; flags: readonly string[] };

/**
 * Build a needs_decomposition API response with approval instructions.
 * Ensures every decomposition response tells the caller exactly how to
 * approve the plan — no more stranded work from missing UX.
 */
function buildDecompositionResponse(result: { taskId: string; plan: unknown; message: string }) {
  return {
    status: "needs_decomposition" as const,
    task_id: result.taskId,
    plan: result.plan,
    message: result.message,
    approve_url: `/tasks/${result.taskId}/approve`,
    approve_command: `curl -X POST http://localhost:18796/tasks/${result.taskId}/approve`,
    instructions: "POST to approve_url to approve and execute this plan, or submit a refined prompt.",
  };
}

/**
 * Shared build-submit helper. Dispatches a build task through the
 * Coordinator (via submitWithGates) and registers the tracked run state.
 * Used by both the legacy POST /tasks handler and the new unified POST
 * /tasks/loqui path so we get exactly one code path for "start a build."
 *
 * Now returns a discriminated union so callers can handle clarification
 * and decomposition gates without starting execution.
 */
async function submitBuildTask(
  ctx: ServerContext,
  prompt: string,
  repoPath: string | undefined,
  exclusions: string[] | undefined,
): Promise<BuildSubmitResult> {
  const taskId = `task_${randomUUID().slice(0, 8)}`;
  const runId = randomUUID();
  const submittedAt = new Date().toISOString();

  // Run pre-execution gates (ambiguity + decomposition)
  const gateResult = await ctx.coordinator.submitWithGates({
    runId,
    input: prompt,
    exclusions,
    ...(repoPath ? { projectRoot: repoPath } : {}),
  });

  if (gateResult.kind === "blocked") {
    console.warn(
      `[tasks] BLOCKED at submit gate — reason="${gateResult.reason}" flags=[${gateResult.flags.join(", ")}]`,
    );
    return { kind: "blocked", reason: gateResult.reason, flags: gateResult.flags };
  }

  if (gateResult.kind === "needs_clarification") {
    console.log(`[tasks] clarification needed for prompt: "${redactText(prompt.slice(0, 80))}"`);;
    return { kind: "needs_clarification", question: gateResult.question };
  }

  if (gateResult.kind === "needs_decomposition") {
    console.log(`[tasks] decomposition needed — ${(gateResult.plan as any).waves?.length ?? 0} wave(s)`);
    return {
      kind: "needs_decomposition",
      taskId: gateResult.taskId,
      plan: gateResult.plan,
      message: gateResult.message,
    };
  }

  // Gate passed — execution started
  const tracked: TrackedRun = {
    taskId,
    runId,
    status: "queued",
    prompt,
    submittedAt,
    completedAt: null,
    receipt: null,
    error: null,
  };
  trackedRuns.set(taskId, tracked);
  await ctx.receiptStore.registerTask({
    taskId,
    runId,
    prompt: tracked.prompt,
    submittedAt,
  });
  tracked.status = "running";
  void ctx.receiptStore.updateTask(taskId, { status: "running" }).catch((err: unknown) =>
    console.error("[tasks] receiptStore update failed:", err),
  );

  ctx.eventBus.emit({
    type: "run_started",
    payload: { taskId, runId, prompt: tracked.prompt, status: "running", repoPath: repoPath ?? null },
  });

  console.log(`[tasks] coordinator executing for taskId=${taskId} (projectRoot=${repoPath ?? "(default)"})...`);

  // The receipt promise is already running from submitWithGates
  gateResult.receipt.then((receipt) => {
    console.log(`[tasks] coordinator.submit resolved: taskId=${taskId}, verdict=${receipt.verdict}, cost=$${receipt.totalCost.estimatedCostUsd}`);
    tracked.runId = receipt.runId;
    tracked.status =
      receipt.verdict === "success" ? "complete" :
      receipt.verdict === "partial" ? "partial" :
      receipt.verdict === "aborted" ? "cancelled" : "failed";
    tracked.completedAt = new Date().toISOString();
    tracked.receipt = receipt;
    tracked.error = receipt.verdict === "success"
      ? null
      : (receipt.providerLaneTruth?.status === "not_run"
          ? receipt.providerLaneTruth.reason
          : receipt.rollback?.status && receipt.rollback.status !== "clean"
            ? receipt.rollback.summary
            : null);
    void ctx.receiptStore.updateTask(taskId, {
      runId: receipt.runId,
      status: tracked.status,
      completedAt: tracked.completedAt,
      error: tracked.error,
    }).catch((err: unknown) =>
      console.error("[tasks] receiptStore update failed:", err),
    );

    ctx.eventBus.emit({
      type: "run_complete",
      payload: {
        taskId,
        runId: receipt.runId,
        verdict: receipt.verdict,
        totalCostUsd: receipt.totalCost.estimatedCostUsd,
        durationMs: receipt.durationMs,
        executionVerified: receipt.executionVerified,
        executionReason: receipt.executionGateReason,
      },
    });

    ctx.eventBus.emit({
      type: "run_receipt",
      payload: { taskId, runId: receipt.runId, receiptId: receipt.id, receipt },
    });
  }).catch((err) => {
    console.error("═══ COORDINATOR SUBMIT FAILED ═══");
    console.error("taskId:", taskId);
    console.error("prompt:", redactText(tracked.prompt.slice(0, 200)));
    console.error("repoPath:", repoPath ?? "(default)");
    console.error("error:", redactError(err));
    console.error("═════════════════════════════════");

    tracked.status = "failed";
    tracked.completedAt = new Date().toISOString();
    tracked.error = redactText(err instanceof Error ? err.message : String(err));
    void ctx.receiptStore.updateTask(taskId, {
      status: "failed",
      completedAt: tracked.completedAt,
      error: tracked.error,
    }).catch((err: unknown) =>
      console.error("[tasks] receiptStore update failed:", err),
    );

    ctx.eventBus.emit({
      type: "run_complete",
      payload: {
        taskId,
        runId,
        verdict: "failed",
        error: tracked.error,
        executionVerified: false,
      },
    });
  });

  return { kind: "running", taskId, runId, prompt, repoPath: repoPath ?? null };
}

/**
 * Find the most recent tracked run so the unified Loqui route can
 * reconstruct the "continuation" prompt for a resume_run intent.
 * Returns null when the session has no prior runs — the classifier
 * already guards against this but the handler double-checks so a
 * stale client context cannot spawn a resume against nothing.
 */
function findLatestTrackedRun(): TrackedRun | null {
  let latest: TrackedRun | null = null;
  for (const run of trackedRuns.values()) {
    if (!latest) {
      latest = run;
      continue;
    }
    if (run.submittedAt > latest.submittedAt) {
      latest = run;
    }
  }
  return latest;
}

async function findLatestKnownRun(ctx: ServerContext): Promise<{
  taskId: string | null;
  runId: string;
  prompt: string;
  status: string;
} | null> {
  const tracked = findLatestTrackedRun();
  if (tracked) {
    return {
      taskId: tracked.taskId,
      runId: tracked.runId,
      prompt: tracked.prompt,
      status: tracked.status,
    };
  }

  const recent = await ctx.receiptStore.listRuns(10);
  for (const entry of recent) {
    const receipt = await ctx.receiptStore.getRun(entry.runId);
    if (!receipt) continue;
    const task = await ctx.receiptStore.getTaskByRunId(entry.runId);
    return {
      taskId: task?.taskId ?? null,
      runId: entry.runId,
      prompt: task?.prompt ?? receipt.prompt,
      status: receipt.status,
    };
  }

  return null;
}

async function findKnownRunById(
  ctx: ServerContext,
  id: string | null | undefined,
): Promise<{
  taskId: string | null;
  runId: string;
  prompt: string;
  status: string;
} | null> {
  if (!id) return null;
  const task = await ctx.receiptStore.getTask(id);
  if (task) {
    const receipt = await ctx.receiptStore.getRun(task.runId);
    return {
      taskId: task.taskId,
      runId: task.runId,
      prompt: task.prompt || receipt?.prompt || "",
      status: receipt?.status ?? task.status,
    };
  }
  const byRun = await ctx.receiptStore.getTaskByRunId(id);
  if (byRun) {
    const receipt = await ctx.receiptStore.getRun(byRun.runId);
    return {
      taskId: byRun.taskId,
      runId: byRun.runId,
      prompt: byRun.prompt || receipt?.prompt || "",
      status: receipt?.status ?? byRun.status,
    };
  }
  const receipt = await ctx.receiptStore.getRun(id);
  if (receipt) {
    return {
      taskId: null,
      runId: receipt.runId,
      prompt: receipt.prompt,
      status: receipt.status,
    };
  }
  return null;
}

// ─── Routes ──────────────────────────────────────────────────────────

export const taskRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  fastify.get<{
    Querystring: {
      limit?: string | number;
      sort?: string;
      status?: string;
    };
  }>(
    "/",
    async (request, reply) => {
      const rawLimit = Number(request.query.limit ?? 20);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(Math.trunc(rawLimit), 100))
        : 20;
      const sort = String(request.query.sort ?? "desc").toLowerCase();
      const statusFilter = typeof request.query.status === "string" && request.query.status.trim().length > 0
        ? request.query.status.trim()
        : undefined;

      const persisted = await ctx().receiptStore.listRuns(limit * 2, statusFilter);
      const tasks = await Promise.all(
        persisted.map(async (entry) => {
          const task = await ctx().receiptStore.getTaskByRunId(entry.runId);
          return {
            task_id: task?.taskId ?? null,
            run_id: entry.runId,
            prompt: task?.prompt ?? entry.prompt,
            submitted_at: task?.submittedAt ?? entry.createdAt,
            completed_at: task?.completedAt ?? entry.completedAt,
            status: task?.status ?? entry.status,
            verdict: entry.finalClassification ?? entry.status,
            cost: entry.costUsd,
            confidence: entry.confidence,
            summary: entry.summary,
          };
        }),
      );

      tasks.sort((a, b) => {
        const left = a.submitted_at ?? "";
        const right = b.submitted_at ?? "";
        return sort === "asc"
          ? (left < right ? -1 : left > right ? 1 : 0)
          : (left < right ? 1 : left > right ? -1 : 0);
      });

      reply.send({
        tasks: tasks.slice(0, limit),
        count: Math.min(tasks.length, limit),
        sort,
      });
    },
  );

  async function cancelTrackedTask(id: string): Promise<{
    ok: boolean;
    taskId: string;
    runId: string | null;
    message: string;
  }> {
    const tracked = trackedRuns.get(id);
    if (tracked && tracked.runId) {
      const cancelled = ctx().coordinator.cancel(tracked.runId);
      if (cancelled) {
        tracked.status = "cancelled";
        tracked.completedAt = new Date().toISOString();
        tracked.error = "Cancelled by user";
        await ctx().receiptStore.updateTask(tracked.taskId, {
          status: "cancelled",
          completedAt: tracked.completedAt,
          error: tracked.error,
        });
        ctx().eventBus.emit({
          type: "run_cancelled",
          payload: {
            taskId: tracked.taskId,
            runId: tracked.runId,
            status: "cancelled",
            verdict: "cancelled",
            completedAt: tracked.completedAt,
            error: tracked.error,
          },
        });
        return {
          ok: true,
          taskId: tracked.taskId,
          runId: tracked.runId,
          message: "Run cancellation requested",
        };
      }
    }

    const persistedTask = await ctx().receiptStore.getTask(id) ?? await ctx().receiptStore.getTaskByRunId(id);
    if (persistedTask) {
      const cancelled = ctx().coordinator.cancel(persistedTask.runId);
      if (cancelled) {
        const completedAt = new Date().toISOString();
        await ctx().receiptStore.updateTask(persistedTask.taskId, {
          status: "cancelled",
          completedAt,
          error: "Cancelled by user",
        });
        const trackedPersisted = trackedRuns.get(persistedTask.taskId);
        if (trackedPersisted) {
          trackedPersisted.status = "cancelled";
          trackedPersisted.completedAt = completedAt;
          trackedPersisted.error = "Cancelled by user";
        }
        ctx().eventBus.emit({
          type: "run_cancelled",
          payload: {
            taskId: persistedTask.taskId,
            runId: persistedTask.runId,
            status: "cancelled",
            verdict: "cancelled",
            completedAt,
            error: "Cancelled by user",
          },
        });
        return {
          ok: true,
          taskId: persistedTask.taskId,
          runId: persistedTask.runId,
          message: "Run cancellation requested",
        };
      }
    }

    const cancelled = ctx().coordinator.cancel(id);
    if (cancelled) {
      const completedAt = new Date().toISOString();
      ctx().eventBus.emit({
        type: "run_cancelled",
        payload: {
          taskId: id,
          runId: id,
          status: "cancelled",
          verdict: "cancelled",
          completedAt,
          error: "Cancelled by user",
        },
      });
      return {
        ok: true,
        taskId: id,
        runId: id,
        message: "Run cancellation requested",
      };
    }

    return {
      ok: false,
      taskId: id,
      runId: null,
      message: `No active run found with ID "${id}"`,
    };
  }

  function toTaskStatus(
    status: import("../../core/receipt-store.js").PersistentRunStatus,
    finalClassification?: string | null,
  ): TrackedRun["status"] {
    // PARTIAL_SUCCESS maps to "partial" regardless of the underlying status
    if (finalClassification === "PARTIAL_SUCCESS") return "partial";
    switch (status) {
      // Active states
      case "PROPOSED":
      case "RUNNING":
      case "EXECUTING_IN_WORKSPACE":
      case "VERIFICATION_PENDING":
        return "running";
      case "AWAITING_APPROVAL":
      case "DISAGREEMENT_HOLD":
        return "running";
      // Terminal success
      case "COMPLETE":
      case "VERIFIED_PASS":
      case "READY_FOR_PROMOTION":
        return "complete";
      // Cancelled
      case "ABORTED":
      case "INTERRUPTED":
        return "cancelled";
      // Failures
      case "REJECTED":
      case "CRASHED":
      case "EXECUTION_ERROR":
      case "CLEANUP_ERROR":
      case "UNSUPPORTED_CONFIG":
      case "ROLLBACK_FAILED":
      case "ROLLBACK_INCOMPLETE":
      case "UNSAFE_STATE":
      case "FAILED":
      case "VERIFIED_FAIL":
      case "CRUCIBULUM_FAIL":
      default:
        return "failed";
    }
  }

  fastify.post<{ Body: LoquiBody }>(
    "/loqui",
    {
      schema: {
        body: {
          type: "object",
          required: ["question", "repoPath"],
          properties: {
            question: { type: "string", minLength: 1 },
            repoPath: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: LoquiBody }>, reply: FastifyReply) => {
      const { question, repoPath } = request.body;

      if (!existsSync(repoPath)) {
        reply.code(400).send({
          error: "Bad request",
          message: `repoPath does not exist on this host: ${repoPath}`,
        });
        return;
      }

      const decision = routeLoquiInput({
        input: question,
        context: { projectRoot: repoPath },
      });
      if (decision.action === "build") {
        const result = await submitBuildTask(ctx(), decision.effectivePrompt, repoPath, undefined);
        const envelope = {
          route: "build" as const,
          intent: decision.intent,
          label: decision.label,
          reason: decision.reason,
          confidence: decision.confidence,
          signals: [...decision.signals],
          original_input: decision.originalInput,
        };
        if (result.kind === "blocked") {
          reply.code(400).send({
            ...envelope,
            route: "blocked",
            status: "blocked",
            reason: result.reason,
            flags: [...result.flags],
          });
          return;
        }
        if (result.kind === "needs_clarification") {
          reply.send({
            ...envelope,
            route: "clarify",
            status: "needs_clarification",
            clarification: result.question,
          });
          return;
        }
        if (result.kind === "needs_decomposition") {
          reply.code(202).send({
            ...envelope,
            ...buildDecompositionResponse(result),
          });
          return;
        }
        recordLoquiDecisionForRun(decision, { runId: result.runId, taskId: result.taskId });
        reply.code(202).send({
          ...envelope,
          task_id: result.taskId,
          run_id: result.runId,
          prompt: result.prompt,
          repo_path: result.repoPath,
          status: "running",
          message: "Build task submitted. Watch the main status card and current diff for progress.",
        });
        return;
      }

      if (decision.action === "clarify") {
        reply.send({
          route: "clarify",
          intent: decision.intent,
          label: decision.label,
          reason: decision.reason,
          confidence: decision.confidence,
          signals: [...decision.signals],
          original_input: decision.originalInput,
          status: "needs_clarification",
          clarification: decision.clarification,
        });
        return;
      }

      const answer = await askLoqui(question, repoPath);
      reply.send({ answer });
    }
  );

  /**
   * POST /tasks/loqui/unified — Unified Loqui intent routing.
   *
   * Accepts one freeform input string, runs it through the
   * classifier + router, and dispatches to the correct backend path.
   * The UI sends every Loqui chat message here — there is no more
   * "mode" to pick at submit time.
   *
   * Response shape (always the same top-level wrapper):
   *   {
   *     route: "build" | "answer" | "clarify",
   *     intent, label, reason, confidence, signals,
   *     ...plus a route-specific payload:
   *       build   → { task_id, run_id, prompt, repo_path }
   *       answer  → { answer }
   *       clarify → { clarification }
   *   }
   *
   * The `signals` field exists so the UI (and later audit tooling)
   * can show *why* Loqui picked the route it picked — this preserves
   * the inspectability constraint from the execution-truth work.
   */
  fastify.post<{ Body: LoquiUnifiedBody }>(
    "/loqui/unified",
    {
      schema: {
        body: {
          type: "object",
          required: ["input", "repoPath"],
          properties: {
            input: { type: "string", minLength: 1 },
            repoPath: { type: "string", minLength: 1 },
            context: {
              type: "object",
              additionalProperties: true,
              properties: {
                activeRunId: { type: ["string", "null"] },
                lastRunId: { type: ["string", "null"] },
                lastRunVerdict: { type: ["string", "null"] },
                previousMessageWasBuild: { type: "boolean" },
                awaitingScopeFor: { type: ["string", "null"] },
                projectRoot: { type: ["string", "null"] },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: LoquiUnifiedBody }>, reply: FastifyReply) => {
      const { input, repoPath } = request.body;
      // Default the projectRoot used for follow-up path normalization
      // to repoPath. The UI can override (e.g. when the run targets a
      // sub-tree), but it never has to — the typical case is "the
      // repo I'm on now is the root for this clarification."
      const incomingContext = request.body.context ?? {};
      const routerContext: LoquiIntentContext = {
        ...incomingContext,
        ...(incomingContext.projectRoot
          ? {}
          : { projectRoot: repoPath }),
      };

      if (!existsSync(repoPath)) {
        reply.code(400).send({
          error: "Bad request",
          message: `repoPath does not exist on this host: ${repoPath}`,
        });
        return;
      }

      const decision: LoquiRouteDecision = routeLoquiInput({ input, context: routerContext });
      console.log(
        `[tasks] /loqui/unified: action=${decision.action} intent=${decision.intent} ` +
        `label=${decision.label} confidence=${decision.confidence.toFixed(2)} ` +
        `reason="${decision.reason}" signals=${decision.signals.length}`,
      );

      // Base envelope every response shares. Gives the UI a stable
      // shape to hang its intent badge / signal audit off of, no
      // matter which backend path actually ran.
      const scopedBuildSignal = decision.signals.includes("build:scoped-build-signal");
      const safeFallbackFired = decision.signals.some((s) => s.startsWith("safe-fallback:"));
      const envelope = {
        route: decision.action,
        intent: decision.intent,
        label: decision.label,
        reason: decision.reason,
        confidence: decision.confidence,
        signals: [...decision.signals],
        original_input: decision.originalInput,
        scoped_build_signal: scopedBuildSignal,
        safe_fallback_suppressed: scopedBuildSignal && !safeFallbackFired,
        ...(decision.followUpScope
          ? {
              follow_up_scope: {
                relative_path: decision.followUpScope.relativePath,
                absolute_path: decision.followUpScope.absolutePath,
                exists: decision.followUpScope.exists,
                is_directory: decision.followUpScope.isDirectory,
                message: decision.followUpScope.message,
              },
            }
          : {}),
      };

      // ── Plan Assist + Scout interception ──────────────────────
      // Before dispatching to the build path, check if the prompt is
      // plan-worthy. If so, optionally run scouts to gather evidence,
      // then return a plan suggestion instead of executing immediately.
      //
      // Safety: plan creation does NOT start execution. Vague prompts
      // still clarify. Unsafe prompts still block. The suggestion is
      // purely advisory — the user must explicitly click "Create Plan".
      // Scouts are read-only and advisory. Cloud scouts only when
      // routing policy permits. Never silently escalate.
      if (decision.action === "build") {
        const { planResult: planAssist, scoutEvidence } =
          await detectPlanAssistWithScouts({
            prompt: decision.originalInput,
            repoPath,
            intentConfidence: decision.confidence,
            intent: decision.intent,
            modelProfile: undefined, // let routing decide
            cloudKeysAvailable: undefined,
          });
        if (planAssist.kind === "plan_suggestion") {
          console.log(
            `[tasks] /loqui/unified: plan-assist intercepted build — ` +
            `${planAssist.subtasks.length} subtasks suggested, ` +
            `signals=${planAssist.signals.join(",")}` +
            (scoutEvidence?.spawned ? `, scouts=${scoutEvidence.reports.length}` : ""),
          );
          reply.send({
            ...envelope,
            route: "suggest_plan",
            status: "suggest_plan",
            plan_suggestion: {
              objective: planAssist.objective,
              subtasks: planAssist.subtasks,
              reason: planAssist.reason,
              signals: [...planAssist.signals],
              confidence: planAssist.confidence,
            },
            scout_evidence: scoutEvidence ? {
              spawned: scoutEvidence.spawned,
              reason: scoutEvidence.spawnDecision.reason,
              reports_count: scoutEvidence.reports.length,
              recommended_targets: scoutEvidence.recommendedTargets.slice(0, 10),
              recommended_tests: scoutEvidence.recommendedTests.slice(0, 5),
              risks: scoutEvidence.risks.slice(0, 5),
              routing: scoutEvidence.routing.map((r) => ({
                route: r.route,
                model: r.model,
                provider: r.provider,
                reason: r.reason,
                cost: r.estimatedCostUsd,
              })),
              total_cost_usd: scoutEvidence.totalCostUsd,
              scout_report_ids: scoutEvidence.reports.map((r) => r.scoutId),
            } : null,
          });
          return;
        }
        if (planAssist.kind === "block") {
          reply.code(400).send({
            ...envelope,
            route: "blocked",
            status: "blocked",
            reason: planAssist.reason,
          });
          return;
        }
        if (planAssist.kind === "clarify") {
          reply.send({
            ...envelope,
            route: "clarify",
            status: "needs_clarification",
            clarification: planAssist.question,
          });
          return;
        }
        // kind === "skip" → fall through to normal build path
      }

      switch (decision.action) {
        case "build": {
          const result = await submitBuildTask(ctx(), decision.effectivePrompt, repoPath, undefined);
          if (result.kind === "blocked") {
            reply.code(400).send({
              ...envelope,
              route: "blocked",
              status: "blocked",
              reason: result.reason,
              flags: [...result.flags],
            });
            return;
          }
          if (result.kind === "needs_clarification") {
            reply.send({
              ...envelope,
              route: "clarify",
              status: "needs_clarification",
              clarification: result.question,
            });
            return;
          }
          if (result.kind === "needs_decomposition") {
            reply.code(202).send({
              ...envelope,
              ...buildDecompositionResponse(result),
            });
            return;
          }
          recordLoquiDecisionForRun(decision, { runId: result.runId, taskId: result.taskId });
          reply.code(202).send({
            ...envelope,
            task_id: result.taskId,
            run_id: result.runId,
            prompt: result.prompt,
            repo_path: result.repoPath,
            status: "running",
            message: "Build task submitted. Watch the main status card and current diff for progress.",
          });
          return;
        }

        case "resume": {
          // Stitch the new input onto the most recent tracked run's
          // prompt so the Coordinator sees a self-contained request.
          // If no prior run exists on the server (e.g. because this
          // server was restarted since the UI learned about it), we
          // fall back to treating the input as a bare build rather
          // than failing — the user's intent to "continue" is clear
          // even if we don't have the history to reference.
          const requestedPriorId = routerContext.activeRunId ?? routerContext.lastRunId ?? null;
          const prior =
            await findKnownRunById(ctx(), requestedPriorId) ??
            await findLatestKnownRun(ctx());
          const stitched = prior
            ? `Continue the prior build (${prior.runId}): "${prior.prompt}". Follow-up instruction: ${decision.originalInput}`
            : decision.originalInput;
          const result = await submitBuildTask(ctx(), stitched, repoPath, undefined);
          if (result.kind === "blocked") {
            reply.code(400).send({
              ...envelope,
              route: "blocked",
              status: "blocked",
              reason: result.reason,
              flags: [...result.flags],
            });
            return;
          }
          if (result.kind === "needs_clarification") {
            reply.send({
              ...envelope,
              route: "clarify",
              status: "needs_clarification",
              clarification: result.question,
            });
            return;
          }
          if (result.kind === "needs_decomposition") {
            reply.code(202).send({
              ...envelope,
              ...buildDecompositionResponse(result),
            });
            return;
          }
          recordLoquiDecisionForRun(decision, { runId: result.runId, taskId: result.taskId });
          reply.code(202).send({
            ...envelope,
            task_id: result.taskId,
            run_id: result.runId,
            prompt: result.prompt,
            repo_path: result.repoPath,
            resumed_from: prior?.runId ?? null,
            status: "running",
            message: prior
              ? `Resuming from ${prior.runId}. New build task submitted.`
              : "No prior run found in persisted history — submitted as a fresh build.",
          });
          return;
        }

        case "answer": {
          const answer = await askLoqui(decision.effectivePrompt, repoPath);
          reply.send({ ...envelope, answer });
          return;
        }

        case "dry_run": {
          // Preflight + Dry Run System v1 — grounded structured
          // plan produced by generateDryRun. Nothing is written,
          // no worker runs. The plan reuses every planning
          // primitive the Coordinator uses at runtime, so the
          // steps the user sees here match what would happen if
          // they submitted the same request for real.
          const plan = generateDryRun({ input: decision.originalInput, projectRoot: repoPath });
          reply.send({ ...envelope, plan });
          return;
        }

        case "clarify":
        default: {
          reply.send({ ...envelope, clarification: decision.clarification });
          return;
        }
      }
    }
  );

  /**
   * POST /tasks/dry-run — Direct dry-run entry point.
   *
   * Skips the classifier and produces a structured dry-run plan
   * from a raw prompt + repoPath. Used by API clients that
   * already know they want a plan (no natural-language gate).
   * Response shape mirrors the `dry_run` action from the
   * unified route: { plan: DryRunPlan }.
   */
  fastify.post<{ Body: { input: string; repoPath: string } }>(
    "/dry-run",
    {
      schema: {
        body: {
          type: "object",
          required: ["input", "repoPath"],
          properties: {
            input: { type: "string", minLength: 1 },
            repoPath: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { input, repoPath } = request.body;
      if (!existsSync(repoPath)) {
        reply.code(400).send({
          error: "Bad request",
          message: `repoPath does not exist on this host: ${repoPath}`,
        });
        return;
      }
      const plan = generateDryRun({ input, projectRoot: repoPath });
      reply.send({ plan });
    }
  );

  /**
   * POST /tasks — Submit a new build task.
   *
   * Calls coordinator.submit() and tracks the run.
   * Returns immediately with task_id + run_id. The run executes async.
   * Client should subscribe on WebSocket with { type: "subscribe", runId }.
   *
   * The optional `repoPath` field in the body lets the caller target a
   * specific local repo as the project root for this build. The Coordinator
   * uses it as the effective projectRoot — workers see it via
   * assignment.projectRoot, gitCommit runs with cwd=repoPath, and the
   * IntegrationJudge normalizes deliverable paths against it. When omitted,
   * the Coordinator falls back to its own boot-time config.projectRoot
   * (typically the API server's cwd).
   */
  fastify.post<{ Body: SubmitBody }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            prompt: { type: "string", minLength: 1 },
            input: { type: "string", minLength: 1 },
            repoPath: { type: "string" },
            exclusions: { type: "array", items: { type: "string" } },
            quality_bar: { type: "string", enum: ["minimal", "standard", "hardened"] },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Body: SubmitBody }>, reply: FastifyReply) => {
      const prompt = request.body.prompt || request.body.input;
      const repoPath = request.body.repoPath;
      console.log("[tasks] POST /tasks received:", { prompt: redactText(prompt?.slice(0, 80) ?? ""), repoPath });

      if (!prompt || !prompt.trim()) {
        reply.code(400).send({
          error: "Bad request",
          message: "Either 'prompt' or 'input' field is required",
        });
        return;
      }

      // Validate repoPath if provided. The CLI does its own existsSync check
      // but we re-validate at the API boundary as defense-in-depth — a
      // misconfigured client (or a direct curl) might send a path that
      // doesn't exist on this host. Failing here gives a clear error
      // instead of letting the Coordinator throw mid-build.
      if (repoPath !== undefined && repoPath.length > 0) {
        if (!existsSync(repoPath)) {
          console.warn(`[tasks] rejecting POST: repoPath does not exist: ${repoPath}`);
          reply.code(400).send({
            error: "Bad request",
            message: `repoPath does not exist on this host: ${repoPath}`,
          });
          return;
        }
      }

      const result = await submitBuildTask(ctx(), prompt.trim(), repoPath, request.body.exclusions);

      if (result.kind === "blocked") {
        reply.code(400).send({
          status: "blocked",
          reason: result.reason,
          flags: [...result.flags],
        });
        return;
      }

      if (result.kind === "needs_clarification") {
        reply.code(202).send({
          status: "needs_clarification",
          question: result.question,
        });
        return;
      }

      if (result.kind === "needs_decomposition") {
        reply.code(202).send(buildDecompositionResponse(result));
        return;
      }

      reply.code(202).send({
        task_id: result.taskId,
        run_id: result.runId,
        status: "running",
        prompt: result.prompt,
        repo_path: result.repoPath,
        message: "Task submitted. Connect to /ws and subscribe to receive live updates.",
      });
    }
  );

  /**
   * GET /tasks/:id — Get task status and current run state.
   */
  fastify.get<{ Params: TaskParams }>(
    "/:id",
    async (request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const tracked = trackedRuns.get(id);

      if (tracked) {
        const activeRun = ctx().coordinator.getRunStatus(tracked.runId);
        const completedTasks = activeRun ? activeRun.run.tasks.filter((task) => task.status === "completed").length : 0;
        const failedTasks = activeRun ? activeRun.run.tasks.filter((task) => task.status === "failed").length : 0;

        // If the coordinator has resolved the receipt, extract extended fields
        const receipt = tracked.receipt as any;
        reply.send({
          task_id: tracked.taskId,
          run_id: tracked.runId,
          status: tracked.status,
          verdict: receipt?.finalClassification ?? receipt?.humanSummary?.classification ?? null,
          summary: receipt?.humanSummary?.headline ?? null,
          confidence: receipt?.confidence?.overall ?? null,
          cost: receipt?.totalCost?.estimatedCostUsd ?? null,
          prompt: tracked.prompt,
          submitted_at: tracked.submittedAt,
          completed_at: tracked.completedAt,
          error: tracked.error,
          provider_lane_truth: receipt?.providerLaneTruth ?? null,
          active_run: Boolean(activeRun),
          progress: activeRun ? {
            phase: activeRun.run.phase,
            completed_tasks: completedTasks,
            failed_tasks: failedTasks,
            total_tasks: activeRun.run.tasks.length,
            total_cost: activeRun.run.totalCost,
          } : null,
        });
        return;
      }

      const persistedTask = await ctx().receiptStore.getTask(id) ?? await ctx().receiptStore.getTaskByRunId(id);
      if (persistedTask) {
        const persistedRun = await ctx().receiptStore.getRun(persistedTask.runId);
        const activeRun = ctx().coordinator.getRunStatus(persistedTask.runId);
        const completedTasks = activeRun ? activeRun.run.tasks.filter((task) => task.status === "completed").length : 0;
        const failedTasks = activeRun ? activeRun.run.tasks.filter((task) => task.status === "failed").length : 0;
        reply.send({
          task_id: persistedTask.taskId,
          run_id: persistedTask.runId,
          status: persistedRun
            ? toTaskStatus(persistedRun.status, persistedRun.finalClassification)
            : persistedTask.status,
          verdict: persistedRun?.finalClassification ?? null,
          summary: persistedRun?.taskSummary ?? null,
          confidence: persistedRun?.confidence?.overall ?? null,
          cost: persistedRun?.totalCost?.estimatedCostUsd ?? null,
          prompt: persistedTask.prompt,
          submitted_at: persistedTask.submittedAt,
          completed_at: persistedRun?.completedAt ?? persistedTask.completedAt,
          error: persistedRun?.errors?.[0] ?? persistedTask.error,
          provider_lane_truth: persistedRun?.finalReceipt?.providerLaneTruth ?? null,
          active_run: Boolean(activeRun),
          progress: activeRun ? {
            phase: activeRun.run.phase,
            completed_tasks: completedTasks,
            failed_tasks: failedTasks,
            total_tasks: activeRun.run.tasks.length,
            total_cost: activeRun.run.totalCost,
          } : persistedRun ? {
            phase: persistedRun.phase,
            completed_tasks: persistedRun.workerEvents.filter((event: any) => event.status === "completed").length,
            failed_tasks: persistedRun.workerEvents.filter((event: any) => event.status === "failed").length,
            total_tasks: persistedRun.workerEvents.length,
            total_cost: persistedRun.totalCost,
          } : null,
        });
        return;
      }

      // Fallback: search event history
      const recentEvents = ctx().eventBus.recentEvents(100);
      const taskEvents = recentEvents.filter(
        (e) => (e.payload as any).taskId === id || (e.payload as any).runId === id
      );

      if (taskEvents.length === 0) {
        reply.code(404).send({
          error: "Not found",
          message: `No task or run found with ID "${id}"`,
        });
        return;
      }

      const lastEvent = taskEvents[taskEvents.length - 1];
      const isComplete = lastEvent.type === "run_complete" || lastEvent.type === "run_receipt";
      const runId = (lastEvent.payload as any).runId ?? id;

      reply.send({
        task_id: id,
        run_id: runId,
        status: isComplete ? "complete" : "running",
        phase: lastEvent.type,
        active_run: !isComplete,
        progress: null,
        last_event: lastEvent,
        event_count: taskEvents.length,
        events: taskEvents,
      });
    }
  );

  /**
   * GET /tasks/:id/receipts — Get the full receipt bundle for a completed task.
   */
  fastify.get<{ Params: TaskParams }>(
    "/:id/receipts",
    async (request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
      const { id } = request.params;

      // Check tracked runs first
      const tracked = trackedRuns.get(id);
      if (tracked?.receipt) {
        reply.send({ task_id: id, run_id: tracked.runId, receipt: tracked.receipt });
        return;
      }

      const task = await ctx().receiptStore.getTask(id) ?? await ctx().receiptStore.getTaskByRunId(id);
      const persisted = await ctx().receiptStore.getRun(task?.runId ?? id);
      if (persisted) {
        reply.send({ task_id: task?.taskId ?? id, run_id: persisted.runId, receipt: persisted.finalReceipt ?? persisted });
        return;
      }

      // Fallback to event history
      const recentEvents = ctx().eventBus.recentEvents(200);
      const receiptEvent = recentEvents.find(
        (e) =>
          e.type === "run_receipt" &&
          ((e.payload as any).taskId === id || (e.payload as any).runId === id)
      );

      if (!receiptEvent) {
        reply.code(404).send({
          error: "Not found",
          message: `No receipt found for task "${id}". Task may still be running.`,
        });
        return;
      }

      reply.send({
        task_id: id,
        receipt: receiptEvent.payload,
      });
    }
  );

  /**
   * POST /tasks/:id/cancel — Cancel a running task.
   */
  fastify.post<{ Params: TaskParams }>(
    "/:id/cancel",
    async (request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const result = await cancelTrackedTask(id);
      if (!result.ok) {
        reply.code(404).send({
          error: "Not found",
          message: result.message,
        });
        return;
      }
      reply.send({
        task_id: result.taskId,
        run_id: result.runId,
        status: "cancelled",
        message: result.message,
      });
    }
  );

  /**
   * POST /tasks/:id/approve — Approve a pending decomposition plan and
   * resume execution.
   */
  fastify.post<{ Params: TaskParams }>(
    "/:id/approve",
    async (request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const result = ctx().coordinator.approvePlan(id);

      if (!result) {
        reply.code(404).send({
          error: "Not found",
          message: `No pending plan found with ID "${id}"`,
        });
        return;
      }

      const tracked = registerTrackedPlanRun(id, result.receipt, ctx());
      reply.code(202).send({
        task_id: tracked.taskId,
        run_id: tracked.runId,
        status: "running",
        message: `Plan "${id}" approved. Execution started.`,
      });
    }
  );

  /**
   * DELETE /tasks/:id — Cancel a running task.
   */
  fastify.delete<{ Params: TaskParams }>(
    "/:id",
    async (request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const result = await cancelTrackedTask(id);
      if (!result.ok) {
        reply.code(404).send({
          error: "Not found",
          message: result.message,
        });
        return;
      }
      reply.send({
        task_id: result.taskId,
        run_id: result.runId,
        status: "cancelled",
        message: result.message,
      });
    }
  );

  /**
   * POST /tasks/:id/promote — Promote workspace changes to the source repo.
   * This is the final step: applies the workspace commit to the source
   * repository. Only works for runs that have been committed in their
   * workspace (status: READY_FOR_PROMOTION or VERIFIED_PASS).
   */
  fastify.post<{ Params: TaskParams; Body: { source_repo?: string } }>(
    "/:id/promote",
    async (request: FastifyRequest<{ Params: TaskParams; Body: { source_repo?: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const tracked = trackedRuns.get(id);
      const persistedTask = tracked
        ? null
        : await ctx().receiptStore.getTask(id) ?? await ctx().receiptStore.getTaskByRunId(id);
      const persistedRun = tracked || persistedTask
        ? null
        : await ctx().receiptStore.getRun(id);
      const runId = tracked?.runId ?? persistedTask?.runId ?? persistedRun?.runId ?? null;
      const taskId = tracked?.taskId ?? persistedTask?.taskId ?? id;
      if (!runId) {
        reply.code(404).send({
          error: "Not found",
          message: `No task or persisted run "${id}" is available for promotion`,
        });
        return;
      }
      const result = await ctx().coordinator.promoteToSource(runId, request.body?.source_repo);
      if (!result.ok) {
        reply.code(400).send({
          error: "Promotion failed",
          message: result.error,
          run_id: runId,
          action: "Re-run the task if the receipt is missing a patch artifact or inspect the persisted receipt for rollback details.",
        });
        return;
      }
      reply.send({
        task_id: taskId,
        run_id: runId,
        status: "promoted",
        commit_sha: result.commitSha,
        message: "Changes promoted to source repository",
      });
    }
  );
};
