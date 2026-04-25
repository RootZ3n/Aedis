import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  builderTierCollapseWarning,
  findNextStrongerBuilderTier,
  loadModelConfig,
  resolveBuilderModelForTier,
  resolveBuilderChainForTier,
  checkAnthropicHotPathDoctrine,
  _resetDoctrineWarningCache,
} from "./config.js";

/**
 * End-to-end tests for the save -> execute contract on worker model config.
 *
 * Before the fix:
 *   - UI POSTed `{ models: {...} }` but the server iterated roles on the
 *     raw body, so saves silently no-oped.
 *   - Workers called loadModelConfig(workspaceProjectRoot), but the
 *     saved config lives in the source repo's .aedis/ dir (gitignored,
 *     never copied to the worktree), so reads fell through to defaults.
 *
 * These tests lock in both halves.
 */

test("loadModelConfig returns saved assignments from .aedis/model-config.json", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-config-test-"));
  try {
    const aedisDir = join(projectRoot, ".aedis");
    mkdirSync(aedisDir, { recursive: true });
    writeFileSync(
      join(aedisDir, "model-config.json"),
      JSON.stringify({
        builder: { model: "claude-sonnet-4-6", provider: "anthropic" },
        critic: { model: "qwen3.6-plus", provider: "portum" },
      }),
    );

    const config = loadModelConfig(projectRoot);
    assert.equal(config.builder.model, "claude-sonnet-4-6");
    assert.equal(config.builder.provider, "anthropic");
    assert.equal(config.critic.model, "qwen3.6-plus");
    assert.equal(config.critic.provider, "portum");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("loadModelConfig falls back to defaults when no config file exists (fallback source)", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-config-test-"));
  try {
    const config = loadModelConfig(projectRoot);
    // Defaults from server/routes/config.ts DEFAULT_MODEL_CONFIG
    assert.equal(config.builder.provider, "openrouter");
    assert.equal(config.critic.provider, "anthropic");
    assert.equal(config.integrator.model, "glm-5.1");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("POST body envelope: unwraps { models } and persists flat config to disk", async () => {
  // This test exercises the unwrap path that was the root cause of the
  // original bug: the UI posts { models: {...} } and the handler must
  // merge those role keys into the persisted config.
  const fastify = (await import("fastify")).default;
  const { configRoutes } = await import("./config.js");

  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-config-test-"));
  try {
    const app = fastify();
    // Minimal ServerContext stub — route only reads projectRoot + eventBus.emit.
    (app as any).decorate("ctx", {
      config: { projectRoot },
      eventBus: { emit: () => {} },
    });
    await app.register(configRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/models",
      payload: {
        models: {
          builder: { model: "claude-sonnet-4-6", provider: "anthropic" },
          critic: { model: "qwen3.6-plus", provider: "portum" },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.models.builder.model, "claude-sonnet-4-6");
    assert.equal(body.models.critic.provider, "portum");
    assert.deepEqual(body.updated_roles.sort(), ["builder", "critic"]);

    // Verify it actually hit disk — the previous bug was a silent no-op.
    const persisted = JSON.parse(
      readFileSync(join(projectRoot, ".aedis", "model-config.json"), "utf-8"),
    );
    assert.equal(persisted.builder.model, "claude-sonnet-4-6");
    assert.equal(persisted.critic.model, "qwen3.6-plus");

    // And a follow-up load returns what we just saved.
    const reloaded = loadModelConfig(projectRoot);
    assert.equal(reloaded.builder.model, "claude-sonnet-4-6");
    assert.equal(reloaded.critic.provider, "portum");

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("POST body envelope: also accepts flat body shape (legacy CLI callers)", async () => {
  const fastify = (await import("fastify")).default;
  const { configRoutes } = await import("./config.js");

  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-config-test-"));
  try {
    const app = fastify();
    (app as any).decorate("ctx", {
      config: { projectRoot },
      eventBus: { emit: () => {} },
    });
    await app.register(configRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/models",
      payload: {
        builder: { model: "xiaomi/mimo-v2-pro", provider: "openrouter" },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.models.builder.model, "xiaomi/mimo-v2-pro");
    assert.equal(body.models.builder.provider, "openrouter");

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("builder tier helpers resolve distinct tier assignments when configured", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-config-test-"));
  try {
    const aedisDir = join(projectRoot, ".aedis");
    mkdirSync(aedisDir, { recursive: true });
    writeFileSync(
      join(aedisDir, "model-config.json"),
      JSON.stringify({
        builder: { model: "cheap-fast", provider: "openrouter" },
        escalation: { model: "premium-fallback", provider: "anthropic" },
        builderTiers: {
          standard: { model: "standard-main", provider: "openrouter" },
          premium: { model: "premium-main", provider: "anthropic" },
        },
      }),
      "utf-8",
    );

    const config = loadModelConfig(projectRoot);
    assert.equal(resolveBuilderModelForTier(config, "fast").identity, "openrouter/cheap-fast");
    assert.equal(resolveBuilderModelForTier(config, "standard").identity, "openrouter/standard-main");
    assert.equal(resolveBuilderModelForTier(config, "premium").identity, "anthropic/premium-main");
    assert.equal(findNextStrongerBuilderTier(config, "standard")?.tier, "premium");
    assert.equal(builderTierCollapseWarning(config), null);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("builder tier helpers warn when every tier collapses to the same model", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-config-test-"));
  try {
    const config = loadModelConfig(projectRoot);
    const warning = builderTierCollapseWarning({
      ...config,
      builder: { model: "same-model", provider: "openrouter" },
      escalation: { model: "same-model", provider: "openrouter" },
      builderTiers: {
        fast: { model: "same-model", provider: "openrouter" },
        standard: { model: "same-model", provider: "openrouter" },
        premium: { model: "same-model", provider: "openrouter" },
      },
    });
    assert.match(warning ?? "", /collapses to one model/i);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("resolveBuilderChainForTier produces a single-entry chain for legacy single-assignment configs", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-config-chain-"));
  try {
    const aedisDir = join(projectRoot, ".aedis");
    mkdirSync(aedisDir, { recursive: true });
    writeFileSync(
      join(aedisDir, "model-config.json"),
      JSON.stringify({
        builder: { model: "minimax-coding", provider: "minimax" },
      }),
      "utf-8",
    );
    const config = loadModelConfig(projectRoot);
    const resolved = resolveBuilderChainForTier(config, "standard");
    assert.equal(resolved.chain.length, 1);
    assert.equal(resolved.chain[0]!.provider, "minimax");
    assert.equal(resolved.primaryIdentity, "minimax/minimax-coding");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("resolveBuilderChainForTier returns the declared chain in order, deduped against the primary", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-config-chain-"));
  try {
    const aedisDir = join(projectRoot, ".aedis");
    mkdirSync(aedisDir, { recursive: true });
    writeFileSync(
      join(aedisDir, "model-config.json"),
      JSON.stringify({
        builder: { model: "primary-model", provider: "minimax" },
        builderTiers: {
          standard: {
            model: "tier-primary",
            provider: "minimax",
            chain: [
              { provider: "minimax", model: "tier-primary" }, // dup of primary, should drop
              { provider: "openrouter", model: "z-ai/glm-5.1" },
              { provider: "ollama", model: "qwen3.5:9b" },
            ],
          },
        },
      }),
      "utf-8",
    );
    const config = loadModelConfig(projectRoot);
    const resolved = resolveBuilderChainForTier(config, "standard");
    assert.deepEqual(
      resolved.chain.map((c) => `${c.provider}/${c.model}`),
      [
        "minimax/tier-primary",
        "openrouter/z-ai/glm-5.1",
        "ollama/qwen3.5:9b",
      ],
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("checkAnthropicHotPathDoctrine flags Anthropic primary in builder/critic/integrator", () => {
  // Be defensive about prior env state
  const prev = process.env.AEDIS_ALLOW_ANTHROPIC;
  delete process.env.AEDIS_ALLOW_ANTHROPIC;
  try {
    const violations = checkAnthropicHotPathDoctrine({
      scout: { model: "local", provider: "local" },
      builder: { model: "claude-sonnet-4-6", provider: "anthropic" },
      critic: { model: "claude-sonnet-4-6", provider: "anthropic" },
      verifier: { model: "local", provider: "local" },
      integrator: { model: "glm-5.1", provider: "zai" },
      escalation: { model: "glm-5.1", provider: "zai" },
      coordinator: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
      builderTiers: {},
    });
    const roles = violations.map((v) => v.role).sort();
    assert.deepEqual(roles, ["builder", "critic"]);
  } finally {
    if (prev !== undefined) process.env.AEDIS_ALLOW_ANTHROPIC = prev;
  }
});

test("checkAnthropicHotPathDoctrine flags Anthropic in tier chain entries", () => {
  const prev = process.env.AEDIS_ALLOW_ANTHROPIC;
  delete process.env.AEDIS_ALLOW_ANTHROPIC;
  try {
    const violations = checkAnthropicHotPathDoctrine({
      scout: { model: "local", provider: "local" },
      builder: { model: "minimax-coding", provider: "minimax" },
      critic: { model: "qwen3.5:9b", provider: "ollama" },
      verifier: { model: "local", provider: "local" },
      integrator: { model: "glm-5.1", provider: "zai" },
      escalation: { model: "glm-5.1", provider: "zai" },
      coordinator: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
      builderTiers: {
        premium: {
          model: "xiaomi/mimo-v2.5-pro",
          provider: "openrouter",
          chain: [
            { provider: "minimax", model: "minimax-coding" },
            { provider: "anthropic", model: "claude-sonnet-4-6" },
          ],
        },
      },
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.tier, "premium");
    assert.equal(violations[0]!.source, "chain");
    assert.equal(violations[0]!.model, "claude-sonnet-4-6");
  } finally {
    if (prev !== undefined) process.env.AEDIS_ALLOW_ANTHROPIC = prev;
  }
});

test("checkAnthropicHotPathDoctrine returns no violations when AEDIS_ALLOW_ANTHROPIC=1", () => {
  const prev = process.env.AEDIS_ALLOW_ANTHROPIC;
  process.env.AEDIS_ALLOW_ANTHROPIC = "1";
  try {
    const violations = checkAnthropicHotPathDoctrine({
      scout: { model: "local", provider: "local" },
      builder: { model: "claude-sonnet-4-6", provider: "anthropic" },
      critic: { model: "claude-sonnet-4-6", provider: "anthropic" },
      verifier: { model: "local", provider: "local" },
      integrator: { model: "claude-sonnet-4-6", provider: "anthropic" },
      escalation: { model: "claude-sonnet-4-6", provider: "anthropic" },
      coordinator: { model: "claude-sonnet-4-6", provider: "anthropic" },
      builderTiers: {},
    });
    assert.equal(violations.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AEDIS_ALLOW_ANTHROPIC;
    else process.env.AEDIS_ALLOW_ANTHROPIC = prev;
  }
});

test("loadModelConfig accepts and persists chain entries via normalization", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-config-chain-load-"));
  _resetDoctrineWarningCache();
  try {
    const aedisDir = join(projectRoot, ".aedis");
    mkdirSync(aedisDir, { recursive: true });
    writeFileSync(
      join(aedisDir, "model-config.json"),
      JSON.stringify({
        builder: {
          model: "minimax-coding",
          provider: "minimax",
          chain: [
            { provider: "openrouter", model: "z-ai/glm-5.1" },
            { provider: "ollama", model: "qwen3.5:9b" },
            { provider: "", model: "drop-me" }, // malformed, should drop
          ],
        },
      }),
      "utf-8",
    );
    const config = loadModelConfig(projectRoot);
    assert.equal(config.builder.chain?.length, 2);
    assert.equal(config.builder.chain?.[0]!.provider, "openrouter");
    assert.equal(config.builder.chain?.[1]!.provider, "ollama");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
