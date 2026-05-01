/**
 * Run routes — Query build run history, details, and receipts.
 *
 * GET /runs              — Recent runs with summary
 * GET /runs/:id          — Full run detail + task graph
 * GET /runs/:id/integration — Integration judge result
 * GET /runs/:id/receipts — Cost breakdown
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../index.js";
import type { WireMessage } from "../websocket.js";
import {
  projectRunList,
  projectRunDetail,
  type TrackedRunLike,
} from "../../core/metrics.js";
import {
  getAllTrackedRuns,
  getLoquiDecisionForRun,
  getTrackedRun,
} from "./tasks.js";
import {
  buildInactiveCandidatesBlock,
  buildLoquiDecisionView,
  buildRunDetailResponse,
  buildRunIntegrationResponse,
  buildRunListEntry,
  projectCandidatesFromReceipt as projectCandidatesFromReceiptShape,
  type RunCandidatesBlock,
  type RunCandidateView,
  type RunLoquiDecisionView,
} from "./run-contracts.js";

// ─── Request Schemas ─────────────────────────────────────────────────

interface RunParams {
  id: string;
}

interface RunsQuery {
  limit?: number;
  status?: string;
}

// ─── Routes ──────────────────────────────────────────────────────────

export const runRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;
  const resolveRunId = async (id: string): Promise<string> => {
    const task = await ctx().receiptStore.getTask(id);
    return task?.runId ?? id;
  };

  /**
   * GET /runs — List recent runs with summary.
   *
   * Metrics + External API v1: prefers the tracked-run registry
   * (populated by POST /tasks) so every list item carries the
   * grounded summary, classification, confidence, and cost from
   * the RunReceipt. Falls back to the event-bus projection when
   * the registry is empty (tests, fresh boot, legacy clients).
   */
  fastify.get<{ Querystring: RunsQuery }>(
    "/",
    async (request: FastifyRequest<{ Querystring: RunsQuery }>, reply: FastifyReply) => {
      const limit = Math.min(request.query.limit ?? 20, 100);
      const statusFilter = request.query.status;

      const persisted = await ctx().receiptStore.listRuns(limit, statusFilter);
      if (persisted.length > 0) {
        reply.send({
          runs: persisted.map((run) => ({
            ...buildRunListEntry({
              id: run.runId,
              runId: run.runId,
              status: run.status,
              classification: run.finalClassification,
              prompt: run.prompt,
              summary: run.summary,
              costUsd: run.costUsd,
              confidence: run.confidence ?? 0,
              timestamp: run.updatedAt,
              completedAt: run.completedAt,
            }),
          })),
          total: persisted.length,
          source: "persistent-receipts",
        });
        return;
      }

      const tracked = getAllTrackedRuns() as unknown as readonly TrackedRunLike[];
      if (tracked.length > 0) {
        const projected = projectRunList(tracked, limit)
          .filter(
            (run) =>
              !statusFilter ||
              run.status === statusFilter ||
              run.classification === statusFilter,
          );
        reply.send({
          runs: projected.map((run) => buildRunListEntry({
            id: run.id,
            runId: run.runId ?? run.id,
            status: run.status,
            classification: run.classification,
            prompt: run.prompt,
            summary: run.summary,
            costUsd: run.costUsd,
            confidence: run.confidence,
            timestamp: run.timestamp,
            completedAt: run.completedAt,
          })),
          total: projected.length,
          source: "tracked-runs",
        });
        return;
      }

      // Fallback: event-bus projection. Unchanged from the
      // pre-v1 implementation so existing clients and tests keep
      // working when the tracked registry is empty.
      const events = ctx().eventBus.recentEvents(500);

      const runMap = new Map<string, WireMessage[]>();
      for (const event of events) {
        const runId = (event.payload as any).runId;
        if (!runId) continue;
        const existing = runMap.get(runId) ?? [];
        existing.push(event);
        runMap.set(runId, existing);
      }

      const runs = [...runMap.entries()]
        .map(([runId, runEvents]) => {
          const started = runEvents.find((e) => e.type === "run_started");
          const completed = runEvents.find((e) => e.type === "run_complete");
          const verdict = (completed?.payload as any)?.verdict ?? "running";

          return {
            id: runId,
            runId,
            status: completed ? "complete" : "running",
            classification: verdict,
            prompt: String((started?.payload as any)?.prompt ?? ""),
            summary: verdict,
            costUsd: Number((completed?.payload as any)?.totalCostUsd ?? 0),
            confidence: 0,
            timestamp: started?.timestamp ?? completed?.timestamp ?? new Date().toISOString(),
            completedAt: completed?.timestamp ?? null,
          };
        })
        .filter((r) => !statusFilter || r.status === statusFilter || r.classification === statusFilter)
        .slice(-limit)
        .reverse();

      reply.send({
        runs,
        total: runs.length,
        source: "event-bus",
      });
    }
  );

  /**
   * GET /runs/:id — Full run detail including task graph state.
   *
   * Metrics + External API v1: first checks the tracked-run
   * registry. If `id` matches a tracked task or run ID, returns
   * the projected detail (receipts + files changed + summary +
   * confidence + errors) — the response shape the external API
   * contract specifies. Active-run and event-bus fallbacks are
   * preserved so in-flight lookups and legacy event-only runs
   * continue to work.
   */
  fastify.get<{ Params: RunParams }>(
    "/:id",
    async (request: FastifyRequest<{ Params: RunParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const runId = await resolveRunId(id);

      const persisted = await ctx().receiptStore.getRun(runId);
      if (persisted) {
        const task = await ctx().receiptStore.getTaskByRunId(runId);
        const humanSummary = persisted.humanSummary as {
          headline?: unknown;
          narrative?: unknown;
          verification?: unknown;
        } | null;
        const candidates = projectCandidatesFromReceipt(persisted.finalReceipt);
        const loqui = projectLoquiDecision(runId, task?.taskId ?? null);
        reply.send({
          ...buildRunDetailResponse({
            id: persisted.runId,
            taskId: task?.taskId ?? null,
            runId: persisted.runId,
            status: persisted.status,
            prompt: task?.prompt ?? persisted.prompt,
            submittedAt: task?.submittedAt ?? persisted.startedAt ?? persisted.createdAt,
            completedAt: persisted.completedAt,
            receipt: persisted.finalReceipt,
            filesChanged: persisted.changesSummary.map((change) => ({
              path: change.path,
              operation: change.operation,
            })),
            summary: {
              classification: persisted.finalClassification,
              headline: typeof humanSummary?.headline === "string" && humanSummary.headline
                ? humanSummary.headline
                : persisted.taskSummary,
              narrative: typeof humanSummary?.narrative === "string" ? humanSummary.narrative : "",
              verification: typeof humanSummary?.verification === "string" ? humanSummary.verification : "not-run",
              // Surface the actual checks that ran (typecheck/tests/lint etc.)
              // so the Trust Summary panel stops showing "no checks recorded"
              // on every run. Pulled from humanSummary when available, else
              // directly from the persisted verification receipt.
              verificationChecks: ((humanSummary as { verificationChecks?: readonly unknown[] })?.verificationChecks
                ?? (persisted as { verificationReceipt?: { checks?: readonly unknown[] } }).verificationReceipt?.checks
                ?? []) as readonly unknown[],
              // Failure explanation is only attached to human summaries on
              // non-success classifications (run-summary.ts guards this),
              // but we forward it verbatim when present so the UI can show
              // a real root cause — and omit it otherwise so the panel
              // doesn't paint "(unknown) gate failed silently" on runs
              // that actually succeeded.
              failureExplanation: (humanSummary as { failureExplanation?: unknown })?.failureExplanation ?? null,
            },
            confidence: persisted.confidence,
            errors: persisted.errors.map((message) => ({ source: "persistent-receipt", message })),
            executionVerified: persisted.finalReceipt?.executionVerified ?? null,
            executionGateReason: persisted.finalReceipt?.executionGateReason ?? null,
            blastRadius: persisted.finalReceipt?.blastRadius ?? null,
            totalCostUsd: persisted.totalCost.estimatedCostUsd,
            workerEvents: persisted.workerEvents,
            checkpoints: persisted.checkpoints,
            candidates,
            ...(loqui ? { loqui } : {}),
          }),
          source: "persistent-receipts",
        });
        return;
      }

      // Try tracked registry first — either the task_id or the
      // runId. `getTrackedRun` keys on task_id; a linear scan
      // covers the runId case without needing a second index.
      const byTaskId = getTrackedRun(id);
      const tracked =
        byTaskId ??
        (getAllTrackedRuns() as unknown as readonly TrackedRunLike[]).find(
          (r) => r.runId === runId,
        );
      if (tracked) {
        const detail = projectRunDetail(tracked as unknown as TrackedRunLike);
        if (detail) {
          reply.send({
            ...buildRunDetailResponse({
              id: detail.id,
              taskId: detail.id,
              runId: detail.runId ?? detail.id,
              status: detail.status,
              prompt: detail.prompt,
              submittedAt: detail.submittedAt,
              completedAt: detail.completedAt,
              receipt: detail.receipt,
              filesChanged: detail.filesChanged,
              summary: detail.summary,
              confidence: detail.confidence,
              errors: detail.errors,
              executionVerified: detail.executionVerified,
              executionGateReason: detail.executionGateReason,
              blastRadius: detail.blastRadius,
              totalCostUsd: detail.totalCostUsd,
              workerEvents: [],
              checkpoints: [],
            }),
            source: "tracked-runs",
          });
          return;
        }
      }

      // Check active runs (in-flight coordinator state)
      const active = ctx().coordinator.getRunStatus(runId);
      if (active) {
        const task = await ctx().receiptStore.getTaskByRunId(runId);
        const liveCandidates = projectCandidatesFromActiveRun(ctx(), runId);
        const loqui = projectLoquiDecision(runId, task?.taskId ?? null);
        reply.send({
          ...buildRunDetailResponse({
            id: runId,
            taskId: task?.taskId ?? null,
            runId,
            status: "running",
            prompt: task?.prompt ?? "",
            submittedAt: task?.submittedAt ?? active.run.startedAt,
            completedAt: active.run.completedAt,
            receipt: null,
            filesChanged: [],
            summary: {
              classification: null,
              headline: `Run is ${active.run.phase}`,
              narrative: "",
              verification: "not-run",
            },
            confidence: { overall: 0, planning: 0, execution: 0, verification: 0 },
            errors: [],
            executionVerified: null,
            executionGateReason: null,
            blastRadius: null,
            totalCostUsd: active.run.totalCost.estimatedCostUsd,
            workerEvents: [],
            checkpoints: [],
            candidates: liveCandidates,
            ...(loqui ? { loqui } : {}),
          }),
          runState: {
            phase: active.run.phase,
            tasks: active.run.tasks.map((t) => ({
              id: t.id,
              workerType: t.workerType,
              description: t.description,
              status: t.status,
              targetFiles: t.targetFiles,
            })),
            assumptions: active.run.assumptions,
            decisions: active.run.decisions,
            totalCost: active.run.totalCost,
          },
          taskGraph: {
            nodes: active.graph.nodes.map((n) => ({
              id: n.id,
              label: n.label,
              workerType: n.workerType,
              status: n.status,
              assignedTier: n.assignedTier,
              targetFiles: n.targetFiles,
            })),
            edges: active.graph.edges,
            mergeGroups: active.graph.mergeGroups,
            checkpoints: active.graph.checkpoints.map((cp) => ({
              id: cp.id,
              label: cp.label,
              status: cp.status,
            })),
            escalationBoundaries: active.graph.escalationBoundaries,
          },
        });
        return;
      }

      // Fall back to event history
      const events = ctx().eventBus.recentEvents(500);
      const runEvents = events.filter((e) => (e.payload as any).runId === runId);

      if (runEvents.length === 0) {
        reply.code(404).send({
          error: "Not found",
          message: `No run found with ID "${id}"`,
        });
        return;
      }

      const started = runEvents.find((event) => event.type === "run_started");
      const completed = runEvents.find((event) => event.type === "run_complete");
      reply.send({
        ...buildRunDetailResponse({
          id: runId,
          taskId: String((started?.payload as any)?.taskId ?? ""),
          runId,
          status: String((completed?.payload as any)?.verdict ?? "complete"),
          prompt: String((started?.payload as any)?.prompt ?? ""),
          submittedAt: started?.timestamp ?? new Date().toISOString(),
          completedAt: completed?.timestamp ?? null,
          receipt: null,
          filesChanged: [],
          summary: {
            classification: String((completed?.payload as any)?.classification ?? "") || null,
            headline: "Run detail reconstructed from event history",
            narrative: "",
            verification: "not-run",
          },
          confidence: { overall: 0, planning: 0, execution: 0, verification: 0 },
          errors: [],
          executionVerified: (completed?.payload as any)?.executionVerified ?? null,
          executionGateReason: (completed?.payload as any)?.executionReason ?? null,
          blastRadius: null,
          totalCostUsd: Number((completed?.payload as any)?.totalCostUsd ?? 0),
          workerEvents: [],
          checkpoints: [],
        }),
        timeline: runEvents.map((e) => ({
          type: e.type,
          timestamp: e.timestamp,
          payload: e.payload,
        })),
      });
    }
  );

  /**
   * GET /runs/:id/integration — Integration judge results.
   */
  fastify.get<{ Params: RunParams }>(
    "/:id/integration",
    async (request: FastifyRequest<{ Params: RunParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const runId = await resolveRunId(id);

      const persisted = await ctx().receiptStore.getRun(runId);
      if (persisted) {
        reply.send(buildRunIntegrationResponse({
          runId,
          status: persisted.status,
          integration: {
            verdict:
              persisted.finalReceipt?.mergeDecision?.action === "apply"
                ? "approved"
                : persisted.finalReceipt?.mergeDecision?.action === "block"
                  ? "blocked"
                  : "not-available",
            summary: persisted.finalReceipt?.mergeDecision?.summary ?? "No integration decision recorded",
            events: [],
            lastCheck: persisted.finalReceipt?.mergeDecision ?? null,
          },
          checkpoints: persisted.checkpoints,
          workerEvents: persisted.workerEvents,
        }));
        return;
      }

      const events = ctx().eventBus.recentEvents(500);
      const integrationEvents = events.filter(
        (e) =>
          (e.payload as any).runId === runId &&
          (e.type === "integration_check" || e.type === "merge_approved" || e.type === "merge_blocked")
      );

      if (integrationEvents.length === 0) {
        reply.code(404).send({
          error: "Not found",
          message: `No integration results for run "${id}"`,
        });
        return;
      }

      const lastCheck = integrationEvents[integrationEvents.length - 1];

      reply.send(buildRunIntegrationResponse({
        runId,
        status: "complete",
        integration: {
          verdict: lastCheck.type === "merge_approved" ? "approved" : lastCheck.type === "merge_blocked" ? "blocked" : "pending",
          summary: String((lastCheck.payload as any)?.summary ?? lastCheck.type),
          events: integrationEvents,
          lastCheck,
        },
        checkpoints: [],
        workerEvents: [],
      }));
    }
  );

  /**
   * GET /runs/:id/receipts — Cost breakdown and full receipt.
   */
  fastify.get<{ Params: RunParams }>(
    "/:id/receipts",
    async (request: FastifyRequest<{ Params: RunParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const runId = await resolveRunId(id);
      const persisted = await ctx().receiptStore.getRun(runId);
      if (persisted) {
        reply.send({
          runId,
          receipt: persisted.finalReceipt ?? persisted,
          costTimeline: persisted.workerEvents.map((event) => ({
            type: event.status,
            timestamp: event.at,
            payload: event,
          })),
          source: "persistent-receipts",
        });
        return;
      }

      const events = ctx().eventBus.recentEvents(500);
      const receiptEvent = events.find(
        (e) => e.type === "run_receipt" && (e.payload as any).runId === runId
      );

      // Gather all cost-related events
      const costEvents = events.filter(
        (e) =>
          (e.payload as any).runId === runId &&
          (e.type === "worker_assigned" || e.type === "task_complete" || e.type === "run_receipt")
      );

      if (costEvents.length === 0) {
        reply.code(404).send({
          error: "Not found",
          message: `No receipt data for run "${id}"`,
        });
        return;
      }

      reply.send({
        runId,
        receipt: receiptEvent?.payload ?? null,
        costTimeline: costEvents.map((e) => ({
          type: e.type,
          timestamp: e.timestamp,
          payload: e.payload,
        })),
        source: "event-bus",
      });
    }
  );
};

// ─── Projection helpers ─────────────────────────────────────────────

/**
 * Wrapper kept for back-compat with the route handler — delegates to
 * the pure projection in run-contracts.ts so tests can pin the
 * shape without booting fastify.
 */
function projectCandidatesFromReceipt(finalReceipt: unknown): RunCandidatesBlock {
  return projectCandidatesFromReceiptShape(finalReceipt as Parameters<typeof projectCandidatesFromReceiptShape>[0]);
}

/**
 * Project an active-run's live candidate list. The Coordinator's
 * in-memory `Candidate[]` carries the rich fields (advisoryFindings,
 * confidence, changedFiles) that the persisted manifest strips, so
 * the UI gets the full picture while a run is still in flight.
 */
function projectCandidatesFromActiveRun(
  context: ServerContext,
  runId: string,
): RunCandidatesBlock {
  const candidates = context.coordinator.getRunCandidates(runId);
  if (!candidates || candidates.length === 0) {
    return buildInactiveCandidatesBlock("unknown", "Run is in flight — no candidates recorded yet.");
  }
  const winner = context.coordinator.selectBestRunCandidate(runId);
  const winnerId = winner?.workspaceId ?? null;
  const hasShadow = candidates.some((c) => c.role === "shadow");
  const projected: RunCandidateView[] = candidates.map((c) => {
    const isWinner = winnerId !== null && c.workspaceId === winnerId;
    const dq = c.status !== "passed" && c.status !== "pending"
      ? `status=${c.status}`
      : null;
    return {
      workspaceId: c.workspaceId,
      role: c.role,
      lane: c.lane ?? null,
      provider: c.provider ?? null,
      model: c.model ?? null,
      status: c.status,
      disqualification: dq,
      costUsd: c.costUsd,
      latencyMs: c.latencyMs,
      verifierVerdict: c.verifierVerdict,
      confidence: c.confidence ?? null,
      advisoryFindings: c.advisoryFindings ?? null,
      criticalFindings: c.criticalFindings,
      changedFilesCount: c.changedFiles?.length ?? null,
      outcome: dq
        ? "disqualified"
        : isWinner
          ? "selected"
          : winnerId === null
            ? "pending"
            : "lost",
      reason: c.reason,
    };
  });
  return {
    shadowMode: hasShadow ? "active" : "inactive",
    laneMode: "in-flight",
    inactiveReason: hasShadow
      ? ""
      : "Only the primary lane has produced a candidate so far.",
    candidates: projected,
    selection: {
      winnerWorkspaceId: winnerId,
      winnerRole: winner?.role ?? null,
      rolePreferenceUsed: false,
      costAffected: false,
      advisoryAffected: false,
      shadowPromoteAllowed: false,
      note: "Only primary workspaces can promote. Selection is recomputed on every receipt write.",
    },
  };
}

/**
 * Look up the Loqui decision the unified router recorded when this
 * run was submitted. Returns undefined when no decision is on file
 * (legacy /tasks submit, or server restarted since submission).
 */
function projectLoquiDecision(
  runId: string,
  taskId: string | null,
): RunLoquiDecisionView | undefined {
  const decision = getLoquiDecisionForRun(runId)
    ?? (taskId ? getLoquiDecisionForRun(taskId) : undefined);
  if (!decision) return undefined;
  return buildLoquiDecisionView(decision);
}

// ─── Diff Utilities ─────────────────────────────────────────────────

/**
 * Split a combined unified diff (multiple files) into a Map keyed by
 * the b-side file path. Each value is a self-contained diff that
 * starts with `diff --git ...` and contains all hunks for that file.
 * Sections without a recognisable `diff --git a/... b/...` header are
 * silently dropped.
 */
export function splitUnifiedDiffByFile(combined: string): Map<string, string> {
  const result = new Map<string, string>();
  const sections = combined.split(/(?=^diff --git )/m);
  for (const section of sections) {
    const headerMatch = /^diff --git a\/\S+ b\/(\S+)/.exec(section);
    if (!headerMatch) continue;
    const filePath = headerMatch[1];
    result.set(filePath, section.trimEnd());
  }
  return result;
}

/**
 * Synthesize a unified diff for a newly created file. The output uses
 * `/dev/null` as the a-side and marks every line as added.
 */
export function synthesizeCreateDiff(filePath: string, content: string): string {
  const lines = content.split("\n");
  const added = lines.map((l) => `+${l}`).join("\n");
  return `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${added}\n`;
}
