/**
 * Scout Evidence API routes.
 *
 * GET  /scouts/evidence          — list all scout evidence run IDs
 * GET  /scouts/evidence/:runId   — get scout evidence for a specific run
 * POST /scouts/spawn-check       — check whether scouts would spawn for a prompt
 * POST /scouts/run               — run scouts for a prompt (on-demand)
 *
 * Read-only surface for evidence retrieval. The spawn-check and run
 * endpoints are utility surfaces for the UI and Plan Assist.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../index.js";
import { shouldSpawnScouts, type ScoutSpawnInput } from "../../core/scout-spawn.js";
import { routeScout } from "../../core/scout-routing.js";
import { ScoutEvidenceStore, type ScoutEvidence } from "../../core/scout-report.js";
import { runScouts } from "../../core/scout-agents.js";

export const scoutEvidenceRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => (fastify as unknown as { ctx: ServerContext }).ctx;

  function getStore(): ScoutEvidenceStore {
    return new ScoutEvidenceStore(ctx().config.stateRoot);
  }

  // GET /scouts/evidence — list all evidence run IDs
  fastify.get("/evidence", async (_req: FastifyRequest, reply: FastifyReply) => {
    const store = getStore();
    const ids = await store.list();
    reply.send({ runIds: ids });
  });

  // GET /scouts/evidence/:runId — get evidence for a run
  fastify.get<{ Params: { runId: string } }>(
    "/evidence/:runId",
    async (req: FastifyRequest<{ Params: { runId: string } }>, reply: FastifyReply) => {
      const { runId } = req.params;
      if (!runId) {
        reply.status(400).send({ error: "runId is required" });
        return;
      }
      const store = getStore();
      const evidence = await store.load(runId);
      if (!evidence) {
        reply.status(404).send({ error: `No scout evidence found for run ${runId}` });
        return;
      }
      reply.send(evidence);
    },
  );

  // POST /scouts/spawn-check — check whether scouts would spawn
  fastify.post("/spawn-check", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.prompt !== "string") {
      reply.status(400).send({ error: "prompt (string) is required" });
      return;
    }

    const input: ScoutSpawnInput = {
      prompt: body.prompt as string,
      intentConfidence:
        typeof body.intentConfidence === "number" ? body.intentConfidence : undefined,
      intent: typeof body.intent === "string" ? body.intent : undefined,
      knownTargetFiles: Array.isArray(body.knownTargetFiles)
        ? (body.knownTargetFiles as string[])
        : undefined,
      isTaskPlanCreation:
        typeof body.isTaskPlanCreation === "boolean" ? body.isTaskPlanCreation : undefined,
      remainingBudgetUsd:
        typeof body.remainingBudgetUsd === "number" ? body.remainingBudgetUsd : undefined,
      modelProfile: typeof body.modelProfile === "string" ? body.modelProfile : undefined,
      cloudKeysAvailable:
        typeof body.cloudKeysAvailable === "boolean" ? body.cloudKeysAvailable : undefined,
    };

    const decision = shouldSpawnScouts(input);
    reply.send(decision);
  });

  // POST /scouts/run — run scouts on-demand
  fastify.post("/run", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.prompt !== "string" || typeof body.repoPath !== "string") {
      reply.status(400).send({ error: "prompt (string) and repoPath (string) are required" });
      return;
    }

    const prompt = body.prompt as string;
    const repoPath = body.repoPath as string;

    // Check spawn decision
    const spawnInput: ScoutSpawnInput = {
      prompt,
      knownTargetFiles: Array.isArray(body.targetFiles) ? (body.targetFiles as string[]) : undefined,
      modelProfile: typeof body.modelProfile === "string" ? body.modelProfile : undefined,
      cloudKeysAvailable:
        typeof body.cloudKeysAvailable === "boolean" ? body.cloudKeysAvailable : undefined,
    };
    const decision = shouldSpawnScouts(spawnInput);

    if (!decision.spawn) {
      reply.send({
        spawned: false,
        decision,
        reports: [],
      });
      return;
    }

    // Route each scout type
    const routingDecisions = decision.scoutTypes.map((type) =>
      routeScout({
        scoutType: type,
        modelProfile: (body.modelProfile as string) || "default",
        cloudKeysAvailable: Boolean(body.cloudKeysAvailable),
        repoFileCount: 0,
        promptLength: prompt.length,
      }),
    );

    // Run scouts
    const reports = await runScouts({
      repoPath,
      prompt,
      scoutTypes: decision.scoutTypes,
      targetFiles: Array.isArray(body.targetFiles) ? (body.targetFiles as string[]) : [],
    });

    // Persist evidence
    const runId =
      typeof body.runId === "string"
        ? body.runId
        : `scout-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const evidence: ScoutEvidence = {
      runId,
      prompt,
      repoPath,
      reports,
      spawnDecision: decision,
      createdAt: new Date().toISOString(),
    };

    const store = getStore();
    await store.save(evidence);

    reply.send({
      spawned: true,
      decision,
      routing: routingDecisions,
      reports,
      runId,
    });
  });
};
