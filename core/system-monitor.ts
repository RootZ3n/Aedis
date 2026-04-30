/**
 * System Resource Monitor — lightweight memory/CPU tracking.
 *
 * Uses Node.js `os` APIs only (no heavy dependencies). Returns a
 * SystemSnapshot with memory usage, pressure level, and timestamp.
 *
 * Thresholds:
 *   ok       — ≤ 70% memory used
 *   warning  — > 70% and ≤ 85%
 *   critical — > 85%
 *
 * The monitor is designed for polling (every 2–3 seconds). It does
 * NOT start or manage a poll loop — that's the caller's job.
 *
 * Safety: read-only, no side effects, no file I/O, no network.
 */

import { totalmem, freemem, cpus } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────

export type PressureLevel = "ok" | "warning" | "critical";

export interface SystemSnapshot {
  readonly totalMem: number;
  readonly usedMem: number;
  readonly freeMem: number;
  readonly percentUsed: number;
  readonly heapUsedMb: number;
  readonly level: PressureLevel;
  readonly timestamp: string;
}

// ─── Thresholds ──────────────────────────────────────────────────────

const WARNING_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 85;

export function classifyPressure(percentUsed: number): PressureLevel {
  if (percentUsed > CRITICAL_THRESHOLD) return "critical";
  if (percentUsed > WARNING_THRESHOLD) return "warning";
  return "ok";
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Take a snapshot of current system resource usage.
 * Pure read — no side effects, no I/O.
 */
export function takeSnapshot(): SystemSnapshot {
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  const pct = total > 0 ? (used / total) * 100 : 0;
  const heap = process.memoryUsage().heapUsed;

  return {
    totalMem: total,
    usedMem: used,
    freeMem: free,
    percentUsed: Math.round(pct * 10) / 10,
    heapUsedMb: Math.round(heap / (1024 * 1024)),
    level: classifyPressure(pct),
    timestamp: new Date().toISOString(),
  };
}

// ─── Transition Detection ────────────────────────────────────────────

/**
 * Detect pressure level transitions. Returns the event type to emit,
 * or null if no transition occurred.
 */
export function detectTransition(
  previousLevel: PressureLevel | null,
  currentLevel: PressureLevel,
): "system_pressure_warning" | "system_pressure_critical" | "system_pressure_recovered" | "system_status" | null {
  if (previousLevel === null) {
    // First snapshot — emit status, not a transition
    return "system_status";
  }
  if (previousLevel === currentLevel) return null;

  if (currentLevel === "critical") return "system_pressure_critical";
  if (currentLevel === "warning" && previousLevel === "ok") return "system_pressure_warning";
  if (currentLevel === "warning" && previousLevel === "critical") return "system_pressure_recovered";
  if (currentLevel === "ok" && previousLevel !== "ok") return "system_pressure_recovered";

  return null;
}

/**
 * Build human-readable message for the current pressure level.
 */
export function pressureMessage(snapshot: SystemSnapshot): string {
  const usedGb = (snapshot.usedMem / (1024 ** 3)).toFixed(1);
  const totalGb = (snapshot.totalMem / (1024 ** 3)).toFixed(1);
  switch (snapshot.level) {
    case "ok":
      return `System memory: ${snapshot.percentUsed}% (${usedGb}/${totalGb} GB)`;
    case "warning":
      return `Memory pressure warning: ${snapshot.percentUsed}% used (${usedGb}/${totalGb} GB). Consider smaller tasks or freeing memory.`;
    case "critical":
      return `Memory pressure critical: ${snapshot.percentUsed}% used (${usedGb}/${totalGb} GB). Consider closing heavy processes before starting new tasks.`;
  }
}
