/**
 * Timeline — structured, human-readable action feed for Aedis runs.
 *
 * Converts raw AedisEvent payloads into typed TimelineEntry objects
 * suitable for rendering in a filterable action timeline. Pure functions,
 * no side effects, no secrets in output text.
 *
 * Every entry has:
 *   - timestamp (ISO)
 *   - status (info / success / warning / error / active)
 *   - phase (which pipeline stage)
 *   - message (human-readable, one line)
 *   - details (optional longer text for expand/tooltip)
 *   - importance (high / normal / low) for filtering
 *
 * Design: does NOT change execution behavior. Read-only view layer.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type TimelineStatus = "info" | "success" | "warning" | "error" | "active";
export type TimelineImportance = "high" | "normal" | "low";

export type TimelinePhase =
  | "intent"
  | "safety"
  | "discovery"
  | "scout"
  | "planning"
  | "building"
  | "reviewing"
  | "verifying"
  | "integrating"
  | "approval"
  | "promotion"
  | "repair"
  | "summary";

export interface TimelineEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly status: TimelineStatus;
  readonly phase: TimelinePhase;
  readonly message: string;
  readonly details: string;
  readonly importance: TimelineImportance;
  /** Original event type for audit. */
  readonly eventType: string;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Convert a raw WS event into a TimelineEntry, or null if the event
 * type is not timeline-worthy (e.g. internal system events).
 */
export function eventToTimelineEntry(
  eventType: string,
  payload: Record<string, unknown>,
  timestamp?: string,
): TimelineEntry | null {
  const ts = timestamp || new Date().toISOString();
  const id = `tl-${eventType}-${ts}-${Math.random().toString(36).slice(2, 6)}`;

  switch (eventType) {
    // ── Intent / Routing ───────────────────────────────────────
    case "run_started":
      return entry(id, ts, "active", "intent", "high",
        `Run started${payload.runId ? ` (${trunc(String(payload.runId), 12)})` : ""}`,
        redactInput(String(payload.input || "")),
        eventType);

    case "charter_generated":
      return entry(id, ts, "info", "planning", "normal",
        `Charter generated — ${trunc(objectiveFrom(payload), 60)}`,
        "",
        eventType);

    case "intent_locked":
      return entry(id, ts, "info", "planning", "low",
        "Intent locked",
        "",
        eventType);

    // ── Safety ─────────────────────────────────────────────────
    case "merge_blocked":
      return entry(id, ts, "error", "safety", "high",
        `Merge blocked: ${trunc(String(arrayFirst(payload.blockers) || "critical findings"), 80)}`,
        "",
        eventType);

    case "merge_approved":
      return entry(id, ts, "success", "safety", "high",
        "Merge approved — changes passed all safety gates",
        "",
        eventType);

    case "adversarial_escalation":
      return entry(id, ts, "warning", "safety", "high",
        `Adversarial content detected — escalation triggered`,
        "",
        eventType);

    // ── Preflight Scouts ───────────────────────────────────────
    case "preflight_scouts_started":
      return entry(id, ts, "active", "scout", "normal",
        String(payload.message || "Running read-only scout checks..."),
        "Scouts are read-only and cannot edit your repo.",
        eventType);

    case "preflight_scouts_complete": {
      const tCount = Number(payload.recommendedTargetCount || 0);
      const rCount = Number(payload.riskCount || 0);
      return entry(id, ts, tCount > 0 || rCount > 0 ? "success" : "info", "scout", "normal",
        String(payload.message || `Scouts: ${tCount} target(s), ${rCount} risk(s)`),
        payload.reason ? String(payload.reason) : "",
        eventType);
    }

    case "preflight_scouts_skipped":
      return entry(id, ts, "info", "scout", "low",
        String(payload.message || "Scouts not needed"),
        "",
        eventType);

    // ── Discovery ──────────────────────────────────────────────
    case "blast_radius_estimated": {
      const level = String(payload.level || "unknown");
      const status: TimelineStatus = level === "high" || level === "critical" ? "warning"
        : level === "medium" ? "info" : "success";
      return entry(id, ts, status, "discovery", "normal",
        `Blast radius: ${level} — ${trunc(String(payload.rationale || ""), 60)}`,
        "",
        eventType);
    }

    case "task_graph_built":
      return entry(id, ts, "info", "planning", "low",
        `Task graph: ${payload.nodeCount || "?"} node(s)`,
        "",
        eventType);

    case "coherence_check_passed":
      return entry(id, ts, "success", "planning", "low",
        "Pre-build coherence check passed",
        "",
        eventType);

    case "coherence_check_failed":
      return entry(id, ts, "error", "planning", "high",
        "Pre-build coherence check failed",
        "",
        eventType);

    // ── Workers ────────────────────────────────────────────────
    case "worker_assigned": {
      const wt = String(payload.workerType || payload.worker_type || "unknown");
      return entry(id, ts, "active", phaseForWorker(wt), "normal",
        `${capitalize(wt)} assigned`,
        "",
        eventType);
    }

    case "task_started":
    case "worker_started": {
      const wt = String(payload.workerType || payload.worker_type || "");
      if (!wt) return null;
      return entry(id, ts, "active", phaseForWorker(wt), "normal",
        `${capitalize(wt)} started`,
        "",
        eventType);
    }

    case "scout_complete": {
      const conf = formatConf(payload.confidence ?? (payload.result as Record<string, unknown> | undefined)?.confidence);
      return entry(id, ts, "success", "discovery", "normal",
        `Scout complete — confidence ${conf}`,
        "",
        eventType);
    }

    case "builder_complete": {
      const conf = formatConf(payload.confidence ?? (payload.result as Record<string, unknown> | undefined)?.confidence);
      return entry(id, ts, "success", "building", "high",
        `Builder complete — confidence ${conf}`,
        "",
        eventType);
    }

    case "critic_review": {
      const conf = formatConf(payload.confidence ?? (payload.result as Record<string, unknown> | undefined)?.confidence);
      return entry(id, ts, "info", "reviewing", "normal",
        `Critic review — confidence ${conf}`,
        "",
        eventType);
    }

    case "verifier_check": {
      const conf = formatConf(payload.confidence ?? (payload.result as Record<string, unknown> | undefined)?.confidence);
      return entry(id, ts, "info", "verifying", "normal",
        `Verifier check — confidence ${conf}`,
        "",
        eventType);
    }

    case "integration_check":
      return entry(id, ts, "info", "integrating", "normal",
        "Integration check",
        "",
        eventType);

    // ── Task outcome ───────────────────────────────────────────
    case "task_complete":
      return entry(id, ts, "success", "integrating", "high",
        "Task completed successfully",
        "",
        eventType);

    case "task_failed": {
      const err = String(payload.error || payload.message || "unknown error");
      const wt = String(payload.workerType || payload.worker_type || "task");
      return entry(id, ts, "error", phaseForWorker(wt), "high",
        `${capitalize(wt)} failed — ${trunc(err, 80)}`,
        "",
        eventType);
    }

    // ── Execution gate ─────────────────────────────────────────
    case "execution_verified":
      return entry(id, ts, "success", "verifying", "high",
        `Execution verified${payload.reason ? " — " + trunc(String(payload.reason), 80) : ""}`,
        "",
        eventType);

    case "execution_failed":
      return entry(id, ts, "error", "verifying", "high",
        `Execution failed — ${trunc(String(payload.reason || payload.errorMessage || "no real output"), 80)}`,
        "",
        eventType);

    // ── Commit / Promotion ─────────────────────────────────────
    case "commit_created": {
      const sha = String(payload.sha || payload.commitSha || "").slice(0, 8);
      return entry(id, ts, "success", "promotion", "high",
        `Committed ${sha || "(unknown)"}`,
        "",
        eventType);
    }

    // ── Run lifecycle ──────────────────────────────────────────
    case "run_cancelled":
      return entry(id, ts, "warning", "summary", "high",
        "Run cancelled",
        "",
        eventType);

    case "run_complete":
      return entry(id, ts, "info", "summary", "high",
        `Run complete — verdict: ${String(payload.verdict || payload.status || "unknown")}`,
        "",
        eventType);

    case "run_summary": {
      const cls = String(payload.classification || "");
      const headline = String(payload.headline || "");
      const status: TimelineStatus = cls.includes("SUCCESS") ? "success"
        : cls.includes("FAIL") || cls.includes("ERROR") ? "error"
        : "info";
      return entry(id, ts, status, "summary", "high",
        headline || `Summary: ${cls}`,
        String(payload.narrative || ""),
        eventType);
    }

    // ── Recovery / Escalation ──────────────────────────────────
    case "recovery_attempted":
      return entry(id, ts, "warning", "repair", "high",
        `Recovery attempted: ${trunc(String(payload.strategy || payload.reason || ""), 60)}`,
        "",
        eventType);

    case "escalation_triggered":
      return entry(id, ts, "warning", "repair", "high",
        `Escalation triggered${payload.toModel ? " → " + String(payload.toModel) : ""}`,
        String(payload.reason || ""),
        eventType);

    // ── Task Plan events ───────────────────────────────────────
    case "task_plan_event": {
      const kind = String(payload.kind || "");
      if (kind.includes("paused") || kind.includes("blocked")) {
        return entry(id, ts, "warning", "approval", "high",
          String(payload.message || `Plan ${kind.replace(/_/g, " ")}`),
          "",
          eventType);
      }
      if (kind.includes("failed") || kind.includes("cancelled")) {
        return entry(id, ts, "error", "summary", "high",
          String(payload.message || `Plan ${kind.replace(/_/g, " ")}`),
          "",
          eventType);
      }
      if (kind.includes("completed")) {
        return entry(id, ts, "success", "summary", "high",
          String(payload.message || "Plan completed"),
          "",
          eventType);
      }
      // subtask_started, subtask_completed, etc.
      return entry(id, ts, "info", "building", "normal",
        String(payload.message || `Plan event: ${kind.replace(/_/g, " ")}`),
        "",
        eventType);
    }

    // ── System pressure ──────────────────────────────────────────
    case "system_pressure_warning":
      return entry(id, ts, "warning", "safety", "high",
        String(payload.message || "System memory pressure: warning"),
        "",
        eventType);

    case "system_pressure_critical":
      return entry(id, ts, "error", "safety", "high",
        String(payload.message || "System memory pressure: critical"),
        "",
        eventType);

    case "system_pressure_recovered":
      return entry(id, ts, "success", "safety", "normal",
        String(payload.message || "System memory pressure: recovered"),
        "",
        eventType);

    default:
      return null;
  }
}

/**
 * Reconstruct a timeline from persisted run detail data (for reload).
 * Uses workerEvents + summary + receipt to build a partial timeline.
 */
export function reconstructTimeline(runData: {
  workerEvents?: readonly { workerType: string; status: string; summary: string; timestamp?: string }[];
  summary?: { classification?: string; headline?: string; narrative?: string };
  receipt?: { verdict?: string; preflightScoutReportIds?: readonly string[] };
  status?: string;
  submittedAt?: string;
  completedAt?: string;
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let seq = 0;

  // Run started
  if (runData.submittedAt) {
    entries.push(entry(
      `tl-recon-${seq++}`, runData.submittedAt, "active", "intent", "high",
      "Run started", "", "run_started"));
  }

  // Worker events
  if (runData.workerEvents) {
    for (const ev of runData.workerEvents) {
      const status: TimelineStatus = ev.status === "failed" ? "error"
        : ev.status === "completed" ? "success" : "info";
      entries.push(entry(
        `tl-recon-${seq++}`, ev.timestamp || "", status,
        phaseForWorker(ev.workerType), "normal",
        `${capitalize(ev.workerType)}: ${ev.summary}`, "", "worker_event"));
    }
  }

  // Scout evidence
  if (runData.receipt?.preflightScoutReportIds?.length) {
    entries.push(entry(
      `tl-recon-${seq++}`, "", "success", "scout", "normal",
      `Scout evidence used: ${runData.receipt.preflightScoutReportIds.length} report(s)`,
      "Read-only scouts gathered advisory evidence.", "preflight_scouts_complete"));
  }

  // Summary
  if (runData.summary?.headline) {
    const cls = String(runData.summary.classification || "");
    const status: TimelineStatus = cls.includes("SUCCESS") ? "success"
      : cls.includes("FAIL") || cls.includes("ERROR") ? "error" : "info";
    entries.push(entry(
      `tl-recon-${seq++}`, runData.completedAt || "", status, "summary", "high",
      runData.summary.headline, runData.summary.narrative || "", "run_summary"));
  }

  return entries;
}

/**
 * Filter a timeline by importance level.
 */
export function filterTimeline(
  entries: readonly TimelineEntry[],
  filter: "all" | "important" | "errors",
): TimelineEntry[] {
  switch (filter) {
    case "all":
      return [...entries];
    case "important":
      return entries.filter((e) => e.importance === "high");
    case "errors":
      return entries.filter((e) => e.status === "error" || e.status === "warning");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function entry(
  id: string, timestamp: string, status: TimelineStatus,
  phase: TimelinePhase, importance: TimelineImportance,
  message: string, details: string, eventType: string,
): TimelineEntry {
  return { id, timestamp, status, phase, message, details, importance, eventType };
}

function trunc(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatConf(raw: unknown): string {
  if (raw == null) return "pending";
  const num = Number(raw);
  if (!Number.isFinite(num)) return "pending";
  return `${Math.round(Math.max(0, Math.min(1, num)) * 100)}%`;
}

function phaseForWorker(wt: string): TimelinePhase {
  const lower = wt.toLowerCase();
  if (lower === "scout") return "discovery";
  if (lower === "builder") return "building";
  if (lower === "critic") return "reviewing";
  if (lower === "verifier") return "verifying";
  if (lower === "integrator") return "integrating";
  return "building";
}

function objectiveFrom(payload: Record<string, unknown>): string {
  if (typeof payload.objective === "string") return payload.objective;
  if (payload.charter && typeof (payload.charter as Record<string, unknown>).objective === "string") {
    return (payload.charter as Record<string, unknown>).objective as string;
  }
  if (typeof payload.summary === "string") return payload.summary;
  return "";
}

function arrayFirst(value: unknown): string {
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  return "";
}

/** Strip potential secrets/tokens/keys from freeform input text. */
function redactInput(text: string): string {
  return text
    .replace(/(?:password|secret|token|api[_-]?key|auth)\s*[:=]\s*\S+/gi, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+/]{40,}\b/g, "[REDACTED]");
}
