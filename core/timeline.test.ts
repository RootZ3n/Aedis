import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  eventToTimelineEntry,
  reconstructTimeline,
  filterTimeline,
  type TimelineEntry,
} from "./timeline.js";

// ─── Key events appear in timeline ───────────────────────────────────

describe("eventToTimelineEntry — key events", () => {
  it("run_started produces intent entry", () => {
    const e = eventToTimelineEntry("run_started", { runId: "r-123", input: "add auth" });
    assert.ok(e);
    assert.equal(e.phase, "intent");
    assert.equal(e.status, "active");
    assert.equal(e.importance, "high");
    assert.ok(e.message.includes("Run started"));
  });

  it("charter_generated produces planning entry", () => {
    const e = eventToTimelineEntry("charter_generated", {
      charter: { objective: "Add authentication" },
    });
    assert.ok(e);
    assert.equal(e.phase, "planning");
    assert.ok(e.message.includes("Charter"));
    assert.ok(e.message.includes("Add authentication"));
  });

  it("preflight_scouts_started produces scout entry", () => {
    const e = eventToTimelineEntry("preflight_scouts_started", {
      message: "Running read-only scout checks...",
    });
    assert.ok(e);
    assert.equal(e.phase, "scout");
    assert.equal(e.status, "active");
    assert.ok(e.details.includes("read-only"));
  });

  it("preflight_scouts_complete produces scout entry with counts", () => {
    const e = eventToTimelineEntry("preflight_scouts_complete", {
      message: "Scouts found 3 target(s) and 1 risk(s)",
      recommendedTargetCount: 3,
      riskCount: 1,
      reason: "low confidence targets",
    });
    assert.ok(e);
    assert.equal(e.phase, "scout");
    assert.equal(e.status, "success");
    assert.ok(e.message.includes("3 target"));
  });

  it("preflight_scouts_skipped produces low-importance scout entry", () => {
    const e = eventToTimelineEntry("preflight_scouts_skipped", {
      message: "Scouts not needed",
    });
    assert.ok(e);
    assert.equal(e.phase, "scout");
    assert.equal(e.importance, "low");
  });

  it("blast_radius_estimated produces discovery entry", () => {
    const e = eventToTimelineEntry("blast_radius_estimated", {
      level: "medium",
      rationale: "3 files affected",
    });
    assert.ok(e);
    assert.equal(e.phase, "discovery");
    assert.ok(e.message.includes("medium"));
  });

  it("worker_assigned produces worker entry", () => {
    const e = eventToTimelineEntry("worker_assigned", {
      workerType: "builder",
    });
    assert.ok(e);
    assert.equal(e.phase, "building");
    assert.equal(e.status, "active");
    assert.ok(e.message.includes("Builder"));
  });

  it("builder_complete produces building entry", () => {
    const e = eventToTimelineEntry("builder_complete", { confidence: 0.85 });
    assert.ok(e);
    assert.equal(e.phase, "building");
    assert.equal(e.status, "success");
    assert.ok(e.message.includes("85%"));
  });

  it("verifier_check produces verifying entry", () => {
    const e = eventToTimelineEntry("verifier_check", { confidence: 0.9 });
    assert.ok(e);
    assert.equal(e.phase, "verifying");
  });

  it("execution_verified produces high-importance success", () => {
    const e = eventToTimelineEntry("execution_verified", {
      reason: "files modified on disk",
    });
    assert.ok(e);
    assert.equal(e.status, "success");
    assert.equal(e.importance, "high");
    assert.ok(e.message.includes("verified"));
  });

  it("execution_failed produces high-importance error", () => {
    const e = eventToTimelineEntry("execution_failed", {
      reason: "no real output produced",
    });
    assert.ok(e);
    assert.equal(e.status, "error");
    assert.equal(e.importance, "high");
  });

  it("commit_created produces promotion entry", () => {
    const e = eventToTimelineEntry("commit_created", { sha: "abc12345" });
    assert.ok(e);
    assert.equal(e.phase, "promotion");
    assert.equal(e.status, "success");
    assert.ok(e.message.includes("abc12345"));
  });

  it("run_summary produces summary entry", () => {
    const e = eventToTimelineEntry("run_summary", {
      classification: "VERIFIED_SUCCESS",
      headline: "Build completed successfully",
      narrative: "All tests passed",
    });
    assert.ok(e);
    assert.equal(e.phase, "summary");
    assert.equal(e.status, "success");
    assert.ok(e.details.includes("All tests passed"));
  });

  it("merge_blocked produces safety error", () => {
    const e = eventToTimelineEntry("merge_blocked", {
      blockers: ["scope violation detected"],
    });
    assert.ok(e);
    assert.equal(e.phase, "safety");
    assert.equal(e.status, "error");
    assert.equal(e.importance, "high");
  });
});

// ─── Repair diagnosis event ──────────────────────────────────────────

describe("eventToTimelineEntry — repair events", () => {
  it("recovery_attempted appears after failure", () => {
    const e = eventToTimelineEntry("recovery_attempted", {
      strategy: "retry_clearer_contract",
      reason: "weak output detected",
    });
    assert.ok(e);
    assert.equal(e.phase, "repair");
    assert.equal(e.status, "warning");
    assert.equal(e.importance, "high");
    assert.ok(e.message.includes("Recovery"));
  });

  it("escalation_triggered produces repair entry", () => {
    const e = eventToTimelineEntry("escalation_triggered", {
      toModel: "claude-sonnet-4-6",
      reason: "low builder confidence",
    });
    assert.ok(e);
    assert.equal(e.phase, "repair");
    assert.ok(e.message.includes("claude-sonnet-4-6"));
  });

  it("task_failed with worker info produces error entry", () => {
    const e = eventToTimelineEntry("task_failed", {
      workerType: "builder",
      error: "verification failure: 3 tests failed",
    });
    assert.ok(e);
    assert.equal(e.status, "error");
    assert.equal(e.importance, "high");
    assert.ok(e.message.includes("Builder"));
    assert.ok(e.message.includes("verification failure"));
  });
});

// ─── Approval pause event ────────────────────────────────────────────

describe("eventToTimelineEntry — approval", () => {
  it("task_plan_event with pause produces approval entry", () => {
    const e = eventToTimelineEntry("task_plan_event", {
      kind: "plan_paused",
      message: "Plan paused: approval required for run r-456",
    });
    assert.ok(e);
    assert.equal(e.phase, "approval");
    assert.equal(e.status, "warning");
    assert.equal(e.importance, "high");
    assert.ok(e.message.includes("approval"));
  });

  it("task_plan_event with blocked produces approval entry", () => {
    const e = eventToTimelineEntry("task_plan_event", {
      kind: "subtask_blocked",
      message: "Subtask blocked: awaiting human review",
    });
    assert.ok(e);
    assert.equal(e.phase, "approval");
    assert.equal(e.status, "warning");
  });
});

// ─── No secrets ──────────────────────────────────────────────────────

describe("eventToTimelineEntry — no secrets", () => {
  it("run_started redacts secrets from input text", () => {
    const e = eventToTimelineEntry("run_started", {
      input: "fix auth with api_key=sk_live_abc123xyz and password=hunter2",
    });
    assert.ok(e);
    // The details field (where input is placed) should redact secrets
    assert.ok(!e.details.includes("sk_live_abc123xyz"));
    assert.ok(!e.details.includes("hunter2"));
    assert.ok(e.details.includes("[REDACTED]"));
  });

  it("long base64-like tokens are redacted", () => {
    const longToken = "A".repeat(50);
    const e = eventToTimelineEntry("run_started", {
      input: `set token=${longToken}`,
    });
    assert.ok(e);
    assert.ok(!e.details.includes(longToken));
  });
});

// ─── Timeline survives reload ────────────────────────────────────────

describe("reconstructTimeline — reload from persisted data", () => {
  it("reconstructs timeline from workerEvents + summary", () => {
    const entries = reconstructTimeline({
      submittedAt: "2026-04-29T10:00:00.000Z",
      workerEvents: [
        { workerType: "scout", status: "completed", summary: "context gathered" },
        { workerType: "builder", status: "completed", summary: "changes produced" },
        { workerType: "verifier", status: "completed", summary: "all tests pass" },
      ],
      summary: {
        classification: "VERIFIED_SUCCESS",
        headline: "Build completed successfully",
        narrative: "All 5 tests passed",
      },
      completedAt: "2026-04-29T10:01:00.000Z",
    });

    assert.ok(entries.length >= 4); // run_started + 3 workers + summary
    assert.equal(entries[0].phase, "intent");
    assert.ok(entries.some((e) => e.phase === "summary"));
    assert.ok(entries.some((e) => e.message.includes("Scout")));
  });

  it("reconstructs scout evidence from receipt", () => {
    const entries = reconstructTimeline({
      receipt: { preflightScoutReportIds: ["scout-1", "scout-2"] },
    });
    assert.ok(entries.some((e) => e.phase === "scout"));
    assert.ok(entries.some((e) => e.message.includes("2 report")));
  });

  it("handles empty run data gracefully", () => {
    const entries = reconstructTimeline({});
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 0);
  });
});

// ─── Filtering ───────────────────────────────────────────────────────

describe("filterTimeline", () => {
  const sample: TimelineEntry[] = [
    { id: "1", timestamp: "", status: "info", phase: "planning", message: "a", details: "", importance: "low", eventType: "x" },
    { id: "2", timestamp: "", status: "success", phase: "building", message: "b", details: "", importance: "high", eventType: "y" },
    { id: "3", timestamp: "", status: "error", phase: "verifying", message: "c", details: "", importance: "high", eventType: "z" },
    { id: "4", timestamp: "", status: "warning", phase: "repair", message: "d", details: "", importance: "normal", eventType: "w" },
  ];

  it("all filter returns everything", () => {
    assert.equal(filterTimeline(sample, "all").length, 4);
  });

  it("important filter returns only high-importance entries", () => {
    const result = filterTimeline(sample, "important");
    assert.equal(result.length, 2);
    assert.ok(result.every((e) => e.importance === "high"));
  });

  it("errors filter returns only error/warning entries", () => {
    const result = filterTimeline(sample, "errors");
    assert.equal(result.length, 2);
    assert.ok(result.every((e) => e.status === "error" || e.status === "warning"));
  });
});

// ─── Unknown events return null ──────────────────────────────────────

describe("eventToTimelineEntry — unknown events", () => {
  it("unknown event type returns null", () => {
    const e = eventToTimelineEntry("some_internal_event", {});
    assert.equal(e, null);
  });

  it("system_event returns null", () => {
    const e = eventToTimelineEntry("system_event", {});
    assert.equal(e, null);
  });
});
