import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProviderRegistry, providerRoutes } from "./providers.js";

test("loadProviderRegistry returns seeded defaults when no file exists", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-providers-test-"));
  try {
    const registry = loadProviderRegistry(projectRoot);
    assert.ok(registry.providers.anthropic);
    assert.ok(registry.providers.openrouter);
    assert.ok(registry.providers.openrouter.models.length > 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("POST /:provider/models persists to disk and refuses unknown providers", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-providers-test-"));
  try {
    const app = fastify();
    (app as any).decorate("ctx", {
      config: { projectRoot },
      eventBus: { emit: () => {} },
    });
    await app.register(providerRoutes);

    // Happy path.
    const add = await app.inject({
      method: "POST",
      url: "/anthropic/models",
      payload: { model: "claude-haiku-4-5-20251001" },
    });
    assert.equal(add.statusCode, 200);
    assert.equal(add.json().added, true);
    assert.ok(add.json().models.includes("claude-haiku-4-5-20251001"));

    // Persisted to disk.
    const file = JSON.parse(
      readFileSync(join(projectRoot, ".aedis", "providers.json"), "utf-8"),
    );
    assert.ok(file.providers.anthropic.models.includes("claude-haiku-4-5-20251001"));

    // Idempotent — adding the same model again is a no-op.
    const dup = await app.inject({
      method: "POST",
      url: "/anthropic/models",
      payload: { model: "claude-haiku-4-5-20251001" },
    });
    assert.equal(dup.statusCode, 200);
    assert.equal(dup.json().added, false);

    // Unknown provider rejected.
    const bad = await app.inject({
      method: "POST",
      url: "/not-a-real-provider/models",
      payload: { model: "x" },
    });
    assert.equal(bad.statusCode, 400);

    // Empty model rejected.
    const empty = await app.inject({
      method: "POST",
      url: "/anthropic/models",
      payload: { model: "  " },
    });
    assert.equal(empty.statusCode, 400);

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("DELETE /:provider/models/:model removes and 404s on missing", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-providers-test-"));
  try {
    const app = fastify();
    (app as any).decorate("ctx", {
      config: { projectRoot },
      eventBus: { emit: () => {} },
    });
    await app.register(providerRoutes);

    const del = await app.inject({
      method: "DELETE",
      url: "/anthropic/models/claude-sonnet-4-6",
    });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().removed, true);
    assert.ok(!del.json().models.includes("claude-sonnet-4-6"));

    const missing = await app.inject({
      method: "DELETE",
      url: "/anthropic/models/does-not-exist",
    });
    assert.equal(missing.statusCode, 404);

    await app.close();
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("GET / reports apiKeyPresent without leaking key values", async () => {
  const fastify = (await import("fastify")).default;
  const projectRoot = mkdtempSync(join(tmpdir(), "aedis-providers-test-"));
  const savedKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "sk-secret-not-to-leak";
    const app = fastify();
    (app as any).decorate("ctx", {
      config: { projectRoot },
      eventBus: { emit: () => {} },
    });
    await app.register(providerRoutes);

    const res = await app.inject({ method: "GET", url: "/" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.providers.anthropic.apiKeyPresent, true);
    assert.equal(body.providers.local.apiKeyPresent, true); // no key required
    // Key value never appears in the response.
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("sk-secret-not-to-leak"));

    await app.close();
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
