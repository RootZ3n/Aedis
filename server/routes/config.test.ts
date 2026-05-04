import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  builderTierCollapseWarning,
  findNextStrongerBuilderTier,
  loadModelConfig,
  modelConfigRequiresCloudKeys,
  resolveBuilderModelForTier,
  resolveBuilderChainForTier,
  resolveAssignmentChain,
  getActiveModelProfile,
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
        critic: { model: "qwen3.5:9b", provider: "ollama" },
      }),
    );

    const config = loadModelConfig(projectRoot);
    assert.equal(config.builder.model, "claude-sonnet-4-6");
    assert.equal(config.builder.provider, "anthropic");
    assert.equal(config.critic.model, "qwen3.5:9b");
    assert.equal(config.critic.provider, "ollama");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("loadModelConfig falls back to defaults when no config file exists (fallback source)", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-config-test-"));
  try {
    const config = loadModelConfig(projectRoot);
    // Defaults from server/routes/config.ts DEFAULT_MODEL_CONFIG.
    // Critic stays on Mimo in the default hot path while the pipeline
    // is stabilized. It must NOT default to Anthropic.
    assert.equal(config.builder.provider, "openrouter");
    assert.equal(config.critic.provider, "openrouter");
    assert.equal(config.critic.model, "xiaomi/mimo-v2.5");
    assert.equal(config.integrator.model, "local");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("AEDIS_MODEL_PROFILE=local-smoke uses Ollama only and does not require cloud keys", () => {
  const prev = process.env.AEDIS_MODEL_PROFILE;
  process.env.AEDIS_MODEL_PROFILE = "local-smoke";
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-local-smoke-config-"));
  try {
    const config = loadModelConfig(projectRoot);
    assert.equal(getActiveModelProfile(), "local-smoke");
    assert.equal(config.builder.provider, "ollama");
    assert.equal(config.builder.model, "qwen3.5:9b");
    assert.equal(config.critic.provider, "ollama");
    assert.equal(config.escalation.provider, "ollama");
    assert.deepEqual(modelConfigRequiresCloudKeys(config), []);
  } finally {
    if (prev === undefined) delete process.env.AEDIS_MODEL_PROFILE;
    else process.env.AEDIS_MODEL_PROFILE = prev;
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("default model profile still reports required cloud keys clearly", () => {
  const prev = process.env.AEDIS_MODEL_PROFILE;
  delete process.env.AEDIS_MODEL_PROFILE;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-default-cloud-"));
  try {
    const config = loadModelConfig(projectRoot);
    assert.deepEqual(modelConfigRequiresCloudKeys(config), ["OPENROUTER_API_KEY", "ZAI_API_KEY"]);
  } finally {
    if (prev !== undefined) process.env.AEDIS_MODEL_PROFILE = prev;
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("DEFAULT_MODEL_CONFIG (the empty-config fallback) does not violate the no-Anthropic-hot-path doctrine", () => {
  // Regression lock-in: the default config was previously routing
  // Critic to claude-sonnet-4-6 / anthropic, which silently put every
  // empty-config installation on the paid Anthropic path. The fix
  // moved Critic to ollama/qwen3.5:9b. This test asserts the default
  // never re-introduces Anthropic in builder/critic/integrator.
  const prev = process.env.AEDIS_ALLOW_ANTHROPIC;
  delete process.env.AEDIS_ALLOW_ANTHROPIC;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-default-doctrine-"));
  _resetDoctrineWarningCache();
  try {
    // Loading from a project root with no .aedis/model-config.json
    // resolves to the DEFAULT_MODEL_CONFIG fallback, which is exactly
    // what the doctrine validator should clear.
    const config = loadModelConfig(projectRoot);
    const violations = checkAnthropicHotPathDoctrine(config);
    assert.deepEqual(
      violations,
      [],
      `default config introduced Anthropic in hot-path roles: ${JSON.stringify(violations)}`,
    );
  } finally {
    if (prev !== undefined) process.env.AEDIS_ALLOW_ANTHROPIC = prev;
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
          critic: { model: "qwen3.5:9b", provider: "ollama" },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.models.builder.model, "claude-sonnet-4-6");
    assert.equal(body.models.critic.provider, "ollama");
    assert.deepEqual(body.updated_roles.sort(), ["builder", "critic"]);

    // Verify it actually hit disk — the previous bug was a silent no-op.
    const persisted = JSON.parse(
      readFileSync(join(projectRoot, ".aedis", "model-config.json"), "utf-8"),
    );
    assert.equal(persisted.builder.model, "claude-sonnet-4-6");
    assert.equal(persisted.critic.model, "qwen3.5:9b");

    // And a follow-up load returns what we just saved.
    const reloaded = loadModelConfig(projectRoot);
    assert.equal(reloaded.builder.model, "claude-sonnet-4-6");
    assert.equal(reloaded.critic.provider, "ollama");

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

test("resolveAssignmentChain returns empty when assignment is undefined", () => {
  // Defensive: resolveAssignmentChain([]) signals "this role isn't
  // configured at all." Callers that get [] should fall back to their
  // own default rather than treat the role as unmapped.
  const chain = resolveAssignmentChain(undefined);
  assert.deepEqual(chain, []);
});

test("resolveAssignmentChain returns single-entry chain for a primary with no chain field", () => {
  const chain = resolveAssignmentChain({ provider: "ollama", model: "qwen3.5:9b" });
  assert.deepEqual(chain, [{ provider: "ollama", model: "qwen3.5:9b" }]);
});

test("resolveAssignmentChain returns primary first then declared chain in order, deduped", () => {
  const chain = resolveAssignmentChain({
    provider: "ollama",
    model: "qwen3.5:9b",
    chain: [
      { provider: "ollama", model: "qwen3.5:9b" }, // dup of primary, must drop
      { provider: "openrouter", model: "xiaomi/mimo-v2.5" },
      { provider: "openrouter", model: "xiaomi/mimo-v2.5" }, // dup of prior chain entry, must drop
    ],
  });
  assert.deepEqual(
    chain.map((c) => `${c.provider}/${c.model}`),
    ["ollama/qwen3.5:9b", "openrouter/xiaomi/mimo-v2.5"],
  );
});

test("resolveAssignmentChain preserves the head's label when present", () => {
  const chain = resolveAssignmentChain({
    provider: "openrouter",
    model: "xiaomi/mimo-v2.5",
    label: "xiaomi/mimo-v2.5 via OpenRouter",
  });
  assert.equal(chain[0]?.label, "xiaomi/mimo-v2.5 via OpenRouter");
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
      integrator: { model: "local", provider: "local" },
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
      integrator: { model: "local", provider: "local" },
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
