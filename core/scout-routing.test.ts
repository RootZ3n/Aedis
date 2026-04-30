import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeScout, type ScoutRoutingInput } from "./scout-routing.js";

describe("routeScout", () => {
  // ── Local-smoke → deterministic only ─────────────────────────────

  it("local-smoke profile → deterministic scout", () => {
    const result = routeScout({
      scoutType: "target_discovery",
      modelProfile: "local-smoke",
      cloudKeysAvailable: true,
      repoFileCount: 1000,
      promptLength: 500,
    });
    assert.equal(result.route, "deterministic");
    assert.ok(result.reason.includes("local-smoke"));
    assert.equal(result.estimatedCostUsd, 0);
  });

  // ── Cloud keys missing → no cloud scout ──────────────────────────

  it("no cloud keys → local scout", () => {
    const result = routeScout({
      scoutType: "target_discovery",
      modelProfile: "default",
      cloudKeysAvailable: false,
      repoFileCount: 1000,
      promptLength: 500,
    });
    assert.equal(result.route, "local");
    assert.ok(result.reason.includes("No cloud"));
    assert.equal(result.estimatedCostUsd, 0);
  });

  // ── Deterministic scouts (small repo) ────────────────────────────

  it("repo_map on small repo → deterministic", () => {
    const result = routeScout({
      scoutType: "repo_map",
      modelProfile: "default",
      cloudKeysAvailable: true,
      repoFileCount: 100,
      promptLength: 50,
    });
    assert.equal(result.route, "deterministic");
  });

  it("test_discovery on small repo → deterministic", () => {
    const result = routeScout({
      scoutType: "test_discovery",
      modelProfile: "default",
      cloudKeysAvailable: true,
      repoFileCount: 200,
      promptLength: 50,
    });
    assert.equal(result.route, "deterministic");
  });

  it("docs on small repo → deterministic", () => {
    const result = routeScout({
      scoutType: "docs",
      modelProfile: "default",
      cloudKeysAvailable: true,
      repoFileCount: 100,
      promptLength: 50,
    });
    assert.equal(result.route, "deterministic");
  });

  // ── Complex task + cloud available → cloud recommended ───────────

  it("large repo + target_discovery + cloud keys → cloud", () => {
    const result = routeScout({
      scoutType: "target_discovery",
      modelProfile: "default",
      cloudKeysAvailable: true,
      repoFileCount: 800,
      promptLength: 100,
    });
    assert.equal(result.route, "cloud");
    assert.ok(result.estimatedCostUsd > 0);
    assert.ok(result.reason.includes("large repo"));
  });

  it("complex prompt + target_discovery + cloud keys → cloud", () => {
    const result = routeScout({
      scoutType: "target_discovery",
      modelProfile: "default",
      cloudKeysAvailable: true,
      repoFileCount: 100,
      promptLength: 500,
    });
    assert.equal(result.route, "cloud");
    assert.ok(result.reason.includes("complex prompt"));
  });

  it("low prior confidence + cloud keys → cloud", () => {
    const result = routeScout({
      scoutType: "target_discovery",
      modelProfile: "default",
      cloudKeysAvailable: true,
      repoFileCount: 100,
      promptLength: 100,
      priorLocalConfidence: 0.2,
    });
    assert.equal(result.route, "cloud");
    assert.ok(result.reason.includes("low prior"));
  });

  // ── Default: local ───────────────────────────────────────────────

  it("simple target_discovery + cloud keys → local (default)", () => {
    const result = routeScout({
      scoutType: "target_discovery",
      modelProfile: "default",
      cloudKeysAvailable: true,
      repoFileCount: 200,
      promptLength: 100,
    });
    assert.equal(result.route, "local");
    assert.equal(result.estimatedCostUsd, 0);
  });

  it("risk scout on small repo + cloud keys → local", () => {
    const result = routeScout({
      scoutType: "risk",
      modelProfile: "default",
      cloudKeysAvailable: true,
      repoFileCount: 100,
      promptLength: 100,
    });
    assert.equal(result.route, "local");
  });

  // ── Privacy: cloud forbidden under local-only ────────────────────

  it("privacy/local-only profile → cloud scout forbidden", () => {
    const result = routeScout({
      scoutType: "target_discovery",
      modelProfile: "local-smoke",
      cloudKeysAvailable: true,
      repoFileCount: 2000,
      promptLength: 1000,
    });
    // Even with huge repo + long prompt, local-smoke → deterministic
    assert.equal(result.route, "deterministic");
  });
});
