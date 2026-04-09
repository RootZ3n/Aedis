/**
 * SimpleMode — One-sentence entry point for Zendorium.
 *
 * Takes natural language like "add dark mode to the settings page"
 * and produces a structured Charter input ready for the Coordinator.
 *
 * SimpleMode is the front door for developers who want to describe
 * what they want in plain English and let Zendorium figure out the
 * how. It bridges the gap between human intent and machine-actionable
 * build plans without requiring the user to know the Charter schema.
 *
 * Flow: parse → classify → expand → return CharterInput
 */

import {
  CharterGenerator,
  type RequestAnalysis,
  type RequestCategory,
} from "./charter.js";
import type { CreateIntentParams, Charter, Constraint, Deliverable, QualityBar } from "./intent.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface SimpleModeInput {
  /** Raw natural language input */
  readonly text: string;
  /** Optional: caller-specified project root */
  readonly projectRoot?: string;
  /** Optional: force a specific quality bar */
  readonly qualityBar?: QualityBar;
  /** Optional: files the user explicitly mentioned */
  readonly hintFiles?: string[];
}

export interface ParsedIntent {
  /** Original input text */
  readonly raw: string;
  /** Classified intent type */
  readonly category: RequestCategory;
  /** Detected action verb */
  readonly action: string;
  /** Detected target (what is being acted on) */
  readonly target: string;
  /** Detected location (where in the codebase) */
  readonly location: string | null;
  /** Detected qualifier (how to do it) */
  readonly qualifier: string | null;
  /** Confidence in the parse 0-1 */
  readonly confidence: number;
  /** Full analysis from CharterGenerator */
  readonly analysis: RequestAnalysis;
}

export interface ExpandedCharter {
  /** Structured charter ready for IntentObject creation */
  readonly charterInput: CreateIntentParams;
  /** The parsed intent that produced this */
  readonly parsedFrom: ParsedIntent;
  /** Suggestions for the user if confidence is low */
  readonly suggestions: readonly string[];
  /** Whether this needs user confirmation before proceeding */
  readonly needsConfirmation: boolean;
}

// ─── SimpleMode ──────────────────────────────────────────────────────

export class SimpleMode {
  private charterGen: CharterGenerator;

  constructor() {
    this.charterGen = new CharterGenerator({ autoTestDeliverables: true });
  }

  /**
   * Parse raw input into a structured intent classification.
   */
  parse(input: SimpleModeInput): ParsedIntent {
    const text = input.text.trim();
    if (!text) {
      throw new SimpleModeError("Empty input");
    }

    const analysis = this.charterGen.analyzeRequest(text);
    const { action, target, location, qualifier } = this.extractComponents(text);

    // Merge hint files into analysis targets
    if (input.hintFiles?.length) {
      for (const f of input.hintFiles) {
        if (!analysis.targets.includes(f)) {
          (analysis.targets as string[]).push(f);
        }
      }
    }

    const confidence = this.computeConfidence(analysis, action, target);

    return {
      raw: text,
      category: analysis.category,
      action,
      target,
      location,
      qualifier,
      confidence,
      analysis,
    };
  }

  /**
   * Expand a parsed intent into a full Charter input
   * ready for IntentObject creation.
   */
  expand(parsed: ParsedIntent, opts?: { qualityBar?: QualityBar }): ExpandedCharter {
    const charter = this.charterGen.generateCharter(parsed.analysis);
    const constraints = this.charterGen.generateDefaultConstraints(parsed.analysis);

    // Override quality bar if specified
    const finalCharter: Charter = opts?.qualityBar
      ? { ...charter, qualityBar: opts.qualityBar }
      : charter;

    const charterInput: CreateIntentParams = {
      runId: "", // Coordinator will assign
      userRequest: parsed.raw,
      charter: finalCharter,
      constraints,
      exclusions: this.inferExclusions(parsed),
    };

    const suggestions = this.generateSuggestions(parsed);
    const needsConfirmation =
      parsed.confidence < 0.6 ||
      parsed.analysis.ambiguities.length > 2 ||
      parsed.analysis.riskSignals.length > 0;

    return {
      charterInput,
      parsedFrom: parsed,
      suggestions,
      needsConfirmation,
    };
  }

  /**
   * One-shot: parse and expand in a single call.
   * Returns the expanded charter ready for Coordinator.submit().
   */
  process(input: SimpleModeInput): ExpandedCharter {
    const parsed = this.parse(input);
    return this.expand(parsed, { qualityBar: input.qualityBar });
  }

  // ─── Component Extraction ─────────────────────────────────────────

  private extractComponents(text: string): {
    action: string;
    target: string;
    location: string | null;
    qualifier: string | null;
  } {
    const lower = text.toLowerCase();

    // Extract action verb (first verb-like word)
    const actionPatterns: [RegExp, string][] = [
      [/^(add|create|implement|build|scaffold|write)\b/i, "create"],
      [/^(fix|repair|resolve|patch|debug)\b/i, "fix"],
      [/^(refactor|restructure|reorganize|clean|extract|split)\b/i, "refactor"],
      [/^(update|modify|change|adjust|tweak)\b/i, "update"],
      [/^(remove|delete|drop|strip|kill)\b/i, "remove"],
      [/^(test|add tests|write tests|cover)\b/i, "test"],
      [/^(document|add docs|explain)\b/i, "document"],
      [/^(investigate|check|audit|explore|look at)\b/i, "investigate"],
      [/^(move|rename|relocate)\b/i, "move"],
      [/^(upgrade|migrate|bump)\b/i, "upgrade"],
    ];

    let action = "modify"; // default
    for (const [pattern, verb] of actionPatterns) {
      if (pattern.test(lower)) {
        action = verb;
        break;
      }
    }

    // Extract location (file paths, module names)
    const locationMatch = text.match(
      /(?:in|to|from|at|for)\s+([\w\-./]+(?:\.(?:ts|tsx|js|jsx|json|md|yaml|yml)))/i
    ) ?? text.match(
      /(?:in|to|from|at|for)\s+(?:the\s+)?([\w\-./]+(?:\/[\w\-./]*)?)/i
    );
    const location = locationMatch?.[1] ?? null;

    // Extract target (the thing being acted on)
    // Remove action verb and location to get the target
    let target = text;
    for (const [pattern] of actionPatterns) {
      target = target.replace(pattern, "").trim();
    }
    if (location) {
      target = target.replace(new RegExp(`(?:in|to|from|at|for)\\s+(?:the\\s+)?${escapeRegex(location)}`, "i"), "").trim();
    }
    // Clean up common filler
    target = target
      .replace(/^(the|a|an)\s+/i, "")
      .replace(/\s+(to|from|in|at|for)\s*$/i, "")
      .trim();

    // Extract qualifier (how/style)
    const qualifierMatch = text.match(
      /(?:using|with|via|through)\s+(.+?)(?:\s+(?:in|to|from|at|for)\s|$)/i
    );
    const qualifier = qualifierMatch?.[1] ?? null;

    return { action, target: target || text, location, qualifier };
  }

  // ─── Confidence Scoring ────────────────────────────────────────────

  private computeConfidence(
    analysis: RequestAnalysis,
    action: string,
    target: string
  ): number {
    let confidence = 0.5; // baseline

    // Boost for clear action verb
    if (action !== "modify") confidence += 0.15;

    // Boost for specific file targets
    if (analysis.targets.length > 0) confidence += 0.2;

    // Penalize for ambiguities
    confidence -= analysis.ambiguities.length * 0.1;

    // Boost for clear scope
    if (analysis.scopeEstimate === "trivial" || analysis.scopeEstimate === "small") {
      confidence += 0.1;
    }

    // Penalize for very short or very long inputs
    const wordCount = target.split(/\s+/).length;
    if (wordCount < 2) confidence -= 0.15;
    if (wordCount > 20) confidence -= 0.1;

    return Math.max(0, Math.min(1, confidence));
  }

  // ─── Exclusions ────────────────────────────────────────────────────

  private inferExclusions(parsed: ParsedIntent): string[] {
    const exclusions: string[] = [];

    // Always exclude sensitive files
    exclusions.push(".env", ".env.local", "credentials", "secrets");

    // If the task is scoped to specific files, exclude common unrelated areas
    if (parsed.analysis.targets.length > 0 && parsed.analysis.scopeEstimate !== "large") {
      exclusions.push("node_modules", "dist", ".git", "coverage");
    }

    return exclusions;
  }

  // ─── Suggestions ───────────────────────────────────────────────────

  private generateSuggestions(parsed: ParsedIntent): string[] {
    const suggestions: string[] = [];

    if (parsed.analysis.targets.length === 0) {
      suggestions.push("Tip: mention specific file paths for more precise results");
    }

    if (parsed.analysis.ambiguities.length > 0) {
      for (const ambiguity of parsed.analysis.ambiguities) {
        if (ambiguity.includes("subjective")) {
          suggestions.push("Tip: define concrete success criteria (e.g., 'passes lint' or 'matches X pattern')");
        }
        if (ambiguity.includes("hedging")) {
          suggestions.push("Tip: be direct about what you want — 'add X' instead of 'maybe add X'");
        }
      }
    }

    if (parsed.analysis.riskSignals.length > 0) {
      suggestions.push(
        `Heads up: detected risk signals (${parsed.analysis.riskSignals.join(", ")}). Will use elevated review tier.`
      );
    }

    return suggestions;
  }
}

// ─── Examples ────────────────────────────────────────────────────────

/**
 * Usage examples:
 *
 * const sm = new SimpleMode();
 *
 * // Quick feature
 * sm.process({ text: "add dark mode to the settings page" });
 * // → category: "feature", action: "create", target: "dark mode", location: "settings page"
 *
 * // Bug fix with file
 * sm.process({ text: "fix the auth bug in routes/login.ts" });
 * // → category: "bugfix", action: "fix", target: "auth bug", location: "routes/login.ts"
 *
 * // Refactor
 * sm.process({ text: "refactor the receipt system to use the new schema" });
 * // → category: "refactor", action: "refactor", target: "receipt system"
 *
 * // Tests
 * sm.process({ text: "add unit tests for the trust router" });
 * // → category: "test", action: "test", target: "trust router"
 */

// ─── Utilities ───────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Errors ──────────────────────────────────────────────────────────

export class SimpleModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimpleModeError";
  }
}
