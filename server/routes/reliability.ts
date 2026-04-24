/**
 * Reliability API — minimal read surface for the reliability harness.
 *
 * Trials are produced by the CLI (`aedis reliability run`) and written
 * to state/reliability/. This route exposes them for inspection without
 * asking the user to cat JSON.
 *
 * GET /reliability/trials         — list trial summaries, newest first
 * GET /reliability/trials/:id     — full trial, including per-task results
 * GET /reliability/trials/latest  — most recently recorded trial
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";

import type { ServerContext } from "../index.js";
import {
  listTrials,
  loadLatestTrial,
  loadTrial,
} from "../../core/reliability-harness.js";

interface TrialParams {
  id: string;
}

export const reliabilityRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  fastify.get("/trials", async (_req, reply) => {
    const trials = await listTrials(ctx().config.projectRoot);
    reply.send({ trials });
  });

  fastify.get("/trials/latest", async (_req, reply) => {
    const trial = await loadLatestTrial(ctx().config.projectRoot);
    if (!trial) {
      reply.code(404).send({ error: "Not found", message: "no trials recorded" });
      return;
    }
    reply.send({ trial });
  });

  fastify.get<{ Params: TrialParams }>(
    "/trials/:id",
    async (req: FastifyRequest<{ Params: TrialParams }>, reply: FastifyReply) => {
      const trial = await loadTrial(ctx().config.projectRoot, req.params.id);
      if (!trial) {
        reply.code(404).send({
          error: "Not found",
          message: `trial "${req.params.id}" not found`,
        });
        return;
      }
      reply.send({ trial });
    },
  );
};
