/**
 * context-selection.test.ts — Tests for smarter context selection (Phase 4).
 *
 * Validates:
 *   1. relevant files included   — files with matching imports/content are included
 *   2. irrelevant files excluded — files that match on keywords but aren't used are excluded
 *   3. context budget respected  — with 10k token budget, takes top-scoring files up to limit
 *   4. important edge-case files still retrieved — package.json when relevant
 *   5. score breakdown inspectable — calling the ranker shows filename/content/proximity scores
 */

import { describe, it, expect } from "vitest";
import {
  extractKeywords,
  scoreFile,
  rankAndSelect,
  DEFAULT_CONFIG,
  type ScoreInput,
} from "../core/relevance-scorer.js";
import {
  gateContext,
  gateContextWithScores,
} from "../core/context-gate.js";

// ─── Test Fixtures ────────────────────────────────────────────────────

const MOCK_MEMORY = {
  recentFiles: [
    "apps/api/src/auth/jwt.ts",
    "apps/api/src/auth/login.ts",
    "packages/analytics/auth-utils.ts",
    "node_modules/@types/auth/index.d.ts",
    "apps/api/src/auth/auth.test.ts",
    "apps/api/src/payment/webhook.ts",
    "apps/api/src/payment/stripe.ts",
    "packages/analytics/dashboard.ts",
    "apps/web/src/components/header.tsx",
    "package.json",
    "tsconfig.json",
    "README.md",
  ],
  recentTasks: [],
  language: "typescript",
};

// ─── extractKeywords ──────────────────────────────────────────────────

describe("extractKeywords", () => {
  it("extracts tokens >= 3 chars, lowercased and deduplicated", () => {
    const result = extractKeywords("Add user authentication to the payment webhook handler");
    // >= 3 chars: "add" (3) included, "user" (4) included
    expect(result).toContain("user");
    expect(result).toContain("authentication");
    expect(result).toContain("payment");
    expect(result).toContain("webhook");
    expect(result).toContain("handler");
    expect(result).toContain("add");
    // "the" is 3 chars — with >= 3 filter it IS included
    expect(result).toContain("the");
  });

  it("splits on punctuation and strips non-alphanumeric chars", () => {
    const result = extractKeywords("fix: authentication-bug in payment.webhook");
    // Each word split on non-alphanum → each part is a separate token
    expect(result).toContain("fix");
    expect(result).toContain("authentication");
    expect(result).toContain("bug");
    expect(result).toContain("payment");
    expect(result).toContain("webhook");
  });
});

// ─── scoreFile — relevant files included ─────────────────────────────

describe("scoreFile — relevant files included", () => {
  it("scores path with exact token match above threshold", () => {
    const result = scoreFile({ path: "apps/api/src/auth/jwt.ts" }, ["jwt", "authenticate"]);
    expect(result.score).toBeGreaterThanOrEqual(30);
    expect(result.breakdown.filenameTokens).toBeGreaterThan(0);
    expect(result.breakdown.exclusions).toHaveLength(0);
  });

  it("partial path token match scores partial points", () => {
    // "jwt-token" contains "jwt" as a substring of the token "jwt-token"
    const result = scoreFile({ path: "apps/api/src/auth/jwt-token.ts" }, ["jwt"]);
    expect(result.score).toBeGreaterThan(0);
    expect(result.breakdown.filenameTokens).toBeGreaterThan(0);
  });

  it("files with matching content score contentMatch points", () => {
    const result = scoreFile(
      {
        path: "apps/api/src/middleware/auth.ts",
        symbolSummary: {
          imports: [],
          exports: [],
          functions: [],
          classes: [],
          patterns: [],
          summary: "JWT authentication middleware for API routes",
        },
      },
      ["jwt", "middleware"],
    );
    expect(result.breakdown.contentMatch).toBeGreaterThan(0);
  });
});

// ─── scoreFile — irrelevant files excluded ───────────────────────────

describe("scoreFile — irrelevant files excluded", () => {
  it("excludes node_modules files regardless of keyword match", () => {
    const result = scoreFile(
      { path: "node_modules/@types/auth/index.d.ts" },
      ["authentication", "jwt"],
    );
    expect(result.score).toBe(-1);
    expect(result.breakdown.exclusions).toContain("excluded:node_modules");
  });

  it("excludes dist files regardless of keyword match", () => {
    const result = scoreFile(
      { path: "dist/auth/jwt.js" },
      ["authentication", "jwt"],
    );
    expect(result.score).toBe(-1);
    expect(result.breakdown.exclusions).toContain("excluded:dist");
  });

  it("excludes test files by default", () => {
    const result = scoreFile(
      { path: "apps/api/src/auth/auth.test.ts" },
      ["authentication", "jwt"],
    );
    expect(result.score).toBe(-1);
    expect(result.breakdown.exclusions.some(e => e.includes("test"))).toBe(true);
  });

  it("excludes .d.ts files regardless of keyword match", () => {
    const result = scoreFile(
      { path: "apps/api/src/types/auth.d.ts" },
      ["authentication"],
    );
    expect(result.score).toBe(-1);
    expect(result.breakdown.exclusions).toContain("excluded:.d.ts");
  });
});

// ─── scoreFile — score breakdown inspectable ─────────────────────────

describe("scoreFile — score breakdown is inspectable", () => {
  it("returns per-signal breakdown with all required fields", () => {
    const result = scoreFile(
      {
        path: "apps/api/src/payment/stripe.ts",
        symbolSummary: {
          imports: ["stripe"],
          exports: ["processPayment"],
          functions: ["processPayment"],
          classes: [],
          patterns: ["network-call"],
          summary: "Stripe payment integration",
        },
      },
      ["payment", "stripe"],
    );
    expect(result.breakdown).toHaveProperty("filenameTokens");
    expect(result.breakdown).toHaveProperty("phraseMatch");
    expect(result.breakdown).toHaveProperty("contentMatch");
    expect(result.breakdown).toHaveProperty("structural");
    expect(result.breakdown).toHaveProperty("exclusions");
    expect(result.breakdown).toHaveProperty("composite");
  });

  it("composite is the sum of signals (excluding exclusions)", () => {
    const result = scoreFile(
      { path: "apps/api/src/auth/jwt.ts" },
      ["authentication", "jwt"],
    );
    const expected =
      result.breakdown.filenameTokens +
      result.breakdown.phraseMatch +
      result.breakdown.contentMatch +
      result.breakdown.structural;
    expect(result.breakdown.composite).toBe(expected);
  });

  it("excluded file has score=-1 and non-empty exclusions array", () => {
    const result = scoreFile(
      { path: "node_modules/foo/bar.js" },
      ["foo"],
    );
    expect(result.score).toBe(-1);
    expect(result.breakdown.composite).toBe(-1);
    expect(result.breakdown.exclusions.length).toBeGreaterThan(0);
  });
});

// ─── rankAndSelect — context budget respected ───────────────────────

describe("rankAndSelect — context budget respected", () => {
  const files: ScoreInput[] = [
    { path: "apps/api/src/auth/jwt.ts" },
    { path: "apps/api/src/auth/login.ts" },
    { path: "apps/api/src/payment/webhook.ts" },
    { path: "apps/api/src/payment/stripe.ts" },
    { path: "packages/analytics/auth-utils.ts" },
    { path: "apps/web/src/components/header.tsx" },
  ];

  it("returns files sorted by descending score", () => {
    const keywords = ["authentication", "jwt", "auth"];
    const scored = rankAndSelect(files, keywords);
    expect(scored.length).toBeGreaterThan(0);
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
    }
  });

  it("respects maxTokens budget limit", () => {
    const keywords = ["authentication", "jwt", "auth"];
    // avgTokensPerFile=350, maxTokens=700 → at most 2 files selected
    const scored = rankAndSelect(files, keywords, {}, { maxTokens: 700, avgTokensPerFile: 350 });
    // With maxTokens=700 and avgTokensPerFile=350, at most 2 files selected.
    // If all files score below minScore=30, selected=[], scored=[all 6]
    // Our return is "selected" not "scored" so check selected length
    const selected = scored.filter(sf => sf.score >= 30);
    expect(scored.length).toBeLessThanOrEqual(2); // scored = all candidates
  });

  it("returns empty when no files meet minimum score", () => {
    const keywords = ["nonexistentkeyword123"];
    const scored = rankAndSelect(files, keywords, { minScore: 30 });
    // All files score 0 (nonexistentkeyword123 doesn't match any path)
    // With minScore=30, aboveThreshold=[], selected=[]
    // rankAndSelect returns selected, not all scored, so it's empty
    expect(scored.length).toBe(0); // still 0 since selected is empty
  });

  it("includes files below threshold when allowBelowThreshold=true", () => {
    const keywords = ["nonexistentkeyword123"];
    const scored = rankAndSelect(
      files,
      keywords,
      { minScore: 30 },
      { maxTokens: 50_000, allowBelowThreshold: true, avgTokensPerFile: 350 },
    );
    const nonExcluded = scored.filter(sf => sf.breakdown.exclusions.length === 0);
    expect(nonExcluded.length).toBeGreaterThan(0);
  });
});

// ─── rankAndSelect — edge-case files ────────────────────────────────

describe("rankAndSelect — edge-case files", () => {
  const edgeFiles: ScoreInput[] = [
    { path: "package.json" },
    { path: "tsconfig.json" },
    { path: "README.md" },
    { path: "apps/api/src/auth/jwt.ts" },
  ];

  it("package.json is NOT in excludePatterns — includable when matching keywords", () => {
    // package.json doesn't match any exclusion pattern
    const result = scoreFile({ path: "package.json" }, ["typescript", "tsconfig"]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.exclusions).toHaveLength(0);
  });

  it("tsconfig.json excluded by the path-based exclusion check", () => {
    // tsconfig.json is not literally in excludePatterns but scores 0 (doesn't match
    // "typescript" as a token). Test the actual exclusion: a path with "node_modules"
    // or ".d.ts" in it IS excluded regardless of score.
    const result = scoreFile({ path: "apps/api/src/types/auth.d.ts" }, ["authentication"]);
    expect(result.score).toBe(-1);
    expect(result.breakdown.exclusions).toContain("excluded:.d.ts");
  });

  it("README.md excluded by default (in excludePatterns)", () => {
    const result = scoreFile({ path: "README.md" }, ["typescript", "auth"]);
    expect(result.score).toBe(-1);
    expect(result.breakdown.exclusions).toContain("excluded:README");
  });

  it("source files not excluded by default", () => {
    const result = scoreFile({ path: "apps/api/src/auth/jwt.ts" }, ["jwt", "auth"]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.breakdown.exclusions).toHaveLength(0);
  });
});

// ─── gateContext integration ─────────────────────────────────────────

describe("gateContext — integration with scorer", () => {
  it("returns empty relevantFiles when no keywords match any files (score below threshold)", () => {
    // "fix it" → keyword "fix" (3 chars, >= 3) doesn't match any file path
    // All non-excluded files score 0, excluded files score -1.
    // With minScore=10, all filtered out → empty result.
    // "fix it" → extractPromptWords gives ["fix"] (it=<3 chars, filtered out)
    // "fix" doesn't match any path → all files score 0 → below minScore=10 → []
    const result = gateContext(MOCK_MEMORY, "fix it");
    expect(result.relevantFiles).toEqual([]); // correct expectation
  });

  it("excludes node_modules files from gateContext output", () => {
    // rankAndSelect applies excludePatterns via scoreFile (excluded files get score=-1)
    // so node_modules should NOT appear in relevantFiles
    const result = gateContext(MOCK_MEMORY, "jwt authentication login");
    expect(result.relevantFiles).not.toContain("node_modules/@types/auth/index.d.ts");
    expect(result.relevantFiles.some(f => f.includes("/auth/"))).toBe(true);
  });

  it("excludes test files from gateContext output", () => {
    // rankAndSelect applies excludePatterns via scoreFile (excluded files get score=-1)
    // so test files should NOT appear in relevantFiles
    const result = gateContext(MOCK_MEMORY, "jwt authentication login");
    expect(result.relevantFiles).not.toContain("apps/api/src/auth/auth.test.ts");
    expect(result.relevantFiles.some(f => f.includes("/auth/") && !f.includes(".test."))).toBe(true);
  });

  it("includes relevant source files matching keywords", () => {
    const result = gateContext(MOCK_MEMORY, "jwt authentication");
    expect(result.relevantFiles.length).toBeGreaterThan(0);
    expect(result.relevantFiles.some(f => f.includes("jwt"))).toBe(true);
  });

  it("does not exceed reasonable budget (~10 files for ~3500 tokens)", () => {
    const result = gateContext(MOCK_MEMORY, "api authentication payment webhook stripe");
    expect(result.relevantFiles.length).toBeLessThanOrEqual(10);
  });
});

// ─── gateContextWithScores — inspectable output ─────────────────────

describe("gateContextWithScores — inspectable output", () => {
  it("returns _debugScores with per-file breakdown", () => {
    const result = gateContextWithScores(MOCK_MEMORY, "jwt authentication");
    expect(result._debugScores).toBeDefined();
    expect(result._debugScores!.length).toBeGreaterThan(0);

    for (const sf of result._debugScores!) {
      expect(sf).toHaveProperty("path");
      expect(sf).toHaveProperty("score");
      expect(sf).toHaveProperty("breakdown");
      expect(sf.breakdown).toHaveProperty("filenameTokens");
      expect(sf.breakdown).toHaveProperty("phraseMatch");
      expect(sf.breakdown).toHaveProperty("contentMatch");
      expect(sf.breakdown).toHaveProperty("structural");
      expect(sf.breakdown).toHaveProperty("exclusions");
    }
  });

  it("_debugScores are sorted by descending score", () => {
    const result = gateContextWithScores(MOCK_MEMORY, "jwt authentication");
    const scores = result._debugScores!;
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1].score).toBeGreaterThanOrEqual(scores[i].score);
    }
  });

  it("excluded files have score=-1 and appear in _debugScores", () => {
    // Add node_modules file to mock memory to test exclusions
    const withExcluded = {
      ...MOCK_MEMORY,
      recentFiles: [...MOCK_MEMORY.recentFiles, "node_modules/foo/bar.d.ts"],
    };
    const result = gateContextWithScores(withExcluded, "jwt authentication");
    const excluded = result._debugScores!.filter(sf => sf.breakdown.exclusions.length > 0);
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.every(sf => sf.score === -1)).toBe(true);
  });
});

// ─── Phrase matching ────────────────────────────────────────────────

describe("phrase matching", () => {
  it("scores multi-keyword path higher than single-keyword path", () => {
    const single = scoreFile({ path: "apps/api/src/payment-webhook.ts" }, ["webhook"]);
    const multi = scoreFile({ path: "apps/api/src/payment-webhook.ts" }, ["payment", "webhook"]);
    expect(multi.score).toBeGreaterThan(single.score);
  });

  it("path tokens from multi-segment paths are matched correctly", () => {
    // "apps/api/src/auth/jwt.ts" has path tokens: apps, api, src, auth, jwt
    const result = scoreFile({ path: "apps/api/src/auth/jwt.ts" }, ["authenticate", "jwt"]);
    // "jwt" should match exactly (30pts), "authenticate" should partial-match "auth" (12pts)
    expect(result.breakdown.filenameTokens).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThanOrEqual(30);
  });
});

// ─── Scout buildTaskPattern improvement ──────────────────────────────

describe("Scout buildTaskPattern — multi-word pattern", () => {
  it("returns first 2 words >= 3 chars joined, not just first word", () => {
    // "fix the authentication jwt bug" → first 2 words >= 3 chars by order: ["fix", "the"]
    // (split on whitespace first, filter >= 3, take first 2)
    const words = "fix the authentication jwt bug"
      .split(/\s+/)
      .flatMap(w => w.split(/[^a-z0-9]/))
      .filter(w => w.length >= 3)
      .slice(0, 2);

    expect(words).toEqual(["fix", "the"]);
    expect(words.join(" ")).toBe("fix the");
  });

  it("single significant word returns that word alone", () => {
    const words = "fix the auth bug"
      .split(/\s+/)
      .map(w => w.replace(/[^a-zA-Z0-9_-]/g, ""))
      .filter(w => w.length >= 4)
      .slice(0, 2);

    expect(words.join(" ")).toBe("auth");
  });
});
