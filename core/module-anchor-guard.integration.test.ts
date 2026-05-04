import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { Coordinator, NeedsClarificationError } from "./coordinator.js";
import { ReceiptStore } from "./receipt-store.js";
import { WorkerRegistry } from "../workers/base.js";
import type { TrustProfile } from "../router/trust-router.js";
import type { EventBus } from "../server/websocket.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aedis-anchor-guard-"));
  // Both top-level directories exist — the bug requires the named
  // anchor (magister/) to be a real directory while every discovered
  // target lives outside it (web/).
  mkdirSync(join(dir, "magister"), { recursive: true });
  mkdirSync(join(dir, "magister", "modes"), { recursive: true });
  mkdirSync(join(dir, "web", "app", "components"), { recursive: true });
  writeFileSync(
    join(dir, "magister", "router.ts"),
    "export const modes: string[] = [];\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "magister", "modes", "narrator.ts"),
    "export const narrator = { id: 'narrator' };\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "web", "app", "components", "MarkdownMessage.tsx"),
    "export const MarkdownMessage = () => null;\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "anchor-guard", version: "0.0.0" }),
    "utf-8",
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "g@g.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "G"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

function makeEventBus(): EventBus {
  return {
    emit: () => {},
    on: () => () => {},
    onType: () => () => {},
    addClient: () => {},
    removeClient: () => {},
    clientCount: () => 0,
    recentEvents: () => [],
  };
}

test("module-anchor guard: mode-registration task against repo with web/ + magister/ rejects a web/-only target before Builder dispatches", async () => {
  const projectRoot = makeRepo();
  try {
    const trustProfile: TrustProfile = {
      scores: new Map(),
      tierThresholds: { fast: 0, standard: 0, premium: 0 },
    };
    const receiptStore = new ReceiptStore(projectRoot);
    const coordinator = new Coordinator(
      { projectRoot, autoCommit: false, requireWorkspace: true },
      trustProfile,
      new WorkerRegistry(),
      makeEventBus(),
      receiptStore,
    );

    // Prompt names "Magister project" as the anchor and explicitly
    // points Builder at the wrong area (web/app/components). The
    // guard must reject this before any worker is dispatched. The
    // throw is the contract: task-loop.ts catches NeedsClarification-
    // Error and translates it to needs_replan + needs_clarification.
    let caught: unknown = null;
    try {
      await coordinator.submit({
        input:
          "Add the first atomic step for a new Teach Me Anything mode in Magister project " +
          "by editing web/app/components/MarkdownMessage.tsx",
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof NeedsClarificationError,
      `expected NeedsClarificationError; got ${caught instanceof Error ? caught.constructor.name + ": " + caught.message : String(caught)}`,
    );
    const err = caught as NeedsClarificationError;
    assert.match(
      err.message,
      /magister/i,
      `expected error message to name the magister anchor; got: ${err.message}`,
    );
    assert.match(
      err.recommendedAction,
      /anchor mismatch/i,
      `expected recommendedAction to flag the anchor mismatch; got: ${err.recommendedAction}`,
    );
    assert.ok(
      err.recommendedTargets.length > 0,
      "guard must surface candidate targets inside the magister/ anchor",
    );
    assert.ok(
      err.recommendedTargets.every((p) => p.toLowerCase().startsWith("magister/") || !p.includes("/")),
      `every recommended target must live under magister/ (or be a top-level file inside it); got: ${err.recommendedTargets.join(", ")}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("module-anchor guard: target inside the named anchor passes the guard (magister/router.ts is fine)", async () => {
  const projectRoot = makeRepo();
  try {
    const trustProfile: TrustProfile = {
      scores: new Map(),
      tierThresholds: { fast: 0, standard: 0, premium: 0 },
    };
    const receiptStore = new ReceiptStore(projectRoot);
    const coordinator = new Coordinator(
      { projectRoot, autoCommit: false, requireWorkspace: true },
      trustProfile,
      new WorkerRegistry(),
      makeEventBus(),
      receiptStore,
    );

    // Prompt anchors on Magister AND points at magister/router.ts —
    // the guard must NOT fire. The run will still fail downstream
    // (no workers registered), but it must fail past the guard, not
    // at the guard. We assert by checking the failure reason does
    // not mention an anchor mismatch.
    const receipt = await coordinator.submit({
      input:
        "Register a new Teach Me Anything mode in Magister project " +
        "by editing magister/router.ts",
    });

    const reason = (receipt as { failureReason?: string }).failureReason ?? "";
    const summary = receipt.humanSummary?.summary ?? "";
    const haystack = `${reason}\n${summary}`.toLowerCase();
    assert.ok(
      !haystack.includes("anchor mismatch") &&
        !haystack.includes("every discovered target is outside"),
      `guard must not fire when target is inside the anchor; got: ${haystack.slice(0, 240)}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
