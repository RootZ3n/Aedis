/**
 * Prove API — Aedis proving harness endpoints.
 *
 * POST /prove/run    — Run a single prove case
 * POST /prove/suite  — Run a full prove suite
 * GET  /prove/suites — List available built-in suites
 */

import type { FastifyPluginAsync } from "fastify";

import {
  runProveCase,
  runProveSuite,
  builtinProveSuites,
  type ProveCase,
  type ProveSuite,
} from "../../core/proving-harness.js";

export const proveRoutes: FastifyPluginAsync = async (fastify) => {

  /**
   * GET /prove/suites — List available built-in prove suites.
   */
  fastify.get("/suites", async (_request, reply) => {
    const suites = builtinProveSuites();
    reply.send({
      suites: suites.map((s) => ({
        name: s.name,
        caseCount: s.cases.length,
        cases: s.cases.map((c) => ({
          name: c.name,
          prompt: c.prompt,
          expectedOutcome: c.expectedOutcome,
        })),
      })),
    });
  });

  /**
   * POST /prove/run — Run a single prove case.
   * Body: ProveCase (name, projectRoot, prompt, expectedOutcome)
   */
  fastify.post<{ Body: ProveCase }>("/run", async (request, reply) => {
    try {
      const testCase: ProveCase = {
        name: request.body.name ?? "ad-hoc",
        projectRoot: request.body.projectRoot ?? fastify.ctx.config.projectRoot,
        prompt: request.body.prompt,
        expectedOutcome: request.body.expectedOutcome ?? "success",
        expectedIssues: request.body.expectedIssues,
      };

      const result = await runProveCase(testCase);
      reply.send(result);
    } catch (err) {
      reply.status(500).send({
        error: "Prove case failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /prove/suite — Run a full prove suite.
   * Body: { name?: string, cases?: ProveCase[] }
   * If no cases provided, runs the matching built-in suite by name.
   */
  fastify.post<{ Body: { name?: string; cases?: ProveCase[] } }>(
    "/suite",
    async (request, reply) => {
      try {
        let suite: ProveSuite;

        if (request.body.cases && request.body.cases.length > 0) {
          suite = {
            name: request.body.name ?? "custom",
            cases: request.body.cases.map((c) => ({
              ...c,
              projectRoot: c.projectRoot ?? fastify.ctx.config.projectRoot,
            })),
          };
        } else {
          const builtins = builtinProveSuites();
          const match = builtins.find((s) => s.name === (request.body.name ?? "core-planning-reliability"));
          if (!match) {
            reply.status(404).send({
              error: `Suite "${request.body.name}" not found`,
              available: builtins.map((s) => s.name),
            });
            return;
          }
          suite = match;
        }

        const result = await runProveSuite(suite);
        reply.send(result);
      } catch (err) {
        reply.status(500).send({
          error: "Prove suite failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
};
