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
import { getAllTrackedRuns, getTrackedRun } from "./tasks.js";

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
          runs: projected,
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
            run_id: runId,
            status: completed ? "complete" : "running",
            verdict,
            started_at: started?.timestamp ?? null,
            completed_at: completed?.timestamp ?? null,
            event_count: runEvents.length,
            phases: [...new Set(runEvents.map((e) => e.type))],
          };
        })
        .filter((r) => !statusFilter || r.status === statusFilter || r.verdict === statusFilter)
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

      // Try tracked registry first — either the task_id or the
      // runId. `getTrackedRun` keys on task_id; a linear scan
      // covers the runId case without needing a second index.
      const byTaskId = getTrackedRun(id);
      const tracked =
        byTaskId ??
        (getAllTrackedRuns() as unknown as readonly TrackedRunLike[]).find(
          (r) => r.runId === id,
        );
      if (tracked) {
        const detail = projectRunDetail(tracked as unknown as TrackedRunLike);
        if (detail) {
          reply.send({ ...detail, source: "tracked-runs" });
          return;
        }
      }

      // Check active runs (in-flight coordinator state)
      const active = ctx().coordinator.getRunStatus(id);
      if (active) {
        reply.send({
          run_id: id,
          status: "running",
          run_state: {
            phase: active.run.phase,
            tasks: active.run.tasks.map((t) => ({
              id: t.id,
              worker_type: t.workerType,
              description: t.description,
              status: t.status,
              target_files: t.targetFiles,
            })),
            assumptions: active.run.assumptions,
            decisions: active.run.decisions,
            total_cost: active.run.totalCost,
          },
          task_graph: {
            nodes: active.graph.nodes.map((n) => ({
              id: n.id,
              label: n.label,
              worker_type: n.workerType,
              status: n.status,
              assigned_tier: n.assignedTier,
              target_files: n.targetFiles,
            })),
            edges: active.graph.edges,
            merge_groups: active.graph.mergeGroups,
            checkpoints: active.graph.checkpoints.map((cp) => ({
              id: cp.id,
              label: cp.label,
              status: cp.status,
            })),
            escalation_boundaries: active.graph.escalationBoundaries,
          },
        });
        return;
      }

      // Fall back to event history
      const events = ctx().eventBus.recentEvents(500);
      const runEvents = events.filter((e) => (e.payload as any).runId === id);

      if (runEvents.length === 0) {
        reply.code(404).send({
          error: "Not found",
          message: `No run found with ID "${id}"`,
        });
        return;
      }

      reply.send({
        run_id: id,
        status: "complete",
        events: runEvents,
        event_count: runEvents.length,
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

      const events = ctx().eventBus.recentEvents(500);
      const integrationEvents = events.filter(
        (e) =>
          (e.payload as any).runId === id &&
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

      reply.send({
        run_id: id,
        integration: {
          verdict: lastCheck.type === "merge_approved" ? "approved" : lastCheck.type === "merge_blocked" ? "blocked" : "pending",
          events: integrationEvents,
          last_check: lastCheck,
        },
      });
    }
  );

  /**
   * GET /runs/:id/receipts — Cost breakdown and full receipt.
   */
  fastify.get<{ Params: RunParams }>(
    "/:id/receipts",
    async (request: FastifyRequest<{ Params: RunParams }>, reply: FastifyReply) => {
      const { id } = request.params;

      const events = ctx().eventBus.recentEvents(500);
      const receiptEvent = events.find(
        (e) => e.type === "receipt_generated" && (e.payload as any).runId === id
      );

      // Gather all cost-related events
      const costEvents = events.filter(
        (e) =>
          (e.payload as any).runId === id &&
          (e.type === "worker_assigned" || e.type === "task_complete" || e.type === "receipt_generated")
      );

      if (costEvents.length === 0) {
        reply.code(404).send({
          error: "Not found",
          message: `No receipt data for run "${id}"`,
        });
        return;
      }

      reply.send({
        run_id: id,
        receipt: receiptEvent?.payload ?? null,
        cost_timeline: costEvents.map((e) => ({
          type: e.type,
          timestamp: e.timestamp,
          payload: e.payload,
        })),
      });
    }
  );
};
