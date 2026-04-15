import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadModelConfig } from "./config.js";

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
    assert.equal(config.builder.provider, "modelstudio");
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
