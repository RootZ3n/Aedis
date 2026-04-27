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

test("buildScenarios returns 9 scenarios", () => {
  const scenarios = buildScenarios({ tag: "t" });
  assert.equal(scenarios.length, 9);
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
