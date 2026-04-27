import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LANE_CONFIG,
  laneConfigRunsShadow,
  parseLaneConfig,
} from "./lane-config.js";

// ─── parseLaneConfig validation ──────────────────────────────────────

test("parseLaneConfig accepts the minimal primary_only shape", () => {
  const r = parseLaneConfig({
    mode: "primary_only",
    primary: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.config);
  assert.equal(r.config!.mode, "primary_only");
  assert.equal(r.config!.shadow, undefined);
});

test("parseLaneConfig requires a shadow assignment for non-primary modes", () => {
  for (const mode of ["local_then_cloud", "local_vs_cloud", "cloud_with_local_check"] as const) {
    const r = parseLaneConfig({
      mode,
      primary: { lane: "cloud", provider: "openrouter", model: "x" },
    });
    assert.equal(r.config, null, `${mode} without shadow must fail`);
    assert.ok(
      r.errors.some((e) => /shadow assignment is required/.test(e)),
      `${mode}: expected shadow-required error; got ${JSON.stringify(r.errors)}`,
    );
  }
});

test("parseLaneConfig accepts dual-lane mode with both assignments", () => {
  const r = parseLaneConfig({
    mode: "local_vs_cloud",
    primary: { lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" },
    shadow: { lane: "local", provider: "ollama", model: "qwen3.5:9b", label: "local check" },
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.config);
  assert.equal(r.config!.mode, "local_vs_cloud");
  assert.equal(r.config!.shadow?.lane, "local");
  assert.equal(r.config!.shadow?.label, "local check");
});

test("parseLaneConfig rejects mismatched lane (primary and shadow on the same lane)", () => {
  const r = parseLaneConfig({
    mode: "local_vs_cloud",
    primary: { lane: "cloud", provider: "openrouter", model: "x" },
    shadow: { lane: "cloud", provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  assert.equal(r.config, null);
  assert.ok(r.errors.some((e) => /must differ from primary\.lane/.test(e)));
});

test("parseLaneConfig rejects unknown mode", () => {
  const r = parseLaneConfig({
    mode: "swarm_chaos",
    primary: { lane: "cloud", provider: "x", model: "y" },
  });
  assert.equal(r.config, null);
  assert.ok(r.errors.some((e) => /mode must be one of/.test(e)));
});

test("parseLaneConfig rejects unknown lane id", () => {
  const r = parseLaneConfig({
    mode: "primary_only",
    primary: { lane: "edge", provider: "x", model: "y" },
  });
  assert.equal(r.config, null);
  assert.ok(r.errors.some((e) => /lane must be one of/.test(e)));
});

test("parseLaneConfig requires non-empty provider/model strings", () => {
  const cases: Array<{ provider: unknown; model: unknown; expect: RegExp }> = [
    { provider: "", model: "x", expect: /provider must be a non-empty string/ },
    { provider: "x", model: "", expect: /model must be a non-empty string/ },
    { provider: 0, model: "x", expect: /provider must be a non-empty string/ },
    { provider: "x", model: null, expect: /model must be a non-empty string/ },
  ];
  for (const c of cases) {
    const r = parseLaneConfig({
      mode: "primary_only",
      primary: { lane: "cloud", provider: c.provider, model: c.model },
    });
    assert.equal(r.config, null);
    assert.ok(r.errors.some((e) => c.expect.test(e)), `expected ${c.expect}; got ${JSON.stringify(r.errors)}`);
  }
});

test("parseLaneConfig: primary_only retains a stray shadow for round-trip but the runtime ignores it", () => {
  // Operator may have switched mode back to primary_only without
  // deleting the shadow block. Parse should accept it (no errors)
  // and laneConfigRunsShadow must still return false.
  const r = parseLaneConfig({
    mode: "primary_only",
    primary: { lane: "cloud", provider: "x", model: "y" },
    shadow: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.config);
  assert.equal(laneConfigRunsShadow(r.config!), false);
});

test("parseLaneConfig rejects null/non-object input", () => {
  assert.equal(parseLaneConfig(null).config, null);
  assert.equal(parseLaneConfig("config").config, null);
  assert.equal(parseLaneConfig(42).config, null);
});

// ─── DEFAULT_LANE_CONFIG ─────────────────────────────────────────────

test("DEFAULT_LANE_CONFIG runs a single primary lane (back-compat default)", () => {
  // Critical: the production pipeline must keep its current single-lane
  // behavior when no operator config is loaded. Anything else would
  // turn this into autonomous-swarm behavior, which the foundation
  // explicitly disallows for now.
  assert.equal(DEFAULT_LANE_CONFIG.mode, "primary_only");
  assert.equal(laneConfigRunsShadow(DEFAULT_LANE_CONFIG), false);
});

// ─── laneConfigRunsShadow ────────────────────────────────────────────

test("laneConfigRunsShadow is true only when mode is non-primary AND shadow is set", () => {
  const localOnly = parseLaneConfig({
    mode: "primary_only",
    primary: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
  });
  assert.equal(laneConfigRunsShadow(localOnly.config!), false);

  const dual = parseLaneConfig({
    mode: "local_vs_cloud",
    primary: { lane: "cloud", provider: "x", model: "y" },
    shadow: { lane: "local", provider: "ollama", model: "qwen3.5:9b" },
  });
  assert.equal(laneConfigRunsShadow(dual.config!), true);
});
