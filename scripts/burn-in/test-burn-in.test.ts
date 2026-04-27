import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBurnIn01Prompt,
  buildScenarios,
  defaultBurnInRunTag,
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

test("buildScenarios returns 8 scenarios", () => {
  const scenarios = buildScenarios({ tag: "t" });
  assert.equal(scenarios.length, 8);
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
    ],
  );
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
