/**
 * Mission Mode routes — unified high-level workflow.
 *
 * POST /missions/propose  — Propose a mission from a high-level objective
 * POST /missions/start    — Create TaskPlan + start from approved proposal
 *
 * Safety:
 *   - Vague prompt → clarify
 *   - Unsafe prompt → block
 *   - Start creates a TaskPlan but does NOT approve or promote
 *   - All execution goes through coordinator.submit()
 *   - Cloud usage disclosed before start
 */

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";

import type { ServerContext } from "../index.js";
import { proposeMission } from "../../core/mission.js";
import {
  createTaskPlan,
  validateCreateTaskPlanInput,
  type CreateTaskPlanInput,
} from "../../core/task-plan.js";
import { TaskPlanStore } from "../../core/task-plan-store.js";
import { ScoutEvidenceStore } from "../../core/scout-report.js";

// ─── Routes ──────────────────────────────────────────────────────────

export const missionRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => (fastify as unknown as { ctx: ServerContext }).ctx;

  /**
   * POST /missions/propose
   *
   * Takes a high-level objective, runs scouts, generates subtasks.
   * Returns a MissionProposal the user can edit/approve/reject.
   * Does NOT create a TaskPlan or start execution.
   */
  fastify.post("/propose", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.objective !== "string" || typeof body.repoPath !== "string") {
      reply.status(400).send({ error: "objective (string) and repoPath (string) are required" });
      return;
    }

    const objective = (body.objective as string).trim();
    const repoPath = (body.repoPath as string).trim();

    if (!objective) {
      reply.status(400).send({ error: "objective must be non-empty" });
      return;
    }
    if (!existsSync(repoPath)) {
      reply.status(400).send({
        error: "Bad request",
        message: `repoPath does not exist on this host: ${repoPath}`,
      });
      return;
    }

    const result = await proposeMission({
      objective,
      repoPath,
      modelProfile: typeof body.modelProfile === "string" ? body.modelProfile : undefined,
      cloudKeysAvailable: typeof body.cloudKeysAvailable === "boolean" ? body.cloudKeysAvailable : undefined,
    });

    switch (result.kind) {
      case "mission_block":
        reply.status(400).send({
          status: "blocked",
          reason: result.reason,
        });
        return;

      case "mission_clarify":
        reply.send({
          status: "needs_clarification",
          question: result.question,
          reason: result.reason,
        });
        return;

      case "mission_skip":
        reply.send({
          status: "skipped",
          reason: result.reason,
        });
        return;

      case "mission_proposal":
        reply.send({
          status: "proposed",
          proposal: result,
        });
        return;
    }
  });

  /**
   * POST /missions/start
   *
   * Takes an approved (possibly edited) mission proposal and:
   * 1. Creates a TaskPlan
   * 2. Persists scout evidence links
   * 3. Returns the plan ID (does NOT start execution)
   *
   * The user must then POST /task-plans/:id/start to begin.
   * This two-step flow ensures mission start != approval.
   */
  fastify.post("/start", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.objective !== "string" || typeof body.repoPath !== "string") {
      reply.status(400).send({ error: "objective (string) and repoPath (string) are required" });
      return;
    }

    const objective = (body.objective as string).trim();
    const repoPath = (body.repoPath as string).trim();
    const subtasks = Array.isArray(body.subtasks) ? body.subtasks : [];

    if (!objective || subtasks.length === 0) {
      reply.status(400).send({
        error: "objective and at least one subtask are required",
      });
      return;
    }
    if (!existsSync(repoPath)) {
      reply.status(400).send({ error: `repoPath does not exist: ${repoPath}` });
      return;
    }

    // Build TaskPlan input
    const input: CreateTaskPlanInput = {
      objective,
      repoPath,
      subtasks: subtasks.map((s: Record<string, unknown>) => ({
        title: typeof s.title === "string" ? s.title : undefined,
        prompt: typeof s.prompt === "string" ? s.prompt : "",
      })),
      ...(body.budget && typeof body.budget === "object" ? { budget: body.budget as Record<string, number> } : {}),
    };

    const validation = validateCreateTaskPlanInput(input);
    if (!validation.ok) {
      reply.status(400).send({ error: "Validation failed", errors: validation.errors });
      return;
    }

    // Create the plan
    const store = new TaskPlanStore({ stateRoot: ctx().config.stateRoot });
    const planId = `mission_${randomUUID().slice(0, 12)}`;
    const plan = createTaskPlan(input, {
      taskPlanId: planId,
      now: new Date().toISOString(),
    });
    await store.create(plan);

    // Persist scout evidence link if provided
    if (Array.isArray(body.scoutReportIds) && body.scoutReportIds.length > 0) {
      try {
        const evidenceStore = new ScoutEvidenceStore(ctx().config.stateRoot);
        await evidenceStore.save({
          runId: planId,
          planId,
          prompt: objective,
          repoPath,
          reports: [],
          spawnDecision: {
            spawn: true,
            reason: "mission proposal scouts",
            scoutCount: (body.scoutReportIds as string[]).length,
            scoutTypes: ["target_discovery"],
            localOrCloudRecommendation: "deterministic",
            expectedEvidence: ["advisory targets"],
          },
          createdAt: new Date().toISOString(),
        });
      } catch {
        // Non-fatal
      }
    }

    // Emit creation event. `phase: "plan_ready"` is the explicit
    // "no execution has happened yet" signal the UI keys off so the
    // global status banner does not inherit the prior run's state
    // (e.g. a stale COMPLETE 100% from the last build).
    ctx().eventBus.emit({
      type: "task_plan_event",
      payload: {
        kind: "plan_created",
        phase: "plan_ready",
        taskPlanId: planId,
        status: "pending",
        currentSubtaskId: null,
        progress: { completed: 0, total: plan.subtasks.length },
        stopReason: "",
        executed: false,
        message: `Plan ready — ${plan.subtasks.length} subtask(s) waiting for start. Click Start to begin.`,
        updatedAt: plan.updatedAt,
      },
    });

    reply.status(201).send({
      status: "plan_ready",
      phase: "plan_ready",
      task_plan_id: planId,
      plan,
      executed: false,
      next_action: {
        kind: "start_required",
        endpoint: `/task-plans/${planId}/start`,
        method: "POST",
        manualStartRequired: true,
        approvalRequired: true,
        description:
          "Plan created but no Builder/Critic/Verifier/Integrator has run yet. " +
          "Click Start in the Task Plan panel to dispatch the first subtask.",
      },
      message:
        `Plan ready with ${plan.subtasks.length} subtask(s). ` +
        `No execution has occurred — POST /task-plans/${planId}/start to begin. ` +
        `Approval is still required before source changes are promoted.`,
    });
  });
};
