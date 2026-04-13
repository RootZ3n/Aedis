export type ScopeType =
  | "single-file"
  | "small-linked"       // 2-3 files, tightly coupled
  | "multi-file"         // 3-7 files, feature slice
  | "architectural"      // 8+ files or cross-cutting
  | "migration"          // schema/data migration
  | "cross-cutting-sweep"; // regex-rename, lint-fix, every-file-type changes

export interface GovernanceTriggers {
  /** Whether decomposition into waves is mandatory. */
  readonly decompositionRequired: boolean;
  /** Whether human approval is mandatory before apply. */
  readonly approvalRequired: boolean;
  /** Whether escalation to a stronger model is recommended. */
  readonly escalationRecommended: boolean;
  /** Whether wave-based execution with per-wave checkpoints is required. */
  readonly wavesRequired: boolean;
}

export interface ScopeClassification {
  readonly type: ScopeType;
  readonly blastRadius: number;
  readonly recommendDecompose: boolean;
  readonly reason: string;
  /**
   * Governance triggers derived from scope classification. The
   * Coordinator should enforce these — they replace the old
   * single-boolean `recommendDecompose` for driving pipeline behavior.
   */
  readonly governance: GovernanceTriggers;
}

const HIGH_IMPACT_KEYWORDS = ["rename", "refactor", "migrate", "all", "every"];
const SWEEP_KEYWORDS = ["everywhere", "across all", "every file", "global rename", "codemod", "find and replace"];

function normalizeFiles(files: readonly string[]): string[] {
  return Array.from(
    new Set(
      files
        .map((file) => file.trim())
        .filter((file) => file.length > 0),
    ),
  );
}

function estimateDependencyCount(files: readonly string[]): number {
  return files.reduce((sum, file) => {
    const normalized = file.toLowerCase();
    let count = 0;

    if (normalized.includes("schema") || normalized.includes("types") || normalized.endsWith(".d.ts")) {
      count += 3;
    }
    if (normalized.includes("index") || normalized.includes("coordinator") || normalized.includes("router")) {
      count += 2;
    }
    if (normalized.includes("test") || normalized.includes("spec") || normalized.endsWith(".md")) {
      count += 1;
    }

    return sum + count;
  }, 0);
}

function hasKeyword(prompt: string, keywords: readonly string[]): string[] {
  const normalized = prompt.toLowerCase();
  return keywords.filter((keyword) => normalized.includes(keyword));
}

export function classifyScope(prompt: string, files: readonly string[]): ScopeClassification {
  const normalizedFiles = normalizeFiles(files);
  const fileCount = normalizedFiles.length;
  const matchedKeywords = hasKeyword(prompt, HIGH_IMPACT_KEYWORDS);
  const sweepKeywords = hasKeyword(prompt, SWEEP_KEYWORDS);
  const dependencyCount = estimateDependencyCount(normalizedFiles);
  const blastRadius = fileCount + dependencyCount + matchedKeywords.length * 2 + sweepKeywords.length * 3;

  if (sweepKeywords.length > 0 || (matchedKeywords.includes("all") && matchedKeywords.includes("rename"))) {
    return {
      type: "cross-cutting-sweep",
      blastRadius,
      recommendDecompose: true,
      reason: `Cross-cutting sweep detected (${fileCount} file(s), sweep keywords: ${sweepKeywords.join(", ") || matchedKeywords.join(", ")}).`,
      governance: {
        decompositionRequired: true,
        approvalRequired: true,
        escalationRecommended: true,
        wavesRequired: true,
      },
    };
  }

  if (matchedKeywords.includes("migrate")) {
    return {
      type: "migration",
      blastRadius,
      recommendDecompose: true,
      reason: `Migration keyword detected with ${fileCount} file(s) and dependency score ${dependencyCount}.`,
      governance: {
        decompositionRequired: true,
        approvalRequired: true,
        escalationRecommended: fileCount >= 5,
        wavesRequired: true,
      },
    };
  }

  if (fileCount <= 1 && dependencyCount <= 1 && matchedKeywords.length === 0) {
    return {
      type: "single-file",
      blastRadius,
      recommendDecompose: false,
      reason: "Single-file scope with low dependency pressure and no broad-change keywords.",
      governance: {
        decompositionRequired: false,
        approvalRequired: false,
        escalationRecommended: false,
        wavesRequired: false,
      },
    };
  }

  if (fileCount >= 8 || dependencyCount >= 10 || matchedKeywords.includes("all") || matchedKeywords.includes("every")) {
    return {
      type: "architectural",
      blastRadius,
      recommendDecompose: true,
      reason: `Wide change surface detected (${fileCount} file(s), dependency score ${dependencyCount}, keywords: ${matchedKeywords.join(", ") || "none"}).`,
      governance: {
        decompositionRequired: true,
        approvalRequired: true,
        escalationRecommended: true,
        wavesRequired: true,
      },
    };
  }

  if (fileCount >= 3 || dependencyCount >= 4 || matchedKeywords.includes("rename") || matchedKeywords.includes("refactor")) {
    return {
      type: "multi-file",
      blastRadius,
      recommendDecompose: true,
      reason: `Multi-file coordination likely (${fileCount} file(s), dependency score ${dependencyCount}, keywords: ${matchedKeywords.join(", ") || "none"}).`,
      governance: {
        decompositionRequired: fileCount >= 5,
        approvalRequired: fileCount >= 5 || matchedKeywords.includes("refactor"),
        escalationRecommended: false,
        wavesRequired: fileCount >= 4,
      },
    };
  }

  // Small linked change: 2 files or low multi-file with no strong keywords
  if (fileCount === 2 || (fileCount <= 3 && dependencyCount <= 3)) {
    return {
      type: "small-linked",
      blastRadius,
      recommendDecompose: false,
      reason: `Small linked change set (${fileCount} file(s), dependency score ${dependencyCount}).`,
      governance: {
        decompositionRequired: false,
        approvalRequired: false,
        escalationRecommended: false,
        wavesRequired: false,
      },
    };
  }

  return {
    type: "multi-file",
    blastRadius,
    recommendDecompose: false,
    reason: `Scope extends beyond a trivial single-file change but remains bounded (${fileCount} file(s), dependency score ${dependencyCount}).`,
    governance: {
      decompositionRequired: false,
      approvalRequired: false,
      escalationRecommended: false,
      wavesRequired: false,
    },
  };
}
