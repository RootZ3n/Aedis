import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator } from "./coordinator.js";
import { ReceiptStore } from "./receipt-store.js";
import { WorkerRegistry } from "../workers/base.js";
import type { TrustProfile } from "../router/trust-router.js";
import type { EventBus } from "../server/websocket.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-brief-fallback-"));
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "core", "util.ts"), "export const x = 1;\n", "utf-8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "brief-fallback", version: "0.0.0" }), "utf-8");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "g@g.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "G"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("Coordinator persists a minimal implementation brief when planning throws before Builder dispatch", async () => {
  const projectRoot = makeRepo();
  try {
    const trustProfile: TrustProfile = {
      scores: new Map(),
      tierThresholds: { fast: 0, standard: 0, premium: 0 },
    };
    const eventBus: EventBus = {
      emit: () => {},
      on: () => () => {},
      onType: () => () => {},
      addClient: () => {},
      removeClient: () => {},
      clientCount: () => 0,
      recentEvents: () => [],
    };
    const receiptStore = new ReceiptStore(projectRoot);
    const coordinator = new Coordinator(
      { projectRoot, autoCommit: false, requireWorkspace: true },
      trustProfile,
      new WorkerRegistry(),
      eventBus,
      receiptStore,
    );

    (coordinator as any).buildTaskGraph = () => {
      throw new Error("forced planner failure");
    };

    const receipt = await coordinator.submit({ input: "modify core/util.ts to export x = 2" });
    assert.equal(receipt.verdict, "failed");

    const persisted = await receiptStore.getRun(receipt.runId);
    const brief = persisted?.implementationBrief as Record<string, unknown> | null;
    assert.ok(brief, "fallback brief must be persisted on failure");
    assert.match(String(brief.fallbackPlan), /forced planner failure/);
    assert.ok(
      (brief.openQuestions as string[]).some((line) => /forced planner failure/.test(line)),
      `expected openQuestions to include the planner error; got ${JSON.stringify(brief.openQuestions)}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
