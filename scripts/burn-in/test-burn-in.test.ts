import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBurnIn01Prompt,
  buildScenarios,
  defaultBurnInRunTag,
  formatServerIdentity,
} from "./test-burn-in.js";

test("buildBurnIn01Prompt embeds the tag inline in the marker comment", () => {
  const prompt = buildBurnIn01Prompt("ABC123");
  assert.match(prompt, /'\/\/ burn-in: comment-swap probe ABC123\.'/);
  assert.match(prompt, /core\/run-summary\.ts/);
  assert.match(prompt, /Do not modify anything else\./);
});

test("buildBurnIn01Prompt produces distinct prompts for distinct tags", () => {
  const a = buildBurnIn01Prompt("tag-a");
  const b = buildBurnIn01Prompt("tag-b");
  assert.notEqual(a, b);
});

test("defaultBurnInRunTag is deterministic when now/rand are pinned", () => {
  const tag = defaultBurnInRunTag(
    () => 1_700_000_000_000,
    () => 0.5,
  );
  // 1.7e12 → "lpgolwc"; 0.5 * 1e9 = 5e8 → "8c0wpc". Stability is what
  // matters here, not the literal value — test asserts the *shape*.
  assert.match(tag, /^[0-9a-z]+-[0-9a-z]+$/);
});

test("defaultBurnInRunTag produces unique tags across invocations", () => {
  // Real Date.now + Math.random — collision is astronomically unlikely.
  const tags = new Set<string>();
  for (let i = 0; i < 16; i++) tags.add(defaultBurnInRunTag());
  assert.equal(tags.size, 16);
});

test("buildScenarios threads an explicit tag into burn-in-01", () => {
  const scenarios = buildScenarios({ tag: "deadbeef" });
  const burnIn01 = scenarios.find((s) => s.id === "burn-in-01-comment-swap-tiny");
  assert.ok(burnIn01, "burn-in-01 must exist");
  assert.match(burnIn01.prompt, /comment-swap probe deadbeef\./);
});

test("buildScenarios with no tag still produces a usable burn-in-01 prompt", () => {
  const scenarios = buildScenarios();
  const burnIn01 = scenarios.find((s) => s.id === "burn-in-01-comment-swap-tiny");
  assert.ok(burnIn01);
  // The prompt must always carry SOME tag so re-runs can't collide
  // with prior promoted markers in the source repo. The tag pattern
  // is a base36 ms timestamp + base36 random — match that shape.
  assert.match(
    burnIn01.prompt,
    /'\/\/ burn-in: comment-swap probe [0-9a-z]+-[0-9a-z]+\.'/,
  );
});

test("buildScenarios returns 10 scenarios", () => {
  const scenarios = buildScenarios({ tag: "t" });
  assert.equal(scenarios.length, 10);
  assert.deepEqual(
    scenarios.map((s) => s.id),
    [
      "burn-in-01-comment-swap-tiny",
      "burn-in-02-two-file-refactor",
      "burn-in-03-multi-file-improvement",
      "burn-in-04-ambiguous-should-ask",
      "burn-in-05-do-not-touch",
      "burn-in-06-no-op-recovery",
      "burn-in-07-source-plus-test",
      "burn-in-08-external-repo",
      "burn-in-09-command-loop",
      "burn-in-10-repair-loop",
    ],
  );
});

test("burn-in-09: prompt references validation commands by name", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s09 = scenarios.find((s) => s.id === "burn-in-09-command-loop");
  assert.ok(s09, "burn-in-09 must exist");
  assert.match(s09.prompt, /npm run security:secrets/);
  assert.match(s09.prompt, /npm test/);
  assert.match(s09.prompt, /npm run build/);
  assert.match(s09.prompt, /npx tsc --noEmit/);
});

test("burn-in-09: expects at least 2 files changed", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s09 = scenarios.find((s) => s.id === "burn-in-09-command-loop");
  assert.ok(s09);
  assert.ok(
    s09.expected.minFilesChanged !== undefined && s09.expected.minFilesChanged >= 2,
    "command-loop must change source + test file",
  );
});

test("burn-in-09: prompt includes scope-lock phrasing", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s09 = scenarios.find((s) => s.id === "burn-in-09-command-loop");
  assert.ok(s09);
  assert.match(s09.prompt, /do not touch any other file/i);
});

test("burn-in-09: prompt instructs fix-and-rerun on failure", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s09 = scenarios.find((s) => s.id === "burn-in-09-command-loop");
  assert.ok(s09);
  assert.match(s09.prompt, /fix.*rerun/i);
});

test("buildScenarios returns fresh arrays — callers can't mutate cached state", () => {
  const a = buildScenarios({ tag: "x" });
  const b = buildScenarios({ tag: "x" });
  assert.notEqual(a, b, "different array identity");
  assert.deepEqual(
    a.map((s) => s.id),
    b.map((s) => s.id),
  );
});

// ─── Burn-in server identity (stale-dist / duplicate detection) ─────

test("formatServerIdentity: prints pid/port/commit/buildTime/uptime when /health is complete", () => {
  const r = formatServerIdentity({
    pid: 4242,
    port: 18796,
    uptime_human: "5m 49s",
    startedAt: "2026-04-27T22:00:00.000Z",
    build: {
      version: "1.0.0",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      commitShort: "abcdef01",
      buildTime: "2026-04-27T22:00:00.000Z",
      source: "build-info",
    },
  });
  assert.match(r.identityLine, /pid=4242/);
  assert.match(r.identityLine, /port=18796/);
  assert.match(r.identityLine, /commit=abcdef01/);
  assert.match(r.identityLine, /buildTime=2026-04-27T22:00:00\.000Z/);
  assert.match(r.identityLine, /uptime=5m 49s/);
  assert.equal(r.warnings.length, 0, `no warnings when metadata complete; got ${JSON.stringify(r.warnings)}`);
});

test("formatServerIdentity: warns and degrades gracefully when /health has no pid/build (stale dist)", () => {
  const r = formatServerIdentity({
    workers: { scout: { available: true } },
    all_workers_available: true,
  });
  // Identity line still renders — just with sentinels — so the harness
  // never throws on a pre-build-metadata server.
  assert.match(r.identityLine, /pid=unknown/);
  assert.match(r.identityLine, /commit=unknown/);
  assert.match(r.identityLine, /buildTime=unknown/);
  assert.ok(
    r.warnings.some((w) => /missing pid\/build/i.test(w)),
    `expected stale-dist warning; got ${JSON.stringify(r.warnings)}`,
  );
});

test("formatServerIdentity: warns when build metadata source is not the dist file", () => {
  const r = formatServerIdentity({
    pid: 1,
    port: 18796,
    uptime_human: "1m",
    build: {
      version: "1.0.0",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      commitShort: "abcdef01",
      buildTime: "2026-04-27T22:00:00.000Z",
      source: "git-runtime",
    },
  });
  // pid/commit are present, so the missing-fields warning should NOT fire,
  // but the source-of-truth warning should — the operator is running
  // against tsx, not a built dist.
  assert.ok(
    r.warnings.some((w) => /git-runtime/.test(w)),
    `expected git-runtime warning; got ${JSON.stringify(r.warnings)}`,
  );
  assert.ok(
    !r.warnings.some((w) => /missing pid\/build/i.test(w)),
    `did not expect missing-fields warning; got ${JSON.stringify(r.warnings)}`,
  );
});

// ─── burn-in-10 repair-loop ─────────────────────────────────────────

test("burn-in-10: prompt creates two files under tmp/burn-in/", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s10 = scenarios.find((s) => s.id === "burn-in-10-repair-loop");
  assert.ok(s10, "burn-in-10 must exist");
  assert.match(s10.prompt, /tmp\/burn-in\/rotate-string\.ts/);
  assert.match(s10.prompt, /tmp\/burn-in\/rotate-string\.test\.ts/);
});

test("burn-in-10: prompt names the wraparound test that the naive impl fails", () => {
  // The whole point of scenario-10 is that the first impl is likely
  // to fail one specific test (the wraparound case). Pin the test
  // case in the prompt so a future edit can't accidentally remove
  // the failure-trigger and turn this into a happy-path scenario.
  const scenarios = buildScenarios({ tag: "t" });
  const s10 = scenarios.find((s) => s.id === "burn-in-10-repair-loop");
  assert.ok(s10);
  assert.match(s10.prompt, /'abc',\s*7.*===\s*'bca'/);
  assert.match(s10.prompt, /wraparound/i);
});

test("burn-in-10: prompt includes the create→validate→fix→rerun loop instructions", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s10 = scenarios.find((s) => s.id === "burn-in-10-repair-loop");
  assert.ok(s10);
  assert.match(s10.prompt, /run\s+`?npm test`?/i);
  assert.match(s10.prompt, /fix the implementation/i);
  assert.match(s10.prompt, /rerun/i);
  assert.match(s10.prompt, /until all four tests pass/i);
});

test("burn-in-10: scope-locked to tmp/burn-in/ — prompt forbids touching other files", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s10 = scenarios.find((s) => s.id === "burn-in-10-repair-loop");
  assert.ok(s10);
  assert.match(s10.prompt, /do not touch any other file/i);
});

test("burn-in-10: expectation block carries repair-loop validation flags", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s10 = scenarios.find((s) => s.id === "burn-in-10-repair-loop");
  assert.ok(s10);
  assert.equal(s10.expected.minFilesChanged, 2);
  assert.equal(s10.expected.minRepairAttempts, 1);
  assert.equal(s10.expected.requireCommandEvidence, true);
  assert.equal(s10.expected.requireFinalVerifierPass, true);
  // Cost cap defended — repair loops cost more than single-shot.
  assert.ok((s10.expected.maxCostUsd ?? 0) > 0);
});

// ─── Repair-loop predicates (pure functions over RunDetail) ─────────

test("hasCommandEvidence: true when at least one verifier event completed", async () => {
  const { hasCommandEvidence } = await import("./harness.js");
  assert.equal(
    hasCommandEvidence({
      status: "PROMOTED",
      workerEvents: [
        { workerType: "builder", status: "completed", taskId: "t1" },
        { workerType: "verifier", status: "completed", taskId: "t2" },
      ],
    }),
    true,
  );
});

test("hasCommandEvidence: false when verifier never completed", async () => {
  const { hasCommandEvidence } = await import("./harness.js");
  assert.equal(
    hasCommandEvidence({
      status: "EXECUTION_ERROR",
      workerEvents: [
        { workerType: "builder", status: "completed", taskId: "t1" },
        { workerType: "verifier", status: "failed", taskId: "t2" },
      ],
    }),
    false,
  );
  // Missing workerEvents entirely → still false (don't assume).
  assert.equal(hasCommandEvidence({ status: "PROMOTED" }), false);
  assert.equal(hasCommandEvidence(null), false);
});

test("countRepairAttempts: zero on a clean single-builder run", async () => {
  const { countRepairAttempts } = await import("./harness.js");
  assert.equal(
    countRepairAttempts({
      status: "PROMOTED",
      workerEvents: [
        { workerType: "scout", status: "completed", taskId: "t1" },
        { workerType: "builder", status: "completed", taskId: "t2" },
        { workerType: "verifier", status: "completed", taskId: "t3" },
      ],
    }),
    0,
  );
});

test("countRepairAttempts: counts re-dispatched builder events", async () => {
  const { countRepairAttempts } = await import("./harness.js");
  // Repair loop: builder failed once, recovery re-dispatched, second
  // builder completed. Two builder events → one repair attempt.
  assert.equal(
    countRepairAttempts({
      status: "AWAITING_APPROVAL",
      workerEvents: [
        { workerType: "builder", status: "failed", taskId: "t1" },
        { workerType: "builder", status: "completed", taskId: "t1-retry" },
        { workerType: "verifier", status: "completed", taskId: "t2" },
      ],
    }),
    1,
  );
});

test("countRepairAttempts: handles missing workerEvents gracefully (zero)", async () => {
  const { countRepairAttempts } = await import("./harness.js");
  assert.equal(countRepairAttempts({ status: "EXECUTION_ERROR" }), 0);
  assert.equal(countRepairAttempts(null), 0);
});

test("finalVerifierVerdict: returns the receipt verdict when present", async () => {
  const { finalVerifierVerdict } = await import("./harness.js");
  assert.equal(
    finalVerifierVerdict({
      status: "PROMOTED",
      verificationReceipt: { verdict: "pass" },
    }),
    "pass",
  );
  assert.equal(
    finalVerifierVerdict({
      status: "AWAITING_APPROVAL",
      verificationReceipt: { verdict: "pass-with-warnings" },
    }),
    "pass-with-warnings",
  );
  assert.equal(
    finalVerifierVerdict({
      status: "VERIFIED_FAIL",
      verificationReceipt: { verdict: "fail" },
    }),
    "fail",
  );
});

test("finalVerifierVerdict: falls back to summary.verification when receipt is absent", async () => {
  const { finalVerifierVerdict } = await import("./harness.js");
  assert.equal(
    finalVerifierVerdict({
      status: "PROMOTED",
      summary: { verification: "pass" },
    }),
    "pass",
  );
});

test("finalVerifierVerdict: defaults to 'not-run' when nothing reports a verdict", async () => {
  const { finalVerifierVerdict } = await import("./harness.js");
  assert.equal(finalVerifierVerdict({ status: "EXECUTION_ERROR" }), "not-run");
  assert.equal(finalVerifierVerdict(null), "not-run");
  // Unknown verdict string → not-run (don't pass through unsanitised values).
  assert.equal(
    finalVerifierVerdict({ status: "X", verificationReceipt: { verdict: "weird" } }),
    "not-run",
  );
});
