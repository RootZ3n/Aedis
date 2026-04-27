/**
 * Lane config — shape for primary/shadow candidate-lane selection.
 *
 * Phase A scaffolding: this file defines the type surface and a pure
 * `parseLaneConfig` validator. It is NOT wired into the production
 * pipeline yet — the Coordinator's submit() path still runs a single
 * primary-only lane. Tests below pin the type and validator so the
 * later wiring step can lean on a stable contract.
 *
 *   mode === "primary_only"
 *     The current behavior. Only the primary lane runs. The shadow
 *     section, if present, is ignored.
 *
 *   mode === "local_then_cloud"
 *     Try the local lane first. If it disqualifies (verifier fail,
 *     tests fail, missing required deliverables), retry on the cloud
 *     lane. Approval gate sees at most one candidate. Local lane runs
 *     in the primary workspace; cloud lane runs in a shadow workspace.
 *
 *   mode === "local_vs_cloud"
 *     Run both lanes in parallel. selectBestCandidate picks the winner
 *     (primary-role preference + local-on-tie). Only the selected
 *     candidate enters approval; the loser's workspace is cleaned up.
 *
 *   mode === "cloud_with_local_check"
 *     Cloud is the primary lane; a local lane runs alongside as a
 *     diff/quality sanity check but never selected unless the cloud
 *     lane disqualifies. Useful for users who default to cloud but
 *     want a privacy-preserving baseline to compare against.
 *
 * SAFETY:
 *   - Only the candidate whose role==="primary" can promote. Lane is
 *     orthogonal to role; a "cloud" lane on the primary workspace can
 *     promote, a "local" lane on a shadow workspace cannot.
 *   - cleanupLosingCandidates always preserves the primary workspace,
 *     regardless of which candidate the selection picked.
 *   - The approval gate must receive selectBestRunCandidate(runId) — a
 *     single Candidate or null — never the raw multi-candidate list.
 */

export type LaneId = "local" | "cloud";

export type LaneMode =
  | "primary_only"
  | "local_then_cloud"
  | "local_vs_cloud"
  | "cloud_with_local_check";

/**
 * One side of a lane assignment. `provider` and `model` are the same
 * shape as `ModelAssignment` in server/routes/config.ts but without
 * the chain field — lane assignments are single-attempt overrides,
 * not fallback chains. (A lane that needs multi-step retry can layer
 * the existing per-role chain on top.)
 */
export interface LaneAssignment {
  readonly lane: LaneId;
  readonly provider: string;
  readonly model: string;
  /** Optional human label, surfaced in receipts/UI. */
  readonly label?: string;
}

/**
 * Full lane configuration. `primary` always runs in the primary
 * workspace and is the only candidate that can be promoted. `shadow`
 * is the alternate lane — required for any mode other than
 * `primary_only`, ignored when primary_only is set.
 */
export interface LaneConfig {
  readonly mode: LaneMode;
  readonly primary: LaneAssignment;
  readonly shadow?: LaneAssignment;
}

const VALID_LANES: ReadonlySet<LaneId> = new Set(["local", "cloud"]);
const VALID_MODES: ReadonlySet<LaneMode> = new Set([
  "primary_only",
  "local_then_cloud",
  "local_vs_cloud",
  "cloud_with_local_check",
]);

export interface ParseLaneConfigResult {
  readonly config: LaneConfig | null;
  readonly errors: readonly string[];
}

/**
 * Validate untrusted input (file load, HTTP body) into a frozen
 * LaneConfig, or return errors. Pure: never throws, never reads disk.
 *
 * Required field rules:
 *   - mode must be one of VALID_MODES
 *   - primary must be present with non-empty provider+model+lane
 *   - shadow is REQUIRED when mode !== "primary_only"
 *   - primary.lane and shadow.lane must each be in VALID_LANES
 *   - shadow.lane must differ from primary.lane (the whole point of
 *     having a shadow is to compare against a different lane)
 */
export function parseLaneConfig(raw: unknown): ParseLaneConfigResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { config: null, errors: ["lane config must be an object"] };
  }
  const obj = raw as Record<string, unknown>;

  const mode = obj["mode"];
  if (typeof mode !== "string" || !VALID_MODES.has(mode as LaneMode)) {
    errors.push(`mode must be one of ${[...VALID_MODES].join(", ")}; got ${JSON.stringify(mode)}`);
  }

  const primary = parseAssignment(obj["primary"], "primary", errors);
  let shadow: LaneAssignment | null = null;
  if (mode !== "primary_only") {
    if (obj["shadow"] === undefined || obj["shadow"] === null) {
      errors.push(`shadow assignment is required when mode="${String(mode)}"`);
    } else {
      shadow = parseAssignment(obj["shadow"], "shadow", errors);
    }
  } else if (obj["shadow"] !== undefined && obj["shadow"] !== null) {
    // Permissive — record the shadow if the operator left it in the
    // file but switched mode back to primary_only. The runtime ignores
    // it; we just retain it for round-tripping.
    shadow = parseAssignment(obj["shadow"], "shadow", errors);
  }

  if (primary && shadow && primary.lane === shadow.lane) {
    errors.push(
      `shadow.lane="${shadow.lane}" must differ from primary.lane="${primary.lane}" — ` +
      `a shadow lane that matches the primary provides no comparison signal`,
    );
  }

  if (errors.length > 0) {
    return { config: null, errors };
  }
  return {
    config: Object.freeze({
      mode: mode as LaneMode,
      primary: primary!,
      ...(shadow ? { shadow } : {}),
    }),
    errors: [],
  };
}

function parseAssignment(
  raw: unknown,
  role: "primary" | "shadow",
  errors: string[],
): LaneAssignment | null {
  if (!raw || typeof raw !== "object") {
    errors.push(`${role}: expected object, got ${typeof raw}`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const lane = r["lane"];
  const provider = r["provider"];
  const model = r["model"];
  const label = r["label"];

  let ok = true;
  if (typeof lane !== "string" || !VALID_LANES.has(lane as LaneId)) {
    errors.push(`${role}.lane must be one of ${[...VALID_LANES].join(", ")}; got ${JSON.stringify(lane)}`);
    ok = false;
  }
  if (typeof provider !== "string" || provider.trim().length === 0) {
    errors.push(`${role}.provider must be a non-empty string`);
    ok = false;
  }
  if (typeof model !== "string" || model.trim().length === 0) {
    errors.push(`${role}.model must be a non-empty string`);
    ok = false;
  }
  if (label !== undefined && typeof label !== "string") {
    errors.push(`${role}.label must be a string when present`);
    ok = false;
  }
  if (!ok) return null;

  const out: LaneAssignment = {
    lane: lane as LaneId,
    provider: (provider as string).trim(),
    model: (model as string).trim(),
    ...(typeof label === "string" && label.trim().length > 0 ? { label: label.trim() } : {}),
  };
  return Object.freeze(out);
}

/**
 * Default lane config — equivalent to today's behavior. Used as the
 * effective config when no `.aedis/lane-config.json` is present and
 * the operator hasn't passed one explicitly. Keeps the production
 * pipeline single-lane until the operator opts into dual-lane modes.
 */
export const DEFAULT_LANE_CONFIG: LaneConfig = Object.freeze({
  mode: "primary_only",
  primary: Object.freeze({ lane: "cloud", provider: "openrouter", model: "xiaomi/mimo-v2.5" }),
});

/**
 * Whether dual lanes should run for this config. False when mode is
 * primary_only OR when shadow is missing (paranoid double-check —
 * parseLaneConfig already enforces shadow-required for non-primary_only).
 */
export function laneConfigRunsShadow(config: LaneConfig): boolean {
  return config.mode !== "primary_only" && config.shadow !== undefined;
}
