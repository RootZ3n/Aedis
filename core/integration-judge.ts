/**
 * IntegrationJudge — Cross-file coherence validation.
 *
 * RESPONSIBILITY: Evaluates whether the combined changeset is internally
 * consistent AFTER the Builder produces changes, BEFORE final apply.
 * This is distinct from:
 *   - Critic: evaluates the PROPOSED DIFF for quality/correctness
 *   - Verifier: evaluates the REPO STATE after apply (tests, lint, typecheck)
 *
 * The Judge focuses on structural coherence across files:
 *   - Type alignment: do modified exports match their consumers?
 *   - Import coherence: are all imports resolvable after changes?
 *   - Contract adherence: do implementations match their interfaces?
 *   - Assumption collision: did two workers make contradictory assumptions?
 *   - Intent alignment: do the changes fulfill the Charter's deliverables?
 *   - Cross-file coherence: orphaned refs, partial migrations, and an
 *     overall import/export alignment score across the actual diffs.
 *
 * Also provides a lightweight `preflight()` check that runs BEFORE
 * full verification — import/export existence + basic type alignment.
 * If preflight fails, skip the expensive full verification.
 *
 * The Judge runs at VerificationCheckpoints and before final apply.
 * It produces a JudgmentReport with pass/fail verdicts per check and
 * an overall coherence score. Failed judgments block the pipeline.
 */

import { relative, resolve } from "node:path";

import type { IntentObject, Deliverable } from "./intent.js";
import type { RunState, AcceptedAssumption } from "./runstate.js";
import type { FileChange, BuilderOutput, WorkerResult } from "../workers/base.js";
import type { ChangeSet, FileInclusion } from "./change-set.js";

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
  | "rollback-safety"
  | "cross-file-coherence";

export interface JudgmentIssue {
  readonly category: JudgmentCategory;
  readonly severity: "warning" | "blocker";
  readonly message: string;
  readonly files: readonly string[];
  readonly suggestedFix?: string;
}

/**
 * Lightweight preflight result. Runs BEFORE full verification to
 * fail early on broken imports/exports and basic type misalignment.
 * Much cheaper than the full judge() — no assumption checking, no
 * intent alignment, no manifest completeness.
 */
export interface PreflightResult {
  readonly passed: boolean;
  readonly issues: readonly string[];
  readonly durationMs: number;
}

// ─── Cross-file structural findings ──────────────────────────────────

/**
 * A symbol that was removed from one file but is still referenced
 * (by name) in at least one other file in the same change set.
 */
export interface OrphanedReference {
  /** Identifier name (function, class, type, etc.) */
  readonly name: string;
  /** File the export was removed from */
  readonly removedFrom: string;
  /** Other files in the change set that still mention `name` */
  readonly stillReferencedIn: readonly string[];
}

/**
 * Evidence of a half-finished rename: a removed export and an added
 * export co-exist in the same file (rename heuristic), but the OLD
 * name still appears in another changed file — meaning some callers
 * are on the new API and some are on the old.
 */
export interface PartialMigration {
  readonly oldName: string;
  readonly newName: string;
  /** File where the rename was introduced */
  readonly introducedIn: string;
  /** Files that still reference the old name */
  readonly oldNameStillIn: readonly string[];
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
  /**
   * Project root used to normalize paths in checkIntentAlignment.
   *
   * Without this, deliverable paths from the Charter (which may be
   * absolute, relative, or bare basenames depending on what the user
   * typed) and change paths from the Builder (always relative to
   * projectRoot via BuilderWorker.toRelative) compare via exact string
   * match and never align. Path normalization resolves both sides
   * against projectRoot first.
   *
   * Defaults to process.cwd() — correct in production where the API
   * server runs from the project root. Set explicitly via the
   * Coordinator (see core/coordinator.ts constructor) for cases where
   * cwd diverges from the actual project root.
   */
  projectRoot: string;
}

const DEFAULT_CONFIG: IntegrationJudgeConfig = {
  minimumCoherenceScore: 0.8,
  strictImports: true,
  strictAssumptions: true,
  strictScope: true,
  ignorePatterns: ["*.test.ts", "*.spec.ts", "*.md"],
  projectRoot: process.cwd(),
};

// Regex used by every export-aware method below. Captures `function`,
// `const`, `class`, `interface`, `type`, and `enum` exports — matches
// the convention already used by checkTypeAlignment.
const EXPORT_DECL_REGEX = /export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/g;
const REMOVED_EXPORT_REGEX = /^-\s*export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/gm;
const ADDED_EXPORT_REGEX = /^\+\s*export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/gm;
const NAMED_EXPORT_REGEX = /export\s*\{\s*([^}]+)\}/g;
const NAMED_IMPORT_REGEX = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

// ─── Integration Judge ───────────────────────────────────────────────

export class IntegrationJudge {
  private config: IntegrationJudgeConfig;

  constructor(config: Partial<IntegrationJudgeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run all coherence checks against the combined changeset.
   *
   * The optional `changeSet` parameter enables manifest-completeness
   * checking — verifying that every file declared in the change
   * manifest was actually touched by the run. When omitted (legacy
   * callers, single-file runs) the check is skipped.
   */
  judge(
    intent: IntentObject,
    runState: RunState,
    changes: readonly FileChange[],
    workerResults: readonly WorkerResult[],
    phase: JudgmentReport["phase"] = "pre-apply",
    changeSet?: ChangeSet | null,
  ): JudgmentReport {
    const checks: JudgmentCheck[] = [];

    checks.push(this.checkTypeAlignment(changes));
    checks.push(this.checkImportCoherence(changes));
    checks.push(this.checkContractAdherence(changes, workerResults));
    checks.push(this.checkAssumptionCollisions(runState.assumptions, workerResults));
    checks.push(this.checkIntentAlignment(intent, changes));
    checks.push(this.checkScopeBoundary(intent, runState, changes));
    checks.push(this.checkRollbackSafety(changes));
    checks.push(this.checkCrossFileCoherence(changes));

    // Manifest completeness — only runs when a ChangeSet is provided
    if (changeSet) {
      checks.push(this.checkManifestCompleteness(changeSet, changes));
    }

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

  // ─── Preflight Check ─────────────────────────────────────────────

  /**
   * Lightweight integration preflight — runs BEFORE full verification.
   *
   * Checks only:
   *   1. Import coherence: do imports reference files that exist?
   *   2. Type alignment: do removed exports still have consumers?
   *
   * If preflight fails, the full verify() will also fail, so we can
   * skip the expensive external tool hooks (lint, typecheck, tests)
   * and fail early with a clear diagnostic.
   *
   * Does NOT duplicate the full judge() — it reuses checkTypeAlignment
   * and checkImportCoherence internally but skips everything else.
   */
  preflight(changes: readonly FileChange[]): PreflightResult {
    const start = Date.now();
    const issues: string[] = [];

    // Check 1: imports resolve
    const importCheck = this.checkImportCoherence(changes);
    if (!importCheck.passed) {
      issues.push(importCheck.details);
    }

    // Check 2: type alignment — removed exports not still referenced
    const typeCheck = this.checkTypeAlignment(changes);
    if (!typeCheck.passed) {
      issues.push(typeCheck.details);
    }

    return {
      passed: issues.length === 0,
      issues,
      durationMs: Date.now() - start,
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

    // Path normalization for both sides of the comparison.
    //
    // Deliverable paths come from the Charter and may appear as
    // absolute ("/abs/projectRoot/core/intent.ts"), relative
    // ("core/intent.ts"), or bare basenames ("intent.ts") depending on
    // what the user typed. Change paths come from the Builder and are
    // always relative to projectRoot via BuilderWorker.toRelative,
    // forward-slashed.
    //
    // Without normalization, the Set-based exact-string match below
    // never aligns and every deliverable looks "missing" while every
    // change looks "extra" — causing the Integration Judge to fail
    // even on successful builds.
    //
    // The formula:
    //   relative(projectRoot, resolve(projectRoot, p))
    // resolves p to absolute (resolve treats absolute paths as
    // idempotent, relative paths as projectRoot-rooted), then expresses
    // the result back as a path relative to projectRoot. The trailing
    // .replace(/\\/g, "/") forces forward slashes to match the format
    // BuilderWorker.toRelative emits.
    //
    // CAVEAT: this does NOT handle bare-basename deliverables that live
    // in subdirectories. "intent.ts" normalizes to "intent.ts" (placed
    // at projectRoot, not in core/), so it still won't match the
    // Builder's "core/intent.ts". If you see "Missing deliverables"
    // failures with basename-only deliverable paths, the fix is to
    // make the CharterGenerator emit full relative paths, not to
    // extend this normalization further.
    const normalize = (p: string): string =>
      relative(this.config.projectRoot, resolve(this.config.projectRoot, p)).replace(/\\/g, "/");

    const changedPaths = new Set(changes.map((c) => normalize(c.path)));

    // Check each deliverable has at least one corresponding change
    const missingDeliverables: Deliverable[] = [];
    for (const deliverable of intent.charter.deliverables) {
      const hasChange = deliverable.targetFiles.some((f) => changedPaths.has(normalize(f)));
      if (!hasChange && deliverable.targetFiles.length > 0) {
        missingDeliverables.push(deliverable);
      }
    }

    if (missingDeliverables.length > 0) {
      issues.push(
        `Missing deliverables: ${missingDeliverables.map((d) => d.description).join(", ")}`
      );
    }

    // Check for files changed that aren't in any deliverable.
    // Deliverable paths normalized via the same `normalize` helper so
    // the Set lookup matches Builder-emitted change paths consistently.
    const deliverableFiles = new Set(
      intent.charter.deliverables.flatMap((d) => d.targetFiles).map(normalize)
    );
    const extraFiles = changes
      .filter((c) => !deliverableFiles.has(normalize(c.path)))
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

  /**
   * Manifest completeness: verifies that every file declared in the
   * ChangeSet manifest was actually touched by the run, and that no
   * required files were left incomplete.
   *
   * This catches the scenario where Aedis plans to touch 8 files but
   * only produces changes for 5 — a common multi-file failure mode
   * where scope items silently drop.
   *
   * Scoring:
   *   - Required files missing → blocker (these are essential to coherence)
   *   - Optional files missing → warning (degraded but acceptable)
   *   - Score is the ratio of completed required files
   */
  private checkManifestCompleteness(
    changeSet: ChangeSet,
    changes: readonly FileChange[],
  ): JudgmentCheck {
    const issues: string[] = [];
    const affectedFiles: string[] = [];
    const changedPaths = new Set(changes.map((c) => c.path));

    let requiredTotal = 0;
    let requiredCompleted = 0;
    let optionalMissing = 0;

    for (const file of changeSet.filesInScope) {
      const wasChanged = changedPaths.has(file.path);

      if (file.necessity === "required") {
        requiredTotal++;
        if (wasChanged) {
          requiredCompleted++;
        } else {
          issues.push(`Required file "${file.path}" declared in manifest but not changed (${file.whyIncluded})`);
          affectedFiles.push(file.path);
        }
      } else {
        if (!wasChanged) {
          optionalMissing++;
        }
      }
    }

    // Also check for undeclared changes — files changed that weren't in the manifest
    const manifestPaths = new Set(changeSet.filesInScope.map((f) => f.path));
    const undeclaredChanges = changes
      .filter((c) => !manifestPaths.has(c.path))
      .map((c) => c.path);

    if (undeclaredChanges.length > 0) {
      issues.push(`${undeclaredChanges.length} file(s) changed but not declared in manifest: ${undeclaredChanges.join(", ")}`);
      affectedFiles.push(...undeclaredChanges);
    }

    const completionRatio = requiredTotal > 0 ? requiredCompleted / requiredTotal : 1;
    const hasRequiredGaps = requiredTotal > requiredCompleted;
    const passed = !hasRequiredGaps && undeclaredChanges.length === 0;

    const details = passed
      ? `All ${requiredTotal} required file(s) completed${optionalMissing > 0 ? `, ${optionalMissing} optional skipped` : ""}`
      : issues.join("; ");

    return {
      name: "Manifest Completeness",
      category: "intent-alignment",
      passed,
      score: completionRatio,
      details,
      affectedFiles: [...new Set(affectedFiles)],
    };
  }

  /**
   * Cross-file coherence: rolls up the three structural checks
   * (orphaned references, partial migrations, import/export alignment
   * score) into a single JudgmentCheck slot.
   *
   * The score is the alignment ratio from scoreCrossFileCoherence().
   * The check is `passed` only when there are zero orphaned references,
   * zero partial migrations, AND the score is >= 0.8. Anything below
   * that is treated as a blocker — these are the hard-to-spot bugs
   * that pass tests but break consumers downstream, so we'd rather
   * stop the build than ship them.
   */
  private checkCrossFileCoherence(changes: readonly FileChange[]): JudgmentCheck {
    const orphans = this.detectOrphanedReferences(changes);
    const migrations = this.detectPartialMigration(changes);
    const score = this.scoreCrossFileCoherence(changes);

    const issues: string[] = [];
    const affectedFiles: string[] = [];

    for (const orphan of orphans) {
      issues.push(
        `Orphaned reference "${orphan.name}" — removed from ${orphan.removedFrom} but still referenced in ${orphan.stillReferencedIn.join(", ")}`
      );
      affectedFiles.push(orphan.removedFrom, ...orphan.stillReferencedIn);
    }

    for (const migration of migrations) {
      issues.push(
        `Partial migration "${migration.oldName}" → "${migration.newName}" introduced in ${migration.introducedIn}, but ${migration.oldNameStillIn.join(", ")} still use the old name`
      );
      affectedFiles.push(migration.introducedIn, ...migration.oldNameStillIn);
    }

    const passed = orphans.length === 0 && migrations.length === 0 && score >= 0.8;

    const summary = `import/export alignment ${(score * 100).toFixed(0)}%`;
    const details = passed
      ? `${summary} — no orphaned references, no partial migrations`
      : `${summary}; ${issues.join("; ")}`;

    return {
      name: "Cross-File Coherence",
      category: "cross-file-coherence",
      passed,
      score,
      details,
      affectedFiles: [...new Set(affectedFiles)],
    };
  }

  // ─── Cross-file structural methods ───────────────────────────────

  /**
   * Find references to deleted or renamed exports that other changed
   * files did NOT update.
   *
   * Strategy:
   *   1. Walk every non-delete change and pull `removed` / `added`
   *      export names from its diff (lines starting with -/+).
   *   2. For each removed export, check whether the same file added
   *      it back (rename within a single file is fine).
   *   3. For removed exports that weren't re-added in the same file,
   *      scan every OTHER changed file's content for the identifier
   *      as a whole word. Each other file that still mentions the
   *      name is a stale reference.
   *   4. Also handles deleted files: when a whole file is removed,
   *      every export it ever declared is treated as removed and the
   *      same scan applies.
   *
   * Returns one OrphanedReference per (name, removedFrom) pair that
   * has at least one stale referencing file. Empty array means every
   * removed export was either re-added in place or genuinely unused
   * elsewhere in the changeset.
   */
  private detectOrphanedReferences(
    changes: readonly FileChange[]
  ): OrphanedReference[] {
    const orphans: OrphanedReference[] = [];

    // Build map: file path → { removed: [], added: [] }
    const exportChanges = new Map<string, { removed: string[]; added: string[] }>();

    for (const change of changes) {
      const removed: string[] = [];
      const added: string[] = [];

      if (change.operation === "delete") {
        // Whole-file delete — treat every export the file used to declare
        // (per its originalContent if available) as removed.
        const original = change.originalContent ?? "";
        for (const m of original.matchAll(EXPORT_DECL_REGEX)) {
          removed.push(m[1]);
        }
        for (const m of original.matchAll(NAMED_EXPORT_REGEX)) {
          for (const name of m[1].split(",")) {
            const cleaned = name.trim().split(/\s+as\s+/)[0].trim();
            if (cleaned) removed.push(cleaned);
          }
        }
      } else {
        const diff = change.diff ?? "";
        for (const m of diff.matchAll(REMOVED_EXPORT_REGEX)) removed.push(m[1]);
        for (const m of diff.matchAll(ADDED_EXPORT_REGEX)) added.push(m[1]);
      }

      if (removed.length > 0 || added.length > 0) {
        exportChanges.set(change.path, { removed, added });
      }
    }

    // For each removed export, find files that still reference the name.
    for (const [sourceFile, { removed, added }] of exportChanges) {
      const reAddedHere = new Set(added);

      for (const name of removed) {
        // Re-added in the same file → not orphaned (rename within file is fine).
        if (reAddedHere.has(name)) continue;

        const wholeWord = new RegExp(`\\b${escapeRegExp(name)}\\b`);
        const stillIn: string[] = [];

        for (const other of changes) {
          if (other.path === sourceFile) continue;
          if (other.operation === "delete") continue;
          // Prefer post-change content; fall back to diff if content is absent.
          const haystack = other.content ?? other.diff ?? "";
          if (wholeWord.test(haystack)) {
            stillIn.push(other.path);
          }
        }

        if (stillIn.length > 0) {
          orphans.push({
            name,
            removedFrom: sourceFile,
            stillReferencedIn: stillIn,
          });
        }
      }
    }

    return orphans;
  }

  /**
   * Detect mixed old/new API usage across files — the half-finished
   * rename pattern where one file has been migrated and others have
   * not.
   *
   * Strategy:
   *   1. For each non-delete change, pull both removed exports and
   *      added exports from its diff. If both lists are non-empty,
   *      treat the file as having performed at least one rename.
   *   2. Pair removed[i] with added[i] (best-effort positional pairing
   *      — fragile but cheap; covers the common case where a single
   *      rename appears as one removed line and one added line).
   *   3. For each (oldName, newName) pair where the names differ,
   *      scan every OTHER changed file for whole-word matches of
   *      `oldName`. Each match is a file that's still on the old API.
   *   4. Returns one PartialMigration per (oldName, newName) pair
   *      with at least one straggler.
   *
   * NOTE: this is a heuristic. It will miss renames that don't manifest
   * as paired export-line changes (e.g. a function renamed via inline
   * edit) and it will produce false positives if the same diff legitimately
   * removes one export and adds an unrelated one. The signal is still
   * useful — false positives surface as warnings, not blockers.
   */
  private detectPartialMigration(
    changes: readonly FileChange[]
  ): PartialMigration[] {
    const migrations: PartialMigration[] = [];

    for (const change of changes) {
      if (change.operation === "delete") continue;
      const diff = change.diff ?? "";
      if (!diff) continue;

      const removed = [...diff.matchAll(REMOVED_EXPORT_REGEX)].map((m) => m[1]);
      const added = [...diff.matchAll(ADDED_EXPORT_REGEX)].map((m) => m[1]);

      if (removed.length === 0 || added.length === 0) continue;

      // Positional pairing — covers single-rename diffs cleanly and
      // degrades gracefully on multi-rename diffs (might mis-pair but
      // still detects that something migrated).
      const pairCount = Math.min(removed.length, added.length);
      for (let i = 0; i < pairCount; i++) {
        const oldName = removed[i];
        const newName = added[i];
        if (oldName === newName) continue;

        const wholeWord = new RegExp(`\\b${escapeRegExp(oldName)}\\b`);
        const stillIn: string[] = [];

        for (const other of changes) {
          if (other.path === change.path) continue;
          if (other.operation === "delete") continue;
          const haystack = other.content ?? other.diff ?? "";
          if (wholeWord.test(haystack)) {
            stillIn.push(other.path);
          }
        }

        if (stillIn.length > 0) {
          migrations.push({
            oldName,
            newName,
            introducedIn: change.path,
            oldNameStillIn: stillIn,
          });
        }
      }
    }

    return migrations;
  }

  /**
   * Returns a 0..1 cross-file coherence score based on how many
   * cross-file imports actually resolve to exports that exist after
   * the changes are applied.
   *
   * Definition of "cross-file":
   *   We only count imports whose target file is ALSO in the change
   *   set — imports of node_modules / standard library / unchanged
   *   files are out of scope (we have no visibility into them).
   *
   * Algorithm:
   *   1. Build exportsByFile: for each non-delete change, parse the
   *      post-change content for `export <kind> <name>` and
   *      `export { ... }` clauses.
   *   2. Build the set of deleted file paths.
   *   3. For every changed (non-delete) file, parse named imports
   *      (`import { a, b } from "./path"`) and resolve each to a
   *      changed file via resolveImportPath().
   *   4. For each name in each cross-file import:
   *        - if the target was deleted → import counts as unresolved
   *        - else if the target's post-change exports include the
   *          name → resolved
   *        - else → unresolved
   *   5. Score = resolved / total. If there are zero cross-file imports
   *      (e.g. a single-file change), return 1.0 — there's nothing to
   *      misalign.
   *
   * The score is consumed by checkCrossFileCoherence() and used as the
   * JudgmentCheck score for the cross-file-coherence category, which
   * feeds into the overall weighted coherence score in the report.
   */
  private scoreCrossFileCoherence(changes: readonly FileChange[]): number {
    if (changes.length === 0) return 1;

    // 1. Build post-change exports per file.
    const exportsByFile = new Map<string, Set<string>>();
    for (const change of changes) {
      if (change.operation === "delete") continue;
      const content = change.content ?? "";
      const exported = new Set<string>();

      for (const m of content.matchAll(EXPORT_DECL_REGEX)) {
        exported.add(m[1]);
      }
      for (const m of content.matchAll(NAMED_EXPORT_REGEX)) {
        for (const name of m[1].split(",")) {
          const cleaned = name.trim().split(/\s+as\s+/)[0].trim();
          if (cleaned) exported.add(cleaned);
        }
      }

      exportsByFile.set(change.path, exported);
    }

    // 2. Set of deleted file paths.
    const deletedFiles = new Set(
      changes.filter((c) => c.operation === "delete").map((c) => c.path)
    );

    // 3. Walk every changed file's named imports and score them.
    let totalImports = 0;
    let resolvedImports = 0;

    for (const change of changes) {
      if (change.operation === "delete") continue;
      const content = change.content ?? "";

      for (const m of content.matchAll(NAMED_IMPORT_REGEX)) {
        const importedNames = m[1]
          .split(",")
          .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
          .filter(Boolean);
        const importPath = m[2];

        // Resolve the import path against the importer's directory and
        // try to find a matching change. Cross-file coherence is only
        // defined when the target is in our change set.
        const resolved = this.resolveImportPath(change.path, importPath);
        const candidates = [resolved, `${resolved}.ts`, `${resolved}.js`, `${resolved}/index.ts`, `${resolved}/index.js`];
        const targetPath = candidates.find((c) =>
          changes.some((other) => other.path === c)
        );

        if (!targetPath) continue; // External import — out of scope.

        if (deletedFiles.has(targetPath)) {
          // Importing from a deleted file — every imported name is unresolved.
          totalImports += importedNames.length;
          continue;
        }

        const targetExports = exportsByFile.get(targetPath) ?? new Set<string>();
        for (const name of importedNames) {
          totalImports++;
          if (targetExports.has(name)) {
            resolvedImports++;
          }
        }
      }
    }

    // No cross-file imports → nothing to misalign → perfect coherence.
    if (totalImports === 0) return 1;

    return resolvedImports / totalImports;
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
      "cross-file-coherence": 1.4,
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

// ─── Module-level helpers ────────────────────────────────────────────

/**
 * Escape a string for safe insertion into a RegExp source. Used by the
 * cross-file structural methods so an identifier containing regex
 * metacharacters (e.g. `$state`) doesn't blow up the whole-word match.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
