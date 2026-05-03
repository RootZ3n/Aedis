/**
 * UI parity tests — mirrors core/plan-ready-ui.test.ts.
 *
 * The HTML dashboard inlines a copy of the unsafe-state assessment
 * because it can't import TS modules. This test suite parses
 * `ui/index.html` and pins:
 *
 *   1. The CONTAMINATED WORKSPACE card markup exists and starts
 *      hidden by default.
 *   2. The renderApprovalCard function gates on the inline assessment
 *      and returns early when unsafe.
 *   3. The global status bar resolves `effectiveStatus = 'contaminated'`
 *      when the assessment trips, taking precedence over
 *      paused/needs_replan/running.
 *   4. The unsafe-state CTA/cancel/mark-inspected buttons are wired.
 *   5. No code path in renderApprovalCard or renderGlobalStatusBar
 *      shows an Approve action under contaminated state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HTML = readFileSync(join(__dirname, "..", "ui", "index.html"), "utf8");

test("UI inlines an assessUnsafeStateUI helper and uses it in the approval card guard", () => {
  assert.match(HTML, /function assessUnsafeStateUI\(/);
  // The helper must check at minimum:
  assert.match(HTML, /'rollback_incomplete'/);
  assert.match(HTML, /'rollback_failed'/);
  assert.match(HTML, /'unsafe_state'/);
  assert.match(HTML, /'manual_inspection_required'/);
  // The text-evidence fallback must be present for older receipts.
  // The HTML literally contains the regex pattern as JS source; check
  // for a distinctive substring instead of a re-encoded regex.
  assert.ok(
    HTML.includes("ROLLBACK") && HTML.includes("INCOMPLETE") && HTML.includes("FAILED") && HTML.includes("UNSAFE"),
    "UI helper must encode the rollback text-evidence pattern",
  );
  assert.match(HTML, /manual\\s\+inspection\\s\+required/i);
});

test("renderApprovalCard hides the card when assessUnsafeStateUI flags unsafe", () => {
  const idx = HTML.indexOf("function renderApprovalCard()");
  assert.ok(idx > 0);
  const block = HTML.slice(idx, idx + 4_000);
  // The function MUST call the assessor.
  assert.match(block, /assessUnsafeStateUI\(run\)/);
  // It MUST early-return without `card.classList.add('show')` when unsafe.
  assert.match(block, /if \(unsafe && unsafe\.unsafe\)\s*\{[\s\S]*?card\.classList\.remove\('show'\)/);
});

test("CONTAMINATED WORKSPACE card markup exists, starts hidden, and lacks an Approve button", () => {
  // The card section.
  assert.match(HTML, /id="unsafe-state-card"[^>]*style="display:none"/);
  // Title that names the contamination.
  assert.match(HTML, /Contaminated Workspace/);
  // Buttons present:
  assert.match(HTML, /id="unsafe-state-cancel"[^>]*>Cancel Run<\/button>/);
  assert.match(HTML, /id="unsafe-state-mark-inspected"[^>]*>Mark Inspected<\/button>/);
  assert.match(HTML, /id="unsafe-state-show-diff"[^>]*>Show Last Diff<\/button>/);
  // No Approve / Promote button anywhere in the card body. Slice
  // the card region and assert the absence to avoid matching
  // unrelated approval markup elsewhere.
  const start = HTML.indexOf('id="unsafe-state-card"');
  assert.ok(start > 0);
  const end = HTML.indexOf("</section>", start);
  const cardHtml = HTML.slice(start, end);
  assert.doesNotMatch(cardHtml, /\bid="unsafe-state-approve"/);
  assert.doesNotMatch(cardHtml, />\s*Approve\s*</);
  assert.doesNotMatch(cardHtml, />\s*Promote/);
});

test("renderUnsafeStateCard exists and is wired into the render pipeline", () => {
  assert.match(HTML, /function renderUnsafeStateCard\(/);
  // The override render() must call renderUnsafeStateCard before
  // renderApprovalCard so layout order matches the visual priority.
  const override = HTML.indexOf("const _origRender = render");
  assert.ok(override > 0);
  const block = HTML.slice(override, override + 1_000);
  const idxUnsafe = block.indexOf("renderUnsafeStateCard(");
  const idxApproval = block.indexOf("renderApprovalCard(");
  assert.ok(idxUnsafe > 0 && idxApproval > 0);
  assert.ok(idxUnsafe < idxApproval, "renderUnsafeStateCard must run before renderApprovalCard");
});

test("global status bar resolves effectiveStatus='contaminated' when the assessor trips", () => {
  const idx = HTML.indexOf("function renderGlobalStatusBar()");
  assert.ok(idx > 0);
  // Slice large enough to include both the assessor call and the
  // CTA branch (renderGlobalStatusBar is long; default 8 KB cuts
  // it off before the CTA section).
  const block = HTML.slice(idx, idx + 20_000);
  // The block must compute unsafeAssessment first.
  assert.match(block, /assessUnsafeStateUI\(run\)/);
  assert.match(block, /'contaminated'/);
  assert.match(block, /CONTAMINATED — INSPECT/);
  assert.match(block, /effectiveStatus === 'contaminated'/);
});

test("contaminated CTA opens the unsafe-state card, never the approval card", () => {
  const idx = HTML.indexOf("effectiveStatus === 'contaminated'");
  assert.ok(idx > 0);
  // Slice the contaminated branch and confirm it scrolls to
  // unsafe-state-card, not approval-card.
  const block = HTML.slice(idx, idx + 800);
  assert.match(block, /unsafe-state-card/);
  // The branch's onclick must NOT scroll to approval-card.
  const onclick = block.match(/cta\.onclick = \(\) => \{[\s\S]*?\};/);
  assert.ok(onclick, "contaminated branch must define a CTA onclick");
  assert.doesNotMatch(onclick![0], /approval-card/);
});

test("CSS defines a contaminated style distinct from failed and from approval-card visuals", () => {
  assert.match(HTML, /\.global-status-bar\.status-contaminated/);
  assert.match(HTML, /\.gsb-dot\.contaminated/);
});

test("Mark Inspected button does NOT issue any approval/promote network call", () => {
  // The button must be UI-only (it dismisses the card; the workspace
  // is still contaminated). Slice the handler block and assert no
  // fetch to /approvals/.../approve or /promote.
  const idx = HTML.indexOf("unsafe-state-mark-inspected");
  assert.ok(idx > 0);
  // Find the click handler that follows the button id.
  const handlerStart = HTML.indexOf("markBtn.addEventListener", idx);
  assert.ok(handlerStart > 0);
  const handler = HTML.slice(handlerStart, handlerStart + 1_500);
  assert.doesNotMatch(handler, /\/approvals\/.+\/approve/);
  assert.doesNotMatch(handler, /\/promote/);
});
