#!/usr/bin/env node
/**
 * Failure-chain live smoke.
 *
 * Runs the fixture-backed coordinator/task-loop tests that exercise the
 * live execution pipeline with real workspaces and receipt persistence:
 * A) Builder no-op stops before Critic/Verifier
 * B) valid atomic Builder diff reaches approval (Magister fixture)
 * C) Critic timeout pauses/classifies without retrying the same model
 */
import { spawnSync } from "node:child_process";

const cases = [
  {
    file: "core/coordinator-multi-step.test.ts",
    pattern: "failure-chain|critic stage timeout",
  },
  {
    file: "core/magister-fixture.test.ts",
    pattern: "attaching a target via /attachTargetToSubtask resumes Builder dispatch",
  },
];

for (const c of cases) {
  const res = spawnSync(
    "npx",
    ["tsx", "--test", c.file, "--test-name-pattern", c.pattern],
    { stdio: "inherit", cwd: process.cwd(), env: process.env },
  );
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

console.log("[smoke-failure-chain-live] PASS");
