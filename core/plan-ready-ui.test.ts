/**
 * UI-side regression tests for the "PLAN READY" UX bug fix.
 *
 * The dashboard is a single static HTML file, so these tests parse
 * `ui/index.html` for the specific structural / textual contracts
 * the fix relies on — the same way `ui/components/*.test.tsx` lock
 * down React-component contracts elsewhere in the repo.
 *
 * The contracts checked here:
 *
 *   1. The banner override mirrors core/banner-status.ts, so a
 *      `pending` plan flips the banner word to PLAN READY.
 *   2. A Start CTA is wired up that POSTs to
 *      /task-plans/:id/start (so users can dispatch the first
 *      subtask without leaving the banner).
 *   3. The status strip uses the effective status, not the raw run
 *      status, when computing the displayed % — preventing the
 *      "COMPLETE 100%" mis-render after mission creation.
 *   4. The trust summary panel is hidden on `pending` plans so a
 *      stale prior run cannot imply the new plan executed.
 *   5. Receipts feed surfaces an explicit "no source execution yet"
 *      empty state when the loaded plan is `pending`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { computeEffectiveBannerStatus } from "./banner-status.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HTML_PATH = join(__dirname, "..", "ui", "index.html");
const HTML = readFileSync(HTML_PATH, "utf8");

test("UI inlines the effectiveBannerStatus override (mirrors core helper)", () => {
  // Sanity: the helper's contract is what the UI relies on.
  assert.equal(
    computeEffectiveBannerStatus({ runStatus: "complete", planStatus: "pending" }),
    "plan_ready",
  );

  // The HTML must contain the inline override function and the
  // critical `planStatus === 'pending'` branch — without it the
  // bug returns.
  assert.match(HTML, /function effectiveBannerStatus\(/);
  assert.match(HTML, /planStatus === 'pending'/);
  assert.match(HTML, /return 'plan_ready'/);
});

test("UI exposes a Start Mission CTA on plan_ready", () => {
  // The CTA must mention "Start Mission" so the next action is
  // unambiguous, and POST to /task-plans/:id/start (the existing
  // start endpoint).
  assert.match(HTML, /Start Mission/);
  assert.match(HTML, /\/task-plans\/\$\{encodeURIComponent\(planId\)\}\/start/);
});

test("UI status strip reads the effective status — never advertises 100% for plan_ready", () => {
  // Pull out the renderHeader function block and confirm the
  // status strip uses `effectiveStrip` rather than the raw
  // run status — this is the line that used to read
  // `status === 'complete' ? 100 : ...`.
  const start = HTML.indexOf("function renderHeader()");
  assert.ok(start > 0, "renderHeader must exist");
  const block = HTML.slice(start, start + 5_000);
  assert.match(block, /effectiveStrip = effectiveBannerStatus\(status\)/);
  assert.match(block, /effectiveStrip === 'plan_ready'/);
  assert.match(block, /'PLAN READY'/);
});

test("Trust summary panel is suppressed on pending plans (no execution implied)", () => {
  const idx = HTML.indexOf("function renderTrustSummary()");
  assert.ok(idx > 0);
  const block = HTML.slice(idx, idx + 3_000);
  assert.match(block, /planStatus === 'pending'/);
  assert.match(block, /panel\.style\.display = 'none'/);
});

test("Receipts feed shows explicit 'no source execution yet' on pending plans", () => {
  const idx = HTML.indexOf("function renderReceipts()");
  assert.ok(idx > 0);
  const block = HTML.slice(idx, idx + 2_500);
  assert.match(block, /planStatus === 'pending'/);
  assert.match(block, /no source execution yet/i);
});

test("CSS defines plan_ready styling distinct from complete", () => {
  // `.status-strip.plan_ready` must exist and not collide with
  // `.status-strip.complete` — the visual difference is the whole
  // point of the fix.
  assert.match(HTML, /\.status-strip\.plan_ready::before/);
  assert.match(HTML, /\.gsb-dot\.plan_ready/);
  assert.match(HTML, /\.global-status-bar\.status-plan_ready/);
});

test("missionStart success message reflects 'plan ready, no execution yet'", () => {
  // Pin the user-facing assistant message so we can't regress to
  // "Mission created (id) ... Click Start" without saying that no
  // Builder/Critic/Verifier/Integrator ran.
  const idx = HTML.indexOf("async function missionStart()");
  assert.ok(idx > 0);
  const block = HTML.slice(idx, idx + 4_000);
  assert.match(block, /Plan ready/);
  assert.match(
    block,
    /No Builder\/Critic\/Verifier\/Integrator has run yet/,
  );
  // Auto-scroll to Task Plan panel after creation.
  assert.match(block, /taskplan-panel/);
  assert.match(block, /scrollIntoView/);
});
