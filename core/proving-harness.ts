/**
 * Proving Harness — Real-world validation for Aedis planning reliability.
 *
 * Runs Aedis against test repos to measure planning accuracy. Does NOT
 * execute full builds — it runs the planning + dry-run pipeline and
 * compares predictions against expected outcomes based on repo structure.
 *
 * Usage:
 *   const suites = builtinProveSuites();
 *   const result = await runProveSuite(suites[0]);
 *   console.log(result.summary);
 */

import { runPreflight } from "./preflight.js";
import { generateDryRun } from "./dry-run.js";
import {
  loadMemory,
  findPatternWarnings,
  shouldRecommendStrictMode,
} from "./project-memory.js";
import { assessRepoReadiness } from "./repo-readiness.js";
import { classifyScope } from "./scope-classifier.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ProveCase {
  readonly name: string;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly expectedOutcome: "success" | "failure" | "partial";
  readonly expectedIssues?: readonly string[];
}

export interface ProveResult {
  readonly case: ProveCase;
  readonly timestamp: string;
  readonly preflightPassed: boolean;
  readonly preflightIssues: string[];
  readonly scopeType: string;
  readonly blastRadius: number;
  readonly predictedConfidence: number;
  readonly predictedFiles: string[];
  readonly repoReadinessLevel: string;
  readonly repoReadinessWarnings: string[];
  readonly strictModeRecommended: boolean;
  readonly patternWarnings: string[];
  readonly outcomeMatch: boolean;
  readonly durationMs: number;
  readonly verdict: "pass" | "fail" | "inconclusive";
}

export interface ProveSuite {
  readonly name: string;
  readonly cases: readonly ProveCase[];
}

export interface ProveSuiteResult {
  readonly suite: string;
  readonly timestamp: string;
  readonly results: readonly ProveResult[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly inconclusive: number;
    readonly avgConfidence: number;
    readonly avgDurationMs: number;
  };
}

// ─── Outcome matching ────────────────────────────────────────────────

function checkOutcomeMatch(
  expected: ProveCase["expectedOutcome"],
  confidence: number,
): boolean {
  switch (expected) {
    case "success":
      return confidence >= 0.7;
    case "failure":
      return confidence < 0.5;
    case "partial":
      return confidence >= 0.4 && confidence <= 0.75;
  }
}

function deriveVerdict(
  outcomeMatch: boolean,
  preflightPassed: boolean,
  preflightIssues: readonly string[],
  expectedOutcome: ProveCase["expectedOutcome"],
): ProveResult["verdict"] {
  // Preflight issues that prevent confident assessment → inconclusive
  if (preflightIssues.length > 0 && !preflightPassed) {
    return "inconclusive";
  }

  if (!outcomeMatch) {
    return "fail";
  }

  // For success cases, preflight must also pass
  if (expectedOutcome === "success" && !preflightPassed) {
    return "inconclusive";
  }

  return "pass";
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Run a single prove case against the planning pipeline.
 * Does not execute workers or write files — pure planning-level validation.
 */
export async function runProveCase(testCase: ProveCase): Promise<ProveResult> {
  const start = Date.now();

  // 1. Preflight
  const preflight = runPreflight({
    input: testCase.prompt,
    projectRoot: testCase.projectRoot,
  });
  const preflightPassed = preflight.ok;
  const preflightIssues = preflight.findings
    .filter((f) => f.severity === "block" || f.severity === "warn")
    .map((f) => f.message);

  // 2. Scope classification (quick, before full dry-run)
  const scope = classifyScope(testCase.prompt, []);

  // 3. Dry-run planning
  const plan = generateDryRun({
    input: testCase.prompt,
    projectRoot: testCase.projectRoot,
  });

  const predictedConfidence = plan.confidence.overall;
  const predictedFiles = [...plan.filesLikelyTouched];
  const blastRadius = plan.blastRadius.rawScore;

  // 4. Load memory and check for pattern warnings
  const memory = await loadMemory(testCase.projectRoot);
  const patternWarnings = findPatternWarnings(memory, {
    prompt: testCase.prompt,
    scopeType: scope.type,
    plannedFilesCount: predictedFiles.length,
  });

  // 5. Strict mode recommendation
  const strictModeRecommended = shouldRecommendStrictMode(memory, {
    prompt: testCase.prompt,
    scopeType: scope.type,
  });

  // 6. Repo readiness
  const readiness = assessRepoReadiness({
    projectRoot: testCase.projectRoot,
    changedFiles: predictedFiles,
    verificationReceipt: null,
  });

  // 7. Compare prediction against expected outcome
  const outcomeMatch = checkOutcomeMatch(
    testCase.expectedOutcome,
    predictedConfidence,
  );

  const verdict = deriveVerdict(
    outcomeMatch,
    preflightPassed,
    preflightIssues,
    testCase.expectedOutcome,
  );

  return {
    case: testCase,
    timestamp: new Date().toISOString(),
    preflightPassed,
    preflightIssues,
    scopeType: scope.type,
    blastRadius,
    predictedConfidence,
    predictedFiles,
    repoReadinessLevel: readiness.level,
    repoReadinessWarnings: [...readiness.warnings],
    strictModeRecommended,
    patternWarnings,
    outcomeMatch,
    durationMs: Date.now() - start,
    verdict,
  };
}

/**
 * Run all cases in a suite sequentially and aggregate results.
 */
export async function runProveSuite(
  suite: ProveSuite,
): Promise<ProveSuiteResult> {
  const results: ProveResult[] = [];

  for (const testCase of suite.cases) {
    results.push(await runProveCase(testCase));
  }

  const passed = results.filter((r) => r.verdict === "pass").length;
  const failed = results.filter((r) => r.verdict === "fail").length;
  const inconclusive = results.filter((r) => r.verdict === "inconclusive").length;

  const avgConfidence =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.predictedConfidence, 0) / results.length
      : 0;

  const avgDurationMs =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.durationMs, 0) / results.length
      : 0;

  return {
    suite: suite.name,
    timestamp: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      inconclusive,
      avgConfidence: Number(avgConfidence.toFixed(3)),
      avgDurationMs: Math.round(avgDurationMs),
    },
  };
}

/**
 * Returns built-in prove suites with structural test cases.
 * These test Aedis's planning/scoping — not actual code generation.
 * The projectRoot defaults to the current working directory; callers
 * should override per-case if pointing at real test repos.
 */
export function builtinProveSuites(): ProveSuite[] {
  const defaultRoot = process.cwd();

  return [
    {
      name: "core-planning-reliability",
      cases: [
        {
          name: "healthy single file",
          projectRoot: defaultRoot,
          prompt: "fix the bug in src/utils.ts",
          expectedOutcome: "success",
        },
        {
          name: "missing tests",
          projectRoot: defaultRoot,
          prompt: "refactor the auth module",
          expectedOutcome: "partial",
          expectedIssues: ["missing-tests"],
        },
        {
          name: "architectural scope",
          projectRoot: defaultRoot,
          prompt: "rename all database functions everywhere",
          expectedOutcome: "failure",
          expectedIssues: ["blast-radius-high", "decomposition-required"],
        },
      ],
    },
  ];
}

// ─── Cross-repo proving ─────────────────────────────────────────────

export interface RepoProfile {
  readonly path: string;
  readonly name: string;
  readonly language: string;
  readonly hasTests: boolean;
  readonly hasTsConfig: boolean;
  readonly hasPackageJson: boolean;
  readonly fileCount: number;
  readonly readinessLevel: string;
  readonly readinessWarnings: readonly string[];
}

export interface ProveReport {
  readonly repo: RepoProfile;
  readonly suite: string;
  readonly results: readonly ProveResult[];
  readonly summary: ProveSuiteResult["summary"];
  readonly portabilityAssessment: string;
  readonly recommendation: "safe" | "safe-with-review" | "risky" | "blocked";
  readonly timestamp: string;
}

/**
 * Profile a repo to understand its shape before running prove cases.
 */
export async function profileRepo(projectRoot: string): Promise<RepoProfile> {
  const { existsSync, readdirSync } = await import("node:fs");
  const { basename } = await import("node:path");

  const hasTsConfig = existsSync(`${projectRoot}/tsconfig.json`);
  const hasPackageJson = existsSync(`${projectRoot}/package.json`);

  // Count source files (lightweight — top 3 levels only)
  let fileCount = 0;
  const hasTests = hasTestDirectory(projectRoot);
  try {
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        if (e.isDirectory()) walk(`${dir}/${e.name}`, depth + 1);
        else if (/\.[jt]sx?$/.test(e.name)) fileCount++;
      }
    };
    walk(projectRoot, 0);
  } catch { /* permission errors */ }

  const readiness = assessRepoReadiness({
    projectRoot,
    changedFiles: [],
    verificationReceipt: null,
  });

  const memory = await loadMemory(projectRoot);

  return {
    path: projectRoot,
    name: basename(projectRoot),
    language: memory.language,
    hasTests,
    hasTsConfig,
    hasPackageJson,
    fileCount,
    readinessLevel: readiness.level,
    readinessWarnings: [...readiness.warnings],
  };
}

function hasTestDirectory(root: string): boolean {
  const { existsSync } = require("node:fs");
  return (
    existsSync(`${root}/__tests__`) ||
    existsSync(`${root}/tests`) ||
    existsSync(`${root}/test`) ||
    existsSync(`${root}/src/__tests__`)
  );
}

/**
 * Build a standard prove suite for an arbitrary repo.
 * Generates cases appropriate to the repo's shape.
 */
export function buildRepoProveSuite(profile: RepoProfile): ProveSuite {
  const cases: ProveCase[] = [
    {
      name: "single-file fix",
      projectRoot: profile.path,
      prompt: "fix a bug in the main module",
      expectedOutcome: "success",
    },
    {
      name: "multi-file feature",
      projectRoot: profile.path,
      prompt: "add a new feature that requires 3-4 files",
      expectedOutcome: profile.hasTests ? "success" : "partial",
    },
    {
      name: "broad refactor",
      projectRoot: profile.path,
      prompt: "refactor all utility functions across the codebase",
      expectedOutcome: profile.fileCount > 20 ? "failure" : "partial",
    },
  ];

  if (!profile.hasTests) {
    cases.push({
      name: "missing test coverage",
      projectRoot: profile.path,
      prompt: "add tests for the core module",
      expectedOutcome: "partial",
      expectedIssues: ["missing-tests"],
    });
  }

  return {
    name: `cross-repo:${profile.name}`,
    cases,
  };
}

/**
 * Run a full cross-repo prove workflow: profile → suite → run → report.
 */
export async function proveRepo(projectRoot: string): Promise<ProveReport> {
  const profile = await profileRepo(projectRoot);
  const suite = buildRepoProveSuite(profile);
  const result = await runProveSuite(suite);

  const passRate = result.summary.total > 0
    ? result.summary.passed / result.summary.total
    : 0;

  const recommendation: ProveReport["recommendation"] =
    passRate >= 0.8 ? "safe" :
    passRate >= 0.5 ? "safe-with-review" :
    passRate > 0 ? "risky" :
    "blocked";

  const portabilityParts: string[] = [];
  if (profile.readinessLevel !== "normal") {
    portabilityParts.push(`repo readiness: ${profile.readinessLevel}`);
  }
  if (!profile.hasTsConfig && profile.language === "typescript") {
    portabilityParts.push("missing tsconfig.json");
  }
  if (!profile.hasTests) {
    portabilityParts.push("no test directory detected");
  }
  if (profile.readinessWarnings.length > 0) {
    portabilityParts.push(profile.readinessWarnings[0]);
  }
  const portabilityAssessment = portabilityParts.length > 0
    ? portabilityParts.join("; ")
    : "no portability issues detected";

  return {
    repo: profile,
    suite: suite.name,
    results: result.results,
    summary: result.summary,
    portabilityAssessment,
    recommendation,
    timestamp: new Date().toISOString(),
  };
}

// ─── Persistence ────────────────────────────────────────────────────

const MAX_STORED_REPORTS = 20;

/**
 * Persist a prove report to .aedis/prove-history.json.
 * Capped at MAX_STORED_REPORTS entries.
 */
export async function persistProveReport(
  storageRoot: string,
  report: ProveReport,
): Promise<void> {
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const dir = join(storageRoot, ".aedis");
  const path = join(dir, "prove-history.json");

  await mkdir(dir, { recursive: true });

  let history: ProveReport[] = [];
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) history = parsed;
  } catch { /* file doesn't exist yet */ }

  history.unshift(report);
  history = history.slice(0, MAX_STORED_REPORTS);

  await writeFile(path, JSON.stringify(history, null, 2), "utf8");
}

/**
 * Load prove history from .aedis/prove-history.json.
 */
export async function loadProveHistory(
  storageRoot: string,
): Promise<ProveReport[]> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const path = join(storageRoot, ".aedis", "prove-history.json");

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_STORED_REPORTS) : [];
  } catch {
    return [];
  }
}
