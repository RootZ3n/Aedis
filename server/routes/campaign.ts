/**
 * Campaign API — cross-repo proving and trust measurement.
 *
 * Registry:
 *   GET    /campaign/repos           — List registered repos
 *   POST   /campaign/repos           — Register a repo
 *   DELETE /campaign/repos/:id       — Remove a repo
 *
 * Campaigns:
 *   POST   /campaign/run/:repoId     — Run a campaign against a repo
 *   GET    /campaign/history/:repoId — Load campaign history for a repo
 *
 * Insights:
 *   GET    /campaign/insights        — Cross-repo aggregated insights
 */

import type { FastifyPluginAsync } from "fastify";

import {
  loadRegistry,
  registerRepo,
  removeRepo,
  generateCampaignCases,
  runCampaign,
  loadCampaignHistory,
  computeCrossRepoInsights,
  type RepoSize,
  type CampaignCase,
} from "../../core/proving-campaign.js";
import { profileRepo } from "../../core/proving-harness.js";

export const campaignRoutes: FastifyPluginAsync = async (fastify) => {
  const root = () => fastify.ctx.config.projectRoot;

  // ─── Registry ───────────────────────────────────────────────────

  fastify.get("/repos", async (_request, reply) => {
    try {
      const registry = await loadRegistry(root());
      reply.send(registry);
    } catch (err) {
      reply.status(500).send({ error: "Registry unavailable", message: String(err) });
    }
  });

  fastify.post<{
    Body: { repoPath: string; name?: string; size?: RepoSize; framework?: string };
  }>("/repos", async (request, reply) => {
    try {
      const { repoPath, name, size, framework } = request.body;
      if (!repoPath) {
        reply.status(400).send({ error: "repoPath is required" });
        return;
      }
      const repo = await registerRepo(root(), repoPath, { name, size, framework });
      reply.status(201).send(repo);
    } catch (err) {
      reply.status(500).send({ error: "Registration failed", message: String(err) });
    }
  });

  fastify.delete<{ Params: { id: string } }>("/repos/:id", async (request, reply) => {
    try {
      const removed = await removeRepo(root(), request.params.id);
      reply.send({ ok: removed });
    } catch (err) {
      reply.status(500).send({ error: "Removal failed", message: String(err) });
    }
  });

  // ─── Campaigns ──────────────────────────────────────────────────

  fastify.post<{
    Params: { repoId: string };
    Body: { mode?: "planning" | "execution" | "mixed"; cases?: CampaignCase[] };
  }>("/run/:repoId", async (request, reply) => {
    try {
      const { repoId } = request.params;
      const mode = request.body.mode ?? "planning";

      let cases: CampaignCase[];
      if (request.body.cases && request.body.cases.length > 0) {
        cases = request.body.cases;
      } else {
        // Auto-generate cases from repo profile
        const registry = await loadRegistry(root());
        const repo = registry.repos.find((r) => r.id === repoId);
        if (!repo) {
          reply.status(404).send({ error: `Repo ${repoId} not found` });
          return;
        }
        const profile = repo.profile ?? await profileRepo(repo.path);
        cases = generateCampaignCases(profile, mode);
      }

      // For execution mode, pass the coordinator. For planning, pass null.
      const coordinator = mode !== "planning"
        ? {
            submit: async (input: { input: string; projectRoot?: string }) => {
              // Submit with no-commit safety: override config to prevent auto-commit
              const receipt = await fastify.ctx.coordinator.submit({
                input: input.input,
                projectRoot: input.projectRoot,
              });
              return receipt;
            },
          }
        : null;

      const report = await runCampaign(root(), repoId, cases, coordinator);
      reply.send(report);
    } catch (err) {
      reply.status(500).send({ error: "Campaign failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get<{ Params: { repoId: string } }>(
    "/history/:repoId",
    async (request, reply) => {
      try {
        const history = await loadCampaignHistory(root(), request.params.repoId);
        reply.send({ campaigns: history, total: history.length });
      } catch (err) {
        reply.status(500).send({ error: "History unavailable", message: String(err) });
      }
    },
  );

  // ─── Insights ───────────────────────────────────────────────────

  fastify.get("/insights", async (_request, reply) => {
    try {
      const insights = await computeCrossRepoInsights(root());
      reply.send(insights);
    } catch (err) {
      reply.status(500).send({ error: "Insights unavailable", message: String(err) });
    }
  });
};
