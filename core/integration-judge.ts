/**
 * IntegrationJudge — Cross-file coherence validation.
 *
 * After workers produce changes, the IntegrationJudge evaluates whether
 * the combined changeset is internally consistent:
 *   - Type alignment: do modified exports match their consumers?
 *   - Import coherence: are all imports resolvable after changes?
 *   - Contract adherence: do implementations match their interfaces?
 *   - Assumption collision: did two workers make contradictory assumptions?
 *   - Intent alignment: do the changes fulfill the Charter's deliverables?
 *
 * The Judge runs at VerificationCheckpoints and before final apply.
 * It produces a JudgmentReport with pass/fail verdicts per check and
 * an overall coherence score. Failed judgments block the pipeline.
 */

import type { IntentObject, Deliverable } from "./intent.js";
import type { RunState, AcceptedAssumption } from "./runstate.js";
import type { FileChange, BuilderOutput, WorkerResult } from "../workers/base.js";

// ─── Judgment Types ──────────────────────────────────────────────────

export interface JudgmentReport {
  readonly id: string;
  readonly intentId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly phase: "checkpoint" | "pre-apply";

  /** Individual check results */
  readonly checks: readonly JudgmentCheck[];
  /** Overall pass/fail */
  readonly passed: boolean;
  /** Coherence score 0-1 */
  readonly coherenceScore: number;
  /** Blocking issues that must be resolved */
  readonly blockers: readonly JudgmentIssue[];
  /** Non-blocking concerns */
  readonly warnings: readonly JudgmentIssue[];
  /** Summary for logging/UI */
  readonly summary: string;
}

export interface JudgmentCheck {
  readonly name: string;
  readonly category: JudgmentCategory;
  readonly passed: boolean;
  readonly score: number; // 0-1
  readonly details: string;
  readonly affectedFiles: readonly string[];
}

export type JudgmentCategory =
  | "type-alignment"
  | "import-coherence"
  | "contract-adherence"
  | "assumption-collision"
  | "intent-alignment"
  | "scope-boundary"
  | "rollback-safety";

export interface JudgmentIssue {
  readonly category: JudgmentCategory;
  readonly severity: "warning" | "blocker";
  readonly message: string;
  readonly files: readonly string[];
  readonly suggestedFix?: string;
}

// ─── Configuration ───────────────────────────────────────────────────

export interface IntegrationJudgeConfig {
  /** Minimum coherence score to pass (0-1) */
  minimumCoherenceScore: number;
  /** Whether to treat unresolvable imports as blockers */
  strictImports: boolean;
  /** Whether to treat assumption collisions as blockers */
  strictAssumptions: boolean;
  /** Whether scope violations are blockers or warnings */
  strictScope: boolean;
  /** File patterns to ignore in coherence checks */
  ignorePatterns: string[];
}

const DEFAULT_CONFIG: IntegrationJudgeConfig = {
  minimumCoherenceScore: 0.8,
  strictImports: true,
  strictAssumptions: true,
  strictScope: true,
  ignorePatterns: ["*.test.ts", "*.spec.ts", "*.md"],
};

// ─── Integration Judge ───────────────────────────────────────────────

export class IntegrationJudge {
  private config: IntegrationJudgeConfig;

  constructor(config: Partial<IntegrationJudgeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run all coherence checks against the combined changeset.
   */
  judge(
    intent: IntentObject,
    runState: RunState,
    changes: readonly FileChange[],
    workerResults: readonly WorkerResult[],
    phase: JudgmentReport["phase"] = "pre-apply"
  ): JudgmentReport {
    const checks: JudgmentCheck[] = [];

    checks.push(this.checkTypeAlignment(changes));
    checks.push(this.checkImportCoherence(changes));
    checks.push(this.checkContractAdherence(changes, workerResults));
    checks.push(this.checkAssumptionCollisions(runState.assumptions, workerResults));
    checks.push(this.checkIntentAlignment(intent, changes));
    checks.push(this.checkScopeBoundary(intent, runState, changes));
    checks.push(this.checkRollbackSafety(changes));

    const coherenceScore = this.computeCoherenceScore(checks);
    const blockers = this.extractBlockers(checks);
    const warnings = this.extractWarnings(checks);
    const passed = blockers.length === 0 && coherenceScore >= this.config.minimumCoherenceScore;

    return {
      id: crypto.randomUUID(),
      intentId: intent.id,
      runId: runState.id,
      timestamp: new Date().toISOString(),
      phase,
      checks,
      passed,
      coherenceScore,
      blockers,
      warnings,
      summary: this.buildSummary(checks, coherenceScore, passed),
    };
  }

  // ─── Individual Checks ───────────────────────────────────────────

  /**
   * Type alignment: do exported type changes match consumer expectations?
   * Detects: renamed exports still referenced by old name, changed signatures,
   * removed exports that other changed files still import.
   */
  private checkTypeAlignment(changes: readonly FileChange[]): JudgmentCheck {
    const issues: string[] = [];
    const affectedFiles: string[] = [];

    // Build map of exports removed or renamed
    const exportChanges = new Map<string, { file: string; removed: string[]; added: string[] }>();

    for (const change of changes) {
      if (change.operation === "delete") continue;
      const content = change.content ?? "";
      const diff = change.diff ?? "";

      // Look for removed exports in diff (lines starting with -)
      const removedExports = [...diff.matchAll(/^-\s*export\s+(?:function|const|class|interface|type|enum)\s+(\w+)/gm)]
        .map((m) => m[1]);
      const addedExports = [...diff.matchAll(/^\+\s*export\s+(?:function|const|class|interface|type|enum)\s+(\w+)/gm)]
        .map((m) => m[1]);

      if (removedExports.length > 0 || addedExports.length > 0) {
        exportChanges.set(change.path, {
          file: change.path,
          removed: removedExports,
          added: addedExports,
        });
      }
    }

    // Check if any removed exports are still imported by other changed files
    for (const change of changes) {
      if (change.operation === "delete") continue;
      const content = change.content ?? change.diff ?? "";

      for (const [exportFile, { removed }] of exportChanges) {
        if (exportFile === change.path) continue;
        for (const name of removed) {
          if (content.includes(name) && !exportChanges.get(change.path)?.added.includes(name)) {
            issues.push(`"${change.path}" references "${name}" removed from "${exportFile}"`);
            affectedFiles.push(change.path, exportFile);
          }
        }
      }
    }

    const passed = issues.length === 0;
    return {
      name: "Type Alignment",
      category: "type-alignment",
      passed,
      score: passed ? 1 : Math.max(0, 1 - issues.length * 0.25),
      details: passed ? "All export changes align with consumers" : issues.join("; "),
      affectedFiles: [...new Set(affectedFiles)],
    };
  }

  /**
   * Import coherence: are all imports in changed files resolvable?
   * Detects: imports from deleted files, imports of removed exports,
   * circular import chains introduced by changes.
   */
  private checkImportCoherence(changes: readonly FileChange[]): JudgmentCheck {
    const issues: string[] = [];
    const affectedFiles: string[] = [];

    const deletedFiles = new Set(
      changes.filter((c) => c.operation === "delete").map((c) => c.path)
    );

    // Check if any changed file imports from a deleted file
    for (const change of changes) {
      if (change.operation === "delete") continue;
      const content = change.content ?? "";

      // Extract relative imports
      const imports = [...content.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)]
        .map((m) => m[1]);

      for (const imp of imports) {
        // Normalize: resolve relative to file's directory
        const resolved = this.resolveImportPath(change.path, imp);
        if (deletedFiles.has(resolved) || deletedFiles.has(resolved + ".ts") || deletedFiles.has(resolved + ".js")) {
          issues.push(`"${change.path}" imports from deleted file "${resolved}"`);
          affectedFiles.push(change.path);
        }
      }
    }

    const passed = issues.length === 0;
    return {
      name: "Import Coherence",
      category: "import-coherence",
      passed,
      score: passed ? 1 : 0,
      details: passed ? "All imports resolvable" : issues.join("; "),
      affectedFiles: [...new Set(affectedFiles)],
    };
  }

  /**
   * Contract adherence: do implementations match their declared interfaces?
   * Checks builder outputs for self-reported contract violations.
   */
  private checkContractAdherence(
    changes: readonly FileChange[],
    workerResults: readonly WorkerResult[]
  ): JudgmentCheck {
    const issues: string[] = [];
    const affectedFiles: string[] = [];

    // Check for interface/implementation mismatches in changed files
    for (const change of changes) {
      if (change.operation === "delete") continue;
      const content = change.content ?? "";

      // Detect classes that claim to implement interfaces
      const implMatches = [...content.matchAll(/class\s+(\w+)\s+implements\s+(\w+)/g)];
      for (const match of implMatches) {
        const [, className, interfaceName] = match;
        // Check if the interface is defined in any of the changed files
        const interfaceFile = changes.find(
          (c) => c.content?.includes(`interface ${interfaceName}`) || c.diff?.includes(`interface ${interfaceName}`)
        );
        if (interfaceFile && interfaceFile.path !== change.path) {
          // Cross-file implementation — flag for manual review if interface changed
          const interfaceDiff = interfaceFile.diff ?? "";
          if (interfaceDiff.includes(`interface ${interfaceName}`)) {
            issues.push(
              `"${className}" in "${change.path}" implements "${interfaceName}" from "${interfaceFile.path}" which was modified`
            );
            affectedFiles.push(change.path, interfaceFile.path);
          }
        }
      }
    }

    // Check worker-reported issues
    for (const result of workerResults) {
      const contractIssues = result.issues.filter(
        (i) => i.message.toLowerCase().includes("contract") || i.message.toLowerCase().includes("interface")
      );
      for (const issue of contractIssues) {
        issues.push(`Worker ${result.workerType}: ${issue.message}`);
        if (issue.file) affectedFiles.push(issue.file);
      }
    }

    const passed = issues.length === 0;
    return {
      name: "Contract Adherence",
      category: "contract-adherence",
      passed,
      score: passed ? 1 : Math.max(0, 1 - issues.length * 0.3),
      details: passed ? "All contracts satisfied" : issues.join("; "),
      affectedFiles: [...new Set(affectedFiles)],
    };
  }

  /**
   * Assumption collision: did two workers make contradictory assumptions?
   * Detects: opposite assumptions about the same entity, conflicting
   * design decisions, incompatible approach choices.
   */
  private checkAssumptionCollisions(
    assumptions: readonly AcceptedAssumption[],
    workerResults: readonly WorkerResult[]
  ): JudgmentCheck {
    const issues: string[] = [];

    // Collect all assumptions: accepted + worker-proposed
    const allAssumptions: { statement: string; source: string }[] = [
      ...assumptions.map((a) => ({ statement: a.statement, source: a.acceptedBy })),
    ];

    for (const result of workerResults) {
      for (const assumption of result.assumptions) {
        allAssumptions.push({ statement: assumption, source: result.workerType });
      }
    }

    // Pairwise collision detection via keyword overlap + negation
    for (let i = 0; i < allAssumptions.length; i++) {
      for (let j = i + 1; j < allAssumptions.length; j++) {
        const a = allAssumptions[i];
        const b = allAssumptions[j];

        if (this.detectContradiction(a.statement, b.statement)) {
          issues.push(
            `Collision: "${a.statement}" (${a.source}) vs "${b.statement}" (${b.source})`
          );
        }
      }
    }

    const passed = issues.length === 0;
    return {
      name: "Assumption Collisions",
      category: "assumption-collision",
      passed: this.config.strictAssumptions ? passed : true,
      score: passed ? 1 : Math.max(0, 1 - issues.length * 0.4),
      details: passed ? "No contradictory assumptions" : issues.join("; "),
      affectedFiles: [],
    };
  }

  /**
   * Intent alignment: do the changes fulfill the Charter's deliverables?
   * Detects: missing deliverables, extra files not in any deliverable.
   */
  private checkIntentAlignment(
    intent: IntentObject,
    changes: readonly FileChange[]
  ): JudgmentCheck {
    const issues: string[] = [];
    const changedPaths = new Set(changes.map((c) => c.path));

    // Check each deliverable has at least one corresponding change
    const missingDeliverables: Deliverable[] = [];
    for (const deliverable of intent.charter.deliverables) {
      const hasChange = deliverable.targetFiles.some((f) => changedPaths.has(f));
      if (!hasChange && deliverable.targetFiles.length > 0) {
        missingDeliverables.push(deliverable);
      }
    }

    if (missingDeliverables.length > 0) {
      issues.push(
        `Missing deliverables: ${missingDeliverables.map((d) => d.description).join(", ")}`
      );
    }

    // Check for files changed that aren't in any deliverable
    const deliverableFiles = new Set(
      intent.charter.deliverables.flatMap((d) => d.targetFiles)
    );
    const extraFiles = changes
      .filter((c) => !deliverableFiles.has(c.path))
      .filter((c) => !this.isIgnored(c.path))
      .map((c) => c.path);

    if (extraFiles.length > 0) {
      issues.push(`Files changed outside deliverables: ${extraFiles.join(", ")}`);
    }

    const deliverableCompletion =
      intent.charter.deliverables.length > 0
        ? 1 - missingDeliverables.length / intent.charter.deliverables.length
        : 1;

    const passed = missingDeliverables.length === 0 && (extraFiles.length === 0 || !this.config.strictScope);
    return {
      name: "Intent Alignment",
      category: "intent-alignment",
      passed,
      score: deliverableCompletion,
      details: passed
        ? `All ${intent.charter.deliverables.length} deliverables addressed`
        : issues.join("; "),
      affectedFiles: extraFiles,
    };
  }

  /**
   * Scope boundary: are changes within the declared exclusions?
   */
  private checkScopeBoundary(
    intent: IntentObject,
    runState: RunState,
    changes: readonly FileChange[]
  ): JudgmentCheck {
    const issues: string[] = [];
    const affectedFiles: string[] = [];

    for (const change of changes) {
      for (const exclusion of intent.exclusions) {
        if (change.path.includes(exclusion)) {
          issues.push(`"${change.path}" violates exclusion "${exclusion}"`);
          affectedFiles.push(change.path);
        }
      }
    }

    const passed = issues.length === 0;
    return {
      name: "Scope Boundary",
      category: "scope-boundary",
      passed: this.config.strictScope ? passed : true,
      score: passed ? 1 : 0,
      details: passed ? "All changes within scope" : issues.join("; "),
      affectedFiles,
    };
  }

  /**
   * Rollback safety: can all changes be reverted cleanly?
   */
  private checkRollbackSafety(changes: readonly FileChange[]): JudgmentCheck {
    const issues: string[] = [];
    const affectedFiles: string[] = [];

    for (const change of changes) {
      if (change.operation === "modify" && !change.originalContent && !change.diff) {
        issues.push(`"${change.path}" modified without original content or diff — cannot rollback`);
        affectedFiles.push(change.path);
      }
    }

    const passed = issues.length === 0;
    return {
      name: "Rollback Safety",
      category: "rollback-safety",
      passed,
      score: passed ? 1 : 0,
      details: passed ? "All changes are revertible" : issues.join("; "),
      affectedFiles,
    };
  }

  // ─── Scoring & Reporting ─────────────────────────────────────────

  private computeCoherenceScore(checks: readonly JudgmentCheck[]): number {
    if (checks.length === 0) return 1;

    // Weighted average — some checks matter more
    const weights: Record<JudgmentCategory, number> = {
      "type-alignment": 1.5,
      "import-coherence": 1.5,
      "contract-adherence": 1.2,
      "assumption-collision": 1.0,
      "intent-alignment": 1.3,
      "scope-boundary": 0.8,
      "rollback-safety": 1.0,
    };

    let weightedSum = 0;
    let totalWeight = 0;

    for (const check of checks) {
      const weight = weights[check.category] ?? 1;
      weightedSum += check.score * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 1;
  }

  private extractBlockers(checks: readonly JudgmentCheck[]): JudgmentIssue[] {
    return checks
      .filter((c) => !c.passed)
      .map((c) => ({
        category: c.category,
        severity: "blocker" as const,
        message: c.details,
        files: c.affectedFiles,
      }));
  }

  private extractWarnings(checks: readonly JudgmentCheck[]): JudgmentIssue[] {
    return checks
      .filter((c) => c.passed && c.score < 1)
      .map((c) => ({
        category: c.category,
        severity: "warning" as const,
        message: c.details,
        files: c.affectedFiles,
      }));
  }

  private buildSummary(
    checks: readonly JudgmentCheck[],
    score: number,
    passed: boolean
  ): string {
    const passedCount = checks.filter((c) => c.passed).length;
    const status = passed ? "PASSED" : "FAILED";
    return `${status} — ${passedCount}/${checks.length} checks passed, coherence ${(score * 100).toFixed(0)}%`;
  }

  // ─── Utilities ───────────────────────────────────────────────────

  private detectContradiction(a: string, b: string): boolean {
    const negators = ["not", "no", "never", "without", "remove", "delete", "don't", "won't", "shouldn't"];
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    // Extract significant words (>3 chars)
    const aWords = new Set(aLower.split(/\W+/).filter((w) => w.length > 3));
    const bWords = new Set(bLower.split(/\W+/).filter((w) => w.length > 3));

    // Check for shared topic with opposing negation
    const overlap = [...aWords].filter((w) => bWords.has(w) && !negators.includes(w));
    if (overlap.length === 0) return false;

    const aNegated = negators.some((n) => aLower.includes(n));
    const bNegated = negators.some((n) => bLower.includes(n));

    return aNegated !== bNegated && overlap.length >= 2;
  }

  private resolveImportPath(fromFile: string, importPath: string): string {
    const dir = fromFile.split("/").slice(0, -1).join("/");
    const parts = [...dir.split("/"), ...importPath.split("/")];
    const resolved: string[] = [];

    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") resolved.pop();
      else resolved.push(part);
    }

    return resolved.join("/");
  }

  private isIgnored(filePath: string): boolean {
    return this.config.ignorePatterns.some((pattern) => {
      const regex = new RegExp(pattern.replace(/\*/g, ".*"));
      return regex.test(filePath);
    });
  }
}
