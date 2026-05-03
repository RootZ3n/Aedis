import test from "node:test";
import assert from "node:assert/strict";

import {
  bannerProgressPct,
  bannerStatusLabel,
  bannerStatusSubtitle,
  computeEffectiveBannerStatus,
} from "./banner-status.js";

test("plan_ready overrides a stale prior 'complete' run status", () => {
  // The exact UX bug: previous run completed, user creates a new
  // mission → plan.status = 'pending', run.status still 'complete'.
  // Banner must show PLAN READY, not COMPLETE 100%.
  const eff = computeEffectiveBannerStatus({
    runStatus: "complete",
    planStatus: "pending",
  });
  assert.equal(eff, "plan_ready");
  assert.equal(bannerStatusLabel(eff), "PLAN READY");
  assert.equal(bannerStatusSubtitle(eff), "Plan ready — waiting for start");
  // 0% never 100% — a freshly created plan must not advertise
  // completion.
  assert.equal(bannerProgressPct(eff), 0);
  assert.equal(bannerProgressPct(eff, { completed: 0, total: 5 }), 0);
});

test("plan_ready overrides a stale prior 'failed' run status", () => {
  const eff = computeEffectiveBannerStatus({
    runStatus: "failed",
    planStatus: "pending",
  });
  assert.equal(eff, "plan_ready");
});

test("plan_ready overrides a stale prior 'cancelled' run status", () => {
  const eff = computeEffectiveBannerStatus({
    runStatus: "cancelled",
    planStatus: "pending",
  });
  assert.equal(eff, "plan_ready");
});

test("running plan trumps any run status", () => {
  const eff = computeEffectiveBannerStatus({
    runStatus: "complete",
    planStatus: "running",
  });
  assert.equal(eff, "running");
});

test("paused plan surfaces blocked", () => {
  const eff = computeEffectiveBannerStatus({
    runStatus: "running",
    planStatus: "paused",
  });
  assert.equal(eff, "blocked");
});

test("blocked plan surfaces blocked", () => {
  const eff = computeEffectiveBannerStatus({
    runStatus: "complete",
    planStatus: "blocked",
  });
  assert.equal(eff, "blocked");
});

test("completed plan does not override run status (run_complete already drove banner)", () => {
  // Once the loop driver has marked the plan completed the run
  // events have driven the banner. We let run status stand to keep
  // the green flourish on terminal success.
  const eff = computeEffectiveBannerStatus({
    runStatus: "complete",
    planStatus: "completed",
  });
  assert.equal(eff, "complete");
});

test("no plan loaded → banner mirrors the run status", () => {
  assert.equal(
    computeEffectiveBannerStatus({ runStatus: "running", planStatus: null }),
    "running",
  );
  assert.equal(
    computeEffectiveBannerStatus({ runStatus: "idle", planStatus: null }),
    "idle",
  );
});

test("bannerStatusLabel covers every emitted status", () => {
  // Compile-time enumeration via runtime list so a future status
  // addition cannot silently regress the label table.
  const all: ReturnType<typeof computeEffectiveBannerStatus>[] = [
    "idle", "queued", "running", "blocked", "paused",
    "plan_ready", "complete", "partial", "failed", "cancelled",
  ];
  for (const s of all) {
    const label = bannerStatusLabel(s);
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0, `label missing for ${s}`);
  }
});

test("running progress reflects plan counts when provided", () => {
  assert.equal(bannerProgressPct("running", { completed: 0, total: 5 }), 0);
  assert.equal(bannerProgressPct("running", { completed: 2, total: 5 }), 40);
  assert.equal(bannerProgressPct("running", { completed: 5, total: 5 }), 100);
  assert.equal(bannerProgressPct("running", null), 50);
  assert.equal(bannerProgressPct("running"), 50);
});

test("complete status reads 100% only when status really is complete", () => {
  assert.equal(bannerProgressPct("complete"), 100);
  assert.equal(bannerProgressPct("plan_ready"), 0);
  assert.equal(bannerProgressPct("idle"), 0);
});
