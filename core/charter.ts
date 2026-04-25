/**
 * CharterGenerator — Turns a one-sentence user request into a structured build objective.
 *
 * The Charter is the "what and why" of a build run. It decomposes vague intent
 * into concrete deliverables, success criteria, and a quality bar. The Coordinator
 * feeds the Charter into the IntentObject before any worker sees it.
 */

import type {
  Charter,
  Constraint,
  Deliverable,
  QualityBar,
} from "./intent.js";

// ─── Analysis Types ──────────────────────────────────────────────────

export interface RequestAnalysis {
  /** The raw user request */
  raw: string;
  /** Detected intent category */
  category: RequestCategory;
  /** Extracted target files/modules if mentioned */
  targets: string[];
  /** Detected scope size */
  scopeEstimate: "trivial" | "small" | "medium" | "large" | "epic";
  /** Detected risk signals */
  riskSignals: string[];
  /** Ambiguities that need resolution or assumptions */
  ambiguities: string[];
}

export type RequestCategory =
  | "feature"
  | "bugfix"
  | "refactor"
  | "scaffold"
  | "config"
  | "test"
  | "docs"
  | "investigation";

// ─── Charter Generation ──────────────────────────────────────────────

export interface CharterGeneratorConfig {
  /** Default quality bar when not inferrable from request */
  defaultQualityBar: QualityBar;
  /** Maximum deliverables before requiring scope split */
  maxDeliverables: number;
  /** Whether to auto-add test deliverables for code changes */
  autoTestDeliverables: boolean;
}

const DEFAULT_CONFIG: CharterGeneratorConfig = {
  defaultQualityBar: "standard",
  maxDeliverables: 12,
  autoTestDeliverables: false,
};

export class CharterGenerator {
  private config: CharterGeneratorConfig;

  constructor(config: Partial<CharterGeneratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze a raw user request into structured signals.
   * This is the first pass — no LLM needed for basic classification.
   */
  analyzeRequest(request: string): RequestAnalysis {
    const lower = request.toLowerCase();

    const category = this.classifyCategory(lower);
    const targets = this.extractTargets(request);
    const scopeEstimate = this.estimateScope(lower, targets);
    const riskSignals = this.detectRiskSignals(lower);
    const ambiguities = this.detectAmbiguities(lower, targets);

    return {
      raw: request,
      category,
      targets,
      scopeEstimate,
      riskSignals,
      ambiguities,
    };
  }

  /**
   * Generate a Charter from a RequestAnalysis.
   * For complex requests, this should be augmented by an LLM call —
   * this method provides the deterministic scaffold.
   */
  generateCharter(analysis: RequestAnalysis): Charter {
    const objective = this.buildObjective(analysis);
    const successCriteria = this.buildSuccessCriteria(analysis);
    const deliverables = this.buildDeliverables(analysis);
    const qualityBar = this.determineQualityBar(analysis);

    if (deliverables.length > this.config.maxDeliverables) {
      throw new CharterScopeError(
        `Request produces ${deliverables.length} deliverables (max ${this.config.maxDeliverables}). ` +
          `Split into smaller requests or raise maxDeliverables.`
      );
    }

    return { objective, successCriteria, deliverables, qualityBar };
  }

  /**
   * Generate default constraints based on analysis.
   * The Coordinator may add more before sealing the IntentObject.
   */
  generateDefaultConstraints(analysis: RequestAnalysis): Constraint[] {
    const constraints: Constraint[] = [
      {
        kind: "rollback",
        description: "All changes must be revertible via git reset",
        hard: true,
      },
      {
        kind: "governance",
        description: "Every file change must trace to a deliverable in the charter",
        hard: true,
      },
    ];

    if (analysis.riskSignals.length > 0) {
      constraints.push({
        kind: "scope",
        description: `Risk signals detected: ${analysis.riskSignals.join(", ")}. Require Critic review before apply.`,
        hard: true,
      });
    }

    if (analysis.scopeEstimate === "large" || analysis.scopeEstimate === "epic") {
      constraints.push({
        kind: "budget",
        description: "Large scope — require cost estimate before execution",
        hard: false,
      });
    }

    return constraints;
  }

  // ─── Private: Classification ─────────────────────────────────────

  private classifyCategory(lower: string): RequestCategory {
    const isDocsIntent =
      /\b(doc(?:s|ument|umentation)?|readme|guide|explain|describe|write up)\b/.test(lower) ||
      /\bdocument\b.*\b(setup|configuration|config|provider|api|workflow)\b/.test(lower);
    if (isDocsIntent) return "docs";

    // Test category requires the user to actually be ASKING to write tests.
    // The old regex matched any occurrence of "test" — so "add // SMOKE TEST
    // comment at the top of X" was misclassified as a test-authoring task
    // and the Builder got a "Add test coverage for: ..." charter, which
    // produced bogus commit messages and the wrong edit. Require either an
    // imperative (add/write/create/implement + test), or a test-file noun
    // compound (test coverage / unit tests / spec file), or "spec for X".
    if (
      /\b(add|write|create|implement|generate|author|cover\s+with)\s+(a\s+|an\s+|new\s+|more\s+|unit\s+|integration\s+)?tests?\b/.test(lower) ||
      /\btests?\s+(coverage|suite|file|case|harness|for\s+\w+)\b/.test(lower) ||
      /\b(unit|integration|e2e|end-to-end)\s+tests?\b/.test(lower) ||
      /\bspec\s+(file|for)\b/.test(lower) ||
      /\btest\s+coverage\b/.test(lower)
    ) return "test";

    if (/\b(investigate|explore|understand|audit|diagnose|trace|inspect|analyze|check)\b/.test(lower)) {
      return "investigation";
    }

    if (
      /\b(config(?:ure)?|reconfig(?:ure)?|env|environment|setting|toggle|flag|option)\b/.test(lower) ||
      (/\b(set up|setup)\b/.test(lower) && !isDocsIntent)
    ) {
      return "config";
    }

    if (
      /\b(scaffold|bootstrap|boilerplate|skeleton)\b/.test(lower) ||
      /\b(init|initialize)\b.*\b(repo|repository|project|package|service)\b/.test(lower) ||
      /\bcreate\b.*\b(new\s+repo|new\s+project|starter|skeleton|scaffold)\b/.test(lower)
    ) {
      return "scaffold";
    }

    if (
      /\b(refactor|improve|clean(?:\s+up)?|restructure|reorganize|extract|simplify|tighten|standardize|unify|consolidate|harden)\b/.test(lower)
    ) {
      return "refactor";
    }

    const hasBugWord =
      /\b(bug|broken|crash|regression|incorrect|wrong|timeout)\b/.test(lower) ||
      /\b(throws?|failing|fails?)\b/.test(lower);
    const hasBugfixVerb = /\b(fix|repair|resolve|correct)\b/.test(lower);
    if (hasBugfixVerb && hasBugWord) return "bugfix";
    if (/\bbugfix\b/.test(lower)) return "bugfix";
    if (/\bis\s+(broken|incorrect|wrong)\b/.test(lower)) return "bugfix";
    if (/\bcrash(?:es|ing)?\b/.test(lower)) return "bugfix";

    return "feature";
  }

  private extractTargets(request: string): string[] {
    // Supported file extensions — widen beyond TS/JS so the charter can
    // pick up targets in Python projects, Godot games, and the other
    // repos Zen actually drives Aedis on. Keep the list explicit so a
    // stray word like "at the end" doesn't accidentally match.
    // Extensions ordered LONGEST-FIRST within each family so alternation
    // doesn't prematurely match a prefix (e.g. "home.tsx" must match .tsx
    // not .ts; "scenes/main.tscn" must match .tscn; "config.json" must
    // match .json not .js). \b at the end prevents runaway matches into
    // words that happen to start with a letter.
    const filePatterns = request.match(
      /[\w\-./]+\.(?:gdshader|svelte|scala|swift|tscn|tres|yaml|json|toml|html|scss|sass|less|pyi|mjs|cjs|tsx|jsx|cpp|hpp|php|bash|vue|sh|ts|js|md|yml|py|rs|go|cs|rb|gd|cc|lua|c|h|kt|java)\b/g,
    );
    // Directory/module patterns — include common non-TS layouts too
    // (`scripts/`, `scenes/`, `hymn_sources/`, etc.). Also include bare
    // `src/<identifier>` paths (no trailing slash) like `src/utils` or
    // `src/email` which are common in prompts but missed by the slash-only
    // pattern when the identifier isn't followed by another path segment.
    const dirPatterns = request.match(
      /(?:src|lib|core|modules|apps|workers|router|scripts|scenes|assets|utils|handlers|routes|services|models|views|templates|tests?|spec)\/[\w\-./]*/g,
    );
    // Bare src/ paths: src/utils, src/email.ts (src/ followed by identifier without trailing /)
    const bareSrcPatterns = request.match(/\bsrc\/[\w.-]+/g) ?? [];
    const normalizeTarget = (target: string): string => {
      const trimmed = target.trim();
      if (!trimmed) return "";
      return trimmed.replace(/[),:;]+$/g, "").replace(/\.$/, "");
    };
    const deduped = [
      ...new Set(
        [...(filePatterns ?? []), ...(dirPatterns ?? []), ...bareSrcPatterns]
          .map(normalizeTarget)
          .filter((target) => target.length > 0),
      ),
    ];
    return deduped.filter((target) =>
      !deduped.some((other) =>
        other !== target && (other.startsWith(`${target}/`) || other.includes(`/${target}/`)),
      ),
    );
  }

  private estimateScope(
    lower: string,
    targets: string[]
  ): RequestAnalysis["scopeEstimate"] {
    if (targets.length > 10) return "epic";
    if (targets.length > 5) return "large";
    if (targets.length > 2) return "medium";
    if (/\b(all|every|entire|whole|across)\b/.test(lower)) return "large";
    if (/\b(simple|quick|small|minor|tiny)\b/.test(lower)) return "trivial";
    return "small";
  }

  private detectRiskSignals(lower: string): string[] {
    const signals: string[] = [];
    if (/\b(delete|remove|drop|destroy)\b/.test(lower)) signals.push("destructive-operation");
    if (/\b(database|db|migration|schema)\b/.test(lower)) signals.push("data-layer");
    if (/\b(auth|token|secret|credential|password)\b/.test(lower)) signals.push("security-sensitive");
    if (/\b(deploy|prod|production|release)\b/.test(lower)) signals.push("production-facing");
    if (/\b(api|endpoint|route|public)\b/.test(lower)) signals.push("public-interface");
    return signals;
  }

  private detectAmbiguities(lower: string, targets: string[]): string[] {
    const ambiguities: string[] = [];
    if (targets.length === 0) ambiguities.push("No specific files/modules mentioned");
    if (/\b(maybe|possibly|might|could|or)\b/.test(lower))
      ambiguities.push("Request contains hedging language");
    if (/\b(better|improve|clean up|nice)\b/.test(lower))
      ambiguities.push("Subjective quality target — needs concrete criteria");
    return ambiguities;
  }

  // ─── Private: Charter Building ───────────────────────────────────

  private buildObjective(analysis: RequestAnalysis): string {
    const prefix: Record<RequestCategory, string> = {
      feature: "Implement",
      bugfix: "Fix",
      refactor: "Refactor",
      scaffold: "Scaffold",
      config: "Configure",
      test: "Add test coverage for",
      docs: "Document",
      investigation: "Investigate",
    };
    return `${prefix[analysis.category]}: ${analysis.raw}`;
  }

  private buildSuccessCriteria(analysis: RequestAnalysis): string[] {
    const criteria: string[] = [
      "All deliverables completed as specified",
      "No regressions in existing tests",
      "Changes are reviewable and revertible",
    ];

    if (analysis.category === "bugfix") {
      criteria.push("Bug no longer reproducible with original reproduction steps");
    }
    if (analysis.category === "feature" || analysis.category === "scaffold") {
      criteria.push("New code has corresponding test coverage");
    }
    if (analysis.riskSignals.includes("public-interface")) {
      criteria.push("Public API changes are backwards-compatible or versioned");
    }

    return criteria;
  }

  private buildDeliverables(analysis: RequestAnalysis): Deliverable[] {
    const deliverables: Deliverable[] = analysis.targets.map((target) => ({
      description: `${analysis.category === "scaffold" ? "Create" : "Modify"} ${target}`,
      targetFiles: [target],
      type: analysis.category === "scaffold" ? "create" as const : "modify" as const,
    }));

    // Auto-add test deliverable if configured
    if (
      this.config.autoTestDeliverables &&
      analysis.category !== "test" &&
      analysis.category !== "docs" &&
      analysis.category !== "investigation"
    ) {
      deliverables.push({
        description: "Add or update tests for changed code",
        targetFiles: analysis.targets.map((t) =>
          t.replace(/\.(ts|tsx)$/, ".test.$1")
        ),
        type: "create",
      });
    }

    // If no targets extracted, create a placeholder deliverable
    if (deliverables.length === 0) {
      deliverables.push({
        description: analysis.raw,
        targetFiles: [],
        type: analysis.category === "scaffold" ? "create" : "modify",
      });
    }

    return deliverables;
  }

  private determineQualityBar(analysis: RequestAnalysis): QualityBar {
    if (analysis.riskSignals.includes("security-sensitive")) return "hardened";
    if (analysis.riskSignals.includes("production-facing")) return "hardened";
    if (analysis.scopeEstimate === "trivial") return "minimal";
    return this.config.defaultQualityBar;
  }
}

// ─── Errors ──────────────────────────────────────────────────────────

export class CharterScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharterScopeError";
  }
}
