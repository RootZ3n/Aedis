/**
 * Trust Dashboard — Historical calibration and observability layer.
 *
 * Pure functions that project run receipts into trust metrics.
 * No side effects, no Fastify — the route handler passes in
 * receipt snapshots and gets back structured dashboard data.
 *
 * The trust model answers:
 *   - Is Aedis getting more reliable over time?
 *   - Where is it overconfident?
 *   - What task types are safe?
 *   - Where is verification weak?
 *   - When should strict mode be used?
 */

import type { RunReceipt } from "./coordinator.js";
import type { TaskPatternProfile, ProjectMemory } from "./project-memory.js";

// ─── Trust History Entry ────────────────────────────────────────────

/** One row per completed run. Extracted from RunReceipt fields. */
export interface TrustHistoryEntry {
  readonly runId: string;
  readonly timestamp: string;
  readonly scopeType: string;
  readonly taskArchetype: string;
  readonly filesChangedCount: number;
  readonly confidence: number;
  readonly confidenceDecision: string;
  readonly verificationCoverageRatio: number | null;
  readonly validationDepthRatio: number | null;
  readonly typeErrorCount: number;
  readonly gitDiffConfirmationRatio: number | null;
  readonly repoReadinessLevel: string;
  readonly strictMode: boolean;
  readonly outcome: string;
  readonly evaluationScore: number | null;
  readonly evaluationPassed: boolean | null;
  readonly disagreementSeverity: string | null;
  readonly disagreementDirection: string | null;
}

// ─── Dashboard Aggregates ───────────────────────────────────────────

export interface TrustVitals {
  readonly avgConfidence: number;
  readonly recentSuccessRate: number;
  readonly evaluationAlignmentRate: number;
  readonly overconfidenceRate: number;
  readonly underconfidenceRate: number;
  readonly avgVerificationCoverage: number;
  readonly avgValidationDepth: number;
  readonly totalRuns: number;
  readonly evaluatedRuns: number;
}

export interface TrustTrend {
  readonly period: string;
  readonly avgConfidence: number;
  readonly avgEvaluationScore: number | null;
  readonly successRate: number;
  readonly verificationDepth: number;
  readonly gitDiffMismatchRate: number;
  readonly runCount: number;
}

export interface ArchetypeInsight {
  readonly archetype: string;
  readonly runs: number;
  readonly successRate: number;
  readonly avgConfidence: number;
  readonly avgEvaluationScore: number | null;
  readonly overconfidenceRate: number;
  readonly reliabilityTier: string;
  readonly topFailureReason: string | null;
}

export interface StrictModeRecommendation {
  readonly archetype: string;
  readonly recommended: boolean;
  readonly reason: string;
  readonly signals: readonly string[];
  readonly strength: "strong" | "moderate" | "weak";
}

export interface CalibrationEntry {
  readonly runId: string;
  readonly timestamp: string;
  readonly rawConfidence: number;
  readonly calibratedConfidence: number | null;
  readonly evaluationScore: number | null;
  readonly evaluationPassed: boolean | null;
  readonly direction: string | null;
  readonly dampening: number;
}

export interface TrustDrift {
  readonly detected: boolean;
  readonly direction: "improving" | "degrading" | "stable";
  readonly signals: readonly string[];
  readonly severity: "none" | "mild" | "significant";
}

export interface FailurePattern {
  readonly pattern: string;
  readonly occurrences: number;
  readonly lastSeen: string;
  readonly archetype: string | null;
  readonly severity: "recurring" | "occasional";
}

export interface TrustDashboard {
  readonly vitals: TrustVitals;
  readonly trends: readonly TrustTrend[];
  readonly archetypes: readonly ArchetypeInsight[];
  readonly strictModeRecommendations: readonly StrictModeRecommendation[];
  readonly calibration: readonly CalibrationEntry[];
  readonly drift: TrustDrift;
  readonly failurePatterns: readonly FailurePattern[];
  readonly topWarnings: readonly string[];
  readonly generatedAt: string;
}

// ─── Extraction ─────────────────────────────────────────────────────

/** Extract a trust history entry from a RunReceipt. */
export function extractTrustEntry(receipt: RunReceipt): TrustHistoryEntry {
  const hs = receipt.humanSummary;
  const vr = receipt.verificationReceipt;
  const ev = receipt.evaluation;
  const ed = hs?.explanationDetails;

  return {
    runId: receipt.runId,
    timestamp: receipt.timestamp,
    scopeType: hs?.blastRadius?.scopeType ?? "unknown",
    taskArchetype: hs?.classification ?? receipt.verdict,
    filesChangedCount: hs?.filesTouchedCount ?? 0,
    confidence: hs?.confidence?.overall ?? 0,
    confidenceDecision: hs?.confidence?.decision ?? "reject",
    verificationCoverageRatio: vr?.coverageRatio ?? ed?.verificationCoverageRatio ?? null,
    validationDepthRatio: vr?.validatedRatio ?? ed?.validatedRatio ?? null,
    typeErrorCount: ed?.typeScriptErrors ?? 0,
    gitDiffConfirmationRatio: ed?.gitDiffConsistency?.includes("fully matched") ? 1.0
      : ed?.gitDiffConsistency?.includes("mismatch") ? 0.5
      : null,
    repoReadinessLevel: ed?.repoReadiness?.level ?? "normal",
    strictMode: hs?.confidence?.penalties?.some((p: string) => p.includes("strict mode")) ?? false,
    outcome: receipt.verdict,
    evaluationScore: ev?.aggregate?.averageScore ?? null,
    evaluationPassed: ev?.aggregate?.overallPass ?? null,
    disagreementSeverity: ev?.disagreement?.severity ?? null,
    disagreementDirection: ev?.disagreement?.direction ?? null,
  };
}

// ─── Aggregation ────────────────────────────────────────────────────

const MAX_HISTORY = 100;
const TREND_BUCKET_SIZE = 5; // runs per trend bucket

export function buildTrustDashboard(
  receipts: readonly RunReceipt[],
  memory: ProjectMemory | null,
): TrustDashboard {
  const entries = receipts
    .slice(0, MAX_HISTORY)
    .map(extractTrustEntry)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const vitals = computeVitals(entries);
  const trends = computeTrends(entries);
  const archetypes = computeArchetypes(entries, memory);
  const strictModeRecommendations = computeStrictRecommendations(archetypes, entries);
  const calibration = computeCalibration(entries, memory);
  const drift = detectTrustDrift(trends, vitals);
  const failurePatterns = detectFailurePatterns(entries, memory);
  const topWarnings = computeTopWarnings(entries, archetypes, drift);

  return {
    vitals,
    trends,
    archetypes,
    strictModeRecommendations,
    calibration,
    drift,
    failurePatterns,
    topWarnings,
    generatedAt: new Date().toISOString(),
  };
}

function computeVitals(entries: readonly TrustHistoryEntry[]): TrustVitals {
  if (entries.length === 0) {
    return {
      avgConfidence: 0, recentSuccessRate: 0, evaluationAlignmentRate: 0,
      overconfidenceRate: 0, underconfidenceRate: 0,
      avgVerificationCoverage: 0, avgValidationDepth: 0,
      totalRuns: 0, evaluatedRuns: 0,
    };
  }

  const recent = entries.slice(0, 20);
  let confSum = 0, successCount = 0;
  let covSum = 0, covCount = 0;
  let depthSum = 0, depthCount = 0;
  let evalAligned = 0, evalTotal = 0;
  let overconfident = 0, underconfident = 0;

  for (const e of recent) {
    confSum += e.confidence;
    if (e.outcome === "success") successCount++;

    if (typeof e.verificationCoverageRatio === "number") {
      covSum += e.verificationCoverageRatio;
      covCount++;
    }
    if (typeof e.validationDepthRatio === "number") {
      depthSum += e.validationDepthRatio;
      depthCount++;
    }
    if (typeof e.evaluationScore === "number") {
      evalTotal++;
      const evalNorm = e.evaluationScore / 100;
      const gap = e.confidence - evalNorm;
      if (Math.abs(gap) < 0.15) evalAligned++;
      if (gap > 0.15 && e.evaluationPassed === false) overconfident++;
      if (gap < -0.15 && e.evaluationPassed === true) underconfident++;
    }
  }

  return {
    avgConfidence: r4(confSum / recent.length),
    recentSuccessRate: r4(successCount / recent.length),
    evaluationAlignmentRate: evalTotal > 0 ? r4(evalAligned / evalTotal) : 0,
    overconfidenceRate: evalTotal > 0 ? r4(overconfident / evalTotal) : 0,
    underconfidenceRate: evalTotal > 0 ? r4(underconfident / evalTotal) : 0,
    avgVerificationCoverage: covCount > 0 ? r4(covSum / covCount) : 0,
    avgValidationDepth: depthCount > 0 ? r4(depthSum / depthCount) : 0,
    totalRuns: entries.length,
    evaluatedRuns: entries.filter((e) => typeof e.evaluationScore === "number").length,
  };
}

function computeTrends(entries: readonly TrustHistoryEntry[]): TrustTrend[] {
  if (entries.length < 2) return [];

  const trends: TrustTrend[] = [];
  for (let i = 0; i < entries.length; i += TREND_BUCKET_SIZE) {
    const bucket = entries.slice(i, i + TREND_BUCKET_SIZE);
    if (bucket.length === 0) break;

    let confSum = 0, evalSum = 0, evalCount = 0;
    let successCount = 0, mismatchCount = 0;
    let depthSum = 0, depthCount = 0;

    for (const e of bucket) {
      confSum += e.confidence;
      if (e.outcome === "success") successCount++;
      if (typeof e.evaluationScore === "number") {
        evalSum += e.evaluationScore;
        evalCount++;
      }
      if (typeof e.validationDepthRatio === "number") {
        depthSum += e.validationDepthRatio;
        depthCount++;
      }
      if (typeof e.gitDiffConfirmationRatio === "number" && e.gitDiffConfirmationRatio < 1) {
        mismatchCount++;
      }
    }

    const oldest = bucket[bucket.length - 1]!.timestamp.slice(0, 10);
    const newest = bucket[0]!.timestamp.slice(0, 10);
    trends.push({
      period: oldest === newest ? oldest : `${oldest} → ${newest}`,
      avgConfidence: r4(confSum / bucket.length),
      avgEvaluationScore: evalCount > 0 ? r4(evalSum / evalCount) : null,
      successRate: r4(successCount / bucket.length),
      verificationDepth: depthCount > 0 ? r4(depthSum / depthCount) : 0,
      gitDiffMismatchRate: r4(mismatchCount / bucket.length),
      runCount: bucket.length,
    });
  }

  return trends;
}

function computeArchetypes(
  entries: readonly TrustHistoryEntry[],
  memory: ProjectMemory | null,
): ArchetypeInsight[] {
  // Prefer pattern memory when available — it has richer signals.
  // Supplement with entry-level data for fields pattern memory doesn't track.
  if (memory && memory.taskPatterns.length > 0) {
    // Build a quick confidence lookup from recent tasks
    const confByArchetype = new Map<string, number[]>();
    for (const task of memory.recentTasks) {
      const key = task.taskTypeKey ?? "";
      if (!key || typeof task.aedisConfidence !== "number") continue;
      const list = confByArchetype.get(key) ?? [];
      list.push(task.aedisConfidence);
      confByArchetype.set(key, list);
    }

    return memory.taskPatterns
      .filter((p) => p.observedRuns >= 2)
      .map((p): ArchetypeInsight => {
        const confs = confByArchetype.get(p.taskTypeKey) ?? [];
        const avgConf = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
        return {
          archetype: p.taskTypeKey,
          runs: p.observedRuns,
          successRate: r4(p.successRate),
          avgConfidence: r4(avgConf),
          avgEvaluationScore: p.evaluatedRuns > 0 ? r4(p.avgEvaluationScore) : null,
          overconfidenceRate: r4(p.overconfidenceRate),
          reliabilityTier: p.reliabilityTier,
          topFailureReason: p.commonFailureReasons[0] ?? null,
        };
      })
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 10);
  }

  // Fallback: group entries by scope type
  const groups = new Map<string, TrustHistoryEntry[]>();
  for (const e of entries) {
    const key = e.scopeType;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  return [...groups.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([archetype, list]): ArchetypeInsight => {
      const successes = list.filter((e) => e.outcome === "success").length;
      const confSum = list.reduce((s, e) => s + e.confidence, 0);
      const evaluated = list.filter((e) => typeof e.evaluationScore === "number");
      const evalSum = evaluated.reduce((s, e) => s + (e.evaluationScore ?? 0), 0);
      const overconf = evaluated.filter(
        (e) => e.confidence >= 0.7 && e.evaluationPassed === false,
      ).length;

      return {
        archetype,
        runs: list.length,
        successRate: r4(successes / list.length),
        avgConfidence: r4(confSum / list.length),
        avgEvaluationScore: evaluated.length > 0 ? r4(evalSum / evaluated.length) : null,
        overconfidenceRate: evaluated.length > 0 ? r4(overconf / evaluated.length) : 0,
        reliabilityTier: tierFromRates(list.length, successes / list.length, evaluated.length > 0 ? overconf / evaluated.length : 0),
        topFailureReason: null,
      };
    })
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 10);
}

function computeStrictRecommendations(
  archetypes: readonly ArchetypeInsight[],
  entries: readonly TrustHistoryEntry[],
): StrictModeRecommendation[] {
  const recs: StrictModeRecommendation[] = [];

  for (const a of archetypes) {
    if (a.runs < 3) continue;

    const signals: string[] = [];
    let strength: StrictModeRecommendation["strength"] = "weak";

    if (a.overconfidenceRate >= 0.3) {
      signals.push(`${pct(a.overconfidenceRate)} overconfidence rate`);
      strength = "strong";
    }
    if (a.successRate < 0.6) {
      signals.push(`${pct(a.successRate)} success rate`);
      strength = strength === "strong" ? "strong" : "moderate";
    }
    if (a.reliabilityTier === "risky") {
      signals.push("reliability tier: risky");
      strength = strength === "weak" ? "moderate" : strength;
    }

    // Check shallow verification for this archetype in entries
    const archetypeEntries = entries.filter(
      (e) => e.scopeType === a.archetype || e.taskArchetype === a.archetype,
    );
    const shallowCount = archetypeEntries.filter(
      (e) => typeof e.validationDepthRatio === "number" && e.validationDepthRatio < 0.5,
    ).length;
    if (shallowCount > 0 && archetypeEntries.length >= 3) {
      const shallowRate = shallowCount / archetypeEntries.length;
      if (shallowRate >= 0.4) {
        signals.push(`${pct(shallowRate)} shallow verification rate`);
        strength = strength === "weak" ? "moderate" : strength;
      }
    }

    if (signals.length > 0) {
      recs.push({
        archetype: a.archetype,
        recommended: true,
        reason: `Strict mode recommended: ${signals.join(", ")}`,
        signals,
        strength,
      });
    }
  }

  return recs.sort((a, b) => {
    const order = { strong: 0, moderate: 1, weak: 2 };
    return order[a.strength] - order[b.strength];
  });
}

function computeCalibration(
  entries: readonly TrustHistoryEntry[],
  memory: ProjectMemory | null,
): CalibrationEntry[] {
  // Build dampening lookup from pattern memory
  const dampeningByArchetype = new Map<string, number>();
  if (memory) {
    for (const p of memory.taskPatterns) {
      dampeningByArchetype.set(p.taskTypeKey, p.confidenceDampening);
    }
  }

  return entries
    .filter((e) => typeof e.evaluationScore === "number" || e.confidence > 0)
    .slice(0, 30)
    .map((e): CalibrationEntry => {
      const dampening = dampeningByArchetype.get(e.scopeType) ?? 1.0;
      const calibrated = dampening < 1.0
        ? r4(e.confidence * dampening)
        : null;
      return {
        runId: e.runId,
        timestamp: e.timestamp,
        rawConfidence: e.confidence,
        calibratedConfidence: calibrated,
        evaluationScore: typeof e.evaluationScore === "number" ? r4(e.evaluationScore / 100) : null,
        evaluationPassed: e.evaluationPassed,
        direction: e.disagreementDirection,
        dampening: r4(dampening),
      };
    });
}

// ─── Trust Drift Detection ──────────────────────────────────────────

function detectTrustDrift(
  trends: readonly TrustTrend[],
  vitals: TrustVitals,
): TrustDrift {
  if (trends.length < 2) {
    return { detected: false, direction: "stable", signals: [], severity: "none" };
  }

  const signals: string[] = [];
  // Compare first half (older) vs second half (newer) of trends
  const mid = Math.floor(trends.length / 2);
  const older = trends.slice(0, mid);
  const newer = trends.slice(mid);

  const olderConf = avg(older.map((t) => t.avgConfidence));
  const newerConf = avg(newer.map((t) => t.avgConfidence));
  const olderSuccess = avg(older.map((t) => t.successRate));
  const newerSuccess = avg(newer.map((t) => t.successRate));
  const olderDepth = avg(older.map((t) => t.verificationDepth));
  const newerDepth = avg(newer.map((t) => t.verificationDepth));

  // Evaluate trends by comparing older and newer evaluation scores
  const olderEval = older.filter((t) => t.avgEvaluationScore != null);
  const newerEval = newer.filter((t) => t.avgEvaluationScore != null);
  const olderEvalAvg = olderEval.length > 0 ? avg(olderEval.map((t) => t.avgEvaluationScore! / 100)) : null;
  const newerEvalAvg = newerEval.length > 0 ? avg(newerEval.map((t) => t.avgEvaluationScore! / 100)) : null;

  // Rising confidence + declining evaluation = overconfidence drift
  if (newerConf > olderConf + 0.05 && olderEvalAvg != null && newerEvalAvg != null && newerEvalAvg < olderEvalAvg - 0.05) {
    signals.push(`Confidence rising (${pct(olderConf)} → ${pct(newerConf)}) while evaluation declining (${pct(olderEvalAvg)} → ${pct(newerEvalAvg)})`);
  }

  // Declining success rate
  if (newerSuccess < olderSuccess - 0.1) {
    signals.push(`Success rate declining: ${pct(olderSuccess)} → ${pct(newerSuccess)}`);
  }

  // Declining verification depth
  if (newerDepth < olderDepth - 0.1) {
    signals.push(`Verification depth declining: ${pct(olderDepth)} → ${pct(newerDepth)}`);
  }

  // Improving signals
  if (newerSuccess > olderSuccess + 0.1) {
    signals.push(`Success rate improving: ${pct(olderSuccess)} → ${pct(newerSuccess)}`);
  }

  // High recent overconfidence
  if (vitals.evaluatedRuns >= 3 && vitals.overconfidenceRate >= 0.3) {
    signals.push(`Overconfidence rate elevated at ${pct(vitals.overconfidenceRate)}`);
  }

  const degradingSignals = signals.filter((s) =>
    s.includes("declining") || s.includes("Overconfidence") || (s.includes("rising") && s.includes("while")),
  );
  const improvingSignals = signals.filter((s) => s.includes("improving"));

  const direction: TrustDrift["direction"] =
    degradingSignals.length > improvingSignals.length ? "degrading" :
    improvingSignals.length > degradingSignals.length ? "improving" :
    "stable";

  const severity: TrustDrift["severity"] =
    degradingSignals.length >= 2 ? "significant" :
    degradingSignals.length === 1 ? "mild" :
    "none";

  return {
    detected: signals.length > 0,
    direction,
    signals,
    severity,
  };
}

// ─── Failure Pattern Detection ──────────────────────────────────────

function detectFailurePatterns(
  entries: readonly TrustHistoryEntry[],
  memory: ProjectMemory | null,
): FailurePattern[] {
  const patterns: FailurePattern[] = [];

  // Source 1: Pattern memory — commonFailureReasons and commonMissingFiles
  if (memory) {
    for (const p of memory.taskPatterns) {
      if (p.observedRuns < 3) continue;

      for (const reason of p.commonFailureReasons.slice(0, 2)) {
        const occurrences = Math.round(p.observedRuns * (1 - p.successRate));
        if (occurrences >= 2) {
          patterns.push({
            pattern: reason,
            occurrences,
            lastSeen: p.lastSeen,
            archetype: p.taskTypeKey,
            severity: occurrences >= 3 ? "recurring" : "occasional",
          });
        }
      }

      for (const file of p.commonMissingFiles.slice(0, 2)) {
        patterns.push({
          pattern: `Missing file: ${file}`,
          occurrences: Math.ceil(p.observedRuns * 0.3), // approximate
          lastSeen: p.lastSeen,
          archetype: p.taskTypeKey,
          severity: "recurring",
        });
      }
    }
  }

  // Source 2: Recent entries — repo readiness issues
  const readinessIssues = new Map<string, { count: number; lastSeen: string }>();
  for (const e of entries.slice(0, 30)) {
    if (e.repoReadinessLevel !== "normal") {
      const key = `repo-readiness:${e.repoReadinessLevel}`;
      const existing = readinessIssues.get(key) ?? { count: 0, lastSeen: e.timestamp };
      existing.count++;
      if (e.timestamp > existing.lastSeen) existing.lastSeen = e.timestamp;
      readinessIssues.set(key, existing);
    }
  }
  for (const [key, info] of readinessIssues) {
    if (info.count >= 2) {
      patterns.push({
        pattern: key.replace("repo-readiness:", "Repo readiness: "),
        occurrences: info.count,
        lastSeen: info.lastSeen,
        archetype: null,
        severity: info.count >= 4 ? "recurring" : "occasional",
      });
    }
  }

  // Source 3: Verification gap clustering
  const shallowVerification = entries.filter(
    (e) => typeof e.validationDepthRatio === "number" && e.validationDepthRatio < 0.5,
  );
  if (shallowVerification.length >= 3) {
    patterns.push({
      pattern: `Shallow verification (validation depth < 50%) in ${shallowVerification.length} runs`,
      occurrences: shallowVerification.length,
      lastSeen: shallowVerification[0]?.timestamp ?? "",
      archetype: null,
      severity: shallowVerification.length >= 5 ? "recurring" : "occasional",
    });
  }

  return patterns
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 10);
}

function computeTopWarnings(
  entries: readonly TrustHistoryEntry[],
  archetypes: readonly ArchetypeInsight[],
  drift?: TrustDrift,
): string[] {
  const warnings: string[] = [];
  const recent = entries.slice(0, 10);

  // Overconfidence trend
  const recentEvaluated = recent.filter((e) => typeof e.evaluationScore === "number");
  const recentOverconf = recentEvaluated.filter(
    (e) => e.confidence >= 0.7 && e.evaluationPassed === false,
  );
  if (recentEvaluated.length >= 3 && recentOverconf.length / recentEvaluated.length >= 0.3) {
    warnings.push(`Overconfidence detected in recent runs: ${recentOverconf.length}/${recentEvaluated.length} evaluated runs had high confidence but failed evaluation`);
  }

  // Shallow verification trend
  const shallowRecent = recent.filter(
    (e) => typeof e.validationDepthRatio === "number" && e.validationDepthRatio < 0.5,
  );
  if (recent.length >= 5 && shallowRecent.length / recent.length >= 0.4) {
    warnings.push(`Shallow verification: ${shallowRecent.length}/${recent.length} recent runs had validation depth below 50%`);
  }

  // Risky archetypes
  const risky = archetypes.filter((a) => a.reliabilityTier === "risky");
  if (risky.length > 0) {
    warnings.push(`${risky.length} task archetype${risky.length > 1 ? "s" : ""} historically risky: ${risky.map((a) => a.archetype).join(", ")}`);
  }

  // Low success rate
  const successRate = recent.length > 0
    ? recent.filter((e) => e.outcome === "success").length / recent.length
    : 0;
  if (recent.length >= 5 && successRate < 0.5) {
    warnings.push(`Low recent success rate: ${pct(successRate)} across last ${recent.length} runs`);
  }

  // Trust drift warning
  if (drift && drift.severity !== "none" && drift.direction === "degrading") {
    warnings.unshift(`Trust drift detected (${drift.severity}): ${drift.signals[0] ?? "declining trust signals"}`);
  }

  return warnings.slice(0, 5);
}

// ─── Utilities ──────────────────────────────────────────────────────

function avg(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ─── Helpers ────────────────────────────────────────────────────────

function tierFromRates(runs: number, successRate: number, overconfidenceRate: number): string {
  if (runs < 3) return "unknown";
  if (successRate >= 0.8 && overconfidenceRate < 0.15) return "reliable";
  if (successRate < 0.6 || overconfidenceRate >= 0.3) return "risky";
  return "caution";
}

function r4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
