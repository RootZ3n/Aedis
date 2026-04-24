/**
 * Cost Dashboard API — Aedis cost observability.
 *
 * GET /cost           — Cost summary, trend, and per-run breakdown
 * GET /cost/trend     — Cost over last N runs (for bar chart)
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { getAllTrackedRuns } from "./tasks.js";

interface CostTrendEntry {
  runId: string;
  taskId: string | null;
  costUsd: number;
  timestamp: string;
  status: string;
  classification: string | null;
}

interface CostBreakdown {
  totalCostUsd: number;
  runsAnalyzed: number;
  avgCostPerRunUsd: number;
  maxCostUsd: number;
  minCostUsd: number;
  medianCostUsd: number;
  trend: CostTrendEntry[];
  byStatus: Record<string, { count: number; totalCostUsd: number }>;
}

export const costRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /cost — Cost summary and per-run breakdown.
   */
  fastify.get(
    "/",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const tracked = await getAllTrackedRuns();
      const persistedIndex = await fastify.ctx.receiptStore.listRuns(1000);

      // Build a map of runId -> cost
      type CostEntry = { runId: string; taskId: string | null; costUsd: number; timestamp: string; status: string; classification: string | null };
      const costMap = new Map<string, CostEntry>();

      for (const entry of persistedIndex) {
        try {
          const run = await fastify.ctx.receiptStore.getRun(entry.runId);
          if (!run) continue;
          const task = await fastify.ctx.receiptStore.getTaskByRunId(entry.runId);
          const cost = Number(run.totalCost?.estimatedCostUsd ?? 0);
          costMap.set(entry.runId, {
            runId: entry.runId,
            taskId: task?.taskId ?? null,
            costUsd: Number.isFinite(cost) ? cost : 0,
            timestamp: run.completedAt ?? run.updatedAt,
            status: run.status,
            classification: run.finalClassification,
          });
        } catch {
          // skip
        }
      }

      const allEntries = [...costMap.values()];
      allEntries.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

      if (allEntries.length === 0) {
        return reply.send({
          totalCostUsd: 0,
          runsAnalyzed: 0,
          avgCostPerRunUsd: 0,
          maxCostUsd: 0,
          minCostUsd: 0,
          medianCostUsd: 0,
          trend: [],
          byStatus: {},
        } satisfies CostBreakdown);
      }

      const costs = allEntries.map((e) => e.costUsd).sort((a, b) => a - b);
      const totalCostUsd = costs.reduce((sum, c) => sum + c, 0);
      const medianCostUsd = costs.length % 2 === 0
        ? (costs[costs.length / 2 - 1] + costs[costs.length / 2]) / 2
        : costs[Math.floor(costs.length / 2)];

      const byStatus: Record<string, { count: number; totalCostUsd: number }> = {};
      for (const entry of allEntries) {
        const key = entry.status;
        if (!byStatus[key]) byStatus[key] = { count: 0, totalCostUsd: 0 };
        byStatus[key].count += 1;
        byStatus[key].totalCostUsd += entry.costUsd;
      }

      const breakdown: CostBreakdown = {
        totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
        runsAnalyzed: allEntries.length,
        avgCostPerRunUsd: Math.round((totalCostUsd / allEntries.length) * 1_000_000) / 1_000_000,
        maxCostUsd: Math.max(...costs),
        minCostUsd: Math.min(...costs),
        medianCostUsd: Math.round(medianCostUsd * 1_000_000) / 1_000_000,
        trend: allEntries.slice(-50).map((e) => ({
          runId: e.runId,
          taskId: e.taskId,
          costUsd: Math.round(e.costUsd * 1_000_000) / 1_000_000,
          timestamp: e.timestamp,
          status: e.status,
          classification: e.classification,
        })),
        byStatus,
      };

      reply.send(breakdown);
    }
  );

  /**
   * GET /cost/trend — Last N cost entries for bar chart.
   */
  fastify.get<{ Querystring: { limit?: string } }>(
    "/trend",
    async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply: FastifyReply) => {
      const limit = Math.min(Math.max(parseInt(request.query.limit ?? "20", 10) || 20, 1), 100);
      const index = await fastify.ctx.receiptStore.listRuns(limit * 2);

      const entries: CostTrendEntry[] = [];
      for (const entry of index) {
        try {
          const run = await fastify.ctx.receiptStore.getRun(entry.runId);
          if (!run) continue;
          const task = await fastify.ctx.receiptStore.getTaskByRunId(entry.runId);
          const cost = Number(run.totalCost?.estimatedCostUsd ?? 0);
          entries.push({
            runId: entry.runId,
            taskId: task?.taskId ?? null,
            costUsd: Math.round((Number.isFinite(cost) ? cost : 0) * 1_000_000) / 1_000_000,
            timestamp: run.completedAt ?? run.updatedAt,
            status: run.status,
            classification: run.finalClassification,
          });
        } catch {
          // skip
        }
      }

      entries.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
      const sliced = entries.slice(-limit);

      reply.send({ trend: sliced, count: sliced.length });
    }
  );
};
