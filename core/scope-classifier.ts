export interface ScopeClassification {
  readonly type: "single-file" | "multi-file" | "architectural" | "migration";
  readonly blastRadius: number;
  readonly recommendDecompose: boolean;
  readonly reason: string;
}

const HIGH_IMPACT_KEYWORDS = ["rename", "refactor", "migrate", "all", "every"];

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
  const dependencyCount = estimateDependencyCount(normalizedFiles);
  const blastRadius = fileCount + dependencyCount + matchedKeywords.length * 2;

  if (matchedKeywords.includes("migrate")) {
    return {
      type: "migration",
      blastRadius,
      recommendDecompose: true,
      reason: `Migration keyword detected with ${fileCount} file(s) and dependency score ${dependencyCount}.`,
    };
  }

  if (fileCount <= 1 && dependencyCount <= 1 && matchedKeywords.length === 0) {
    return {
      type: "single-file",
      blastRadius,
      recommendDecompose: false,
      reason: "Single-file scope with low dependency pressure and no broad-change keywords.",
    };
  }

  if (fileCount >= 8 || dependencyCount >= 10 || matchedKeywords.includes("all") || matchedKeywords.includes("every")) {
    return {
      type: "architectural",
      blastRadius,
      recommendDecompose: true,
      reason: `Wide change surface detected (${fileCount} file(s), dependency score ${dependencyCount}, keywords: ${matchedKeywords.join(", ") || "none"}).`,
    };
  }

  if (fileCount >= 3 || dependencyCount >= 4 || matchedKeywords.includes("rename") || matchedKeywords.includes("refactor")) {
    return {
      type: "multi-file",
      blastRadius,
      recommendDecompose: true,
      reason: `Multi-file coordination likely (${fileCount} file(s), dependency score ${dependencyCount}, keywords: ${matchedKeywords.join(", ") || "none"}).`,
    };
  }

  return {
    type: "multi-file",
    blastRadius,
    recommendDecompose: false,
    reason: `Scope extends beyond a trivial single-file change but remains bounded (${fileCount} file(s), dependency score ${dependencyCount}).`,
  };
}
