/**
 * TrustDashboard — Aedis trust observability UI component.
 *
 * Renders a compact, product-grade view of Aedis trust signals:
 *   - Trust vitals (confidence, success rate, alignment, overconfidence)
 *   - Trend strips (confidence vs evaluation over time)
 *   - Archetype insights (reliable vs risky task types)
 *   - Calibration visibility (raw vs calibrated confidence)
 *   - Strict mode recommendations
 *   - Top warnings
 *
 * Fetches from GET /trust/dashboard. Self-contained — no external
 * state management needed.
 */

import React, { useEffect, useState } from "react";

// ─── Types (mirror core/trust-dashboard.ts) ─────────────────────────

interface TrustVitals {
  avgConfidence: number;
  recentSuccessRate: number;
  evaluationAlignmentRate: number;
  overconfidenceRate: number;
  underconfidenceRate: number;
  avgVerificationCoverage: number;
  avgValidationDepth: number;
  totalRuns: number;
  evaluatedRuns: number;
}

interface TrustTrend {
  period: string;
  avgConfidence: number;
  avgEvaluationScore: number | null;
  successRate: number;
  verificationDepth: number;
  gitDiffMismatchRate: number;
  runCount: number;
}

interface ArchetypeInsight {
  archetype: string;
  runs: number;
  successRate: number;
  avgConfidence: number;
  avgEvaluationScore: number | null;
  overconfidenceRate: number;
  reliabilityTier: string;
  topFailureReason: string | null;
}

interface StrictModeRecommendation {
  archetype: string;
  recommended: boolean;
  reason: string;
  signals: string[];
  strength: "strong" | "moderate" | "weak";
}

interface CalibrationEntry {
  runId: string;
  timestamp: string;
  rawConfidence: number;
  calibratedConfidence: number | null;
  evaluationScore: number | null;
  evaluationPassed: boolean | null;
  direction: string | null;
  dampening: number;
}

interface TrustDrift {
  detected: boolean;
  direction: "improving" | "degrading" | "stable";
  signals: string[];
  severity: "none" | "mild" | "significant";
}

interface FailurePattern {
  pattern: string;
  occurrences: number;
  lastSeen: string;
  archetype: string | null;
  severity: "recurring" | "occasional";
}

interface TrustDashboardData {
  vitals: TrustVitals;
  trends: TrustTrend[];
  archetypes: ArchetypeInsight[];
  strictModeRecommendations: StrictModeRecommendation[];
  calibration: CalibrationEntry[];
  drift: TrustDrift;
  failurePatterns: FailurePattern[];
  topWarnings: string[];
  generatedAt: string;
}

// ─── Component ──────────────────────────────────────────────────────

export function TrustDashboard() {
  const [data, setData] = useState<TrustDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/trust/dashboard?limit=50")
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="trust-loading">Loading trust data...</div>;
  if (error) return <div className="trust-error">Trust dashboard unavailable: {error}</div>;
  if (!data) return null;

  return (
    <div className="trust-dashboard">
      <h2 className="trust-title">Trust Dashboard</h2>

      <VitalsCard vitals={data.vitals} />

      {data.drift.detected && <DriftCard drift={data.drift} />}

      {data.topWarnings.length > 0 && (
        <WarningsCard warnings={data.topWarnings} />
      )}

      {data.trends.length > 0 && (
        <TrendStrip trends={data.trends} />
      )}

      {data.archetypes.length > 0 && (
        <ArchetypesCard archetypes={data.archetypes} />
      )}

      {data.failurePatterns.length > 0 && (
        <FailurePatternsCard patterns={data.failurePatterns} />
      )}

      {data.strictModeRecommendations.length > 0 && (
        <StrictModeCard recommendations={data.strictModeRecommendations} />
      )}

      {data.calibration.length > 0 && (
        <CalibrationCard entries={data.calibration} />
      )}

      <div className="trust-footer">
        Generated {new Date(data.generatedAt).toLocaleString()} from {data.vitals.totalRuns} runs
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function VitalsCard({ vitals }: { vitals: TrustVitals }) {
  return (
    <div className="trust-card trust-vitals">
      <h3>Trust Vitals</h3>
      <div className="vital-grid">
        <VitalBadge
          label="Confidence"
          value={pct(vitals.avgConfidence)}
          color={vitals.avgConfidence >= 0.7 ? "green" : vitals.avgConfidence >= 0.5 ? "yellow" : "red"}
        />
        <VitalBadge
          label="Success Rate"
          value={pct(vitals.recentSuccessRate)}
          color={vitals.recentSuccessRate >= 0.8 ? "green" : vitals.recentSuccessRate >= 0.6 ? "yellow" : "red"}
        />
        <VitalBadge
          label="Eval Alignment"
          value={vitals.evaluatedRuns >= 3 ? pct(vitals.evaluationAlignmentRate) : "n/a"}
          color={vitals.evaluatedRuns < 3 ? "gray" : vitals.evaluationAlignmentRate >= 0.7 ? "green" : vitals.evaluationAlignmentRate >= 0.5 ? "yellow" : "red"}
        />
        <VitalBadge
          label="Overconfidence"
          value={vitals.evaluatedRuns >= 3 ? pct(vitals.overconfidenceRate) : "n/a"}
          color={vitals.evaluatedRuns < 3 ? "gray" : vitals.overconfidenceRate < 0.15 ? "green" : vitals.overconfidenceRate < 0.3 ? "yellow" : "red"}
        />
        <VitalBadge
          label="Verification"
          value={pct(vitals.avgVerificationCoverage)}
          color={vitals.avgVerificationCoverage >= 0.9 ? "green" : vitals.avgVerificationCoverage >= 0.7 ? "yellow" : "red"}
        />
        <VitalBadge
          label="Validation Depth"
          value={pct(vitals.avgValidationDepth)}
          color={vitals.avgValidationDepth >= 0.8 ? "green" : vitals.avgValidationDepth >= 0.5 ? "yellow" : "red"}
        />
      </div>
      <div className="vital-meta">
        {vitals.totalRuns} total runs, {vitals.evaluatedRuns} evaluated
      </div>
    </div>
  );
}

function VitalBadge({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className={`vital-badge vital-${color}`}>
      <div className="vital-value">{value}</div>
      <div className="vital-label">{label}</div>
    </div>
  );
}

function WarningsCard({ warnings }: { warnings: string[] }) {
  return (
    <div className="trust-card trust-warnings">
      <h3>Warnings</h3>
      <ul>
        {warnings.map((w, i) => (
          <li key={i} className="warning-item">{w}</li>
        ))}
      </ul>
    </div>
  );
}

function TrendStrip({ trends }: { trends: TrustTrend[] }) {
  // Reverse so oldest is left, newest is right
  const ordered = [...trends].reverse();
  const maxConf = Math.max(...ordered.map((t) => t.avgConfidence), 0.01);

  return (
    <div className="trust-card trust-trends">
      <h3>Trend</h3>
      <div className="trend-strip">
        {ordered.map((t, i) => {
          const confH = Math.round((t.avgConfidence / maxConf) * 40);
          const evalH = t.avgEvaluationScore != null ? Math.round((t.avgEvaluationScore / 100) * 40) : 0;
          return (
            <div key={i} className="trend-bar-group" title={`${t.period}: ${pct(t.avgConfidence)} conf, ${pct(t.successRate)} success, ${t.runCount} runs`}>
              <div className="trend-bar trend-conf" style={{ height: `${confH}px` }} />
              {evalH > 0 && <div className="trend-bar trend-eval" style={{ height: `${evalH}px` }} />}
              <div className="trend-label">{t.runCount}</div>
            </div>
          );
        })}
      </div>
      <div className="trend-legend">
        <span className="legend-conf">Confidence</span>
        <span className="legend-eval">Evaluation</span>
      </div>
    </div>
  );
}

function ArchetypesCard({ archetypes }: { archetypes: ArchetypeInsight[] }) {
  return (
    <div className="trust-card trust-archetypes">
      <h3>Task Archetypes</h3>
      <table className="archetype-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Runs</th>
            <th>Success</th>
            <th>Overconf</th>
            <th>Tier</th>
          </tr>
        </thead>
        <tbody>
          {archetypes.map((a) => (
            <tr key={a.archetype} className={`tier-${a.reliabilityTier}`}>
              <td className="archetype-name">{a.archetype}</td>
              <td>{a.runs}</td>
              <td>{pct(a.successRate)}</td>
              <td>{pct(a.overconfidenceRate)}</td>
              <td><TierBadge tier={a.reliabilityTier} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    reliable: "green",
    caution: "yellow",
    risky: "red",
    unknown: "gray",
  };
  return <span className={`tier-badge tier-${colors[tier] ?? "gray"}`}>{tier}</span>;
}

function StrictModeCard({ recommendations }: { recommendations: StrictModeRecommendation[] }) {
  return (
    <div className="trust-card trust-strict">
      <h3>Strict Mode Recommendations</h3>
      {recommendations.map((r) => (
        <div key={r.archetype} className={`strict-rec strict-${r.strength}`}>
          <div className="strict-header">
            <span className="strict-archetype">{r.archetype}</span>
            <span className={`strict-strength strength-${r.strength}`}>{r.strength}</span>
          </div>
          <div className="strict-reason">{r.reason}</div>
        </div>
      ))}
    </div>
  );
}

function DriftCard({ drift }: { drift: TrustDrift }) {
  const colors: Record<string, string> = {
    improving: "green",
    degrading: "red",
    stable: "gray",
  };
  const icons: Record<string, string> = {
    improving: "\u2191",
    degrading: "\u2193",
    stable: "\u2192",
  };
  return (
    <div className={`trust-card trust-drift drift-${drift.severity}`}>
      <h3>
        <span className={`drift-icon drift-${colors[drift.direction]}`}>{icons[drift.direction]}</span>
        {" "}Trust Drift: {drift.direction}
      </h3>
      <ul>
        {drift.signals.map((s, i) => (
          <li key={i} className="drift-signal">{s}</li>
        ))}
      </ul>
    </div>
  );
}

function FailurePatternsCard({ patterns }: { patterns: FailurePattern[] }) {
  return (
    <div className="trust-card trust-failures">
      <h3>Failure Patterns</h3>
      <table className="failure-table">
        <thead>
          <tr>
            <th>Pattern</th>
            <th>Hits</th>
            <th>Type</th>
            <th>Freq</th>
          </tr>
        </thead>
        <tbody>
          {patterns.slice(0, 8).map((p, i) => (
            <tr key={i} className={`failure-${p.severity}`}>
              <td className="failure-desc">{p.pattern}</td>
              <td>{p.occurrences}</td>
              <td className="failure-archetype">{p.archetype ?? "-"}</td>
              <td><span className={`freq-badge freq-${p.severity}`}>{p.severity}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalibrationCard({ entries }: { entries: CalibrationEntry[] }) {
  return (
    <div className="trust-card trust-calibration">
      <h3>Confidence Calibration</h3>
      <div className="calibration-question">Is Aedis getting more honest?</div>
      <table className="calibration-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Raw</th>
            <th>Calibrated</th>
            <th>Eval</th>
            <th>Agreed?</th>
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, 10).map((e) => {
            const evalPct = typeof e.evaluationScore === "number" ? pct(e.evaluationScore) : "n/a";
            const calibratedPct = typeof e.calibratedConfidence === "number" ? pct(e.calibratedConfidence) : "-";
            const agreed = e.direction === "aligned" ? "yes"
              : e.direction === "aedis-overconfident" ? "over"
              : e.direction === "aedis-underconfident" ? "under"
              : "-";
            const agreedColor = agreed === "yes" ? "green" : agreed === "over" ? "red" : agreed === "under" ? "yellow" : "gray";
            return (
              <tr key={e.runId}>
                <td className="cal-run" title={e.runId}>{e.runId.slice(0, 8)}</td>
                <td>{pct(e.rawConfidence)}</td>
                <td className={e.dampening < 1 ? "cal-dampened" : ""}>{calibratedPct}</td>
                <td>{evalPct}</td>
                <td><span className={`cal-badge cal-${agreedColor}`}>{agreed}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
