/**
 * Scout Routing — local vs cloud model selection for scout agents.
 *
 * Decides which model/provider to use for each scout type based on
 * task complexity, privacy profile, available keys, and cost.
 *
 * Rules:
 *   LOCAL when: simple file search, repo indexing, grep-style discovery,
 *     low-risk summarization, privacy-sensitive mode, no cloud keys,
 *     task likely fits local context.
 *   CLOUD when: large architecture analysis, complex multi-file reasoning,
 *     ambiguous target discovery, large repo, low local confidence,
 *     cloud keys available and profile permits.
 *   NEVER silently escalate to cloud.
 *
 * Exposes: proposed model/provider, reason, estimated cost.
 */

import type { ScoutReportType } from "./scout-report.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ScoutRoutingInput {
  readonly scoutType: ScoutReportType;
  /** Current model profile ("default" | "local-smoke" | ...) */
  readonly modelProfile: string;
  /** Whether cloud API keys are available */
  readonly cloudKeysAvailable: boolean;
  /** Estimated repo size in files (0 = unknown) */
  readonly repoFileCount: number;
  /** Prompt length in chars */
  readonly promptLength: number;
  /** Local model confidence from prior run (null = no prior data) */
  readonly priorLocalConfidence?: number | null;
  /** Available local model (e.g. "qwen3.5:9b") */
  readonly localModel?: string;
  /** Available cloud model (e.g. "glm-5.1") */
  readonly cloudModel?: string;
}

export interface ScoutRoutingDecision {
  /** Whether to use local, cloud, or deterministic (no model) */
  readonly route: "local" | "cloud" | "deterministic";
  /** Model name to use */
  readonly model: string;
  /** Provider name */
  readonly provider: string;
  /** Human-readable reason for the choice */
  readonly reason: string;
  /** Estimated cost in USD (0 for local/deterministic) */
  readonly estimatedCostUsd: number;
}

// ─── Constants ───────────────────────────────────────────────────────

/** Repo size threshold — above this, consider cloud for complex scouts */
const LARGE_REPO_THRESHOLD = 500;

/** Prompt length threshold for "complex analysis" */
const COMPLEX_PROMPT_THRESHOLD = 300;

/** Confidence threshold — below this, escalate to cloud if available */
const LOW_CONFIDENCE_THRESHOLD = 0.4;

/** Estimated cost per cloud scout call (conservative) */
const CLOUD_SCOUT_COST_ESTIMATE_USD = 0.005;

// ─── Routing Logic ───────────────────────────────────────────────────

export function routeScout(input: ScoutRoutingInput): ScoutRoutingDecision {
  const {
    scoutType,
    modelProfile,
    cloudKeysAvailable,
    repoFileCount,
    promptLength,
    priorLocalConfidence,
  } = input;

  // ── Hard constraints ─────────────────────────────────────────────

  // Local-smoke profile → always deterministic/local
  if (modelProfile === "local-smoke") {
    return {
      route: "deterministic",
      model: "local",
      provider: "local",
      reason: "AEDIS_MODEL_PROFILE=local-smoke — deterministic scout only",
      estimatedCostUsd: 0,
    };
  }

  // ── Deterministic scouts (no model needed) ───────────────────────

  const deterministicTypes: ScoutReportType[] = ["repo_map", "test_discovery", "docs"];
  if (deterministicTypes.includes(scoutType) && repoFileCount < LARGE_REPO_THRESHOLD) {
    return {
      route: "deterministic",
      model: "local",
      provider: "local",
      reason: `${scoutType} on small repo — deterministic scan sufficient`,
      estimatedCostUsd: 0,
    };
  }

  // ── Cloud forbidden if no keys ───────────────────────────────────

  if (!cloudKeysAvailable) {
    return {
      route: "local",
      model: input.localModel || "qwen3.5:9b",
      provider: "ollama",
      reason: "No cloud API keys available — using local model",
      estimatedCostUsd: 0,
    };
  }

  // ── Escalation conditions ────────────────────────────────────────

  const needsCloud =
    // Large repo + complex analysis
    (repoFileCount >= LARGE_REPO_THRESHOLD &&
      (scoutType === "target_discovery" || scoutType === "risk")) ||
    // Long complex prompt
    (promptLength > COMPLEX_PROMPT_THRESHOLD &&
      scoutType === "target_discovery") ||
    // Low prior local confidence
    (priorLocalConfidence != null &&
      priorLocalConfidence < LOW_CONFIDENCE_THRESHOLD &&
      scoutType === "target_discovery");

  if (needsCloud) {
    const reasons: string[] = [];
    if (repoFileCount >= LARGE_REPO_THRESHOLD) reasons.push("large repo");
    if (promptLength > COMPLEX_PROMPT_THRESHOLD) reasons.push("complex prompt");
    if (priorLocalConfidence != null && priorLocalConfidence < LOW_CONFIDENCE_THRESHOLD) {
      reasons.push("low prior local confidence");
    }

    return {
      route: "cloud",
      model: input.cloudModel || "glm-5.1",
      provider: "zai",
      reason: `Cloud scout recommended: ${reasons.join(", ")}`,
      estimatedCostUsd: CLOUD_SCOUT_COST_ESTIMATE_USD,
    };
  }

  // ── Default: local ───────────────────────────────────────────────

  return {
    route: "local",
    model: input.localModel || "qwen3.5:9b",
    provider: "ollama",
    reason: `Local scout sufficient for ${scoutType}`,
    estimatedCostUsd: 0,
  };
}
