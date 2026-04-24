/**
 * Adversarial Guard — Phase 8 hardening.
 *
 * Single-file home for pure detection functions that harden Aedis
 * against hostile repo content, misleading success signals, and
 * contradictory evidence between workers. Every function here is:
 *
 *   - Pure (no I/O, no network, no fs)
 *   - Deterministic (same input → same output)
 *   - Non-refusing (returns findings + severity; callers decide
 *     whether to downgrade, escalate, or annotate)
 *
 * Findings carry a `severity` (`info` | `warn` | `downgrade` |
 * `escalate`) so the caller can map them onto its own gate language
 * without reimplementing the semantics here. `downgrade` is "this
 * should not be promoted to success"; `escalate` is "run the next
 * phase with extra scrutiny / stronger model / strict mode".
 *
 * Design rules:
 *   - Detect, downgrade, escalate — never block outright.
 *   - Preserve the original text. Sanitization wraps suspicious
 *     passages in neutralizing markers so the underlying content is
 *     still readable in logs and receipts.
 *   - Byte-level content-identity is authoritative; whitespace-
 *     normalized identity is advisory (catches the "reformatted echo"
 *     disguise called out in TEST-HARNESS.md rule 5).
 */

import { createHash } from "node:crypto";

// ─── Shared types ───────────────────────────────────────────────────

export type GuardSeverity = "info" | "warn" | "downgrade" | "escalate";

export interface GuardFinding {
  /** Stable code, useful for grouping in dashboards. */
  readonly code: string;
  readonly severity: GuardSeverity;
  readonly message: string;
  /** Optional file / worker / symbol the finding points at. */
  readonly ref?: string;
  /** Optional excerpt (already truncated; never includes credentials). */
  readonly excerpt?: string;
}

// ─── 1. Prompt-injection scanning ───────────────────────────────────

/**
 * Patterns that plausibly attempt to override the model's current
 * instructions when they show up inside a file Scout reads. Matching
 * is case-insensitive; tests asserting specific strings rely on the
 * `code` field rather than the pattern.
 *
 * Keep this list tight. False positives cost more than the checks
 * buy us — a `warn` on every "TODO" comment makes the signal noise.
 */
const INJECTION_PATTERNS: readonly {
  code: string;
  pattern: RegExp;
  severity: GuardSeverity;
  message: string;
}[] = [
  {
    code: "injection.override",
    pattern:
      /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions|context|prompts)\b/i,
    severity: "escalate",
    message: "possible instruction-override directive embedded in repo text",
  },
  {
    code: "injection.new_instructions",
    pattern: /\b(new|updated)\s+(system\s+)?(instructions|directives)\s*[:\-]/i,
    severity: "escalate",
    message: "embedded attempt to inject new instructions",
  },
  {
    code: "injection.persona_shift",
    pattern: /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be|roleplay\s+as)\b/i,
    severity: "warn",
    message: "persona-shift directive in file text",
  },
  {
    code: "injection.system_marker",
    pattern:
      /\[\s*(SYSTEM|INST|INSTRUCTION)\s*\]|<\|im_start\|>|<\|im_end\|>|<\/s>|### Instruction/i,
    severity: "escalate",
    message: "chat-template marker embedded in repo text",
  },
  {
    code: "injection.exfil",
    pattern:
      /\b(post|send|upload|leak|exfiltrate)\b[^\n]{0,40}\b(api[_\s-]?key|secret|token|password|credential)s?\b/i,
    severity: "escalate",
    message: "exfiltration directive referencing credentials",
  },
  {
    code: "injection.shell_pipe",
    pattern:
      /\bcurl\b[^\n]*\|\s*(sh|bash|zsh)\b|\bwget\b[^\n]*\|\s*(sh|bash)\b|\brm\s+-rf\s+\/(?!$)/i,
    severity: "escalate",
    message: "dangerous shell-pipe or destructive rm in file text",
  },
  {
    code: "injection.ai_directive",
    pattern:
      /\b(AI|LLM|ASSISTANT|CLAUDE|GPT|COPILOT)[:\s]+(always|never|must|should)\s+(return|output|say|answer|reply)\b/i,
    severity: "warn",
    message: "AI-directed directive embedded in code/comments",
  },
];

export interface InjectionScanOptions {
  /** Max chars of excerpt to include per finding. Defaults to 140. */
  readonly excerptChars?: number;
  /** Source label (filename) propagated onto findings.ref. */
  readonly source?: string;
}

export interface InjectionScanResult {
  readonly findings: readonly GuardFinding[];
  /**
   * The input with suspicious passages wrapped in a neutralizing
   * marker so that if this text is downstreamed into a builder prompt
   * the model can still read it but is less likely to follow the
   * directive. Left identical to the input when no patterns match.
   */
  readonly sanitized: string;
}

const NEUTRALIZE_PREFIX = "[AEDIS-NEUTRALIZED:";
const NEUTRALIZE_SUFFIX = "]";

export function scanForInjection(
  text: string,
  opts: InjectionScanOptions = {},
): InjectionScanResult {
  if (!text || text.length === 0) {
    return { findings: [], sanitized: text ?? "" };
  }
  const excerptChars = Math.max(20, opts.excerptChars ?? 140);

  const findings: GuardFinding[] = [];
  // Accumulate neutralization edits (start, end, replacement) and apply in
  // descending order so earlier edits' offsets are not invalidated.
  const edits: { start: number; end: number; replacement: string }[] = [];

  for (const p of INJECTION_PATTERNS) {
    const re = new RegExp(p.pattern.source, p.pattern.flags.includes("g") ? p.pattern.flags : p.pattern.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      const excerpt = clipExcerpt(text, start, end, excerptChars);
      findings.push({
        code: p.code,
        severity: p.severity,
        message: p.message,
        ref: opts.source,
        excerpt,
      });
      edits.push({
        start,
        end,
        replacement: `${NEUTRALIZE_PREFIX}${p.code}:${m[0]}${NEUTRALIZE_SUFFIX}`,
      });
    }
  }

  if (findings.length === 0) {
    return { findings: [], sanitized: text };
  }

  edits.sort((a, b) => b.start - a.start);
  let sanitized = text;
  for (const e of edits) {
    sanitized = sanitized.slice(0, e.start) + e.replacement + sanitized.slice(e.end);
  }
  return { findings, sanitized };
}

function clipExcerpt(
  text: string,
  start: number,
  end: number,
  max: number,
): string {
  const pad = Math.max(0, Math.floor((max - (end - start)) / 2));
  const s = Math.max(0, start - pad);
  const e = Math.min(text.length, end + pad);
  const out = text.slice(s, e).replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max - 1) + "…" : out;
}

// ─── 2. Content-identity detection ──────────────────────────────────

export interface ContentIdentityResult {
  /** True when before and after are byte-equal. */
  readonly identical: boolean;
  /**
   * True when before and after are equal after collapsing whitespace
   * and stripping trailing spaces. Catches the "reformatted echo"
   * variant where a model re-emits source with different indentation.
   */
  readonly normalizedIdentical: boolean;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly reason: string;
}

export function detectContentIdentity(
  before: string | null | undefined,
  after: string | null | undefined,
): ContentIdentityResult {
  const b = before ?? "";
  const a = after ?? "";
  const beforeHash = hash(b);
  const afterHash = hash(a);
  const identical = beforeHash === afterHash;
  const normalizedIdentical = identical || normalize(b) === normalize(a);

  let reason: string;
  if (identical) {
    reason = "byte-identical: post-apply content matches pre-apply exactly";
  } else if (normalizedIdentical) {
    reason =
      "whitespace-normalized identical: content matches after collapsing whitespace";
  } else {
    reason = "content differs";
  }
  return { identical, normalizedIdentical, beforeHash, afterHash, reason };
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function normalize(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// ─── 3. Intent satisfaction ─────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "and", "the", "is", "are", "was", "were", "be", "to", "of",
  "in", "on", "at", "for", "with", "by", "from", "as", "it", "this", "that",
  "these", "those", "i", "you", "we", "they", "my", "our", "your",
  "please", "can", "could", "should", "would", "will", "do", "does", "did",
  "if", "when", "then", "so", "but", "or", "not", "no", "yes",
  "code", "file", "files", "function", "functions", "line", "lines",
  "fix", "add", "update", "change", "remove", "delete",
]);

export interface IntentSatisfactionInput {
  readonly prompt: string;
  readonly filesChanged: readonly string[];
  readonly diffText?: string;
  readonly scoutTargets?: readonly string[];
}

export interface IntentSatisfactionResult {
  readonly score: number; // 0..1
  readonly findings: readonly GuardFinding[];
  readonly keywords: readonly string[];
  readonly fileOverlap: number; // fraction of changed files matching a prompt keyword
  readonly symbolOverlap: number; // fraction of prompt keywords appearing in diff
}

export function checkIntentSatisfaction(
  input: IntentSatisfactionInput,
): IntentSatisfactionResult {
  const keywords = extractKeywords(input.prompt);
  const findings: GuardFinding[] = [];

  if (keywords.length === 0) {
    // Prompt has no substantive keywords — can't judge. Stay silent;
    // this just means the signal is unavailable, not that something
    // went wrong.
    return {
      score: 0.5,
      findings,
      keywords,
      fileOverlap: 0,
      symbolOverlap: 0,
    };
  }

  const files = input.filesChanged;
  const fileMatches =
    files.length === 0
      ? 0
      : files.filter((f) => keywords.some((k) => f.toLowerCase().includes(k))).length;
  const fileOverlap = files.length === 0 ? 0 : fileMatches / files.length;

  const diffLower = (input.diffText ?? "").toLowerCase();
  const kwMatches = keywords.filter((k) => diffLower.includes(k)).length;
  const symbolOverlap = keywords.length === 0 ? 0 : kwMatches / keywords.length;

  // Score combines both signals; file overlap is the stronger one
  // because it's a structural match. Diff overlap is noisier.
  const score = 0.6 * fileOverlap + 0.4 * symbolOverlap;

  if (files.length === 0) {
    findings.push({
      code: "intent.no_files_changed",
      severity: "downgrade",
      message:
        "prompt requested a change but no files were modified — cannot satisfy intent",
    });
  } else if (fileOverlap === 0) {
    findings.push({
      code: "intent.file_mismatch",
      severity: "downgrade",
      message: `none of the ${files.length} changed files match any keyword from the prompt`,
    });
  } else if (score < 0.3) {
    findings.push({
      code: "intent.weak_match",
      severity: "warn",
      message: `intent-satisfaction score ${score.toFixed(2)} — changes may not address the prompt`,
    });
  }

  // Scout-declared targets that were completely ignored by the builder.
  if (input.scoutTargets && input.scoutTargets.length > 0 && files.length > 0) {
    const ignored = input.scoutTargets.filter(
      (t) => !files.some((f) => pathsMatch(f, t)),
    );
    if (ignored.length === input.scoutTargets.length) {
      findings.push({
        code: "intent.scout_targets_ignored",
        severity: "warn",
        message: `builder changed ${files.length} file(s); none match any scout target`,
      });
    }
  }

  return { score, findings, keywords, fileOverlap, symbolOverlap };
}

function extractKeywords(prompt: string | null | undefined): string[] {
  if (!prompt || typeof prompt !== "string") return [];
  const tokens = prompt
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return Array.from(new Set(tokens));
}

function pathsMatch(a: string, b: string): boolean {
  const na = a.toLowerCase();
  const nb = b.toLowerCase();
  return na === nb || na.endsWith("/" + nb) || nb.endsWith("/" + na);
}

// ─── 4. Cross-worker consensus ──────────────────────────────────────

export interface ConsensusInput {
  readonly scoutTargets: readonly string[];
  readonly builderFiles: readonly string[];
  /** Files the verifier actually exercised (e.g. test paths or typecheck inputs). */
  readonly verifierFiles?: readonly string[];
}

export interface ConsensusResult {
  readonly score: number; // 0..1 — fraction of builder changes scout corroborated
  readonly findings: readonly GuardFinding[];
  readonly builderFilesUnvouched: readonly string[];
  readonly verifierDisjoint: boolean;
}

export function checkCrossWorkerConsensus(
  input: ConsensusInput,
): ConsensusResult {
  const findings: GuardFinding[] = [];
  const scoutSet = new Set(input.scoutTargets.map((s) => s.toLowerCase()));
  const builderSet = new Set(input.builderFiles.map((s) => s.toLowerCase()));

  const unvouched = input.builderFiles.filter(
    (f) => ![...scoutSet].some((s) => pathsMatch(f, s)),
  );
  const corroborated =
    input.builderFiles.length - unvouched.length;
  const score =
    input.builderFiles.length === 0
      ? 1
      : corroborated / input.builderFiles.length;

  if (
    input.builderFiles.length > 0 &&
    input.scoutTargets.length > 0 &&
    corroborated === 0
  ) {
    findings.push({
      code: "consensus.builder_outside_scout",
      severity: "downgrade",
      message: `builder touched ${input.builderFiles.length} file(s); none were identified by scout`,
    });
  } else if (score > 0 && score < 0.5) {
    findings.push({
      code: "consensus.partial_agreement",
      severity: "warn",
      message: `scout↔builder file agreement ${(score * 100).toFixed(0)}% — unvouched: ${unvouched.slice(0, 3).join(", ")}${unvouched.length > 3 ? "…" : ""}`,
    });
  }

  let verifierDisjoint = false;
  if (input.verifierFiles && input.verifierFiles.length > 0 && builderSet.size > 0) {
    const anyOverlap = input.verifierFiles.some((vf) =>
      [...builderSet].some((bf) => pathsMatch(vf, bf)),
    );
    if (!anyOverlap) {
      verifierDisjoint = true;
      findings.push({
        code: "consensus.verifier_disjoint",
        severity: "warn",
        message:
          "verifier exercised files disjoint from builder's changes — verification may not cover the edit",
      });
    }
  }

  return {
    score,
    findings,
    builderFilesUnvouched: unvouched,
    verifierDisjoint,
  };
}

// ─── 5. Provider-output anomaly ─────────────────────────────────────

const COMPLETION_CLAIMS =
  /\b(i(?:'| ha)?ve|i have|done|completed|fixed|implemented|added|updated)\b/i;

export interface ProviderAnomalyInput {
  readonly responseText: string;
  readonly filesChanged: readonly string[];
  readonly verdict?: string;
  /** Provider/model name, for the finding ref. */
  readonly model?: string;
}

export interface ProviderAnomalyResult {
  readonly findings: readonly GuardFinding[];
}

export function classifyProviderAnomaly(
  input: ProviderAnomalyInput,
): ProviderAnomalyResult {
  const findings: GuardFinding[] = [];
  const text = input.responseText ?? "";
  const changed = input.filesChanged.length;

  if (COMPLETION_CLAIMS.test(text) && changed === 0) {
    findings.push({
      code: "provider.claim_without_change",
      severity: "downgrade",
      message:
        "model response claims completion but no files were changed",
      ref: input.model,
      excerpt: text.slice(0, 140),
    });
  }

  // A response with ```fence``` blocks (typical of a model trying to
  // "edit" something via markdown) but no actual file changes is a
  // strong signal the provider returned prose instead of a tool call.
  if (/```[a-z]*\n[^`]{40,}```/i.test(text) && changed === 0) {
    findings.push({
      code: "provider.prose_instead_of_edit",
      severity: "downgrade",
      message:
        "model returned fenced code but the builder produced no file changes",
      ref: input.model,
    });
  }

  // Very short response on a non-trivial request is suspicious; we can
  // only see it as an info signal here because we don't know the
  // request length at this layer.
  if (text.length > 0 && text.length < 40 && changed === 0) {
    findings.push({
      code: "provider.terse_no_output",
      severity: "info",
      message: "model response unusually short with no file changes",
      ref: input.model,
    });
  }

  return { findings };
}

// ─── 6. Aggregation helpers ─────────────────────────────────────────

/**
 * Roll a set of findings into a single verdict the caller can feed
 * into an existing gate. The order of precedence matches what callers
 * typically want: any `escalate` dominates, then `downgrade`, then
 * `warn`, else `clean`.
 */
export function aggregateSeverity(
  findings: readonly GuardFinding[],
): GuardSeverity | "clean" {
  if (findings.some((f) => f.severity === "escalate")) return "escalate";
  if (findings.some((f) => f.severity === "downgrade")) return "downgrade";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  if (findings.some((f) => f.severity === "info")) return "info";
  return "clean";
}
