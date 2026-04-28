/**
 * Runtime safety policy — projection and safe-default tests.
 *
 * Pin the post-fix invariants the user asked for explicitly:
 *   - Defaults are SAFE (auto-promote off, approval required,
 *     destructive ops blocked, shadow promote impossible).
 *   - Env override only takes effect when the operator types the
 *     unsafe value verbatim — typos resolve to safe.
 *   - The derived `destructiveOps` flag is the AND of "auto-promote
 *     on" + "approval skipped"; either guard alone is enough to block.
 *   - shadowPromoteAllowed is a structural false — never derives
 *     from input, never flips.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveRuntimePolicy,
  policyFromCoordinatorConfig,
  safeDefaults,
} from "./runtime-policy.js";

// ─── safeDefaults: env handling ─────────────────────────────────────

test("safeDefaults with empty env: every guard at the safe value", () => {
  const r = safeDefaults({ env: {} });
  assert.equal(r.autoPromoteOnSuccess, false, "auto-promote OFF by default");
  assert.equal(r.requireApproval, true, "approval REQUIRED by default");
  assert.equal(r.requireWorkspace, true, "workspace REQUIRED by default");
  assert.equal(r.source.autoPromoteOnSuccess, "default-safe");
  assert.equal(r.source.requireApproval, "default-safe");
});

test("safeDefaults: AEDIS_AUTO_PROMOTE=true flips auto-promote on (and only that)", () => {
  const r = safeDefaults({ env: { AEDIS_AUTO_PROMOTE: "true" } });
  assert.equal(r.autoPromoteOnSuccess, true);
  assert.equal(r.requireApproval, true, "approval still required when only AUTO_PROMOTE flipped");
  assert.equal(r.source.autoPromoteOnSuccess, "env-override");
  assert.equal(r.source.requireApproval, "default-safe");
});

test("safeDefaults: AEDIS_REQUIRE_APPROVAL=false disables approval", () => {
  const r = safeDefaults({ env: { AEDIS_REQUIRE_APPROVAL: "false" } });
  assert.equal(r.requireApproval, false);
  assert.equal(r.source.requireApproval, "env-override");
});

test("safeDefaults: AEDIS_AUTO_PROMOTE with non-'true' value resolves to safe", () => {
  // Defense against typos like "TRUE", "1", "yes" — only the literal
  // "true" should flip the guard. Anything else stays safe.
  for (const v of ["TRUE", "1", "yes", "on", " true", "true ", ""]) {
    const r = safeDefaults({ env: { AEDIS_AUTO_PROMOTE: v } });
    assert.equal(
      r.autoPromoteOnSuccess,
      false,
      `AEDIS_AUTO_PROMOTE=${JSON.stringify(v)} must NOT flip the guard`,
    );
  }
});

test("safeDefaults: AEDIS_REQUIRE_APPROVAL with non-'false' value stays required", () => {
  // Same defense — only the literal "false" disables approval.
  for (const v of ["FALSE", "0", "no", "off", " false", "false ", ""]) {
    const r = safeDefaults({ env: { AEDIS_REQUIRE_APPROVAL: v } });
    assert.equal(
      r.requireApproval,
      true,
      `AEDIS_REQUIRE_APPROVAL=${JSON.stringify(v)} must NOT disable approval`,
    );
  }
});

test("safeDefaults: undefined env values resolve to safe", () => {
  const r = safeDefaults({
    env: { AEDIS_AUTO_PROMOTE: undefined, AEDIS_REQUIRE_APPROVAL: undefined },
  });
  assert.equal(r.autoPromoteOnSuccess, false);
  assert.equal(r.requireApproval, true);
});

// ─── deriveRuntimePolicy: projection ────────────────────────────────

test("deriveRuntimePolicy: safe defaults block destructive ops", () => {
  const p = deriveRuntimePolicy({
    autoPromoteOnSuccess: false,
    requireApproval: true,
    requireWorkspace: true,
  });
  assert.equal(p.destructiveOps, "blocked");
  assert.equal(p.shadowPromoteAllowed, false, "structural invariant");
  assert.equal(p.laneMode, "unset");
});

test("deriveRuntimePolicy: only auto-promote on + approval off → destructive allowed", () => {
  const p = deriveRuntimePolicy({
    autoPromoteOnSuccess: true,
    requireApproval: false,
    requireWorkspace: true,
  });
  assert.equal(p.destructiveOps, "allowed");
});

test("deriveRuntimePolicy: auto-promote on but approval required → still blocked", () => {
  const p = deriveRuntimePolicy({
    autoPromoteOnSuccess: true,
    requireApproval: true,
    requireWorkspace: true,
  });
  assert.equal(
    p.destructiveOps,
    "blocked",
    "approval gate alone is enough to block destructive auto-promotion",
  );
});

test("deriveRuntimePolicy: approval skipped but auto-promote off → still blocked", () => {
  const p = deriveRuntimePolicy({
    autoPromoteOnSuccess: false,
    requireApproval: false,
    requireWorkspace: true,
  });
  assert.equal(
    p.destructiveOps,
    "blocked",
    "auto-promote off alone is enough to block destructive runs",
  );
});

test("deriveRuntimePolicy: laneMode is surfaced verbatim when supplied", () => {
  const p = deriveRuntimePolicy({
    autoPromoteOnSuccess: false,
    requireApproval: true,
    requireWorkspace: true,
    laneMode: "local_then_cloud",
  });
  assert.equal(p.laneMode, "local_then_cloud");
});

test("deriveRuntimePolicy: shadowPromoteAllowed is a structural false — never flips", () => {
  // Even with every other guard flipped to unsafe, shadow promotion
  // remains structurally impossible. The field is a guarantee, not
  // a setting.
  const unsafe = deriveRuntimePolicy({
    autoPromoteOnSuccess: true,
    requireApproval: false,
    requireWorkspace: false,
  });
  assert.equal(unsafe.shadowPromoteAllowed, false);
  // TypeScript pin: the literal type must be `false`, not `boolean`.
  const f: false = unsafe.shadowPromoteAllowed;
  assert.equal(f, false);
});

// ─── policyFromCoordinatorConfig: convenience helper ───────────────

test("policyFromCoordinatorConfig: passes laneMode through", () => {
  const p = policyFromCoordinatorConfig(
    { autoPromoteOnSuccess: false, requireApproval: true, requireWorkspace: true },
    "primary_only",
  );
  assert.equal(p.laneMode, "primary_only");
  assert.equal(p.destructiveOps, "blocked");
});

test("policyFromCoordinatorConfig: missing laneMode → 'unset'", () => {
  const p = policyFromCoordinatorConfig({
    autoPromoteOnSuccess: false,
    requireApproval: true,
    requireWorkspace: true,
  });
  assert.equal(p.laneMode, "unset");
});
