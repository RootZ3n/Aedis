/**
 * ProvingCampaign — Aedis cross-repo proving UI.
 *
 * Shows:
 *   - Registered repos with trust badges
 *   - Campaign results per repo
 *   - Cross-repo insights
 *   - Quick-run buttons
 */

import React, { useEffect, useState, useCallback } from "react";

// ─── Types ──────────────────────────────────────────────────────────

type TrustBadge = "safe" | "safe-with-review" | "risky" | "blocked";

interface RegisteredRepo {
  id: string;
  path: string;
  name: string;
  size: string;
  language: string;
  framework: string;
  lastTestedAt: string | null;
  reliabilityScore: number | null;
  trustBadge: TrustBadge | null;
  campaignCount: number;
}

interface CampaignSummary {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
  avgConfidence: number;
  overconfidenceDetected: boolean;
}

interface CampaignReport {
  repoName: string;
  summary: CampaignSummary;
  trustBadge: TrustBadge;
  insights: string[];
  timestamp: string;
}

interface CrossRepoInsights {
  totalRepos: number;
  totalCampaigns: number;
  reposByBadge: Record<TrustBadge, number>;
  mostReliableRepos: { name: string; score: number }[];
  leastReliableRepos: { name: string; score: number }[];
  commonFailurePatterns: { pattern: string; repoCount: number }[];
  overconfidenceRepos: string[];
}

// ─── Component ──────────────────────────────────────────────────────

export function ProvingCampaign() {
  const [repos, setRepos] = useState<RegisteredRepo[]>([]);
  const [insights, setInsights] = useState<CrossRepoInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addPath, setAddPath] = useState("");
  const [runningId, setRunningId] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<CampaignReport | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [regRes, insRes] = await Promise.all([
        fetch("/campaign/repos"),
        fetch("/campaign/insights"),
      ]);
      if (regRes.ok) {
        const data = await regRes.json();
        setRepos(data.repos ?? []);
      }
      if (insRes.ok) {
        setInsights(await insRes.json());
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const addRepo = async () => {
    if (!addPath.trim()) return;
    try {
      const res = await fetch("/campaign/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: addPath.trim() }),
      });
      if (res.ok) {
        setAddPath("");
        refresh();
      }
    } catch { /* silently fail */ }
  };

  const removeRepoById = async (id: string) => {
    await fetch(`/campaign/repos/${id}`, { method: "DELETE" });
    refresh();
  };

  const runCampaignForRepo = async (repoId: string) => {
    setRunningId(repoId);
    setLastReport(null);
    try {
      const res = await fetch(`/campaign/run/${repoId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "planning" }),
      });
      if (res.ok) {
        const report = await res.json();
        setLastReport(report);
        refresh();
      }
    } catch { /* silently fail */ }
    setRunningId(null);
  };

  if (loading) return <div className="prove-loading">Loading proving data...</div>;
  if (error) return <div className="prove-error">Proving unavailable: {error}</div>;

  return (
    <div className="prove-campaign">
      <h2 className="prove-title">Proving Campaigns</h2>

      {/* Add repo */}
      <div className="prove-card prove-add">
        <div className="prove-add-row">
          <input
            className="prove-input"
            placeholder="Path to repo..."
            value={addPath}
            onChange={(e) => setAddPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addRepo()}
          />
          <button className="prove-btn" onClick={addRepo}>Register</button>
        </div>
      </div>

      {/* Cross-repo insights */}
      {insights && insights.totalRepos > 0 && (
        <InsightsCard insights={insights} />
      )}

      {/* Repo list */}
      {repos.length > 0 ? (
        <div className="prove-card prove-repos">
          <h3>Registered Repos</h3>
          <table className="prove-table">
            <thead>
              <tr>
                <th>Repo</th>
                <th>Type</th>
                <th>Files</th>
                <th>Runs</th>
                <th>Score</th>
                <th>Badge</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {repos.map((repo) => (
                <tr key={repo.id}>
                  <td className="prove-repo-name" title={repo.path}>{repo.name}</td>
                  <td>{repo.size}</td>
                  <td>{repo.language}</td>
                  <td>{repo.campaignCount}</td>
                  <td>{repo.reliabilityScore !== null ? `${Math.round(repo.reliabilityScore * 100)}%` : "-"}</td>
                  <td>{repo.trustBadge ? <Badge badge={repo.trustBadge} /> : "-"}</td>
                  <td className="prove-actions">
                    <button
                      className="prove-btn prove-btn-sm"
                      onClick={() => runCampaignForRepo(repo.id)}
                      disabled={runningId !== null}
                    >
                      {runningId === repo.id ? "Running..." : "Run"}
                    </button>
                    <button
                      className="prove-btn prove-btn-sm prove-btn-danger"
                      onClick={() => removeRepoById(repo.id)}
                    >
                      x
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="prove-card prove-empty">
          No repos registered. Add a repo path above to start proving.
        </div>
      )}

      {/* Last campaign report */}
      {lastReport && <ReportCard report={lastReport} />}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function Badge({ badge }: { badge: TrustBadge }) {
  const colors: Record<TrustBadge, string> = {
    safe: "green",
    "safe-with-review": "yellow",
    risky: "red",
    blocked: "gray",
  };
  const labels: Record<TrustBadge, string> = {
    safe: "Safe",
    "safe-with-review": "Review",
    risky: "Risky",
    blocked: "Blocked",
  };
  return <span className={`prove-badge badge-${colors[badge]}`}>{labels[badge]}</span>;
}

function InsightsCard({ insights }: { insights: CrossRepoInsights }) {
  return (
    <div className="prove-card prove-insights">
      <h3>Cross-Repo Insights</h3>
      <div className="prove-insight-grid">
        <div className="prove-stat">
          <div className="prove-stat-value">{insights.totalRepos}</div>
          <div className="prove-stat-label">Repos</div>
        </div>
        <div className="prove-stat">
          <div className="prove-stat-value">{insights.totalCampaigns}</div>
          <div className="prove-stat-label">Campaigns</div>
        </div>
        <div className="prove-stat">
          <div className="prove-stat-value prove-stat-green">{insights.reposByBadge.safe}</div>
          <div className="prove-stat-label">Safe</div>
        </div>
        <div className="prove-stat">
          <div className="prove-stat-value prove-stat-yellow">{insights.reposByBadge["safe-with-review"]}</div>
          <div className="prove-stat-label">Review</div>
        </div>
        <div className="prove-stat">
          <div className="prove-stat-value prove-stat-red">{insights.reposByBadge.risky + insights.reposByBadge.blocked}</div>
          <div className="prove-stat-label">Risky</div>
        </div>
      </div>

      {insights.commonFailurePatterns.length > 0 && (
        <div className="prove-insight-section">
          <div className="prove-insight-label">Common failures across repos:</div>
          <ul>
            {insights.commonFailurePatterns.map((p, i) => (
              <li key={i}>{p.pattern} ({p.repoCount} repos)</li>
            ))}
          </ul>
        </div>
      )}

      {insights.overconfidenceRepos.length > 0 && (
        <div className="prove-insight-section prove-insight-warn">
          Overconfidence detected in: {insights.overconfidenceRepos.join(", ")}
        </div>
      )}
    </div>
  );
}

function ReportCard({ report }: { report: CampaignReport }) {
  const s = report.summary;
  return (
    <div className="prove-card prove-report">
      <h3>
        Campaign Result: {report.repoName}
        <Badge badge={report.trustBadge} />
      </h3>
      <div className="prove-report-stats">
        {s.passed}/{s.total} passed, {s.failed} failed, {s.inconclusive} inconclusive
        {" "}&mdash; avg confidence {Math.round(s.avgConfidence * 100)}%
      </div>
      {report.insights.length > 0 && (
        <ul className="prove-report-insights">
          {report.insights.map((ins, i) => (
            <li key={i}>{ins}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
