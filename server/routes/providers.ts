/**
 * Provider routes — Per-provider model catalog management.
 *
 * Persisted at .aedis/providers.json (gitignored). Seeded on first
 * read from the set of models already referenced in the UI's default
 * MODEL_OPTIONS, so installs with no existing file work out of the box.
 *
 *   GET    /config/providers
 *       Return the full registry plus per-provider { apiKeyPresent }.
 *       Never returns the API-key value itself.
 *
 *   POST   /config/providers/:provider/models   { "model": "..." }
 *       Add a model to a provider. No-op if already present.
 *
 *   DELETE /config/providers/:provider/models/:model
 *       Remove a model from a provider.
 *
 *   GET    /config/providers/openrouter/health
 *       Ping OpenRouter's /api/v1/auth/key with the configured key and
 *       report whether the connection is live. Same pattern as
 *       CrucibulumClient.healthCheck() — failure never breaks anything.
 *
 * The canonical list of providers is the Provider union in
 * core/model-invoker.ts. Unknown provider names are rejected; the
 * per-role allowlist (which providers may serve which role) stays in
 * the UI because it's a UX judgment, not a catalog fact.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { ServerContext } from "../index.js";
import { checkOpenRouterHealth } from "../../core/openrouter-client.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ProviderEntry {
  /** Human-readable label for the UI. */
  label: string;
  /** Env var that holds the API key, if this provider needs one. */
  apiKeyEnv?: string;
  /** Curated list of model IDs available from this provider. */
  models: string[];
}

export interface ProviderRegistry {
  providers: Record<string, ProviderEntry>;
}

const VALID_PROVIDERS = new Set([
  "local",
  "ollama",
  "modelstudio",
  "openrouter",
  "anthropic",
  "openai",
  "minimax",
  "zai",
  "glm-5.1-openrouter",
  "glm-5.1-direct",
  "portum",
]);

// ─── Seeded Defaults ─────────────────────────────────────────────────
//
// Mirrors the hardcoded MODEL_OPTIONS in ui/index.html at the time the
// providers registry was introduced. Once a .aedis/providers.json file
// exists, it takes over and this seed is never re-applied — editing or
// deleting an entry here only affects fresh installs.

const DEFAULT_REGISTRY: ProviderRegistry = {
  providers: {
    local:                 { label: "Local (mock)",           models: ["local"] },
    ollama:                { label: "Ollama",                 models: ["qwen3.5:9b", "qwen3.5:4b"] },
    modelstudio:           { label: "ModelStudio",            apiKeyEnv: "MODELSTUDIO_API_KEY", models: ["qwen3.6-plus", "glm-4"] },
    openrouter:            { label: "OpenRouter",             apiKeyEnv: "OPENROUTER_API_KEY",  models: ["xiaomi/mimo-v2-pro"] },
    anthropic:             { label: "Anthropic",              apiKeyEnv: "ANTHROPIC_API_KEY",   models: ["claude-sonnet-4-6", "claude-opus-4-6"] },
    openai:                { label: "OpenAI",                 apiKeyEnv: "OPENAI_API_KEY",      models: ["gpt-5.4", "gpt-4o"] },
    minimax:               { label: "MiniMax",                apiKeyEnv: "MINIMAX_API_KEY",     models: ["minimax-coding"] },
    zai:                   { label: "Z.ai",                   apiKeyEnv: "ZAI_API_KEY",         models: ["glm-5.1"] },
    "glm-5.1-openrouter":  { label: "GLM-5.1 via OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY",  models: ["z-ai/glm-5.1"] },
    "glm-5.1-direct":      { label: "GLM-5.1 direct",         apiKeyEnv: "ZAI_API_KEY",         models: ["glm-5.1"] },
    portum:                { label: "Portum (local gateway)", models: ["qwen3.6-plus"] },
  },
};

// ─── Persistence ─────────────────────────────────────────────────────

function registryPath(projectRoot: string): string {
  return join(projectRoot, ".aedis", "providers.json");
}

export function loadProviderRegistry(projectRoot: string): ProviderRegistry {
  const path = registryPath(projectRoot);
  if (!existsSync(path)) {
    return cloneRegistry(DEFAULT_REGISTRY);
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as ProviderRegistry;
    // Merge in any newly-added seed providers (users keep their curated
    // models but gain future providers without editing the file).
    const merged: ProviderRegistry = cloneRegistry(DEFAULT_REGISTRY);
    for (const [name, entry] of Object.entries(parsed.providers ?? {})) {
      if (VALID_PROVIDERS.has(name) && entry && Array.isArray(entry.models)) {
        merged.providers[name] = {
          label: entry.label ?? merged.providers[name]?.label ?? name,
          ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : (merged.providers[name]?.apiKeyEnv ? { apiKeyEnv: merged.providers[name].apiKeyEnv } : {})),
          models: entry.models.filter((m) => typeof m === "string" && m.trim().length > 0),
        };
      }
    }
    return merged;
  } catch {
    return cloneRegistry(DEFAULT_REGISTRY);
  }
}

function saveProviderRegistry(projectRoot: string, registry: ProviderRegistry): void {
  const dir = join(projectRoot, ".aedis");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(registryPath(projectRoot), JSON.stringify(registry, null, 2) + "\n", "utf-8");
}

function cloneRegistry(src: ProviderRegistry): ProviderRegistry {
  return {
    providers: Object.fromEntries(
      Object.entries(src.providers).map(([k, v]) => [k, { ...v, models: [...v.models] }]),
    ),
  };
}

// ─── Response shape ──────────────────────────────────────────────────

interface ProviderView extends ProviderEntry {
  apiKeyPresent: boolean;
}

function toView(registry: ProviderRegistry): Record<string, ProviderView> {
  const view: Record<string, ProviderView> = {};
  for (const [name, entry] of Object.entries(registry.providers)) {
    view[name] = {
      ...entry,
      apiKeyPresent: entry.apiKeyEnv
        ? typeof process.env[entry.apiKeyEnv] === "string" && process.env[entry.apiKeyEnv]!.length > 0
        : true,
    };
  }
  return view;
}

// ─── Routes ──────────────────────────────────────────────────────────

export const providerRoutes: FastifyPluginAsync = async (fastify) => {
  const ctx = (): ServerContext => fastify.ctx;

  fastify.get("/", async (_request: FastifyRequest, reply: FastifyReply) => {
    const registry = loadProviderRegistry(ctx().config.projectRoot);
    reply.send({ providers: toView(registry) });
  });

  fastify.post<{ Params: { provider: string }; Body: { model: string } }>(
    "/:provider/models",
    async (request, reply) => {
      const { provider } = request.params;
      if (!VALID_PROVIDERS.has(provider)) {
        reply.code(400).send({ error: `Unknown provider "${provider}"` });
        return;
      }
      const model = typeof request.body?.model === "string" ? request.body.model.trim() : "";
      if (!model) {
        reply.code(400).send({ error: "model must be a non-empty string" });
        return;
      }

      const projectRoot = ctx().config.projectRoot;
      const registry = loadProviderRegistry(projectRoot);
      const entry = registry.providers[provider];
      if (!entry) {
        reply.code(400).send({ error: `Provider "${provider}" is not registered` });
        return;
      }
      if (entry.models.includes(model)) {
        reply.send({ provider, models: entry.models, added: false, message: "Model already present" });
        return;
      }
      entry.models.push(model);
      saveProviderRegistry(projectRoot, registry);

      ctx().eventBus.emit({
        type: "config_event",
        payload: { kind: "provider_model_added", summary: `Added ${provider}/${model}`, provider, model },
      });

      reply.send({ provider, models: entry.models, added: true });
    },
  );

  fastify.delete<{ Params: { provider: string; model: string } }>(
    "/:provider/models/:model",
    async (request, reply) => {
      const { provider } = request.params;
      const model = decodeURIComponent(request.params.model);
      if (!VALID_PROVIDERS.has(provider)) {
        reply.code(400).send({ error: `Unknown provider "${provider}"` });
        return;
      }

      const projectRoot = ctx().config.projectRoot;
      const registry = loadProviderRegistry(projectRoot);
      const entry = registry.providers[provider];
      if (!entry) {
        reply.code(400).send({ error: `Provider "${provider}" is not registered` });
        return;
      }
      const before = entry.models.length;
      entry.models = entry.models.filter((m) => m !== model);
      if (entry.models.length === before) {
        reply.code(404).send({ error: `Model "${model}" not found on provider "${provider}"` });
        return;
      }
      saveProviderRegistry(projectRoot, registry);

      ctx().eventBus.emit({
        type: "config_event",
        payload: { kind: "provider_model_removed", summary: `Removed ${provider}/${model}`, provider, model },
      });

      reply.send({ provider, models: entry.models, removed: true });
    },
  );

  fastify.get("/openrouter/health", async (_request, reply) => {
    const result = await checkOpenRouterHealth();
    reply.send(result);
  });
};
