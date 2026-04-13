import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import type { VerificationReceipt } from "./verification-pipeline.js";

export interface RepoReadinessAssessment {
  readonly level: "normal" | "caution" | "high-risk";
  readonly warnings: readonly string[];
  readonly reviewRequired: boolean;
  readonly signals: readonly string[];
  readonly confidencePenalty: number;
}

const CONVENTIONAL_ROOTS = ["src", "app", "server", "lib", "packages", "services", "apps"];

export function assessRepoReadiness(input: {
  projectRoot: string;
  changedFiles: readonly string[];
  verificationReceipt: VerificationReceipt | null;
}): RepoReadinessAssessment {
  const warnings: string[] = [];
  const signals: string[] = [];
  let confidencePenalty = 0;

  const topLevel = safeReadDir(input.projectRoot);
  const hasConventionalRoot = CONVENTIONAL_ROOTS.some((dir) => topLevel.includes(dir));
  if (!hasConventionalRoot) {
    warnings.push("Repo layout is non-standard; path and dependency heuristics may be weaker here.");
    signals.push("unusual-layout");
    confidencePenalty += 0.05;
  }

  const implFiles = input.changedFiles.filter((file) => /\.(ts|tsx|js|jsx)$/.test(file) && !isTestFile(file));
  const filesMissingTests = implFiles.filter((file) => !hasPairedTest(input.projectRoot, file));
  if (filesMissingTests.length > 0) {
    warnings.push(`${filesMissingTests.length} changed implementation file(s) have no obvious test pair.`);
    signals.push("missing-tests");
    confidencePenalty += Math.min(filesMissingTests.length * 0.03, 0.09);
  }

  const namingStyles = new Set(
    input.changedFiles
      .map((file) => detectNamingStyle(basename(file, extname(file))))
      .filter((style): style is string => Boolean(style)),
  );
  if (namingStyles.size >= 3) {
    warnings.push("Changed files use mixed naming conventions; path-based pairing may be less reliable.");
    signals.push("inconsistent-naming");
    confidencePenalty += 0.04;
  }

  const importCoverage = estimateImportResolutionCoverage(input.projectRoot, implFiles);
  if (importCoverage.samples >= 2 && importCoverage.ratio < 0.6) {
    warnings.push(`Import graph coverage looks weak for changed files (${Math.round(importCoverage.ratio * 100)}% resolvable relative imports).`);
    signals.push("weak-import-coverage");
    confidencePenalty += 0.06;
  }

  if (input.verificationReceipt && typeof input.verificationReceipt.coverageRatio === "number" && input.verificationReceipt.coverageRatio < 0.75) {
    warnings.push(`Verification only covered ${Math.round(input.verificationReceipt.coverageRatio * 100)}% of changed files.`);
    signals.push("low-verification-coverage");
    confidencePenalty += 0.05;
  }

  const level: RepoReadinessAssessment["level"] =
    confidencePenalty >= 0.12 ? "high-risk" : confidencePenalty > 0 ? "caution" : "normal";

  return {
    level,
    warnings,
    reviewRequired: level !== "normal",
    signals,
    confidencePenalty: Number(confidencePenalty.toFixed(2)),
  };
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file);
}

function hasPairedTest(projectRoot: string, file: string): boolean {
  const ext = extname(file);
  const base = file.slice(0, -ext.length);
  const candidates = [
    `${base}.test${ext}`,
    `${base}.spec${ext}`,
    `${base}.test.ts`,
    `${base}.spec.ts`,
    file.replace(/\/src\//, "/__tests__/").replace(ext, `.test${ext}`),
  ];
  return candidates.some((candidate) => existsSync(resolve(projectRoot, candidate)));
}

function detectNamingStyle(name: string): string | null {
  if (name.includes("-")) return "kebab";
  if (name.includes("_")) return "snake";
  if (/^[A-Z]/.test(name)) return "pascal";
  if (/[a-z][A-Z]/.test(name)) return "camel";
  return null;
}

function estimateImportResolutionCoverage(projectRoot: string, files: readonly string[]): { ratio: number; samples: number } {
  let resolved = 0;
  let total = 0;

  for (const file of files) {
    const absPath = resolve(projectRoot, file);
    let content = "";
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    const dir = absPath.slice(0, absPath.lastIndexOf("/"));
    const matches = content.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g);
    for (const match of matches) {
      const specifier = match[1];
      total += 1;
      const base = resolve(dir, specifier);
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
        join(base, "index.js"),
      ];
      if (candidates.some((candidate) => existsSync(candidate))) {
        resolved += 1;
      }
    }
  }

  return {
    ratio: total > 0 ? resolved / total : 1,
    samples: total,
  };
}
