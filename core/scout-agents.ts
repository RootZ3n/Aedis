/**
 * Scout Agents — read-only investigation workers.
 *
 * Each scout type implements a focused investigation task using
 * deterministic file-system operations (search, read, parse). They
 * use the existing ScoutWorker helpers (grep, listDir, readFile) and
 * repo-index infrastructure. Model calls are only made when routing
 * says cloud/local — simple scouts are fully deterministic.
 *
 * Scout agents may:
 *   - search files, inspect repo structure, summarize modules
 *   - identify targets, tests, docs, risk areas
 *   - produce evidence summaries
 *
 * Scout agents may NOT:
 *   - edit files, run destructive commands, promote changes
 *   - bypass approval, hide uncertainty, make final build decisions
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, extname, basename, dirname } from "node:path";
import type { ScoutReport, ScoutReportType, ScoutFinding } from "./scout-report.js";

// ─── Shared helpers ──────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "coverage", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", ".tox", "build", "target",
  ".aedis", ".zendorium",
]);

const IGNORE_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "bun.lockb", "Cargo.lock", "poetry.lock",
]);

async function walkDir(
  dir: string,
  root: string,
  maxFiles: number = 2000,
): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [dir];

  while (queue.length > 0 && results.length < maxFiles) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && !IGNORE_FILES.has(entry.name)) {
        results.push(relative(root, full));
      }
    }
  }
  return results;
}

async function safeReadFile(path: string, maxBytes: number = 32768): Promise<string | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > maxBytes) return null;
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function makeScoutId(type: ScoutReportType): string {
  return `scout-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ─── 1. RepoMapScout ─────────────────────────────────────────────────

export async function runRepoMapScout(
  repoPath: string,
  modelProvider: string = "local",
  modelName: string = "local",
): Promise<ScoutReport> {
  const startedAt = new Date().toISOString();
  const root = resolve(repoPath);
  const findings: ScoutFinding[] = [];
  const risks: string[] = [];

  // Detect package manager
  const pkgManagers = [
    { file: "package.json", name: "npm/node" },
    { file: "Cargo.toml", name: "cargo/rust" },
    { file: "pyproject.toml", name: "python" },
    { file: "go.mod", name: "go" },
    { file: "Gemfile", name: "ruby" },
    { file: "pom.xml", name: "maven/java" },
    { file: "build.gradle", name: "gradle/java" },
  ];

  const detectedPkgManagers: string[] = [];
  for (const pm of pkgManagers) {
    const content = await safeReadFile(join(root, pm.file));
    if (content != null) {
      detectedPkgManagers.push(pm.name);
      findings.push({
        title: `Package manager: ${pm.name}`,
        evidence: `Found ${pm.file}`,
        files: [pm.file],
        confidence: 1.0,
      });
    }
  }

  // Detect framework
  const pkgContent = await safeReadFile(join(root, "package.json"));
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
      const frameworks = [
        { deps: ["react", "react-dom"], name: "React" },
        { deps: ["next"], name: "Next.js" },
        { deps: ["vue"], name: "Vue" },
        { deps: ["@angular/core"], name: "Angular" },
        { deps: ["express"], name: "Express" },
        { deps: ["fastify"], name: "Fastify" },
        { deps: ["hono"], name: "Hono" },
        { deps: ["svelte"], name: "Svelte" },
      ];
      for (const fw of frameworks) {
        if (fw.deps.some((d) => d in allDeps)) {
          findings.push({
            title: `Framework: ${fw.name}`,
            evidence: `Dependency found in package.json`,
            files: ["package.json"],
            confidence: 0.95,
          });
        }
      }

      // Test commands
      const scripts = pkg.scripts || {};
      const testCmd = scripts.test || scripts["test:unit"] || null;
      if (testCmd) {
        findings.push({
          title: "Test command detected",
          evidence: `npm test → ${testCmd}`,
          files: ["package.json"],
          confidence: 0.9,
        });
      }
    } catch {
      // Invalid package.json
    }
  }

  // App structure: list top-level dirs
  const allFiles = await walkDir(root, root, 500);
  const topDirs = new Set<string>();
  for (const f of allFiles) {
    const parts = f.split("/");
    if (parts.length > 1) topDirs.add(parts[0]);
  }

  findings.push({
    title: "Repository structure",
    evidence: `${allFiles.length} files, top-level directories: ${[...topDirs].sort().join(", ")}`,
    files: [...topDirs].map((d) => d + "/"),
    confidence: 1.0,
  });

  // Important directories
  const importantDirs = ["src", "lib", "core", "server", "api", "app", "pages", "components", "workers", "test", "tests", "__tests__", "spec"];
  const presentDirs = importantDirs.filter((d) => topDirs.has(d));
  if (presentDirs.length > 0) {
    findings.push({
      title: "Key directories",
      evidence: presentDirs.join(", "),
      files: presentDirs.map((d) => d + "/"),
      confidence: 0.9,
    });
  }

  return {
    scoutId: makeScoutId("repo_map"),
    type: "repo_map",
    modelProvider,
    modelName,
    localOrCloud: "deterministic",
    confidence: 0.85,
    summary: `Repository: ${detectedPkgManagers.join(", ") || "unknown"} project with ${allFiles.length} files`,
    findings,
    recommendedTargets: [],
    recommendedTests: [],
    risks,
    costUsd: 0,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

// ─── 2. TargetDiscoveryScout ─────────────────────────────────────────

export async function runTargetDiscoveryScout(
  repoPath: string,
  prompt: string,
  modelProvider: string = "local",
  modelName: string = "local",
): Promise<ScoutReport> {
  const startedAt = new Date().toISOString();
  const root = resolve(repoPath);
  const findings: ScoutFinding[] = [];
  const targets: string[] = [];

  const allFiles = await walkDir(root, root, 2000);

  // Extract keywords from prompt
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "can", "shall",
    "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "this", "that", "it", "and", "or", "but", "not", "no",
    "add", "create", "make", "build", "implement", "fix", "update",
    "change", "modify", "remove", "delete", "find", "where", "how",
    "what", "which", "file", "files", "code",
  ]);

  const keywords = prompt
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Score files by keyword match
  const scored: Array<{ file: string; score: number; matches: string[] }> = [];

  for (const file of allFiles) {
    const fileLower = file.toLowerCase();
    const parts = fileLower.split(/[/._-]/);
    let score = 0;
    const matches: string[] = [];

    for (const kw of keywords) {
      if (fileLower.includes(kw)) {
        score += 2;
        matches.push(kw);
      }
      for (const part of parts) {
        if (part === kw) {
          score += 3;
        } else if (part.includes(kw) || kw.includes(part)) {
          score += 1;
        }
      }
    }

    // Boost source files over tests/configs
    const ext = extname(file);
    if ([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"].includes(ext)) {
      score += 0.5;
    }
    if (file.includes("test") || file.includes("spec")) {
      score -= 1;
    }

    if (score > 0) {
      scored.push({ file, score, matches });
    }
  }

  // Sort by score descending, take top candidates
  scored.sort((a, b) => b.score - a.score);
  const topCandidates = scored.slice(0, 10);

  for (const candidate of topCandidates) {
    const confidence = Math.min(1, candidate.score / 10);
    findings.push({
      title: `Candidate: ${candidate.file}`,
      evidence: `Matched keywords: ${[...new Set(candidate.matches)].join(", ")} (score: ${candidate.score.toFixed(1)})`,
      files: [candidate.file],
      confidence,
    });
    targets.push(candidate.file);
  }

  // Also check for explicit file references in prompt
  const fileRefPattern = /(?:^|[\s(])([a-zA-Z0-9_./\\-]+\.(ts|tsx|js|jsx|py|rs|go|java|rb|php|css|html|md|json|yaml|yml|toml))\b/g;
  let match;
  while ((match = fileRefPattern.exec(prompt)) !== null) {
    const ref = match[1];
    if (allFiles.includes(ref) && !targets.includes(ref)) {
      targets.unshift(ref);
      findings.unshift({
        title: `Explicit reference: ${ref}`,
        evidence: "Directly referenced in prompt",
        files: [ref],
        confidence: 0.95,
      });
    }
  }

  return {
    scoutId: makeScoutId("target_discovery"),
    type: "target_discovery",
    modelProvider,
    modelName,
    localOrCloud: "deterministic",
    confidence: topCandidates.length > 0 ? Math.min(0.85, topCandidates[0].score / 8) : 0.2,
    summary: `Found ${topCandidates.length} candidate files from ${allFiles.length} total`,
    findings,
    recommendedTargets: targets.slice(0, 8),
    recommendedTests: [],
    risks: [],
    costUsd: 0,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

// ─── 3. TestDiscoveryScout ───────────────────────────────────────────

export async function runTestDiscoveryScout(
  repoPath: string,
  targetFiles: readonly string[],
  modelProvider: string = "local",
  modelName: string = "local",
): Promise<ScoutReport> {
  const startedAt = new Date().toISOString();
  const root = resolve(repoPath);
  const findings: ScoutFinding[] = [];
  const tests: string[] = [];

  const allFiles = await walkDir(root, root, 2000);

  // Find test files related to targets
  for (const target of targetFiles) {
    const base = basename(target, extname(target));
    const dir = dirname(target);

    const testPatterns = [
      `${base}.test`,
      `${base}.spec`,
      `${base}_test`,
      `test_${base}`,
      `${base}-test`,
    ];

    for (const file of allFiles) {
      const fileBase = basename(file, extname(file));
      if (testPatterns.some((p) => fileBase === p)) {
        tests.push(file);
        findings.push({
          title: `Test for ${target}`,
          evidence: `Found ${file}`,
          files: [file, target],
          confidence: 0.9,
        });
      }
    }

    // Check for __tests__ directory sibling
    const testDirs = ["__tests__", "tests", "test", "spec"];
    for (const td of testDirs) {
      const testDir = join(dir, td);
      for (const file of allFiles) {
        if (file.startsWith(testDir + "/") && basename(file, extname(file)).includes(base)) {
          if (!tests.includes(file)) {
            tests.push(file);
            findings.push({
              title: `Test in ${td}/ for ${target}`,
              evidence: `Found ${file}`,
              files: [file, target],
              confidence: 0.8,
            });
          }
        }
      }
    }
  }

  // Detect test runner
  const pkgContent = await safeReadFile(join(root, "package.json"));
  const testCommands: string[] = [];
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      const scripts = pkg.scripts || {};
      if (scripts.test) testCommands.push(`npm test`);
      if (scripts["test:unit"]) testCommands.push(`npm run test:unit`);

      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if ("vitest" in allDeps) testCommands.push("npx vitest run");
      else if ("jest" in allDeps) testCommands.push("npx jest");
      else if ("mocha" in allDeps) testCommands.push("npx mocha");
    } catch {
      // skip
    }
  }

  // Python tests
  if (allFiles.some((f) => f.endsWith(".py"))) {
    if (allFiles.some((f) => f.includes("pytest") || f.includes("conftest"))) {
      testCommands.push("pytest");
    }
  }

  if (testCommands.length > 0) {
    findings.push({
      title: "Test commands",
      evidence: testCommands.join(", "),
      confidence: 0.85,
    });
  }

  return {
    scoutId: makeScoutId("test_discovery"),
    type: "test_discovery",
    modelProvider,
    modelName,
    localOrCloud: "deterministic",
    confidence: tests.length > 0 ? 0.8 : 0.3,
    summary: `Found ${tests.length} test files, ${testCommands.length} test commands`,
    findings,
    recommendedTargets: [],
    recommendedTests: tests.slice(0, 10),
    risks: [],
    costUsd: 0,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

// ─── 4. RiskScout ────────────────────────────────────────────────────

export async function runRiskScout(
  repoPath: string,
  targetFiles: readonly string[],
  modelProvider: string = "local",
  modelName: string = "local",
): Promise<ScoutReport> {
  const startedAt = new Date().toISOString();
  const root = resolve(repoPath);
  const findings: ScoutFinding[] = [];
  const risks: string[] = [];

  const allFiles = await walkDir(root, root, 2000);

  // Check each target for risk signals
  for (const target of targetFiles) {
    const targetLower = target.toLowerCase();

    // Generated files
    if (
      targetLower.includes("generated") ||
      targetLower.includes(".gen.") ||
      targetLower.includes("auto-generated") ||
      targetLower.endsWith(".d.ts")
    ) {
      risks.push(`${target} appears to be generated — edits may be overwritten`);
      findings.push({
        title: `Generated file: ${target}`,
        evidence: "File name suggests it is auto-generated",
        files: [target],
        confidence: 0.7,
      });
    }

    // Config files
    if (
      targetLower.endsWith(".config.js") ||
      targetLower.endsWith(".config.ts") ||
      targetLower.endsWith(".json") ||
      targetLower.endsWith(".yaml") ||
      targetLower.endsWith(".yml") ||
      targetLower.endsWith(".toml") ||
      targetLower.endsWith(".env") ||
      targetLower.endsWith(".env.example")
    ) {
      risks.push(`${target} is a configuration file — changes may have broad impact`);
      findings.push({
        title: `Config file: ${target}`,
        evidence: "Configuration files affect system-wide behavior",
        files: [target],
        confidence: 0.8,
      });
    }

    // Secrets-adjacent
    if (
      targetLower.includes("secret") ||
      targetLower.includes("credential") ||
      targetLower.includes("password") ||
      targetLower.includes("auth") ||
      targetLower.includes("token") ||
      targetLower.includes(".env")
    ) {
      risks.push(`${target} is secrets-adjacent — review for credential exposure`);
      findings.push({
        title: `Secrets-adjacent: ${target}`,
        evidence: "File may contain or handle sensitive credentials",
        files: [target],
        confidence: 0.75,
      });
    }

    // Migrations
    if (
      targetLower.includes("migration") ||
      targetLower.includes("migrate") ||
      targetLower.includes("schema")
    ) {
      risks.push(`${target} is a migration file — changes are typically irreversible`);
      findings.push({
        title: `Migration: ${target}`,
        evidence: "Migration files affect persistent data",
        files: [target],
        confidence: 0.85,
      });
    }

    // Read file content for deeper risk signals
    const content = await safeReadFile(join(root, target), 16384);
    if (content) {
      // Destructive operations
      if (/\b(rm\s+-rf|DROP\s+TABLE|DELETE\s+FROM|TRUNCATE)\b/i.test(content)) {
        risks.push(`${target} contains destructive operations`);
        findings.push({
          title: `Destructive ops in ${target}`,
          evidence: "File contains DROP/DELETE/TRUNCATE/rm-rf patterns",
          files: [target],
          confidence: 0.9,
        });
      }

      // Hardcoded secrets patterns
      if (/(?:password|secret|api_key|token)\s*[:=]\s*['"][^'"]{8,}/i.test(content)) {
        risks.push(`${target} may contain hardcoded secrets`);
        findings.push({
          title: `Possible hardcoded secrets in ${target}`,
          evidence: "Pattern matches for hardcoded credentials detected",
          files: [target],
          confidence: 0.6,
        });
      }
    }
  }

  // Broad risk: check for risky files in the repo not in targets
  const riskyPatterns = [".env", "credentials", "secrets", "private-key"];
  for (const file of allFiles) {
    if (riskyPatterns.some((p) => file.toLowerCase().includes(p))) {
      if (!targetFiles.includes(file)) {
        findings.push({
          title: `Nearby risk: ${file}`,
          evidence: "Risky file exists near target area",
          files: [file],
          confidence: 0.5,
        });
      }
    }
  }

  return {
    scoutId: makeScoutId("risk"),
    type: "risk",
    modelProvider,
    modelName,
    localOrCloud: "deterministic",
    confidence: risks.length > 0 ? 0.75 : 0.6,
    summary: `${risks.length} risk signals found across ${targetFiles.length} target files`,
    findings,
    recommendedTargets: [],
    recommendedTests: [],
    risks,
    costUsd: 0,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

// ─── 5. DocsScout ────────────────────────────────────────────────────

export async function runDocsScout(
  repoPath: string,
  prompt: string,
  modelProvider: string = "local",
  modelName: string = "local",
): Promise<ScoutReport> {
  const startedAt = new Date().toISOString();
  const root = resolve(repoPath);
  const findings: ScoutFinding[] = [];
  const targets: string[] = [];

  const allFiles = await walkDir(root, root, 2000);

  // Find doc files
  const docFiles = allFiles.filter((f) => {
    const lower = f.toLowerCase();
    return (
      lower.endsWith(".md") ||
      lower.endsWith(".txt") ||
      lower.endsWith(".rst") ||
      lower.includes("readme") ||
      lower.includes("changelog") ||
      lower.includes("contributing") ||
      lower.includes("license") ||
      lower.includes("docs/") ||
      lower.includes("doc/") ||
      lower.includes("documentation/")
    );
  });

  // Rank docs by relevance to prompt
  const keywords = prompt
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const scored: Array<{ file: string; score: number }> = [];
  for (const file of docFiles) {
    let score = 0;
    const lower = file.toLowerCase();

    // README always relevant
    if (lower.includes("readme")) score += 3;

    // Keyword matching
    for (const kw of keywords) {
      if (lower.includes(kw)) score += 2;
    }

    // Content matching (if small enough)
    const content = await safeReadFile(join(root, file), 8192);
    if (content) {
      for (const kw of keywords) {
        if (content.toLowerCase().includes(kw)) score += 1;
      }
    }

    scored.push({ file, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const topDocs = scored.slice(0, 8);

  for (const doc of topDocs) {
    if (doc.score > 0) {
      targets.push(doc.file);
      findings.push({
        title: doc.file,
        evidence: `Relevance score: ${doc.score}`,
        files: [doc.file],
        confidence: Math.min(0.9, doc.score / 6),
      });
    }
  }

  return {
    scoutId: makeScoutId("docs"),
    type: "docs",
    modelProvider,
    modelName,
    localOrCloud: "deterministic",
    confidence: targets.length > 0 ? 0.7 : 0.3,
    summary: `Found ${docFiles.length} doc files, ${targets.length} relevant to task`,
    findings,
    recommendedTargets: targets,
    recommendedTests: [],
    risks: [],
    costUsd: 0,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────

export interface RunScoutsInput {
  readonly repoPath: string;
  readonly prompt: string;
  readonly scoutTypes: readonly ScoutReportType[];
  readonly targetFiles?: readonly string[];
  readonly modelProvider?: string;
  readonly modelName?: string;
}

export async function runScouts(input: RunScoutsInput): Promise<ScoutReport[]> {
  const {
    repoPath,
    prompt,
    scoutTypes,
    targetFiles = [],
    modelProvider = "local",
    modelName = "local",
  } = input;

  const reports: ScoutReport[] = [];

  for (const type of scoutTypes) {
    try {
      let report: ScoutReport;
      switch (type) {
        case "repo_map":
          report = await runRepoMapScout(repoPath, modelProvider, modelName);
          break;
        case "target_discovery":
          report = await runTargetDiscoveryScout(repoPath, prompt, modelProvider, modelName);
          break;
        case "test_discovery":
          report = await runTestDiscoveryScout(repoPath, targetFiles, modelProvider, modelName);
          break;
        case "risk":
          report = await runRiskScout(repoPath, targetFiles, modelProvider, modelName);
          break;
        case "docs":
          report = await runDocsScout(repoPath, prompt, modelProvider, modelName);
          break;
        default:
          continue;
      }
      reports.push(report);
    } catch (err) {
      // Scout failure is non-fatal — report it but continue
      reports.push({
        scoutId: makeScoutId(type),
        type,
        modelProvider,
        modelName,
        localOrCloud: "deterministic",
        confidence: 0,
        summary: `Scout ${type} failed: ${err instanceof Error ? err.message : String(err)}`,
        findings: [],
        recommendedTargets: [],
        recommendedTests: [],
        risks: [`Scout ${type} failed — evidence unavailable`],
        costUsd: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    }
  }

  return reports;
}
