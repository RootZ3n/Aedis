/**
 * Plan routes — Inspect, approve, or reject pending decomposition plans.
 *
 * GET  /plans/:id         — Inspect a pending plan and its scope classification
 * POST /plans/:id/approve — Approve a pending plan and start execution
 * POST /plans/:id/reject  — Drop a pending plan without executing
 *
 * These routes mirror the existing /tasks/:id/approve surface and
 * share its tracked-run bookkeeping via registerTrackedPlanRun, so a
 * plan approved through either path produces the same TrackedRun
 * entry visible to /tasks/:id, /runs/:id, and the WebSocket bus.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../index.js";
import { registerTrackedPlanRun } from "./tasks.js";

interface PlanParams {
  id: string;
}

export const planRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  fastify.get<{ Params: PlanParams }>(
    "/:id",
    async (request: FastifyRequest<{ Params: PlanParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const pending = ctx().coordinator.getPendingPlan(id);
      if (!pending) {
        reply.code(404).send({
          error: "Not found",
          message: `No pending plan found with ID "${id}"`,
        });
        return;
      }
      reply.send({
        plan_id: pending.taskId,
        created_at: pending.createdAt,
        plan: pending.plan,
        scope_classification: pending.scopeClassification,
        submission: {
          input: pending.submission.input,
          repo_path: pending.submission.projectRoot ?? null,
        },
      });
    },
  );

  fastify.post<{ Params: PlanParams }>(
    "/:id/approve",
    async (request: FastifyRequest<{ Params: PlanParams }>, reply: FastifyReply) => {
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
        plan_id: id,
        task_id: tracked.taskId,
        run_id: tracked.runId,
        status: "running",
        message: `Plan "${id}" approved. Execution started.`,
      });
    },
  );

  fastify.post<{ Params: PlanParams }>(
    "/:id/reject",
    async (request: FastifyRequest<{ Params: PlanParams }>, reply: FastifyReply) => {
      const { id } = request.params;
      const removed = ctx().coordinator.rejectPlan(id);
      if (!removed) {
        reply.code(404).send({
          error: "Not found",
          message: `No pending plan found with ID "${id}"`,
        });
        return;
      }
      reply.send({
        plan_id: id,
        status: "rejected",
        message: `Plan "${id}" rejected.`,
      });
    },
  );
};
