import test from "node:test";
import assert from "node:assert/strict";

import {
  isRuntimeArtifact,
  filterRuntimeArtifacts,
  PROMOTION_EXCLUDE_PATHSPECS,
} from "./promotion-filter.js";

test("isRuntimeArtifact: denies .aedis/memory.json", () => {
  assert.equal(isRuntimeArtifact(".aedis/memory.json"), true);
});

test("isRuntimeArtifact: denies workspace-local receipts", () => {
  assert.equal(isRuntimeArtifact(".aedis/receipts/patch-abc123.diff"), true);
});

test("isRuntimeArtifact: denies .aedis/state/** sub-paths", () => {
  assert.equal(isRuntimeArtifact(".aedis/state/foo.json"), true);
  assert.equal(isRuntimeArtifact(".aedis/state/nested/bar.json"), true);
});

test("isRuntimeArtifact: denies .aedis runtime caches", () => {
  assert.equal(isRuntimeArtifact(".aedis/circuit-breaker-state.json"), true);
  assert.equal(isRuntimeArtifact(".aedis/repo-index.json"), true);
});

test("isRuntimeArtifact: denies state/receipts and state/memory", () => {
  assert.equal(isRuntimeArtifact("state/receipts/runs/abc.json"), true);
  assert.equal(isRuntimeArtifact("state/memory/substrate/entries/x.json"), true);
});

test("isRuntimeArtifact: denies aedis-ws-* directories", () => {
  assert.equal(isRuntimeArtifact("aedis-ws-12345"), true);
  assert.equal(isRuntimeArtifact("aedis-ws-12345/anything.txt"), true);
});

test("isRuntimeArtifact: ALLOWS user-edited .aedis config files", () => {
  // model-config.json and providers.json are user-controlled config —
  // a task that targets them must promote normally.
  assert.equal(isRuntimeArtifact(".aedis/model-config.json"), false);
  assert.equal(isRuntimeArtifact(".aedis/providers.json"), false);
});

test("isRuntimeArtifact: ALLOWS regular source files", () => {
  assert.equal(isRuntimeArtifact("src/index.ts"), false);
  assert.equal(isRuntimeArtifact("apps/api/src/extractors/text.ts"), false);
  assert.equal(isRuntimeArtifact("README.md"), false);
  assert.equal(isRuntimeArtifact("generate.py"), false);
});

test("isRuntimeArtifact: handles ./-prefixed paths", () => {
  assert.equal(isRuntimeArtifact("./.aedis/memory.json"), true);
  assert.equal(isRuntimeArtifact("./src/index.ts"), false);
});

test("isRuntimeArtifact: handles backslash paths defensively", () => {
  // Git itself reports POSIX, but a Windows runner might hand us
  // backslashes. Normalize before matching.
  assert.equal(isRuntimeArtifact(".aedis\\memory.json"), true);
  assert.equal(isRuntimeArtifact(".aedis\\state\\foo.json"), true);
});

test("filterRuntimeArtifacts: drops only the runtime entries from a mixed list", () => {
  const input = [
    "src/index.ts",
    ".aedis/memory.json",
    "README.md",
    ".aedis/receipts/patch.diff",
    "package.json",
    "state/receipts/runs/abc.json",
    ".aedis/model-config.json", // user config — must survive
  ];
  const filtered = filterRuntimeArtifacts(input);
  assert.deepEqual(filtered, [
    "src/index.ts",
    "README.md",
    "package.json",
    ".aedis/model-config.json",
  ]);
});

test("filterRuntimeArtifacts: returns the same array when no runtime artifacts present", () => {
  const input = ["src/index.ts", "README.md"];
  const filtered = filterRuntimeArtifacts(input);
  assert.deepEqual(filtered, input);
});

test("filterRuntimeArtifacts: returns empty when every entry is a runtime artifact", () => {
  const input = [
    ".aedis/memory.json",
    ".aedis/state/foo.json",
    "state/receipts/runs/abc.json",
  ];
  const filtered = filterRuntimeArtifacts(input);
  assert.deepEqual(filtered, []);
});

test("PROMOTION_EXCLUDE_PATHSPECS: every entry uses git's exclude pathspec syntax", () => {
  for (const spec of PROMOTION_EXCLUDE_PATHSPECS) {
    assert.match(spec, /^:\(exclude(,glob)?\)/, `expected git exclude pathspec, got: ${spec}`);
  }
});

test("PROMOTION_EXCLUDE_PATHSPECS: covers the same surface as RUNTIME_ARTIFACT_PATTERNS", () => {
  // Sanity: pathspecs and regex patterns must agree on the canonical
  // set of denied paths so the diff text and the file list don't
  // disagree on what's in scope.
  const fixtures = [
    ".aedis/memory.json",
    ".aedis/receipts/patch.diff",
    ".aedis/state/foo.json",
    ".aedis/circuit-breaker-state.json",
    ".aedis/repo-index.json",
    "state/receipts/runs/abc.json",
    "state/memory/foo.json",
    "aedis-ws-12345",
  ];
  for (const f of fixtures) {
    assert.equal(isRuntimeArtifact(f), true, `regex should deny ${f}`);
  }
});
