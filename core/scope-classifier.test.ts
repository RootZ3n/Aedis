import test from "node:test";
import assert from "node:assert/strict";

import { classifyScope, isBugfixLikePrompt } from "./scope-classifier.js";

test("scope classifier: improve provider error handling is not bugfix-like", () => {
  assert.equal(isBugfixLikePrompt("improve provider error handling across providers"), false);
});

test("scope classifier: cross-module 3-file refactor escalates beyond small-linked", () => {
  const scope = classifyScope(
    "refactor auth wiring across server/auth.ts workers/session.ts router/index.ts",
    ["server/auth.ts", "workers/session.ts", "router/index.ts"],
  );

  assert.notEqual(scope.type, "small-linked");
  assert.equal(scope.recommendDecompose, true);
  assert.equal(scope.governance.wavesRequired, true);
});

test("scope classifier: broad provider error-handling task with few files still plans as multi-file", () => {
  const scope = classifyScope(
    "improve provider error handling across providers and shared call paths",
    ["router/provider.ts", "workers/builder.ts"],
  );

  assert.equal(scope.type, "multi-file");
  assert.equal(scope.recommendDecompose, true);
  assert.equal(scope.governance.decompositionRequired, true);
});

test("scope classifier: explicit broad cross-module refactor with 4 files becomes architectural", () => {
  const scope = classifyScope(
    "standardize provider error handling across router, builder, critic, and verifier",
    ["router/provider.ts", "workers/builder.ts", "workers/critic.ts", "workers/verifier.ts"],
  );

  assert.equal(scope.type, "architectural");
  assert.equal(scope.governance.escalationRecommended, true);
});
