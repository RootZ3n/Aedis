/**
 * Preflight Validation — Preflight + Dry Run System v1.
 *
 * Runs a deterministic set of cheap checks against a proposed task
 * before any worker is dispatched. Catches the "obvious problems"
 * class of failures at the edge: missing paths, vague instructions,
 * destructive verbs without a target, security-sensitive surface
 * touched without acknowledgement, repoPath that doesn't exist.
 *
 * Preflight never modifies anything. Every finding is categorized
 * as `ok`, `warn`, or `block`. A single `block` finding is enough
 * to prevent execution; `warn`s surface in the dry-run output so
 * the user sees them but can still proceed.
 *
 * Design principles:
 *
 *   1. Pure function of inputs plus a small amount of stat() disk
 *      probing. No network, no model calls, no state.
 *   2. Every rule returns both a reason AND a concrete suggestion
 *      so "it's blocked" is never shown without "try this instead."
 *   3. Rules are flat and readable. Adding a new check is a new
 *      entry in one of the arrays below — no central dispatcher.
 *   4. Safe fallback: when signals are ambiguous, prefer `warn`
 *      over `block`. The user should be able to proceed against
 *      our advice; we just want them informed.
 */

import { existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export type PreflightSeverity = "ok" | "warn" | "block";

export interface PreflightFinding {
  readonly code: string;
  readonly severity: PreflightSeverity;
  readonly message: string;
  readonly suggestion?: string;
}

export interface PreflightReport {
  /** True when there are no blocking findings. */
  readonly ok: boolean;
  /** Every finding, in the order rules fired. */
  readonly findings: readonly PreflightFinding[];
  /** One-line summary for UI display. */
  readonly summary: string;
  /** True when any finding is a block. */
  readonly blocked: boolean;
  /** True when any warning fired. */
  readonly hasWarnings: boolean;
}

export interface PreflightInput {
  /** The raw user prompt. */
  readonly input: string;
  /** The effective project root for the run. */
  readonly projectRoot: string;
  /**
   * Target files already extracted by the charter (or a smaller
   * cheap heuristic). Preflight does not re-extract — it consumes
   * whatever the caller has. Optional.
   */
  readonly extractedTargets?: readonly string[];
  /**
   * Ambiguities flagged by the charter analyzer. Preflight uses
   * these to decide whether a request is "vague enough to block."
   */
  readonly ambiguities?: readonly string[];
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Run every preflight rule and compose a `PreflightReport`. Pure
 * function except for synchronous `existsSync` disk probes.
 */
export function runPreflight(input: PreflightInput): PreflightReport {
  const findings: PreflightFinding[] = [];
  const raw = (input.input ?? "").trim();
  const projectRoot = input.projectRoot ?? "";
  const targets = input.extractedTargets ?? [];
  const ambiguities = input.ambiguities ?? [];

  // ── Rule 1: empty / trivial input ──────────────────────────────
  if (raw.length === 0) {
    findings.push({
      code: "empty-input",
      severity: "block",
      message: "The request is empty.",
      suggestion: "Describe what you want Aedis to do, even in one short sentence.",
    });
  } else if (raw.length < 4 || raw.split(/\s+/).filter((w) => w.length > 1).length < 2) {
    findings.push({
      code: "trivial-input",
      severity: "block",
      message: `The request "${raw}" is too short to plan against.`,
      suggestion:
        "Include at least a verb and a target, e.g. \"in core/foo.ts, add a helper that …\".",
    });
  }

  // ── Rule 2: missing repoPath ───────────────────────────────────
  if (!projectRoot) {
    findings.push({
      code: "missing-repo-path",
      severity: "block",
      message: "No repoPath was supplied; Aedis does not know which repository to target.",
      suggestion: "Pass a repoPath to the request or set one in the hero form.",
    });
  } else if (!existsSync(projectRoot)) {
    findings.push({
      code: "invalid-repo-path",
      severity: "block",
      message: `repoPath "${projectRoot}" does not exist on disk.`,
      suggestion:
        "Check the path is correct, or clone/create the repo before running Aedis against it.",
    });
  }

  // ── Rule 3: extracted target files that don't exist ───────────
  // A missing target is a WARN not a BLOCK, because the user may
  // be asking Aedis to create the file. We surface the warning so
  // the UI can tell the user "this path doesn't exist — if you
  // meant to create it that's fine."
  const missingTargets: string[] = [];
  for (const target of targets) {
    if (!target || target.length === 0) continue;
    const abs = isAbsolute(target) ? target : resolve(projectRoot || ".", target);
    if (!existsSync(abs)) missingTargets.push(target);
  }
  if (missingTargets.length > 0 && missingTargets.length === targets.length && targets.length > 0) {
    // All named targets are missing. Stronger warn — likely a
    // typo or a wrong relative path.
    findings.push({
      code: "all-targets-missing",
      severity: "warn",
      message:
        missingTargets.length === 1
          ? `The only named target "${missingTargets[0]}" does not exist on disk.`
          : `None of the ${missingTargets.length} named targets exist on disk: ${missingTargets.slice(0, 3).join(", ")}${missingTargets.length > 3 ? "…" : ""}.`,
      suggestion:
        "If you're asking Aedis to create these files, this is expected and you can proceed. Otherwise, check the paths.",
    });
  } else if (missingTargets.length > 0) {
    findings.push({
      code: "some-targets-missing",
      severity: "warn",
      message: `${missingTargets.length} of the named targets do not exist on disk: ${missingTargets.slice(0, 3).join(", ")}${missingTargets.length > 3 ? "…" : ""}.`,
      suggestion:
        "If Aedis should create the missing files, this is expected. Otherwise, fix the paths before running.",
    });
  }

  // ── Rule 4: vague / ambiguous instructions ─────────────────────
  // Ambiguities come from the CharterGenerator.analyzeRequest path.
  // We block only when the request is *very* vague — no targets
  // AND multiple ambiguities. Otherwise we just warn.
  const lower = raw.toLowerCase();
  const hedging = /\b(maybe|possibly|might|could|or|somehow|something|stuff|things)\b/.test(lower);
  const hasConcreteVerb = /\b(build|create|add|fix|implement|refactor|rename|delete|remove|update|move|write|scaffold|generate|replace)\b/.test(lower);
  const ambiguous =
    (ambiguities.length >= 2 && targets.length === 0) ||
    (!hasConcreteVerb && targets.length === 0) ||
    (hedging && targets.length === 0);

  if (ambiguous && raw.length > 0) {
    findings.push({
      code: "vague-instruction",
      severity: "block",
      message:
        "The request is too vague to plan against: no concrete target files and no unambiguous action verb.",
      suggestion:
        "Name a specific file or module and a concrete verb (\"in core/coordinator.ts, add X\"). You can also ask Loqui for a plan first.",
    });
  } else if (ambiguities.length > 0) {
    findings.push({
      code: "soft-ambiguity",
      severity: "warn",
      message: `Charter analyzer flagged ${ambiguities.length} ambiguity/ies: ${ambiguities.slice(0, 2).join(" | ")}${ambiguities.length > 2 ? "…" : ""}.`,
      suggestion:
        "The run can proceed, but consider clarifying or supplying additional acceptance criteria.",
    });
  }

  // ── Rule 5: destructive verbs without targets ──────────────────
  const destructive = /\b(delete|drop|remove|wipe|purge|destroy|rm -rf|truncate)\b/.test(lower);
  if (destructive && targets.length === 0) {
    findings.push({
      code: "destructive-no-target",
      severity: "block",
      message:
        "Destructive verb detected with no explicit target file or module.",
      suggestion:
        "Name exactly which files, directories, or records Aedis should remove. Destructive operations without a target are never executed blindly.",
    });
  }

  // ── Rule 6: security-sensitive surface ─────────────────────────
  const security = /\b(auth|token|secret|credential|password|permission|session|jwt|oauth)\b/.test(lower);
  if (security) {
    findings.push({
      code: "security-sensitive",
      severity: "warn",
      message:
        "This task touches a security-sensitive surface (auth / tokens / credentials / permissions).",
      suggestion:
        "Consider asking for a dry-run plan first, keep the scope narrow, and require human review before committing.",
    });
  }

  // ── Rule 7: impossible writes outside project root ────────────
  for (const target of targets) {
    if (!target || !projectRoot) continue;
    const abs = isAbsolute(target) ? target : resolve(projectRoot, target);
    const normalizedRoot = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
    if (isAbsolute(target) && !abs.startsWith(normalizedRoot) && abs !== projectRoot) {
      findings.push({
        code: "target-outside-root",
        severity: "block",
        message: `Target "${target}" is outside the project root (${projectRoot}).`,
        suggestion:
          "Aedis refuses to write outside the project root. Use a relative path or fix the repoPath.",
      });
    }
  }

  // ── Rule 8: production-sensitive surface ───────────────────────
  if (/\b(prod|production|deploy|release|migration)\b/.test(lower)) {
    findings.push({
      code: "production-sensitive",
      severity: "warn",
      message:
        "This task mentions production / deploy / release / migration — Aedis will apply extra caution but cannot verify runtime impact from the repo alone.",
      suggestion:
        "Run a dry-run first and keep a rollback path ready. Consider a smaller, staged change.",
    });
  }

  const blocked = findings.some((f) => f.severity === "block");
  const hasWarnings = findings.some((f) => f.severity === "warn");

  return {
    ok: !blocked,
    findings,
    summary: buildSummary(findings, blocked, hasWarnings),
    blocked,
    hasWarnings,
  };
}

function buildSummary(
  findings: readonly PreflightFinding[],
  blocked: boolean,
  hasWarnings: boolean,
): string {
  if (findings.length === 0) return "Preflight passed with no findings.";
  if (blocked) {
    const first = findings.find((f) => f.severity === "block");
    return `Preflight blocked: ${first?.message ?? "unknown block"}`;
  }
  if (hasWarnings) {
    const warns = findings.filter((f) => f.severity === "warn").length;
    return `Preflight passed with ${warns} warning${warns === 1 ? "" : "s"}.`;
  }
  return "Preflight passed.";
}
