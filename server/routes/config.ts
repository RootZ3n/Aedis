/**
 * Config routes — Model assignment management.
 *
 * GET  /config/models — Return current model assignments
 * POST /config/models — Update model assignments
 *
 * Persists to .aedis/model-config.json relative to project root.
 * Falls back to the legacy .zendorium/model-config.json location on
 * read so existing installs keep working after the rename. New writes
 * always go to .aedis/.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../index.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ModelAssignment {
  model: string;
  provider: string;
}

export interface ModelConfig {
  scout: ModelAssignment;
  builder: ModelAssignment;
  critic: ModelAssignment;
  verifier: ModelAssignment;
  integrator: ModelAssignment;
  escalation: ModelAssignment;
  coordinator: ModelAssignment;
}

// ─── Defaults ────────────────────────────────────────────────────────
//
// IMPORTANT: a persisted .aedis/model-config.json file at the project
// root will OVERRIDE these defaults via loadModelConfig() below (with
// .zendorium/model-config.json as the legacy fallback). Changing the
// defaults here only affects projects that have no saved config. To
// change an active build's model selection, either delete that file or
// edit its `builder` / `critic` block directly.
//
// Per-role fallbacks (Builder + Critic) are NOT in this config — they
// are hardcoded in the worker constructors (workers/builder.ts and
// workers/critic.ts). The fallback chain logic lives in
// core/model-invoker.ts (invokeModelWithFallback).
//
// Builder default change history:
//   - was: claude-sonnet-4-6 / anthropic (briefly tried as primary, but
//          ModelStudio turned out to be slow rather than broken)
//   - now: qwen3.6-plus / modelstudio (with anthropic/claude-sonnet-4-6
//          as the worker-level fallback)
//
// Critic default change history:
//   - was: qwen3.5:9b / ollama
//   - now: claude-sonnet-4-6 / anthropic (with ollama/qwen3.5:9b as the
//          worker-level fallback) — Critic gates the pipeline so a stronger
//          model here pays for itself by catching issues before Verify.

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  scout: { model: "local", provider: "local" },
  builder: { model: "qwen3.6-plus", provider: "modelstudio" },
  critic: { model: "claude-sonnet-4-6", provider: "anthropic" },
  verifier: { model: "local", provider: "local" },
  integrator: { model: "glm-5.1", provider: "zai" },
  escalation: { model: "glm-5.1", provider: "zai" },
  coordinator: { model: "xiaomi/mimo-v2-pro", provider: "openrouter" },
};

const VALID_ROLES = [
  "scout", "builder", "critic", "verifier",
  "integrator", "escalation", "coordinator",
] as const;

// ─── Persistence ─────────────────────────────────────────────────────

/** Canonical Aedis state directory. Always used for writes. */
function configDir(projectRoot: string): string {
  return join(projectRoot, ".aedis");
}

/** Legacy Zendorium state directory, read-only fallback during the rename. */
function legacyConfigDir(projectRoot: string): string {
  return join(projectRoot, ".zendorium");
}

function configPath(projectRoot: string): string {
  return join(configDir(projectRoot), "model-config.json");
}

function legacyConfigPath(projectRoot: string): string {
  return join(legacyConfigDir(projectRoot), "model-config.json");
}

export function loadModelConfig(projectRoot: string): ModelConfig {
  // Prefer the canonical .aedis/ path. Fall back to the legacy
  // .zendorium/ path so installs that were configured before the
  // rename still load their saved assignments. Writes always go to
  // the canonical path, so the legacy file stops being read the next
  // time the config is saved.
  const canonical = configPath(projectRoot);
  const legacy = legacyConfigPath(projectRoot);
  const pathsToTry = [canonical, legacy];

  for (const path of pathsToTry) {
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8");
        const parsed = JSON.parse(raw);
        // Merge with defaults so new roles get default values
        return { ...DEFAULT_MODEL_CONFIG, ...parsed };
      }
    } catch {
      // Corrupt file — try the next candidate, or fall through to defaults.
    }
  }
  return { ...DEFAULT_MODEL_CONFIG };
}

function saveModelConfig(projectRoot: string, config: ModelConfig): void {
  const dir = configDir(projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath(projectRoot), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function validateModelConfig(body: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null) {
    return { valid: false, errors: ["Body must be a JSON object"] };
  }

  const obj = body as Record<string, unknown>;

  for (const role of VALID_ROLES) {
    if (role in obj) {
      const entry = obj[role] as any;
      if (typeof entry !== "object" || entry === null) {
        errors.push(`${role} must be an object with { model, provider }`);
        continue;
      }
      if (typeof entry.model !== "string" || !entry.model.trim()) {
        errors.push(`${role}.model must be a non-empty string`);
      }
      if (typeof entry.provider !== "string" || !entry.provider.trim()) {
        errors.push(`${role}.provider must be a non-empty string`);
      }
    }
  }

  // Warn about unknown keys but don't fail
  for (const key of Object.keys(obj)) {
    if (!VALID_ROLES.includes(key as any)) {
      errors.push(`Unknown role "${key}" — ignored`);
    }
  }

  return { valid: errors.filter((e) => !e.includes("ignored")).length === 0, errors };
}

// ─── Routes ──────────────────────────────────────────────────────────

export const configRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  /**
   * GET /config/models — Return current model assignments.
   */
  fastify.get(
    "/models",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const config = loadModelConfig(ctx().config.projectRoot);
      reply.send({
        models: config,
        config_path: configPath(ctx().config.projectRoot),
        roles: VALID_ROLES,
      });
    }
  );

  /**
   * POST /config/models — Update model assignments.
   * Accepts a partial or full ModelConfig. Missing roles keep their current values.
   */
  fastify.post<{ Body: Partial<ModelConfig> }>(
    "/models",
    async (request: FastifyRequest<{ Body: Partial<ModelConfig> }>, reply: FastifyReply) => {
      const { valid, errors } = validateModelConfig(request.body);

      if (!valid) {
        reply.code(400).send({
          error: "Validation failed",
          errors,
        });
        return;
      }

      const projectRoot = ctx().config.projectRoot;
      const current = loadModelConfig(projectRoot);

      // Merge incoming assignments with current config
      const updated: ModelConfig = { ...current };
      for (const role of VALID_ROLES) {
        if (role in (request.body as any)) {
          (updated as any)[role] = (request.body as any)[role];
        }
      }

      saveModelConfig(projectRoot, updated);

      // Emit config change event
      ctx().eventBus.emit({
        type: "receipt_generated",
        payload: {
          kind: "config_update",
          summary: "Model configuration updated",
          models: updated,
        },
      });

      reply.send({
        models: updated,
        updated_roles: VALID_ROLES.filter((role) => role in (request.body as any)),
        message: "Model configuration saved. Changes take effect on next run.",
        warnings: errors.filter((e) => e.includes("ignored")),
      });
    }
  );
};
