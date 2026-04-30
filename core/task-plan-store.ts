/**
 * Task-plan store — durable persistence for the multi-step loop.
 *
 * Layout:
 *   <stateRoot>/state/task-plans/index.json     — list of plan IDs
 *   <stateRoot>/state/task-plans/<id>.json      — full plan body
 *
 * Atomicity:
 *   Writes go to a temp file then `rename` to the target path. A
 *   process crash mid-write leaves the previous version intact —
 *   never a half-written JSON file. Same convention as ReceiptStore
 *   (core/receipt-store.ts:writeJsonAtomic).
 *
 * Restart semantics (CRITICAL):
 *   On boot, `restoreOnBoot` scans every plan and reconciles any
 *   plan in the `running` status to `interrupted`. The loop driver
 *   never auto-resumes — the operator must explicitly call
 *   /task-plans/<id>/continue. This is the same defensive default
 *   the coordinator uses for AWAITING_APPROVAL runs (rolled back
 *   on boot rather than re-attempted).
 */

import {
  existsSync,
  mkdirSync,
} from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type StopReason,
  type Subtask,
  type SubtaskStatus,
  type TaskPlan,
  type TaskPlanStatus,
} from "./task-plan.js";

const TASK_PLANS_SUBDIR = "task-plans";

export interface TaskPlanStoreOptions {
  /** Absolute path to <stateRoot>. Plans land in <stateRoot>/state/task-plans/. */
  readonly stateRoot: string;
}

export class TaskPlanStore {
  private readonly dir: string;

  constructor(options: TaskPlanStoreOptions) {
    this.dir = join(options.stateRoot, "state", TASK_PLANS_SUBDIR);
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /** Path the plan body lives at. Exposed for tests / diagnostics only. */
  getPlanPath(planId: string): string {
    return join(this.dir, `${sanitizeId(planId)}.json`);
  }

  /**
   * Persist a brand-new plan. Refuses overwriting an existing plan —
   * the API layer enforces unique IDs at create time.
   */
  async create(plan: TaskPlan): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.getPlanPath(plan.taskPlanId);
    if (existsSync(path)) {
      throw new TaskPlanStoreError(
        `task plan ${plan.taskPlanId} already exists at ${path}`,
      );
    }
    await writeJsonAtomic(path, plan);
  }

  /**
   * Save an updated plan. Overwrites unconditionally — the loop
   * driver is the single writer per plan. Callers MUST update
   * `updatedAt` before calling this.
   */
  async save(plan: TaskPlan): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.getPlanPath(plan.taskPlanId);
    await writeJsonAtomic(path, plan);
  }

  /** Read a plan by id, or null when absent / unparseable. */
  async load(planId: string): Promise<TaskPlan | null> {
    const path = this.getPlanPath(planId);
    if (!existsSync(path)) return null;
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as TaskPlan;
      if (!isTaskPlanShape(parsed)) {
        console.warn(`[task-plan-store] ignoring malformed plan at ${path}`);
        return null;
      }
      return parsed;
    } catch (err) {
      console.warn(
        `[task-plan-store] failed to load plan ${planId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Newest-first list of every plan on disk. */
  async list(): Promise<readonly TaskPlan[]> {
    if (!existsSync(this.dir)) return [];
    const entries = await readdir(this.dir);
    const plans: TaskPlan[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      if (entry === "index.json") continue; // future use
      const id = entry.replace(/\.json$/, "");
      const plan = await this.load(id);
      if (plan) plans.push(plan);
    }
    plans.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return plans;
  }

  /** Delete a plan from disk. Used by tests + the explicit `delete` API. */
  async delete(planId: string): Promise<void> {
    const path = this.getPlanPath(planId);
    if (!existsSync(path)) return;
    await rm(path, { force: true });
  }

  /**
   * Reconcile any plan in `running` state to `interrupted` after a
   * boot. Returns the list of plan IDs that were reconciled. The
   * loop driver NEVER auto-resumes; operator must explicitly continue.
   *
   * Idempotent: calling twice on a clean store is a no-op.
   */
  async restoreOnBoot(now: string): Promise<readonly string[]> {
    const plans = await this.list();
    const reconciled: string[] = [];
    for (const plan of plans) {
      if (plan.status !== "running") continue;
      const next: TaskPlan = {
        ...plan,
        status: "interrupted",
        stopReason: "server_interrupted",
        updatedAt: now,
        // Mark any in-flight subtasks as blocked so the audit trail
        // shows exactly where the run was when the server died.
        // No subtask is silently flipped to completed/failed — we
        // only flip the truthful "this one was running" → blocked.
        subtasks: plan.subtasks.map((s): Subtask => {
          if (s.status === "running" || s.status === "verifying") {
            return {
              ...s,
              status: "blocked",
              blockerReason: "server interrupted while subtask was running",
              nextRecommendedAction:
                "inspect the last receipt to confirm whether the change landed; then continue or skip",
            };
          }
          return s;
        }),
      };
      await this.save(next);
      reconciled.push(plan.taskPlanId);
    }
    if (reconciled.length > 0) {
      console.log(
        `[task-plan-store] STARTUP RECOVERY: reconciled ${reconciled.length} running plan(s) → interrupted; ` +
        `IDs: ${reconciled.join(", ")}`,
      );
    }
    return reconciled;
  }
}

export class TaskPlanStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskPlanStoreError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sanitizeId(id: string): string {
  // Plan IDs are server-generated UUID-shaped strings, but be defensive
  // in case a future caller passes user input.
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await rename(tempPath, path);
}

function isTaskPlanShape(v: unknown): v is TaskPlan {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.schemaVersion !== 1) return false;
  if (typeof o.taskPlanId !== "string" || !o.taskPlanId) return false;
  if (typeof o.objective !== "string") return false;
  if (!Array.isArray(o.subtasks)) return false;
  if (typeof o.status !== "string" || !VALID_PLAN_STATUSES.has(o.status as TaskPlanStatus)) return false;
  // Light shape check on subtasks; full validation isn't needed since
  // we control the writer. Wrong shape just means the file was
  // hand-edited or migrated — refuse to load and surface a warning.
  for (const s of o.subtasks as unknown[]) {
    if (!s || typeof s !== "object") return false;
    const so = s as Record<string, unknown>;
    if (typeof so.id !== "string") return false;
    if (typeof so.prompt !== "string") return false;
    if (typeof so.status !== "string" || !VALID_SUBTASK_STATUSES.has(so.status as SubtaskStatus)) return false;
  }
  return true;
}

const VALID_PLAN_STATUSES: ReadonlySet<TaskPlanStatus> = new Set([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
]);

const VALID_SUBTASK_STATUSES: ReadonlySet<SubtaskStatus> = new Set([
  "pending",
  "running",
  "verifying",
  "repaired",
  "completed",
  "failed",
  "skipped",
  "blocked",
]);

// Re-exported so call sites that touch the disk layout don't need
// to import from task-plan.ts separately.
export type { StopReason };
