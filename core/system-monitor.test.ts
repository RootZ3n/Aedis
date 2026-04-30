import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  takeSnapshot,
  classifyPressure,
  detectTransition,
  pressureMessage,
  type PressureLevel,
  type SystemSnapshot,
} from "./system-monitor.js";

// ─── Snapshot calculation ────────────────────────────────────────────

describe("takeSnapshot", () => {
  it("returns a valid snapshot with all fields", () => {
    const snap = takeSnapshot();
    assert.ok(snap.totalMem > 0, "totalMem should be positive");
    assert.ok(snap.usedMem >= 0, "usedMem should be non-negative");
    assert.ok(snap.freeMem >= 0, "freeMem should be non-negative");
    assert.ok(snap.percentUsed >= 0 && snap.percentUsed <= 100, "percentUsed in range");
    assert.ok(snap.heapUsedMb >= 0, "heapUsedMb non-negative");
    assert.ok(["ok", "warning", "critical"].includes(snap.level));
    assert.ok(snap.timestamp.length > 0, "has timestamp");
    // usedMem + freeMem should roughly equal totalMem
    assert.ok(
      Math.abs((snap.usedMem + snap.freeMem) - snap.totalMem) < snap.totalMem * 0.01,
      "usedMem + freeMem ~ totalMem",
    );
  });

  it("does not crash if called multiple times rapidly", () => {
    for (let i = 0; i < 10; i++) {
      const snap = takeSnapshot();
      assert.ok(snap.totalMem > 0);
    }
  });
});

// ─── Threshold detection ─────────────────────────────────────────────

describe("classifyPressure", () => {
  it("≤70% → ok", () => {
    assert.equal(classifyPressure(0), "ok");
    assert.equal(classifyPressure(50), "ok");
    assert.equal(classifyPressure(70), "ok");
  });

  it(">70% and ≤85% → warning", () => {
    assert.equal(classifyPressure(71), "warning");
    assert.equal(classifyPressure(80), "warning");
    assert.equal(classifyPressure(85), "warning");
  });

  it(">85% → critical", () => {
    assert.equal(classifyPressure(86), "critical");
    assert.equal(classifyPressure(95), "critical");
    assert.equal(classifyPressure(100), "critical");
  });
});

// ─── Event emission only on transitions ──────────────────────────────

describe("detectTransition", () => {
  it("first snapshot emits system_status", () => {
    assert.equal(detectTransition(null, "ok"), "system_status");
    assert.equal(detectTransition(null, "warning"), "system_status");
    assert.equal(detectTransition(null, "critical"), "system_status");
  });

  it("same level → no event", () => {
    assert.equal(detectTransition("ok", "ok"), null);
    assert.equal(detectTransition("warning", "warning"), null);
    assert.equal(detectTransition("critical", "critical"), null);
  });

  it("ok → warning → system_pressure_warning", () => {
    assert.equal(detectTransition("ok", "warning"), "system_pressure_warning");
  });

  it("ok → critical → system_pressure_critical", () => {
    assert.equal(detectTransition("ok", "critical"), "system_pressure_critical");
  });

  it("warning → critical → system_pressure_critical", () => {
    assert.equal(detectTransition("warning", "critical"), "system_pressure_critical");
  });

  it("critical → warning → system_pressure_recovered", () => {
    assert.equal(detectTransition("critical", "warning"), "system_pressure_recovered");
  });

  it("critical → ok → system_pressure_recovered", () => {
    assert.equal(detectTransition("critical", "ok"), "system_pressure_recovered");
  });

  it("warning → ok → system_pressure_recovered", () => {
    assert.equal(detectTransition("warning", "ok"), "system_pressure_recovered");
  });
});

// ─── Pressure messages ───────────────────────────────────────────────

describe("pressureMessage", () => {
  function mockSnap(level: PressureLevel, pct: number): SystemSnapshot {
    return {
      totalMem: 16 * 1024 ** 3, usedMem: pct / 100 * 16 * 1024 ** 3,
      freeMem: (100 - pct) / 100 * 16 * 1024 ** 3, percentUsed: pct,
      heapUsedMb: 100, level, timestamp: new Date().toISOString(),
    };
  }

  it("ok message includes percentage", () => {
    const msg = pressureMessage(mockSnap("ok", 50));
    assert.ok(msg.includes("50%"));
    assert.ok(msg.includes("System memory"));
  });

  it("warning message suggests action", () => {
    const msg = pressureMessage(mockSnap("warning", 75));
    assert.ok(msg.includes("warning"));
    assert.ok(msg.includes("75%"));
  });

  it("critical message suggests closing processes", () => {
    const msg = pressureMessage(mockSnap("critical", 90));
    assert.ok(msg.includes("critical"));
    assert.ok(msg.includes("90%"));
  });
});

// ─── Scout spawn blocked under critical ──────────────────────────────

describe("scout spawn under memory pressure", () => {
  it("critical pressure blocks scouts", async () => {
    const { shouldSpawnScouts } = await import("./scout-spawn.js");
    const result = shouldSpawnScouts({
      prompt: "find all auth files and audit them across the codebase",
      knownTargetFiles: [],
      systemPressureLevel: "critical",
    });
    assert.equal(result.spawn, false);
    assert.ok(result.reason.includes("memory pressure"));
  });

  it("warning pressure allows scouts", async () => {
    const { shouldSpawnScouts } = await import("./scout-spawn.js");
    const result = shouldSpawnScouts({
      prompt: "find all auth files and audit them across the codebase",
      knownTargetFiles: [],
      systemPressureLevel: "warning",
    });
    // warning allows scouts (only critical blocks)
    assert.equal(result.spawn, true);
  });

  it("ok pressure allows scouts normally", async () => {
    const { shouldSpawnScouts } = await import("./scout-spawn.js");
    const result = shouldSpawnScouts({
      prompt: "find all auth files and audit them across the codebase",
      knownTargetFiles: [],
      systemPressureLevel: "ok",
    });
    assert.equal(result.spawn, true);
  });

  it("no pressure level provided allows scouts", async () => {
    const { shouldSpawnScouts } = await import("./scout-spawn.js");
    const result = shouldSpawnScouts({
      prompt: "find all auth files and audit them across the codebase",
      knownTargetFiles: [],
    });
    assert.equal(result.spawn, true);
  });
});

// ─── No crash if system APIs fail ────────────────────────────────────

describe("system monitor resilience", () => {
  it("classifyPressure handles edge values", () => {
    assert.equal(classifyPressure(NaN), "ok"); // NaN > 85 is false
    assert.equal(classifyPressure(-1), "ok");
    assert.equal(classifyPressure(200), "critical");
  });

  it("detectTransition handles all combinations without crash", () => {
    const levels: PressureLevel[] = ["ok", "warning", "critical"];
    for (const prev of [null, ...levels]) {
      for (const curr of levels) {
        // Should never throw
        const result = detectTransition(prev, curr);
        assert.ok(result === null || typeof result === "string");
      }
    }
  });
});

// ─── Timeline integration ────────────────────────────────────────────

describe("timeline entries for system events", () => {
  it("system_pressure_warning creates timeline entry", async () => {
    const { eventToTimelineEntry } = await import("./timeline.js");
    const e = eventToTimelineEntry("system_pressure_warning", {
      message: "Memory pressure warning: 75% used",
    });
    assert.ok(e);
    assert.equal(e.status, "warning");
    assert.equal(e.phase, "safety");
    assert.equal(e.importance, "high");
    assert.ok(e.message.includes("75%"));
  });

  it("system_pressure_critical creates timeline entry", async () => {
    const { eventToTimelineEntry } = await import("./timeline.js");
    const e = eventToTimelineEntry("system_pressure_critical", {
      message: "Memory pressure critical: 92% used",
    });
    assert.ok(e);
    assert.equal(e.status, "error");
    assert.equal(e.importance, "high");
  });

  it("system_pressure_recovered creates timeline entry", async () => {
    const { eventToTimelineEntry } = await import("./timeline.js");
    const e = eventToTimelineEntry("system_pressure_recovered", {
      message: "System recovered: 60% used",
    });
    assert.ok(e);
    assert.equal(e.status, "success");
  });
});
