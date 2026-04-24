/**
 * relevance-scorer.ts — Multi-signal file relevance scoring for context selection.
 *
 * Replaces naive `path.includes(word)` matching in context-gate.ts and
 * scout.ts with a scored approach that:
 *   1. Assigns higher weights to filename token matches
 *   2. Scores multi-token phrase matches above single-token matches
 *   3. Uses a minimum score threshold to filter noise
 *   4. Excludes node_modules, dist, test fixtures unconditionally
 *   5. Supports budget-aware ranked selection
 *   6. Produces inspectable score breakdowns
 *
 * Design: Pure function, no I/O. Called with candidate file paths
 * and optional content hints (for import/proximity signals). For the
 * context-gate use case (no content hint), scoring is path-only.
 *
 * NOT a RAG/vector setup. Weighted scoring with thresholds only.
 */

import type { FileSymbolSummary } from "../workers/scout.js";

// ─── Types ───────────────────────────────────────────────────────────

/** Breakdown of the composite score for one file. */
export interface ScoreBreakdown {
  readonly filenameTokens: number;   // points from matching filename tokens
  readonly phraseMatch: number;     // points from multi-token phrase match
  readonly contentMatch: number;    // points from content match (imports/exports/summary)
  readonly structural: number;      // bonus from structural proximity (shared imports)
  readonly exclusions: readonly string[]; // reasons for exclusion (empty = included)
  readonly composite: number;        // weighted sum
}

export interface ScoredFile {
  readonly path: string;
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
}

/** Score signals available for a candidate file. */
export interface ScoreInput {
  /** Candidate file path (required). */
  readonly path: string;
  /**
   * Pre-extracted symbol summary for the file (optional).
   * When provided, enables structural/proximity scoring.
   * When absent, structural score is 0 (path-only scoring).
   */
  readonly symbolSummary?: FileSymbolSummary;
  /**
   * Import graph — a map of file path → files it imports (optional).
   * Used for structural proximity scoring.
   */
  readonly importGraph?: ReadonlyMap<string, readonly string[]>;
  /**
   * The set of target files for the current task.
   * Used for structural proximity: a candidate gets bonus points
   * if it imports (or is imported by) a target file.
   */
  readonly targetFiles?: readonly string[];
}

/** Configuration for the scorer. */
export interface ScorerConfig {
  /** Minimum composite score for a file to be included. Default: 10 */
  readonly minScore: number;
  /** Points per matched filename token. Default: 30 */
  readonly filenameTokenWeight: number;
  /** Points for a multi-token phrase match in path. Default: 50 */
  readonly phraseMatchWeight: number;
  /** Points per keyword match in content. Default: 5 */
  readonly contentMatchWeight: number;
  /** Max points from structural proximity. Default: 20 */
  readonly maxStructuralScore: number;
  /** Directories/files to always exclude regardless of score. */
  readonly excludePatterns: readonly string[];
  /**
   * Whether to include test files that match keywords.
   * When false (default), test files need very high scores to be included.
   */
  readonly includeTestFiles: boolean;
}

const DEFAULT_SCORER_CONFIG: ScorerConfig = {
  minScore: 10,
  filenameTokenWeight: 30,
  phraseMatchWeight: 50,
  contentMatchWeight: 5,
  maxStructuralScore: 20,
  excludePatterns: [
    "node_modules",
    "dist",
    ".git",
    "coverage",
    ".next",
    "__pycache__",
    "__tests__",
    ".test.",
    ".spec.",
    "_test.",
    "_spec.",
    ".d.ts",
    ".min.js",
    ".bundle.js",
    "CHANGELOG",
    "LICENSE",
    "README",
  ],
  includeTestFiles: false,
};

// ─── Keyword Extraction ──────────────────────────────────────────────

/**
 * Extract normalized keywords from a prompt. Returns unique tokens ≥4 chars.
 * Splits on whitespace first, then strips punctuation from each word individually
 * (so hyphenated compounds like "authentication-bug" become one token).
 */
export function extractKeywords(prompt: string): string[] {
  return Array.from(
    new Set(
      prompt
        .toLowerCase()
        .split(/\s+/)
        .flatMap(word => word.split(/[^a-z0-9]/))
        .filter(word => word.length >= 3),
    ),
  );
}

// ─── Path Token Extraction ──────────────────────────────────────────

/**
 * Extract meaningful tokens from a file path for matching.
 * Removes extensions, normalizes separators, splits on path separators.
 */
function extractPathTokens(filePath: string): string[] {
  const normalized = filePath
    .replace(/\\/g, "/")
    .replace(/\.[^/]+$/, "")  // strip extension
    .replace(/[^a-zA-Z0-9_]+/g, " ")
    .toLowerCase();
  return normalized.split(/\s+/).filter(t => t.length >= 2);
}

// ─── Multi-token Phrase Extraction ──────────────────────────────────

/**
 * Extract multi-token phrases (2-3 tokens) from a path for phrase matching.
 * E.g., "auth/jwt-token.ts" → ["auth jwt", "jwt token", "auth jwt token"]
 */
function extractPathPhrases(filePath: string): string[] {
  const normalized = filePath
    .replace(/\\/g, "/")
    .replace(/\.[^/]+$/, "")
    .replace(/[^a-zA-Z0-9_]+/g, " ")
    .toLowerCase();
  const tokens = normalized.split(/\s+/).filter(t => t.length >= 2);
  const phrases: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    phrases.push(`${tokens[i]} ${tokens[i + 1]}`);
    if (i < tokens.length - 2) {
      phrases.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
    }
  }
  return phrases;
}

// ─── Exclusion Check ────────────────────────────────────────────────

function isExcluded(filePath: string, patterns: readonly string[]): readonly string[] {
  const reasons: string[] = [];
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();

  for (const pattern of patterns) {
    if (normalized.includes(pattern.toLowerCase())) {
      reasons.push(`excluded:${pattern}`);
    }
  }
  return reasons;
}

// ─── Filename Token Scoring ─────────────────────────────────────────

/**
 * Score filename token matches. Each keyword that appears as a complete
 * token in the path scores `filenameTokenWeight` points. Partial token
 * matches score less.
 */
function scoreFilenameTokens(
  path: string,
  keywords: readonly string[],
  weight: number,
): number {
  const pathTokens = new Set(extractPathTokens(path));
  let score = 0;
  for (const kw of keywords) {
    if (pathTokens.has(kw)) {
      score += weight;
    } else {
      // Partial match: keyword is a substring of a path token
      for (const token of pathTokens) {
        if (token.includes(kw) && token.length > kw.length) {
          score += Math.round(weight * 0.4);
          break;
        }
      }
    }
  }
  return score;
}

// ─── Phrase Match Scoring ────────────────────────────────────────────

/**
 * Score multi-token phrase matches. Each phrase that matches exactly
 * scores `phraseMatchWeight` points.
 */
function scorePhraseMatch(
  path: string,
  keywords: readonly string[],
  weight: number,
): number {
  if (keywords.length < 2) return 0;

  const phrases = extractPathPhrases(path);
  let score = 0;

  // Build keyword pairs from the prompt for phrase matching
  for (let i = 0; i < keywords.length - 1; i++) {
    const phrase2 = `${keywords[i]} ${keywords[i + 1]}`;
    for (const ph of phrases) {
      if (ph === phrase2) {
        score += weight;
      } else if (ph.includes(phrase2) || phrase2.includes(ph)) {
        score += Math.round(weight * 0.5);
      }
    }
  }
  return score;
}

// ─── Content Match Scoring ──────────────────────────────────────────

function scoreContentMatch(
  content: string | undefined,
  keywords: readonly string[],
  weight: number,
): number {
  if (!content) return 0;
  const lower = content.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "g");
    const matches = lower.match(regex);
    if (matches) {
      score += matches.length * weight;
    }
  }
  return score;
}

// ─── Structural Proximity Scoring ────────────────────────────────────

function scoreStructural(
  filePath: string,
  symbolSummary: FileSymbolSummary | undefined,
  importGraph: ReadonlyMap<string, readonly string[]> | undefined,
  targetFiles: readonly string[] | undefined,
  maxScore: number,
): number {
  if (!targetFiles || targetFiles.length === 0) return 0;

  const targetSet = new Set(targetFiles);
  let score = 0;

  // Direct import relationship with a target file
  if (importGraph) {
    const imports = importGraph.get(filePath) ?? [];
    for (const imp of imports) {
      if (targetSet.has(imp)) {
        score += Math.round(maxScore * 0.6);
        break;
      }
    }
    // Reverse: something in targets imports this file
    for (const [dep, deps] of importGraph.entries()) {
      if (targetSet.has(dep)) {
        for (const d of deps) {
          if (d === filePath) {
            score += Math.round(maxScore * 0.6);
            break;
          }
        }
      }
    }
  }

  // Shared import: file and targets both import something in common
  // (structural cohesion signal)
  if (symbolSummary && symbolSummary.imports.length > 0) {
    const shared = symbolSummary.imports.filter(imp =>
      targetFiles.some(tf => tf.includes(imp) || imp.includes(tf.split("/").pop() ?? "")),
    );
    score += Math.min(shared.length * 5, Math.round(maxScore * 0.4));
  }

  return Math.min(score, maxScore);
}

// ─── Main Scoring Function ──────────────────────────────────────────

/**
 * Score a single file against the given keywords and configuration.
 * Returns a `ScoredFile` with composite score and per-signal breakdown.
 *
 * This is the primary entry point for scoring a candidate file.
 */
export function scoreFile(
  input: ScoreInput,
  keywords: readonly string[],
  config: Partial<ScorerConfig> = {},
): ScoredFile {
  const cfg: ScorerConfig = { ...DEFAULT_SCORER_CONFIG, ...config };
  const { path } = input;

  // Exclusion check first
  const exclusionReasons = isExcluded(path, cfg.excludePatterns);
  if (exclusionReasons.length > 0) {
    return {
      path,
      score: -1,
      breakdown: {
        filenameTokens: 0,
        phraseMatch: 0,
        contentMatch: 0,
        structural: 0,
        exclusions: exclusionReasons,
        composite: -1,
      },
    };
  }

  // Score each signal
  const filenameTokens = scoreFilenameTokens(path, keywords, cfg.filenameTokenWeight);
  const phraseMatch = scorePhraseMatch(path, keywords, cfg.phraseMatchWeight);
  const contentMatch = scoreContentMatch(
    input.symbolSummary?.summary,
    keywords,
    cfg.contentMatchWeight,
  );
  const structural = scoreStructural(
    path,
    input.symbolSummary,
    input.importGraph,
    input.targetFiles,
    cfg.maxStructuralScore,
  );

  const composite = filenameTokens + phraseMatch + contentMatch + structural;

  return {
    path,
    score: composite,
    breakdown: {
      filenameTokens,
      phraseMatch,
      contentMatch,
      structural,
      exclusions: [],
      composite,
    },
  };
}

// ─── Budget-Aware Ranked Selection ──────────────────────────────────

export interface RankedSelectOptions {
  /**
   * Maximum number of tokens to include.
   * Files are taken in descending score order until budget is exhausted.
   */
  readonly maxTokens: number;
  /**
   * Average tokens per file (used when file has no token estimate).
   * Default: 350
   */
  readonly avgTokensPerFile: number;
  /**
   * When true, include files even if their individual score is below
   * minScore threshold, as long as budget allows. Default: false.
   */
  readonly allowBelowThreshold: boolean;
}

const DEFAULT_RANKED_OPTIONS: RankedSelectOptions = {
  maxTokens: 32_000,
  avgTokensPerFile: 350,
  allowBelowThreshold: false,
};

/**
 * Score multiple files, rank them by composite score, and select the
 * top files that fit within the token budget.
 *
 * Returns scored files in descending score order, with exclusion reasons
 * attached to any files that were filtered by exclusion patterns.
 */
export function rankAndSelect(
  inputs: readonly ScoreInput[],
  keywords: readonly string[],
  config?: Partial<ScorerConfig>,
  rankedOptions?: Partial<RankedSelectOptions>,
): readonly ScoredFile[] {
  const opts = { ...DEFAULT_RANKED_OPTIONS, ...rankedOptions };
  const cfg = { ...DEFAULT_SCORER_CONFIG, ...config };

  // Score all candidates
  const scored = inputs.map(inp => scoreFile(inp, keywords, cfg));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Filter exclusions
  const included = scored.filter(sf => sf.breakdown.exclusions.length === 0);

  // Filter below threshold (unless allowBelowThreshold)
  const aboveThreshold = included.filter(
    sf => opts.allowBelowThreshold || sf.score >= cfg.minScore,
  );

  // Budget-aware selection: take top files until maxTokens exhausted
  let usedTokens = 0;
  const selected: ScoredFile[] = [];
  for (const sf of aboveThreshold) {
    if (usedTokens >= opts.maxTokens) break;
    selected.push(sf);
    usedTokens += opts.avgTokensPerFile;
  }

  // Return budget-limited selection (selected), not all scored files.
  // Callers that need all scored files for debug should call scoreFile directly.
  return selected;
}


// ─── Exported Defaults ───────────────────────────────────────────────

export { DEFAULT_SCORER_CONFIG as DEFAULT_CONFIG };
export type { ScorerConfig as RelevanceScorerConfig };
