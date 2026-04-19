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
    if (/\b(fix|bug|broken|crash|error|issue)\b/.test(lower)) return "bugfix";
    if (/\b(refactor|clean|restructure|reorganize|extract)\b/.test(lower)) return "refactor";
    if (/\b(scaffold|create|init|bootstrap|setup|new repo)\b/.test(lower)) return "scaffold";
    if (/\b(test|spec|coverage)\b/.test(lower)) return "test";
    if (/\b(config|env|setting|toggle)\b/.test(lower)) return "config";
    if (/\b(doc|readme|explain|document)\b/.test(lower)) return "docs";
    if (/\b(investigate|explore|understand|audit|check)\b/.test(lower)) return "investigation";
    return "feature";
  }

  private extractTargets(request: string): string[] {
    const filePatterns = request.match(/[\w\-./]+\.(ts|tsx|js|jsx|json|md|yaml|yml)/g);
    const dirPatterns = request.match(/(?:src|lib|core|modules|apps|workers|router)\/[\w\-./]*/g);
    return [...new Set([...(filePatterns ?? []), ...(dirPatterns ?? [])])];
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
