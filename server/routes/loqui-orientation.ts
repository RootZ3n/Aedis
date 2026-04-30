/**
 * Loqui Orientation route — adaptive system explanation + workflow guide.
 *
 *   GET /loqui/orientation         — Snapshot system state, return the
 *                                    structured orientation response.
 *   GET /api/loqui/orientation     — Same, mounted under /api too.
 *
 * Read-only. The route gathers the live state surface (model profile,
 * provider keys, plans, active runs, state-root isolation) and hands
 * it to `buildOrientation()`. Orientation never auto-runs anything;
 * the response is purely informational with quick-action ids the UI
 * can map to existing buttons.
 *
 * Anti-spam guards live at the trigger layer (UI session storage +
 * `shouldShowOrientation`). The route itself is idempotent — every
 * call returns the current view; it's the UI that decides when to
 * render the panel.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";

import type { ServerContext } from "../index.js";
import {
  buildOrientation,
  isOrientationRequest,
  shouldShowOrientation,
  type OrientationStateSnapshot,
} from "../../core/loqui-orientation.js";
import { TaskPlanStore } from "../../core/task-plan-store.js";
import { getActiveModelProfile } from "./config.js";
import { loadProviderRegistry } from "./providers.js";
import type { TaskPlan } from "../../core/task-plan.js";

// ─── Active-run detection ───────────────────────────────────────────

/**
 * Receipt statuses the UI considers "in flight." Mirrors the mapping
 * in server/routes/tasks.ts (mapTrackedStatus): any of these means a
 * worker is actively doing work or waiting on the operator's approval.
 */
export const ACTIVE_RECEIPT_STATUSES: readonly string[] = [
  "PROPOSED",
  "RUNNING",
  "EXECUTING_IN_WORKSPACE",
  "VERIFICATION_PENDING",
  "AWAITING_APPROVAL",
  "DISAGREEMENT_HOLD",
];

export interface ReceiptListingReader {
  listRuns: (limit: number, status?: string) => Promise<ReadonlyArray<unknown>>;
}

export async function detectActiveTask(receiptStore: ReceiptListingReader): Promise<boolean> {
  // Cap the listing — we only need to know if *any* run is active,
  // not how many. Walking every status filter individually keeps the
  // per-call work small and lets the receipt store short-circuit.
  for (const status of ACTIVE_RECEIPT_STATUSES) {
    const runs = await receiptStore.listRuns(1, status);
    if (runs.length > 0) return true;
  }
  return false;
}

// ─── Plan highlighting ──────────────────────────────────────────────

/**
 * Pick the most relevant plan for the operator. Precedence:
 *   paused → running → interrupted → blocked → pending → newest non-terminal
 *
 * Terminal plans (completed/failed/cancelled) are skipped so orientation
 * never points the operator at a dead plan.
 */
export function pickHighlightedPlan(plans: readonly TaskPlan[]): TaskPlan | null {
  const order: ReadonlyArray<TaskPlan["status"]> = [
    "paused",
    "running",
    "interrupted",
    "blocked",
    "pending",
  ];
  for (const status of order) {
    const match = plans.find((p) => p.status === status);
    if (match) return match;
  }
  // Fall back to the most recent non-terminal plan if any. `list()`
  // returns newest-first, so the first non-terminal entry is fine.
  return plans.find((p) => !isTerminalPlan(p)) ?? null;
}

function isTerminalPlan(plan: TaskPlan): boolean {
  return plan.status === "completed" || plan.status === "failed" || plan.status === "cancelled";
}

// ─── Snapshot builder ───────────────────────────────────────────────

async function buildSnapshot(ctx: ServerContext): Promise<OrientationStateSnapshot> {
  const modelProfile = getActiveModelProfile();

  const registry = loadProviderRegistry(ctx.config.projectRoot);
  const providers = Object.entries(registry.providers).map(([name, entry]) => {
    const requiresKey = Boolean(entry.apiKeyEnv);
    const apiKeyPresent = entry.apiKeyEnv
      ? typeof process.env[entry.apiKeyEnv] === "string" &&
        (process.env[entry.apiKeyEnv] as string).length > 0
      : true;
    return {
      name,
      label: entry.label ?? name,
      apiKeyPresent,
      requiresKey,
    };
  });

  const planStore = new TaskPlanStore({ stateRoot: ctx.config.stateRoot });
  const plans = await planStore.list();
  const highlighted = pickHighlightedPlan(plans);

  const hasActiveTask = await detectActiveTask(ctx.receiptStore);

  const stateRootIsolated = ctx.config.stateRoot !== ctx.config.projectRoot;

  return {
    modelProfile,
    providers,
    planCount: plans.length,
    highlightedPlan: highlighted
      ? {
          taskPlanId: highlighted.taskPlanId,
          status: highlighted.status,
          objective: highlighted.objective,
        }
      : null,
    hasActiveTask,
    stateRootIsolated,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────

interface OrientationQuery {
  /**
   * UI session signals — let the UI declare whether the panel was
   * already shown / dismissed this session, so the response carries a
   * `show` flag the UI can use directly without re-deriving the rule.
   */
  alreadyShown?: string;
  dismissed?: string;
  /**
   * Freeform user utterance, if the operator typed something like
   * "what does Aedis do?" into the Loqui input. The route routes the
   * utterance through `isOrientationRequest` so a bogus value (e.g.
   * "build a registry") doesn't unlock orientation.
   */
  question?: string;
}

function parseBoolFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }
  return false;
}

export const loquiOrientationRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  fastify.get<{ Querystring: OrientationQuery }>(
    "/orientation",
    async (
      request: FastifyRequest<{ Querystring: OrientationQuery }>,
      reply: FastifyReply,
    ) => {
      const snapshot = await buildSnapshot(ctx());
      const orientation = buildOrientation(snapshot);

      const alreadyShown = parseBoolFlag(request.query.alreadyShown);
      const dismissed = parseBoolFlag(request.query.dismissed);
      const explicitlyRequested = isOrientationRequest(
        String(request.query.question ?? ""),
      );

      const show = shouldShowOrientation({
        alreadyShownThisSession: alreadyShown,
        dismissedThisSession: dismissed,
        hasActiveTask: snapshot.hasActiveTask,
        explicitlyRequested,
      });

      reply.send({
        show,
        orientation,
        // Surface the inputs that produced `show` so the UI can render
        // a debug tooltip without making a second call. Truthy
        // explicitlyRequested implies the user typed an orientation
        // question; UIs may use this to scroll the panel into view.
        trigger: {
          alreadyShownThisSession: alreadyShown,
          dismissedThisSession: dismissed,
          hasActiveTask: snapshot.hasActiveTask,
          explicitlyRequested,
        },
        snapshot: {
          modelProfile: snapshot.modelProfile,
          planCount: snapshot.planCount,
          highlightedPlan: snapshot.highlightedPlan,
          hasActiveTask: snapshot.hasActiveTask,
          stateRootIsolated: snapshot.stateRootIsolated,
          missingProviderKeys: snapshot.providers
            .filter((p) => p.requiresKey && !p.apiKeyPresent)
            .map((p) => p.name),
        },
      });
    },
  );
};
