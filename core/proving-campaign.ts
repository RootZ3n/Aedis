/**
 * Proving Campaign System — cross-repo validation and trust measurement.
 *
 * Builds on the proving harness to support:
 *   1. Repo registry — track repos under test
 *   2. Real proving runs — bounded Coordinator execution (no auto-commit)
 *   3. Campaign reports — per-repo and cross-repo insights
 *   4. Trust badges — "safe" / "safe-with-review" / "risky" / "blocked"
 *
 * All state is file-based (.aedis/campaign-registry.json) and bounded.
 * Campaign runs never auto-commit or perform destructive operations.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import {
  profileRepo,
  runProveCase,
  persistProveReport,
  type RepoProfile,
  type ProveCase,
  type ProveResult,
  type ProveReport,
} from "./proving-harness.js";
import { assessRepoReadiness } from "./repo-readiness.js";
import { withRepoLock, writeJsonAtomicLocked } from "./file-lock.js";

// ─── Repo Registry ──────────────────────────────────────────────────

export type RepoSize = "small" | "medium" | "large" | "monorepo" | "messy";

export interface RegisteredRepo {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly size: RepoSize;
  readonly language: string;
  readonly framework: string;
  readonly addedAt: string;
  readonly lastTestedAt: string | null;
  readonly reliabilityScore: number | null;
  readonly trustBadge: TrustBadge | null;
  readonly profile: RepoProfile | null;
  /** Number of proving campaigns run against this repo. */
  readonly campaignCount: number;
}

export type TrustBadge = "safe" | "safe-with-review" | "risky" | "blocked";

export interface RepoRegistry {
  readonly repos: readonly RegisteredRepo[];
  readonly updatedAt: string;
}

// ─── Campaign Types ─────────────────────────────────────────────────

export interface CampaignCase {
  readonly name: string;
  readonly prompt: string;
  readonly expectedOutcome: ProveCase["expectedOutcome"];
  /** "planning" = dry-run only. "execution" = real Coordinator run (bounded, no auto-commit). */
  readonly mode: "planning" | "execution";
}

export interface CampaignResult {
  readonly case: CampaignCase;
  readonly proveResult: ProveResult | null;
  readonly executionResult: ExecutionProveResult | null;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly durationMs: number;
}

/** Result from a real (bounded) Coordinator run. */
export interface ExecutionProveResult {
  readonly runId: string;
  readonly verdict: string;
  readonly confidence: number;
  readonly executionVerified: boolean;
  readonly commitSha: string | null;
  readonly filesChanged: number;
  readonly verificationVerdict: string | null;
  readonly verificationCoverage: number | null;
  readonly validationDepth: number | null;
  readonly evaluationScore: number | null;
  readonly evaluationPassed: boolean | null;
  readonly mergeAction: string | null;
  readonly durationMs: number;
}

export interface CampaignReport {
  readonly repoId: string;
  readonly repoName: string;
  readonly repoPath: string;
  readonly profile: RepoProfile;
  readonly cases: readonly CampaignResult[];
  readonly summary: CampaignSummary;
  readonly trustBadge: TrustBadge;
  readonly insights: readonly string[];
  readonly timestamp: string;
}

export interface CampaignSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly inconclusive: number;
  readonly planningCases: number;
  readonly executionCases: number;
  readonly avgConfidence: number;
  readonly avgDurationMs: number;
  readonly verificationCoverage: number | null;
  readonly overconfidenceDetected: boolean;
}

// ─── Cross-repo Insights ────────────────────────────────────────────

export interface CrossRepoInsights {
  readonly totalRepos: number;
  readonly totalCampaigns: number;
  readonly reposByBadge: Readonly<Record<TrustBadge, number>>;
  readonly mostReliableRepos: readonly { name: string; score: number }[];
  readonly leastReliableRepos: readonly { name: string; score: number }[];
  readonly commonFailurePatterns: readonly { pattern: string; repoCount: number }[];
  readonly overconfidenceRepos: readonly string[];
  readonly generatedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────

const REGISTRY_FILE = "campaign-registry.json";
const CAMPAIGN_DIR = "campaigns";
const MAX_REPOS = 50;
const MAX_CAMPAIGNS_PER_REPO = 10;
const AEDIS_DIR = ".aedis";

function registryPath(storageRoot: string): string {
  return join(resolve(storageRoot), AEDIS_DIR, REGISTRY_FILE);
}

function campaignDir(storageRoot: string): string {
  return join(resolve(storageRoot), AEDIS_DIR, CAMPAIGN_DIR);
}

// ─── Registry Operations ────────────────────────────────────────────

export async function loadRegistry(storageRoot: string): Promise<RepoRegistry> {
  try {
    const raw = await readFile(registryPath(storageRoot), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.repos)) {
      return { repos: parsed.repos.slice(0, MAX_REPOS), updatedAt: parsed.updatedAt ?? new Date().toISOString() };
    }
  } catch { /* missing or corrupt */ }
  return { repos: [], updatedAt: new Date().toISOString() };
}

export async function saveRegistry(storageRoot: string, registry: RepoRegistry): Promise<void> {
  const dir = join(resolve(storageRoot), AEDIS_DIR);
  await mkdir(dir, { recursive: true });
  const capped: RepoRegistry = {
    repos: registry.repos.slice(0, MAX_REPOS),
    updatedAt: new Date().toISOString(),
  };
  // Hold the per-repo advisory lock across the atomic write. Prevents
  // two concurrent runs from racing each other's registry updates and
  // losing one run's learning.
  await withRepoLock(registryPath(storageRoot), () =>
    writeJsonAtomicLocked(registryPath(storageRoot), capped),
  );
}

function inferSize(profile: RepoProfile): RepoSize {
  if (profile.fileCount > 500) return "monorepo";
  if (profile.fileCount > 100) return "large";
  if (profile.fileCount > 30) return "medium";
  if (profile.readinessLevel === "high-risk") return "messy";
  return "small";
}

function inferFramework(profile: RepoProfile): string {
  // Simple heuristic from language + common markers
  if (profile.hasTsConfig) return "typescript";
  if (profile.hasPackageJson) return "node";
  return profile.language;
}

export async function registerRepo(
  storageRoot: string,
  repoPath: string,
  overrides?: { name?: string; size?: RepoSize; framework?: string },
): Promise<RegisteredRepo> {
  const registry = await loadRegistry(storageRoot);
  const absPath = resolve(repoPath);

  // Check for duplicate
  const existing = registry.repos.find((r) => r.path === absPath);
  if (existing) return existing;

  const profile = await profileRepo(absPath);
  const id = `repo_${Date.now().toString(36)}`;

  const repo: RegisteredRepo = {
    id,
    path: absPath,
    name: overrides?.name ?? profile.name,
    size: overrides?.size ?? inferSize(profile),
    language: profile.language,
    framework: overrides?.framework ?? inferFramework(profile),
    addedAt: new Date().toISOString(),
    lastTestedAt: null,
    reliabilityScore: null,
    trustBadge: null,
    profile,
    campaignCount: 0,
  };

  await saveRegistry(storageRoot, {
    repos: [repo, ...registry.repos].slice(0, MAX_REPOS),
    updatedAt: new Date().toISOString(),
  });

  return repo;
}

export async function removeRepo(storageRoot: string, repoId: string): Promise<boolean> {
  const registry = await loadRegistry(storageRoot);
  const filtered = registry.repos.filter((r) => r.id !== repoId);
  if (filtered.length === registry.repos.length) return false;
  await saveRegistry(storageRoot, { ...registry, repos: filtered });
  return true;
}

// ─── Campaign Execution ─────────────────────────────────────────────

/**
 * Generate campaign cases for a repo. These are the prove cases
 * that will be run against the repo. The mode determines whether
 * each case uses planning-only (dry-run) or real execution.
 */
export function generateCampaignCases(
  profile: RepoProfile,
  mode: "planning" | "execution" | "mixed" = "planning",
): CampaignCase[] {
  const cases: CampaignCase[] = [];
  const caseMode = mode === "mixed" ? "planning" : mode;

  cases.push({
    name: "single-file fix",
    prompt: "fix a bug in the main module",
    expectedOutcome: "success",
    mode: caseMode,
  });

  cases.push({
    name: "multi-file feature",
    prompt: "add a new feature that touches 3-4 files",
    expectedOutcome: profile.hasTests ? "success" : "partial",
    mode: caseMode,
  });

  cases.push({
    name: "refactor scope",
    prompt: "refactor the utility functions for consistency",
    expectedOutcome: profile.fileCount > 50 ? "failure" : "partial",
    mode: caseMode,
  });

  if (!profile.hasTests) {
    cases.push({
      name: "missing test infrastructure",
      prompt: "add tests for the core module",
      expectedOutcome: "partial",
      mode: caseMode,
    });
  }

  // For mixed mode, make the last case an execution case
  if (mode === "mixed" && cases.length > 1) {
    const last = cases[cases.length - 1];
    cases[cases.length - 1] = { ...last, mode: "execution" };
  }

  return cases;
}

/**
 * Run a campaign against a registered repo.
 * Planning cases use the dry-run harness.
 * Execution cases use the Coordinator (bounded, no auto-commit).
 *
 * The optional `coordinator` parameter enables real execution cases.
 * When null, execution cases fall back to planning mode.
 */
export async function runCampaign(
  storageRoot: string,
  repoId: string,
  cases: readonly CampaignCase[],
  coordinator?: {
    submit: (input: { input: string; projectRoot?: string }) => Promise<{
      runId: string;
      verdict: string;
      humanSummary?: {
        confidence?: { overall: number };
        filesTouchedCount?: number;
      } | null;
      executionVerified: boolean;
      commitSha: string | null;
      verificationReceipt?: {
        verdict: string;
        coverageRatio: number | null;
        validatedRatio: number | null;
      } | null;
      evaluation?: {
        aggregate?: { averageScore: number; overallPass: boolean } | null;
      } | null;
      mergeDecision?: { action: string } | null;
      durationMs: number;
    }>;
  } | null,
): Promise<CampaignReport> {
  const registry = await loadRegistry(storageRoot);
  const repo = registry.repos.find((r) => r.id === repoId);
  if (!repo) throw new Error(`Repo ${repoId} not found in registry`);

  const profile = repo.profile ?? await profileRepo(repo.path);
  const results: CampaignResult[] = [];

  for (const campaignCase of cases) {
    const start = Date.now();

    if (campaignCase.mode === "execution" && coordinator) {
      // Real bounded execution
      try {
        const receipt = await coordinator.submit({
          input: campaignCase.prompt,
          projectRoot: repo.path,
        });

        const execResult: ExecutionProveResult = {
          runId: receipt.runId,
          verdict: receipt.verdict,
          confidence: receipt.humanSummary?.confidence?.overall ?? 0,
          executionVerified: receipt.executionVerified,
          commitSha: receipt.commitSha,
          filesChanged: receipt.humanSummary?.filesTouchedCount ?? 0,
          verificationVerdict: receipt.verificationReceipt?.verdict ?? null,
          verificationCoverage: receipt.verificationReceipt?.coverageRatio ?? null,
          validationDepth: receipt.verificationReceipt?.validatedRatio ?? null,
          evaluationScore: receipt.evaluation?.aggregate?.averageScore ?? null,
          evaluationPassed: receipt.evaluation?.aggregate?.overallPass ?? null,
          mergeAction: receipt.mergeDecision?.action ?? null,
          durationMs: receipt.durationMs,
        };

        const verdict = execResult.verdict === "success" ? "pass"
          : execResult.verdict === "partial" ? "inconclusive"
          : "fail";

        results.push({
          case: campaignCase,
          proveResult: null,
          executionResult: execResult,
          verdict,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        results.push({
          case: campaignCase,
          proveResult: null,
          executionResult: null,
          verdict: "fail",
          durationMs: Date.now() - start,
        });
      }
    } else {
      // Planning-only (dry-run)
      const proveResult = await runProveCase({
        name: campaignCase.name,
        projectRoot: repo.path,
        prompt: campaignCase.prompt,
        expectedOutcome: campaignCase.expectedOutcome,
      });

      results.push({
        case: campaignCase,
        proveResult,
        executionResult: null,
        verdict: proveResult.verdict,
        durationMs: Date.now() - start,
      });
    }
  }

  const summary = summarizeCampaign(results);
  const trustBadge = computeTrustBadge(summary);
  const insights = generateInsights(results, profile, summary);
  const reliabilityScore = summary.total > 0 ? summary.passed / summary.total : 0;

  const report: CampaignReport = {
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    profile,
    cases: results,
    summary,
    trustBadge,
    insights,
    timestamp: new Date().toISOString(),
  };

  // Persist campaign report
  await persistCampaignReport(storageRoot, report);

  // Update registry with results
  const updatedRepo: RegisteredRepo = {
    ...repo,
    lastTestedAt: new Date().toISOString(),
    reliabilityScore: Number(reliabilityScore.toFixed(3)),
    trustBadge,
    campaignCount: repo.campaignCount + 1,
  };
  const updatedRepos = registry.repos.map((r) => r.id === repoId ? updatedRepo : r);
  await saveRegistry(storageRoot, { repos: updatedRepos, updatedAt: new Date().toISOString() });

  // Also persist as a ProveReport for backwards compatibility
  await persistProveReport(storageRoot, {
    repo: profile,
    suite: `campaign:${repo.name}`,
    results: results.filter((r) => r.proveResult).map((r) => r.proveResult!),
    summary: {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      inconclusive: summary.inconclusive,
      avgConfidence: summary.avgConfidence,
      avgDurationMs: summary.avgDurationMs,
    },
    portabilityAssessment: insights.join("; "),
    recommendation: trustBadge,
    timestamp: new Date().toISOString(),
  });

  return report;
}

function summarizeCampaign(results: readonly CampaignResult[]): CampaignSummary {
  const passed = results.filter((r) => r.verdict === "pass").length;
  const failed = results.filter((r) => r.verdict === "fail").length;
  const inconclusive = results.filter((r) => r.verdict === "inconclusive").length;
  const planningCases = results.filter((r) => r.case.mode === "planning").length;
  const executionCases = results.filter((r) => r.case.mode === "execution").length;

  const confidences = results
    .map((r) => r.proveResult?.predictedConfidence ?? r.executionResult?.confidence ?? 0)
    .filter((c) => c > 0);
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  const avgDurationMs = results.length > 0
    ? results.reduce((a, r) => a + r.durationMs, 0) / results.length : 0;

  const coverages = results
    .map((r) => r.executionResult?.verificationCoverage)
    .filter((c): c is number => typeof c === "number");
  const verificationCoverage = coverages.length > 0
    ? coverages.reduce((a, b) => a + b, 0) / coverages.length : null;

  const overconfidenceDetected = results.some((r) => {
    if (!r.executionResult) return false;
    return r.executionResult.confidence >= 0.7 && r.executionResult.evaluationPassed === false;
  });

  return {
    total: results.length,
    passed,
    failed,
    inconclusive,
    planningCases,
    executionCases,
    avgConfidence: Number(avgConfidence.toFixed(3)),
    avgDurationMs: Math.round(avgDurationMs),
    verificationCoverage,
    overconfidenceDetected,
  };
}

function computeTrustBadge(summary: CampaignSummary): TrustBadge {
  if (summary.total === 0) return "blocked";
  const passRate = summary.passed / summary.total;
  if (passRate >= 0.8 && !summary.overconfidenceDetected) return "safe";
  if (passRate >= 0.5) return "safe-with-review";
  if (passRate > 0) return "risky";
  return "blocked";
}

function generateInsights(
  results: readonly CampaignResult[],
  profile: RepoProfile,
  summary: CampaignSummary,
): string[] {
  const insights: string[] = [];

  if (summary.overconfidenceDetected) {
    insights.push("Overconfidence detected: Aedis predicted success but evaluation disagreed");
  }

  if (!profile.hasTests) {
    insights.push("No test directory: verification coverage will be limited");
  }

  if (profile.readinessLevel !== "normal") {
    insights.push(`Repo readiness: ${profile.readinessLevel}`);
  }

  const failedCases = results.filter((r) => r.verdict === "fail");
  if (failedCases.length > 0) {
    const failedNames = failedCases.map((r) => r.case.name).slice(0, 3);
    insights.push(`Failed cases: ${failedNames.join(", ")}`);
  }

  if (summary.verificationCoverage !== null && summary.verificationCoverage < 0.5) {
    insights.push(`Low verification coverage: ${Math.round(summary.verificationCoverage * 100)}%`);
  }

  const scopeFailures = results.filter(
    (r) => r.verdict === "fail" && r.proveResult && r.proveResult.blastRadius > 10,
  );
  if (scopeFailures.length > 0) {
    insights.push("High blast-radius tasks tend to fail in this repo");
  }

  return insights.slice(0, 6);
}

// ─── Campaign Persistence ───────────────────────────────────────────

async function persistCampaignReport(
  storageRoot: string,
  report: CampaignReport,
): Promise<void> {
  const dir = campaignDir(storageRoot);
  await mkdir(dir, { recursive: true });

  const repoFile = join(dir, `${report.repoId}.json`);
  // Read-modify-write must happen inside the lock so two runs
  // submitting the same repo don't drop each other's history.
  await withRepoLock(repoFile, async () => {
    let history: CampaignReport[] = [];
    try {
      const raw = await readFile(repoFile, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) history = parsed;
    } catch { /* first campaign for this repo */ }

    history.unshift(report);
    history = history.slice(0, MAX_CAMPAIGNS_PER_REPO);

    await writeJsonAtomicLocked(repoFile, history);
  });
}

export async function loadCampaignHistory(
  storageRoot: string,
  repoId: string,
): Promise<CampaignReport[]> {
  const repoFile = join(campaignDir(storageRoot), `${repoId}.json`);
  try {
    const raw = await readFile(repoFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_CAMPAIGNS_PER_REPO) : [];
  } catch {
    return [];
  }
}

// ─── Cross-Repo Insights ────────────────────────────────────────────

export async function computeCrossRepoInsights(
  storageRoot: string,
): Promise<CrossRepoInsights> {
  const registry = await loadRegistry(storageRoot);

  const reposByBadge: Record<TrustBadge, number> = {
    safe: 0,
    "safe-with-review": 0,
    risky: 0,
    blocked: 0,
  };

  const reliableRepos: { name: string; score: number }[] = [];
  const unreliableRepos: { name: string; score: number }[] = [];
  const failurePatterns = new Map<string, Set<string>>();
  const overconfidenceRepos: string[] = [];
  let totalCampaigns = 0;

  for (const repo of registry.repos) {
    if (repo.trustBadge) reposByBadge[repo.trustBadge]++;

    if (typeof repo.reliabilityScore === "number") {
      const entry = { name: repo.name, score: repo.reliabilityScore };
      if (repo.reliabilityScore >= 0.7) reliableRepos.push(entry);
      if (repo.reliabilityScore < 0.5) unreliableRepos.push(entry);
    }

    totalCampaigns += repo.campaignCount;

    // Load campaign history for failure pattern analysis
    const campaigns = await loadCampaignHistory(storageRoot, repo.id);
    for (const campaign of campaigns.slice(0, 3)) { // last 3 campaigns per repo
      for (const result of campaign.cases) {
        if (result.verdict === "fail") {
          const pattern = result.case.name;
          const repos = failurePatterns.get(pattern) ?? new Set();
          repos.add(repo.name);
          failurePatterns.set(pattern, repos);
        }
      }
      if (campaign.summary.overconfidenceDetected && !overconfidenceRepos.includes(repo.name)) {
        overconfidenceRepos.push(repo.name);
      }
    }
  }

  const commonFailures = [...failurePatterns.entries()]
    .filter(([, repos]) => repos.size >= 2)
    .map(([pattern, repos]) => ({ pattern, repoCount: repos.size }))
    .sort((a, b) => b.repoCount - a.repoCount)
    .slice(0, 5);

  return {
    totalRepos: registry.repos.length,
    totalCampaigns,
    reposByBadge,
    mostReliableRepos: reliableRepos.sort((a, b) => b.score - a.score).slice(0, 5),
    leastReliableRepos: unreliableRepos.sort((a, b) => a.score - b.score).slice(0, 5),
    commonFailurePatterns: commonFailures,
    overconfidenceRepos,
    generatedAt: new Date().toISOString(),
  };
}
