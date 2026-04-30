/**
 * resolveModelConfigForResponse — pin the source-of-truth contract
 * for the Worker Models selector.
 *
 * Bug history: the UI rebuilt its dropdowns from a curated provider
 * allowlist that did NOT include `openrouter` for builder or `zai`
 * for integrator/escalation. The server's actual DEFAULT_MODEL_CONFIG
 * uses both. So the saved/active values weren't in the dropdown,
 * the browser silently fell through to option index 0 (an ollama/qwen
 * row), and the operator saw a "qwen" label while Aedis was actually
 * routing to OpenRouter / Z.ai. These tests pin the backend half of
 * the fix: the route response now carries `profile` + per-role
 * `source` so the UI never has to guess.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveModelConfigForResponse } from "./config.js";

function withProjectRoot(setup?: (root: string) => void): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "aedis-config-source-"));
  if (setup) setup(root);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withProfile<T>(profile: string | null, fn: () => T): T {
  const prev = process.env.AEDIS_MODEL_PROFILE;
  if (profile === null) delete process.env.AEDIS_MODEL_PROFILE;
  else process.env.AEDIS_MODEL_PROFILE = profile;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AEDIS_MODEL_PROFILE;
    else process.env.AEDIS_MODEL_PROFILE = prev;
  }
}

// ─── Profile = local-smoke ──────────────────────────────────────────

test("resolveModelConfigForResponse: local-smoke profile → every role source='profile'", () => {
  const { root, cleanup } = withProjectRoot();
  try {
    withProfile("local-smoke", () => {
      const result = resolveModelConfigForResponse(root);
      assert.equal(result.profile, "local-smoke");
      assert.equal(result.source.builder, "profile");
      assert.equal(result.source.critic, "profile");
      assert.equal(result.source.integrator, "profile");
      assert.equal(result.source.escalation, "profile");
      assert.equal(result.source.coordinator, "profile");
      // Spot-check that the returned config matches the local-smoke profile.
      assert.equal(result.config.builder.provider, "ollama");
      assert.equal(result.config.critic.provider, "ollama");
    });
  } finally {
    cleanup();
  }
});

test("resolveModelConfigForResponse: local-smoke ignores a saved file (still source='profile' uniformly)", () => {
  const { root, cleanup } = withProjectRoot((r) => {
    mkdirSync(join(r, ".aedis"), { recursive: true });
    writeFileSync(
      join(r, ".aedis", "model-config.json"),
      JSON.stringify({
        builder: { model: "claude-sonnet-4-6", provider: "anthropic" },
      }),
      "utf-8",
    );
  });
  try {
    withProfile("local-smoke", () => {
      const result = resolveModelConfigForResponse(root);
      assert.equal(result.profile, "local-smoke");
      // Saved file existed, but local-smoke wins. The UI uses this
      // to decide read-only mode + lock copy.
      assert.equal(result.source.builder, "profile");
      // The value the worker would actually see is the profile's, NOT
      // the saved file's. This is the truthful answer.
      assert.equal(result.config.builder.provider, "ollama");
      // configFilePresent stays true — operators benefit from knowing
      // a saved file exists even when it's currently dormant.
      assert.equal(result.configFilePresent, true);
    });
  } finally {
    cleanup();
  }
});

// ─── Profile = default ──────────────────────────────────────────────

test("resolveModelConfigForResponse: default profile + no saved file → all roles source='default'", () => {
  const { root, cleanup } = withProjectRoot();
  try {
    withProfile(null, () => {
      const result = resolveModelConfigForResponse(root);
      assert.equal(result.profile, "default");
      assert.equal(result.configFilePresent, false);
      for (const role of ["scout", "builder", "critic", "verifier", "integrator", "escalation", "coordinator"] as const) {
        assert.equal(result.source[role], "default", `${role} must be 'default' when no saved file`);
      }
      // Server's actual defaults — these are the values that were
      // showing up as "qwen" in the dropdown before the fix.
      assert.equal(result.config.builder.provider, "openrouter");
      assert.equal(result.config.integrator.provider, "zai");
      assert.equal(result.config.escalation.provider, "zai");
    });
  } finally {
    cleanup();
  }
});

test("resolveModelConfigForResponse: default profile + saved file → only saved roles source='saved'", () => {
  const { root, cleanup } = withProjectRoot((r) => {
    mkdirSync(join(r, ".aedis"), { recursive: true });
    writeFileSync(
      join(r, ".aedis", "model-config.json"),
      JSON.stringify({
        builder: { model: "claude-sonnet-4-6", provider: "anthropic" },
        critic: { model: "qwen3.5:9b", provider: "ollama" },
      }),
      "utf-8",
    );
  });
  try {
    withProfile(null, () => {
      const result = resolveModelConfigForResponse(root);
      assert.equal(result.profile, "default");
      assert.equal(result.configFilePresent, true);
      assert.equal(result.source.builder, "saved");
      assert.equal(result.source.critic, "saved");
      // Roles the saved file didn't override → "default".
      assert.equal(result.source.integrator, "default");
      assert.equal(result.source.escalation, "default");
      assert.equal(result.source.coordinator, "default");
      // Saved values surface verbatim.
      assert.equal(result.config.builder.model, "claude-sonnet-4-6");
      assert.equal(result.config.builder.provider, "anthropic");
    });
  } finally {
    cleanup();
  }
});

// ─── Trust contract: missing cloud keys do NOT silently swap to local ─

test("resolveModelConfigForResponse: missing cloud key does NOT rewrite saved value to local qwen", () => {
  // The bug we are fixing was the UI silently displaying `qwen` even
  // when the actual config said openrouter. The server side has the
  // analogous trust property: a missing OPENROUTER_API_KEY must not
  // cause the route to lie about what's configured. The worker's
  // dispatch may fail at runtime, but the *configured* value still
  // surfaces truthfully here so the operator can see the mismatch.
  const { root, cleanup } = withProjectRoot((r) => {
    mkdirSync(join(r, ".aedis"), { recursive: true });
    writeFileSync(
      join(r, ".aedis", "model-config.json"),
      JSON.stringify({
        builder: { model: "xiaomi/mimo-v2.5", provider: "openrouter" },
      }),
      "utf-8",
    );
  });
  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    withProfile(null, () => {
      const result = resolveModelConfigForResponse(root);
      // Builder is reported truthfully even though no API key is set.
      assert.equal(result.source.builder, "saved");
      assert.equal(result.config.builder.model, "xiaomi/mimo-v2.5");
      assert.equal(result.config.builder.provider, "openrouter");
      // Critically: the route did NOT silently fall back to local qwen.
      assert.notEqual(result.config.builder.provider, "ollama");
    });
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    cleanup();
  }
});

// ─── Malformed saved file → fall back to default, not crash ─────────

test("resolveModelConfigForResponse: malformed saved file → default sources, no throw", () => {
  const { root, cleanup } = withProjectRoot((r) => {
    mkdirSync(join(r, ".aedis"), { recursive: true });
    writeFileSync(join(r, ".aedis", "model-config.json"), "not json", "utf-8");
  });
  try {
    withProfile(null, () => {
      const result = resolveModelConfigForResponse(root);
      assert.equal(result.profile, "default");
      // Source treats an unreadable file as "no saved value".
      assert.equal(result.source.builder, "default");
      // configFilePresent reflects "we couldn't read a saved file";
      // operators can still see the file's existence via the
      // `config_path` field on the route response.
      assert.equal(result.configFilePresent, false);
    });
  } finally {
    cleanup();
  }
});

// ─── Empty/partial file content → only filled rows = saved ──────────

test("resolveModelConfigForResponse: saved file with empty model string → that role stays 'default'", () => {
  const { root, cleanup } = withProjectRoot((r) => {
    mkdirSync(join(r, ".aedis"), { recursive: true });
    writeFileSync(
      join(r, ".aedis", "model-config.json"),
      JSON.stringify({
        builder: { model: "", provider: "openrouter" },  // empty model — invalid
        critic: { model: "qwen3.5:9b", provider: "ollama" },
      }),
      "utf-8",
    );
  });
  try {
    withProfile(null, () => {
      const result = resolveModelConfigForResponse(root);
      assert.equal(result.source.builder, "default", "empty model string must not count as saved");
      assert.equal(result.source.critic, "saved");
    });
  } finally {
    cleanup();
  }
});
