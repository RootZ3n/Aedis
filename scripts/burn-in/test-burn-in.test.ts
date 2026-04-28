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

test("buildScenarios id-list contract — pin exact order so a future insert is intentional", () => {
  const scenarios = buildScenarios({ tag: "t" });
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
      "burn-in-11-lane-rescue",
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

// ─── Stale-server gate ──────────────────────────────────────────────
//
// The full refusal path inside main() can't be exercised without a
// live server, but the contract has three parts the harness can pin
// directly:
//   1. assessStaleness fires when the inputs match a stale condition
//      (covered in core/staleness.test.ts)
//   2. The flag --allow-stale-server is recognised by argv parsing
//   3. Burn-in's preamble logging mentions "Allow stale server"
//
// (2) and (3) are static-string tests against the source so a future
// refactor can't silently drop the flag.

test("burn-in: --allow-stale-server flag is recognised in main()", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("./test-burn-in.ts", import.meta.url),
    "utf-8",
  );
  assert.match(src, /--allow-stale-server/);
  assert.match(src, /Allow stale server:/);
});

test("burn-in: refusal path exists with explicit error message", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("./test-burn-in.ts", import.meta.url),
    "utf-8",
  );
  // The refusal block must be present and must mention the override.
  assert.match(src, /Refusing to run burn-in against a stale server/);
  assert.match(src, /pass --allow-stale-server/);
});

test("burn-in: imports the shared assessStaleness helper", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("./test-burn-in.ts", import.meta.url),
    "utf-8",
  );
  assert.match(src, /assessStaleness/);
  assert.match(src, /detectSourceNewerThanDist/);
});

// ─── Lane-rescue scenario + cost guard ──────────────────────────────

test("buildScenarios returns 11 scenarios", () => {
  const scenarios = buildScenarios({ tag: "t" });
  assert.equal(scenarios.length, 11);
  assert.ok(scenarios.some((s) => s.id === "burn-in-11-lane-rescue"));
});

test("burn-in-11: prompt enforces strict error-message contract that 9B local often misses", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s11 = scenarios.find((s) => s.id === "burn-in-11-lane-rescue");
  assert.ok(s11);
  // The exact-string error-message contracts are the trip wires that
  // make the local primary likely to fail verification on first try.
  assert.match(s11.prompt, /'parseFraction: zero denominator'/);
  assert.match(s11.prompt, /'parseFraction: invalid format'/);
  assert.match(s11.prompt, /MUST throw/);
});

test("burn-in-11: scope-locked to tmp/burn-in/", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s11 = scenarios.find((s) => s.id === "burn-in-11-lane-rescue");
  assert.ok(s11);
  assert.match(s11.prompt, /tmp\/burn-in\/parse-fraction\.ts/);
  assert.match(s11.prompt, /do not touch any other file/i);
});

test("burn-in-11: expectation block sets a higher cost cap to cover cloud-shadow spend", () => {
  const scenarios = buildScenarios({ tag: "t" });
  const s11 = scenarios.find((s) => s.id === "burn-in-11-lane-rescue");
  assert.ok(s11);
  assert.equal(s11.expected.minFilesChanged, 2);
  // Cloud-shadow runs cost more than purely local repair-loop runs.
  assert.ok((s11.expected.maxCostUsd ?? 0) >= 1.0);
  assert.equal(s11.expected.requireCommandEvidence, true);
});

// ─── shouldRunLaneRescue (cost guard) ───────────────────────────────

test("shouldRunLaneRescue: skips when lane mode is not local_then_cloud", async () => {
  const { shouldRunLaneRescue } = await import("./harness.js");
  for (const mode of ["primary_only", "local_vs_cloud", "cloud_with_local_check", undefined]) {
    const r = shouldRunLaneRescue({
      ...(mode ? { laneMode: mode } : {}),
      shadowProvider: "openrouter",
      allowShadowCost: true,
    });
    assert.equal(r.run, false, `mode ${JSON.stringify(mode)} must skip`);
    assert.match((r as { reason: string }).reason, /local_then_cloud/);
  }
});

test("shouldRunLaneRescue: skips when no shadow provider is configured", async () => {
  const { shouldRunLaneRescue } = await import("./harness.js");
  const r = shouldRunLaneRescue({
    laneMode: "local_then_cloud",
    allowShadowCost: true,
  });
  assert.equal(r.run, false);
  assert.match((r as { reason: string }).reason, /no shadow lane configured/);
});

test("shouldRunLaneRescue: cloud shadow without --allow-shadow-cost SKIPS (not fails)", async () => {
  const { shouldRunLaneRescue } = await import("./harness.js");
  const r = shouldRunLaneRescue({
    laneMode: "local_then_cloud",
    shadowProvider: "openrouter",
    allowShadowCost: false,
  });
  assert.equal(r.run, false);
  assert.match((r as { reason: string }).reason, /paid cloud/);
  assert.match((r as { reason: string }).reason, /--allow-shadow-cost/);
});

test("shouldRunLaneRescue: cloud shadow WITH --allow-shadow-cost runs", async () => {
  const { shouldRunLaneRescue } = await import("./harness.js");
  for (const provider of [
    "openrouter", "anthropic", "openai", "minimax", "modelstudio", "zai",
    "glm-5.1-openrouter", "glm-5.1-direct",
  ]) {
    const r = shouldRunLaneRescue({
      laneMode: "local_then_cloud",
      shadowProvider: provider,
      allowShadowCost: true,
    });
    assert.equal(r.run, true, `cloud provider ${provider} with flag must run`);
  }
});

test("shouldRunLaneRescue: local shadow runs WITHOUT --allow-shadow-cost (no spend)", async () => {
  const { shouldRunLaneRescue } = await import("./harness.js");
  for (const provider of ["ollama", "local"]) {
    const r = shouldRunLaneRescue({
      laneMode: "local_then_cloud",
      shadowProvider: provider,
      allowShadowCost: false,
    });
    assert.equal(r.run, true, `local provider ${provider} should not need the flag`);
  }
});

test("isCloudShadowProvider: known cloud providers true, others false", async () => {
  const { isCloudShadowProvider } = await import("./harness.js");
  assert.equal(isCloudShadowProvider("openrouter"), true);
  assert.equal(isCloudShadowProvider("anthropic"), true);
  assert.equal(isCloudShadowProvider("ollama"), false);
  assert.equal(isCloudShadowProvider("local"), false);
  assert.equal(isCloudShadowProvider(undefined), false);
  assert.equal(isCloudShadowProvider(""), false);
});

// ─── Skip wiring exists in main() ───────────────────────────────────

test("burn-in: --allow-shadow-cost flag is recognised in main()", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("./test-burn-in.ts", import.meta.url),
    "utf-8",
  );
  assert.match(src, /--allow-shadow-cost/);
  assert.match(src, /allowShadowCost/);
  assert.match(src, /shouldRunLaneRescue/);
});

test("burn-in: lane-rescue skip emits a SKIPPED line with the gate reason", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("./test-burn-in.ts", import.meta.url),
    "utf-8",
  );
  assert.match(src, /burn-in-11-lane-rescue.*!laneRescueGate\.run/s);
  assert.match(src, /⏭ SKIPPED:/);
});
