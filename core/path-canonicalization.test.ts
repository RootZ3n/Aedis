import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CharterGenerator } from "./charter.js";
import { classifyScope } from "./scope-classifier.js";
import { createChangeSet } from "./change-set.js";
import { createIntent } from "./intent.js";
import { Coordinator } from "./coordinator.js";
import { normalizePrompt } from "./prompt-normalizer.js";

// These tests lock in the fix for "Scope drift" false-positives that blocked
// every build against a source repo with an absolute path in the prompt
// (e.g. "edit /mnt/ai/squidley-v2/apps/api/src/routes/index.ts"). The
// Coordinator's prepareDeliverablesForGraph canonicalizes those paths to
// worktree-relative before they reach workers, and the Critic defensively
// accepts both shapes.

test("CharterGenerator extracts absolute paths verbatim (pre-canonicalization)", () => {
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(
    "Add a comment at the top of /mnt/ai/squidley-v2/apps/api/src/routes/index.ts",
  );
  // Sanity: the regex captures the absolute path as-is. Canonicalization
  // must happen downstream in the Coordinator.
  assert.ok(
    analysis.targets.includes("/mnt/ai/squidley-v2/apps/api/src/routes/index.ts"),
    `expected absolute target, got ${JSON.stringify(analysis.targets)}`,
  );
});

test("createChangeSet deduplicates absolute + relative forms of the same file", () => {
  const gen = new CharterGenerator();
  const analysis = gen.analyzeRequest(
    "edit apps/api/src/routes/index.ts and /mnt/ai/squidley-v2/apps/api/src/routes/index.ts",
  );
  const charter = gen.generateCharter(analysis);
  const intent = createIntent({
    runId: "test-run",
    userRequest: analysis.raw,
    charter,
    constraints: [],
  });
  const files = charter.deliverables.flatMap((d) => [...d.targetFiles]);
  const cs = createChangeSet(intent, files, undefined, "/mnt/ai/squidley-v2");
  const paths = cs.filesInScope.map((f) => f.path);
  assert.equal(
    paths.length,
    1,
    `expected 1 file after dedup, got ${paths.length}: ${paths.join(", ")}`,
  );
  assert.equal(paths[0], "apps/api/src/routes/index.ts");
});

test("scope classifier: absolute path → single-file (not multi-file)", () => {
  const sc = classifyScope(
    "Add a comment at the top of /mnt/ai/squidley-v2/apps/api/src/routes/index.ts",
    ["/mnt/ai/squidley-v2/apps/api/src/routes/index.ts"],
  );
  assert.equal(sc.type, "single-file", `expected single-file got ${sc.type}: ${sc.reason}`);
});

test("submitWithGates: no extractable target → needs_clarification (not coherence crash)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-extract-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }), "utf-8");
  try {
    const CoordinatorAny = Coordinator as any;
    const coord = new CoordinatorAny({ projectRoot: dir });
    const result = await coord.submitWithGates({
      input: "test to Aedis using test-aedis fixture at /tmp/test-aedis",
      projectRoot: dir,
    } as any);
    assert.equal(result.kind, "needs_clarification",
      `expected needs_clarification, got ${result.kind}`);
    if (result.kind === "needs_clarification") {
      assert.match(result.question, /file/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("submitWithGates: missing emitter path → needs_clarification instead of running into NO_OP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aedis-missing-target-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }), "utf-8");
  try {
    const CoordinatorAny = Coordinator as any;
    const coord = new CoordinatorAny({ projectRoot: dir });
    const result = await coord.submitWithGates({
      input: "Run Jest tests for /mnt/ai/squidley-v2/core/events/emitters/emitter.ts. Report pass/fail and any error output.",
      projectRoot: dir,
    } as any);
    assert.equal(result.kind, "needs_clarification",
      `expected needs_clarification, got ${result.kind}`);
    if (result.kind === "needs_clarification") {
      assert.match(result.question, /does not exist|check the path|correct file/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizePrompt: absolute-path prompt is preserved verbatim even when the path is wrong", async () => {
  const raw = "Run Jest tests for /mnt/ai/squidley-v2/core/events/emitters/emitter.ts. Report pass/fail and any error output.";
  const out = await normalizePrompt(
    raw,
    {
      relevantFiles: ["core/contracts/default-contracts.ts"],
      recentTaskSummaries: [],
      language: "typescript",
    },
    "/mnt/ai/squidley-v2",
  );
  assert.equal(out, raw);
});
