// Builder worker module
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import type { RunState, CostEntry } from "../core/runstate.js";
import { recordDecision, recordFileTouch } from "../core/runstate.js";
import {
  invokeModelWithFallback,
  createRunInvocationContext,
  type InvokeConfig,
  type Provider,
  type RunInvocationContext,
} from "../core/model-invoker.js";
import { DiffApplier } from "../core/diff-applier.js";
import { loadModelConfig } from "../server/routes/config.js";
import type { EventBus } from "../server/websocket.js";
import {
  AbstractWorker,
  validateWorkerAssignment,
  type BuildDecision,
  type BuilderOutput,
  type FileChange,
  type WorkerAssignment,
  type WorkerResult,
} from "./base.js";
import { extractRelevantSection, type SectionExtraction } from "./scout.js";

// ─── Contract Types (exported for Critic) ────────────────────────────

export interface TaskContract {
  readonly file: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly interfaceRules: readonly string[];
}

export interface ModelInvocation {
  readonly model: string;
  readonly prompt: string;
  readonly contract: TaskContract;
  readonly assignment: WorkerAssignment;
}

export interface ModelResponse {
  readonly content: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCostUsd?: number;
}

export interface BuilderResult extends WorkerResult {
  readonly output: BuilderOutput & {
    readonly contract: TaskContract;
    readonly prompt: string;
    readonly rawModelResponse: string;
    /**
     * Phase 8.5 — provider-anomaly findings from classifyProviderAnomaly
     * against the raw model response + produced changes. Empty when the
     * response looked consistent with the diff. Aggregated alongside
     * scout injection findings + execution content-identity findings
     * by collectAdversarialFindingsForConfidence.
     */
    readonly providerFindings?: readonly GuardFinding[];
  };
}

export interface BuilderWorkerConfig {
  readonly projectRoot: string;
  readonly eventBus?: EventBus;
  readonly runState?: RunState;
  readonly defaultModel?: string;
  readonly defaultProvider?: Provider;
  /**
   * Fallback model for when the primary provider times out or errors.
   * Defaults to claude-sonnet-4-6 on Anthropic. Set to null to disable
   * the fallback.
   */
  readonly fallbackModel?: { provider: Provider; model: string } | null;
}

// Default fallback chain target — Kimi K2 via OpenRouter as the cheap-and-fast
// backstop for the builder. qwen3.6-plus via OpenRouter is the primary;
// Kimi K2 via OpenRouter is the fallback when qwen is unavailable.
const DEFAULT_FALLBACK: { provider: Provider; model: string } = {
  provider: "openrouter",
  model: "moonshotai/kimi-k2",
};

// Maximum number of run contexts to keep in memory. Each entry is tiny
// (a Set of provider strings), but we cap it to avoid unbounded growth
// across very long-lived processes.
const MAX_RUN_CONTEXTS = 50;

// ─── Prompt Size Caps ────────────────────────────────────────────────
//
// The Builder enforces a hard ceiling on prompt size to keep model calls
// fast and predictable. The cap is expressed in tokens, but enforced in
// chars (~4 chars per token is the standard rough estimate — actual
// tokenization varies by model, but this approximation is intentionally
// conservative so we never exceed the real limit).
//
//   PROMPT_TOKEN_CAP        — hard ceiling on the entire prompt
//   PROMPT_CHAR_CAP         — same, in chars (TOKEN_CAP * 4)
//   CONTEXT_TOKEN_CAP       — soft ceiling on the joined context layers block
//   CONTEXT_CHAR_CAP        — same, in chars
//   LARGE_FILE_CHAR_THRESHOLD — when originalContent exceeds this, the
//     Builder switches to SECTION-EDIT MODE: it calls extractRelevantSection
//     from workers/scout.ts to get a windowed slice of the file, asks the
//     model to produce a unified diff with original line numbers, and
//     applies that diff to the full file on disk. This keeps coordinator.ts
//     (54k+ chars) and similar large files editable without blowing the cap.
const PROMPT_TOKEN_CAP = 16_000;
const PROMPT_CHAR_CAP = PROMPT_TOKEN_CAP * 4;     // 64_000
const CONTEXT_TOKEN_CAP = 12_000;
const CONTEXT_CHAR_CAP = CONTEXT_TOKEN_CAP * 4;   // 48_000
const LARGE_FILE_CHAR_THRESHOLD = 30_000;
import { computeBuilderConfidence } from "../core/confidence-scoring.js";
import {
  classifyProviderAnomaly,
  type GuardFinding,
} from "../core/adversarial-guard.js";

// Reserved overhead for separators and the "Relevant context:" header
// when computing the available context budget.
const CONTEXT_OVERHEAD_CHARS = 64;

// ─── Section-Mode Safety Thresholds ──────────────────────────────────
//
// These gates exist because the previous 50% length threshold let a
// real corruption through: coordinator.ts went from 1343 to 1298 lines
// (96.6% retained) and the looser check waved it through to a commit.
const SECTION_LENGTH_RETAIN_FLOOR = 0.95;
const SECTION_BRACE_DELTA_TOLERANCE = 2;

// Code-file extensions we care about for prose-detection. Markdown
// and plain-text files legitimately contain prose, so we skip them.
const CODE_FILE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|kt|swift|c|cc|cpp|cs|php|scala|hs|clj|lua|sh|bash|zsh|fish|toml|yaml|yml|json)$/i;

/**
 * Heuristic: does this look like a model that ignored "return the file
 * content" and emitted conversational analysis / markdown review instead?
 *
 * Fires when ALL of these are true:
 *   - target file is a code file (by extension)
 *   - content starts with (or early-contains) common prose markers:
 *       "I've reviewed" / "I have reviewed" / "Here's" / "Here is"
 *       / "Sure, here" / markdown headers / "Let me"
 *   - OR content is dominated by markdown bold/headers with no braces
 *
 * Tuned to be conservative — false positives are worse than
 * false negatives here because this throws and reverts the run.
 */
// ─── Phase 11 — export preservation ─────────────────────────────────

/**
 * Regex covering the named-export shapes TypeScript files emit most
 * often. Mirrors EXPORT_DECL_REGEX in core/integration-judge.ts so the
 * two layers agree on what counts as an export. Kept local to avoid a
 * cross-module dependency between the builder and the judge.
 */
const NAMED_EXPORT_REGEX =
  /(?:^|\n)\s*export\s+(?:abstract\s+)?(?:async\s+)?(?:default\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/g;
const EXPORT_CLAUSE_REGEX = /(?:^|\n)\s*export\s*\{\s*([^}]+)\}/g;

// Phase 12 — per-export signature capture. Matches the same export
// shapes as NAMED_EXPORT_REGEX but additionally captures everything
// from the keyword (function/const/…) up to the first `{` (body) or
// `=` (initializer) — i.e. the signature line. Used to detect the
// "kept the name but changed the shape" corruption mode where the
// model preserves an export by name but mutates its parameters /
// generics / return type / class hierarchy in a way that breaks
// downstream callers.
const NAMED_EXPORT_SIG_REGEX =
  /(?:^|\n)\s*export\s+(?:abstract\s+)?(?:async\s+)?(?:default\s+)?(function|const|let|var|class|interface|type|enum)\s+(\w+)([^{=\n]*)/g;

/**
 * Extract the set of named exports from a source file. Returns a
 * stable-sorted, deduplicated list of identifiers. Returns an empty
 * array on non-TS/JS files — the caller is responsible for gating by
 * extension so we don't false-positive on markdown, JSON, etc.
 */
export function extractNamedExports(content: string): string[] {
  if (!content) return [];
  const names = new Set<string>();
  const haystack = "\n" + content;
  for (const match of haystack.matchAll(NAMED_EXPORT_REGEX)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of haystack.matchAll(EXPORT_CLAUSE_REGEX)) {
    for (const name of match[1].split(",")) {
      const cleaned = name.trim().split(/\s+as\s+/)[1]?.trim() ?? name.trim().split(/\s+as\s+/)[0].trim();
      if (cleaned) names.add(cleaned);
    }
  }
  return [...names].sort();
}

/**
 * Phase 12 — per-export signature fingerprint. For every named export
 * declaration, capture a normalized signature string of the form
 * `<kind> <name><tail>` where `<tail>` is everything from the name up
 * to the body (`{`) or initializer (`=`), with whitespace collapsed.
 * Re-export clauses (`export { … } from …`) get a `clause` kind with
 * no signature payload — the source of truth for those is the upstream
 * file, not this one.
 *
 * Returns a Map keyed by exported name so the caller can ask "did the
 * shape of `foo` change?" via a single lookup rather than re-scanning
 * the diff. Pure, deterministic, no I/O.
 */
export function extractNamedExportSignatures(content: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!content) return out;
  const haystack = "\n" + content;

  for (const match of haystack.matchAll(NAMED_EXPORT_SIG_REGEX)) {
    const kind = match[1];
    const name = match[2];
    const tail = (match[3] ?? "").replace(/\s+/g, " ").trim();
    if (!name) continue;
    out.set(name, tail ? `${kind} ${name} ${tail}` : `${kind} ${name}`);
  }
  for (const match of haystack.matchAll(EXPORT_CLAUSE_REGEX)) {
    for (const raw of match[1].split(",")) {
      const cleaned = raw.trim().split(/\s+as\s+/)[1]?.trim() ?? raw.trim().split(/\s+as\s+/)[0].trim();
      if (cleaned && !out.has(cleaned)) out.set(cleaned, `clause ${cleaned}`);
    }
  }
  return out;
}

/**
 * Phase 11 — export-preservation guard. The dominant merge-gate
 * failure mode for simple bugfix/feature tasks on targeted files
 * (stress-01, stress-02, stress-09, stress-11..14) is a wholesale
 * file rewrite: the model "fixes" fibonacci by emitting a new file
 * that contains only fibonacci, deleting every sibling export
 * (divide, isEven, capitalize, Stack, etc.) that downstream tests
 * depend on. The integration judge catches the aftermath as
 * type-alignment + cross-file-coherence + intent-alignment blockers,
 * but by then the patch is already written and the run is wasted.
 *
 * This guard fires BEFORE the patch is applied. When the updated
 * content has lost two or more named exports present in the original,
 * we throw — the coordinator surfaces a builder error and the run
 * classifies concretely as worker_issue instead of merge_blocked.
 *
 * Threshold is intentionally >= 2 removals. A legitimate rename
 * (1 removed, 1 added) or a targeted deletion named in the prompt
 * would have exactly 1 removal and slip through. A rewrite always
 * trashes many.
 */
export interface ExportSignatureChange {
  readonly name: string;
  readonly before: string;
  readonly after: string;
}

export interface ExportPreservationIssue {
  /**
   * Names that were exported in the original but are no longer
   * exported in the updated content. Catches:
   *   - explicit removal of the `export` keyword (symbol may still
   *     exist in the file — extractNamedExports only matches when
   *     `export` is present, so the comparison is set-based, not
   *     diff-line based)
   *   - moves to a different file with no re-export clause kept
   *   - wholesale rewrites
   */
  readonly missing: readonly string[];
  /**
   * Phase 12 — names that are exported in BOTH versions but whose
   * declared signature changed. Catches:
   *   - parameter list changes
   *   - return type changes
   *   - generic constraint changes
   *   - class extends/implements changes
   *   - const type-annotation changes
   * Body / initializer values are intentionally excluded (those can
   * change without breaking downstream callers).
   */
  readonly signatureChanges: readonly ExportSignatureChange[];
  readonly originalCount: number;
  readonly updatedCount: number;
}

/**
 * Compare the export sets of two file revisions and report:
 *   - missing exports (case 1 + case 3 from the corruption taxonomy)
 *   - signature changes for exports kept by name (case 2)
 *
 * Comparison is between the EXTRACTED EXPORT SETS, not raw diff
 * lines — this is what makes "removed `export` keyword but kept
 * `function foo`" a detected case: `foo` is in the before-set but
 * not the after-set because `extractNamedExports` requires the
 * `export` prefix to match.
 */
export function findRemovedExports(
  originalContent: string,
  updatedContent: string,
): ExportPreservationIssue {
  const beforeSigs = extractNamedExportSignatures(originalContent);
  const afterSigs = extractNamedExportSignatures(updatedContent);

  const missing: string[] = [];
  const signatureChanges: ExportSignatureChange[] = [];

  for (const [name, before] of beforeSigs) {
    const after = afterSigs.get(name);
    if (!after) {
      missing.push(name);
      continue;
    }
    // Re-export clauses don't carry a signature payload, so a
    // `clause name` ↔ `function name(…)` swap is treated as a kept
    // export — that's a legitimate "move with re-export" pattern.
    if (before.startsWith("clause ") || after.startsWith("clause ")) continue;
    if (before !== after) {
      signatureChanges.push({ name, before, after });
    }
  }
  missing.sort();
  return {
    missing,
    signatureChanges,
    originalCount: beforeSigs.size,
    updatedCount: afterSigs.size,
  };
}

const EXPORT_LOSS_THRESHOLD_DEFAULT = 2;
const EXPORT_LOSS_THRESHOLD_STRICT = 1;

/**
 * Phase 11 Task 1 — does the user's request explicitly authorize
 * removing or renaming an export? If yes, a single-export drop is a
 * legitimate outcome and should not trip the preservation guard.
 * Exported for reuse in tests. Pure function, whole-word matching.
 */
export function requestAuthorizesRemoval(userRequest: string | null | undefined): boolean {
  if (!userRequest || typeof userRequest !== "string") return false;
  const lower = userRequest.toLowerCase();
  if (/\b(remove|removing|delete|deleting|drop|dropping|eliminate|eliminating)\b/.test(lower)) return true;
  if (/\brename|renaming\b/.test(lower)) return true;
  // "replace" only authorizes removal when it looks structural/API-level,
  // not when the user means "replace this string/message/logic".
  if (
    /\breplac(?:e|ing)\b[\s\S]{0,80}\b(function|class|helper|module|validator|logger|export|symbol|api|component|hook)\b[\s\S]{0,80}\bwith\b/.test(lower)
  ) return true;
  // "extract" authorizes removal only when moving code into a file/module
  // boundary, which is the common re-export/refactor shape.
  if (/\bextract(?:ing)?\b[\s\S]{0,80}\b(into|to)\b[\s\S]{0,80}\b(file|module)\b/.test(lower)) return true;
  return false;
}

/**
 * Phase 11 Task 1 — enforce that the builder's output keeps the
 * original file's exports. The threshold is dynamic:
 *
 *   - If the user request contains NO removal/rename intent (the
 *     common "fix" / "add" shape for simple targeted tasks), then
 *     dropping ANY export is suspicious — threshold is 1. This
 *     catches the single-symbol corruption case observed on
 *     stress-01..14 where the builder silently drops `Stack` or
 *     `validateEmail` while "fixing" a sibling function.
 *
 *   - If the user request explicitly authorizes removal / rename /
 *     replacement / extraction, keep the original >=2 threshold so
 *     legitimate rename flows (1 removed, 1 added) still slip
 *     through.
 *
 * `userRequest` is optional; when absent the check falls back to the
 * original >=2 threshold, preserving backward compatibility for any
 * caller that hasn't adopted the new signature yet.
 */
export function enforcePreservedExports(
  originalContent: string,
  updatedContent: string,
  filePath: string,
  userRequest?: string | null,
): void {
  if (!CODE_FILE_EXTENSIONS.test(filePath)) return;
  const issue = findRemovedExports(originalContent, updatedContent);
  if (issue.missing.length === 0 && issue.signatureChanges.length === 0) return;

  const authorizedRemoval =
    userRequest === undefined
      ? true // legacy caller: assume authorized so we keep the old threshold
      : requestAuthorizesRemoval(userRequest);
  const removalThreshold = authorizedRemoval
    ? EXPORT_LOSS_THRESHOLD_DEFAULT
    : EXPORT_LOSS_THRESHOLD_STRICT;
  // Phase 12 — signature-change threshold is intentionally one step
  // looser than the removal threshold. Reasoning: a single signature
  // change is often the EXACT thing the user asked for ("fix
  // capitalize to handle empty strings" may legitimately add a
  // parameter). Two or more signature changes in unrelated exports
  // signals broader rewrite. Authorized requests get a higher
  // threshold for the same reason renames/extracts can legitimately
  // mutate multiple shapes during a refactor.
  const sigThreshold = authorizedRemoval ? 3 : 2;

  const removalTrips = issue.missing.length >= removalThreshold;
  const sigTrips = issue.signatureChanges.length >= sigThreshold;
  if (!removalTrips && !sigTrips) return;

  const parts: string[] = [];
  if (issue.missing.length > 0) {
    parts.push(
      `removed ${issue.missing.length} existing export(s) (${issue.missing.slice(0, 8).join(", ")}${issue.missing.length > 8 ? "…" : ""})`,
    );
  }
  if (issue.signatureChanges.length > 0) {
    const names = issue.signatureChanges.slice(0, 4).map((c) => c.name).join(", ");
    parts.push(
      `changed ${issue.signatureChanges.length} export signature(s) (${names}${issue.signatureChanges.length > 4 ? "…" : ""})`,
    );
  }
  const modeLabel = authorizedRemoval ? "wholesale rewrite" : "unrelated-symbol corruption";
  throw new Error(
    `SAFETY: Builder output ${parts.join(" and ")} from ${filePath}. ` +
      `Original had ${issue.originalCount} export(s); updated has ${issue.updatedCount}. ` +
      `Refusing the patch — detected ${modeLabel}; the user request did not authorize ${
        sigTrips && !removalTrips ? "this many signature changes" : "removing these symbols"
      }.`,
  );
}

/**
 * Phase 11 — produce the EXPORT PRESERVATION directive for the
 * builder prompt. When the source has >= 2 named exports, list them
 * by name so the model is confronted with the concrete identifiers
 * it must keep. When the source has fewer than 2 exports, the
 * directive is a no-op line that still conveys the rule.
 */
export function buildExportPreservationDirective(content: string): string {
  const names = extractNamedExports(content);
  if (names.length === 0) {
    return "EXPORT PRESERVATION: do not remove any existing top-level declaration unless the user request explicitly asks for it.";
  }
  const listed = names.slice(0, 16).join(", ");
  const suffix = names.length > 16 ? `, and ${names.length - 16} more` : "";
  return `EXPORT PRESERVATION: this file currently exports ${names.length} symbol(s): ${listed}${suffix}. Your output MUST still export every one of them. Do not delete, rename, or "simplify" any existing export unless the user request explicitly asks to remove it. Removing exports here will break downstream imports and fail the build.`;
}

function looksLikeConversationalProse(content: string, filePath: string): boolean {
  if (!CODE_FILE_EXTENSIONS.test(filePath)) return false;
  const trimmed = content.trimStart();
  if (trimmed.length === 0) return false;

  // Look at just the first ~800 chars — conversational openers live at
  // the top. Avoids false-positive on a code file that happens to have
  // a long multi-line string somewhere deep.
  const head = trimmed.slice(0, 800);

  const PROSE_STARTERS = [
    /^I['’]ve\s+reviewed\b/i,
    /^I\s+have\s+reviewed\b/i,
    /^Here'?s\s+(a|the|what|an)\b/i,
    /^Here\s+is\s+(a|the|what|an)\b/i,
    /^Sure,?\s*here/i,
    /^Let me\b/i,
    /^Looking\s+at\b/i,
    /^Based\s+on\b/i,
    /^After\s+reviewing\b/i,
    /^To\s+(answer|address|summarize)\b/i,
  ];
  if (PROSE_STARTERS.some((re) => re.test(head))) return true;

  // Markdown header at the top of a code file — almost always prose.
  // Permits `# Title` only inside actual string literals or comments —
  // but those are easy: they come AFTER code lines, not first.
  if (/^#{1,3}\s+\S/.test(trimmed)) return true;

  // Overwhelming markdown: bold **...** > 3 times in the first 800 chars
  // AND fewer than 2 braces — almost certainly not TypeScript / JS.
  const boldCount = (head.match(/\*\*[^*]+\*\*/g) ?? []).length;
  const braceCount = (head.match(/[{}]/g) ?? []).length;
  if (boldCount >= 3 && braceCount < 2) return true;

  // Backticked-filename headers like "### squidley-voice.ts" appear
  // when the model is explaining files rather than editing one.
  if (/^###?\s+`[\w./-]+\.[a-z]+`/im.test(head)) return true;

  return false;
}

/**
 * Compute the real (LCS-based) unified diff for a single file in a git
 * workspace by calling `git diff HEAD -- <path>`. Returns an empty string
 * if the file is untracked (new file), in which case callers should fall
 * back to the synthetic diff. Throws if `git` is unreachable.
 */
async function computeGitDiff(projectRoot: string, filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--", filePath],
      { cwd: projectRoot, timeout: 10_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    // File is likely new (no HEAD entry) or outside git. Return empty so
    // the caller falls back to synthetic.
    return "";
  }
}

// ─── Internal types for prompt assembly ──────────────────────────────

interface BuiltPrompt {
  readonly prompt: string;
  readonly chars: number;
  readonly estimatedTokens: number;
  readonly fixedChars: number;
  readonly contextChars: number;
  readonly contextBudget: number;
  readonly truncated: ReadonlyArray<TruncatedFile>;
  readonly layersIncluded: number;
  readonly layersTotal: number;
  readonly originalContentChars: number;
  readonly sectionMode: boolean;
}

interface TruncatedFile {
  readonly path: string;
  readonly chars: number;
  readonly layerIndex: number;
  readonly reason: string;
}

// Structural type for assignment.context.layers — kept loose so we don't
// depend on the exact AssembledContext shape from elsewhere.
type ContextLayers = ReadonlyArray<{
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}>;

// ─── Builder Worker ──────────────────────────────────────────────────

export class BuilderWorker extends AbstractWorker {
  readonly type = "builder" as const;
  readonly name = "Builder Worker";

  private readonly projectRoot: string;
  private readonly eventBus: EventBus | null;
  private readonly runState: RunState | null;
  private readonly defaultModel: string;
  private readonly defaultProvider: Provider;
  private readonly fallbackModel: { provider: Provider; model: string } | null;
  private readonly diffApplier: DiffApplier;

  /**
   * Per-run fallback contexts. Keyed by intent.runId so the timeout
   * blacklist persists across multiple Builder.execute() calls within
   * a single Coordinator run, but does NOT leak across runs.
   */
  private readonly runContexts = new Map<string, RunInvocationContext>();

  constructor(config: BuilderWorkerConfig) {
    super();
    // NOTE: this.projectRoot is the constructor-time default. In production
    // it's the API server's cwd (typically /mnt/ai/Zendorium). Per-task
    // submissions can override via assignment.projectRoot, which is what
    // execute() and estimateCost() read first; this field is the fallback
    // for tests and stand-alone harnesses that bypass the assignment-based
    // wiring. All path operations (resolveTarget, toRelative,
    // getActiveModelConfig) take projectRoot as a parameter so they can
    // honor the per-task override without depending on this field.
    this.projectRoot = resolve(config.projectRoot);
    this.eventBus = config.eventBus ?? null;
    this.runState = config.runState ?? null;
    this.defaultModel = config.defaultModel ?? "qwen3.6-plus";
    this.defaultProvider = config.defaultProvider ?? "modelstudio";
    this.fallbackModel = config.fallbackModel === null
      ? null
      : (config.fallbackModel ?? DEFAULT_FALLBACK);
    this.diffApplier = new DiffApplier();
  }

  canHandle(assignment: WorkerAssignment): boolean {
    return assignment.task.targetFiles.length === 1;
  }

  async estimateCost(assignment: WorkerAssignment): Promise<CostEntry> {
    // Resolve effective projectRoot from assignment first.
    const projectRoot = assignment.projectRoot ?? this.projectRoot;
    const configRoot = assignment.sourceRepo ?? projectRoot;
    const contextChars = assignment.context.layers.reduce(
      (sum, layer) => sum + layer.files.reduce((inner, file) => inner + file.content.length, 0),
      0,
    );
    const inputTokens = Math.ceil((contextChars + assignment.task.description.length * 2) / 4);
    const outputTokens = Math.min(assignment.tokenBudget, 1800);
    const { model } = this.getActiveModelConfig(configRoot);
    return {
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd: Number(((inputTokens * 0.00000035) + (outputTokens * 0.0000012)).toFixed(6)),
    };
  }

  async execute(assignment: WorkerAssignment): Promise<BuilderResult> {
    // FAIL-FAST: reject malformed assignments at the worker boundary.
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    validateWorkerAssignment(assignment, this.type);

    const startedAt = Date.now();
    const taskId = assignment.task.id;

    // Resolve the effective projectRoot for this task. Coordinator.dispatchNode
    // populates assignment.projectRoot per-submission so the Builder can target
    // any repo, not just the one it was constructed with. Falls back to
    // this.projectRoot (constructor-time, the API server's cwd) when no
    // override is provided — the test/standalone-harness path. Declared
    // outside the try block so the catch handler can use it too without
    // re-resolving.
    const projectRoot = assignment.projectRoot ?? this.projectRoot;
    // Model assignments are persisted in .aedis/model-config.json at
    // the SOURCE repo. The disposable workspace worktree does not carry
    // that file (it's gitignored). Read from sourceRepo when the
    // Coordinator provided it; fall back to projectRoot for standalone
    // harnesses that don't distinguish the two.
    const configRoot = assignment.sourceRepo ?? projectRoot;

    try {
      if (!this.canHandle(assignment)) {
        throw new Error("Builder requires an exact single-file contract scope");
      }

      const { model: primaryModel, provider: primaryProvider } = this.getActiveModelConfig(configRoot);
      const contract = this.buildContract(assignment);
      // Normalize absolute source-repo paths to worktree-relative before resolveTarget.
      const normalizedFile = assignment.sourceRepo && contract.file.startsWith(assignment.sourceRepo)
        ? resolve(projectRoot, contract.file.slice(assignment.sourceRepo.length).replace(/^[\\/]+/, ""))
        : contract.file;
      const targetPath = this.resolveTarget(normalizedFile, projectRoot);
      const relativePath = this.toRelative(targetPath, projectRoot);

      // ALWAYS read the full file. In section-edit mode we use a windowed
      // slice for the prompt, but the diff is applied back to the FULL
      // content on disk — so fullContent must be the source of truth.
      // Guard against directory paths resolved from ambiguous file references.
      let fullContent: string;
      try {
        fullContent = await readFile(targetPath, "utf8");
      } catch (err) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EISDIR") {
          console.warn(`[builder] readFile: path is a directory, skipping: ${relativePath}`);
          return this.failure(
            assignment,
            `EISDIR: resolved path is a directory: ${relativePath}`,
            { model: this.getActiveModelConfig(configRoot).model, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
            Date.now() - startedAt,
          ) as BuilderResult;
        }
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          // File does not exist yet — builder treats this as create-from-empty.
          // Model receives empty content and generates the full new file,
          // then writeFile creates it normally.
          fullContent = "";
        } else {
          throw err;
        }
      }
      this.logFileTouch(taskId, relativePath, "read");

      // ─── LARGE FILE HANDLING ─────────────────────────────────────────
      let promptContent = fullContent;
      let sectionInfo: SectionExtraction | null = null;

      if (fullContent.length > LARGE_FILE_CHAR_THRESHOLD) {
        // contract.goal is a charter-generated summary that often loses key
        // phrases from the original user prompt. Concatenate intent.userRequest
        // with contract.goal so the trigger phrase is matched no matter
        // which source contains it. The regex doesn't care about extra text.
        const taskDesc = `${assignment.intent.userRequest} ${contract.goal}`;
        sectionInfo = extractRelevantSection(targetPath, fullContent, taskDesc);
        if (sectionInfo) {
          promptContent = sectionInfo.section;
          console.log(
            `[builder] LARGE FILE: ${fullContent.length} chars > ${LARGE_FILE_CHAR_THRESHOLD} threshold. ` +
            `Extracted lines ${sectionInfo.startLine}-${sectionInfo.endLine} of ${sectionInfo.totalLines} ` +
            `(method=${sectionInfo.extractionMethod}, function=${sectionInfo.matchedFunction ?? "(none)"}, ` +
            `keywords=[${sectionInfo.keywordsUsed.join(", ")}], section=${promptContent.length} chars)`
          );
          this.noteDecision(
            taskId,
            `Section-edit mode: lines ${sectionInfo.startLine}-${sectionInfo.endLine} of ${sectionInfo.totalLines}`,
            `File too large (${fullContent.length} chars > ${LARGE_FILE_CHAR_THRESHOLD}); ` +
            `extracted via ${sectionInfo.extractionMethod}, function=${sectionInfo.matchedFunction ?? "(none)"}`,
          );
        } else {
          console.warn(
            `[builder] LARGE FILE: ${fullContent.length} chars but extractRelevantSection returned null. ` +
            `Will send full file — prompt may exceed cap.`
          );
        }
      }

      // Build prompt using the *primary* model name. The fallback model sees
      // the same prompt — it's not aware of the model identity in the prompt
      // text, so this is purely a label inside the system message.
      const built = this.buildPrompt(contract, assignment, promptContent, primaryModel, sectionInfo);
      const prompt = built.prompt;

      // Truncation log — emit BEFORE the prompt-size log so the operator
      // sees what was dropped first, then the resulting size.
      if (built.truncated.length > 0) {
        const dropped = built.truncated
          .map((t) => `${t.path} (${t.chars} chars, layer ${t.layerIndex}: ${t.reason})`)
          .join("; ");
        console.warn(
          `[builder] context truncated: ${built.truncated.length} file(s) dropped to fit ` +
          `${built.contextBudget}-char context budget (cap=${CONTEXT_CHAR_CAP}, ` +
          `kept ${built.layersIncluded}/${built.layersTotal} layer(s)) — ${dropped}`
        );
      }

      // Hard-ceiling check
      if (built.chars > PROMPT_CHAR_CAP) {
        console.warn(
          `[builder] WARN: prompt is ${built.chars} chars (~${built.estimatedTokens} tokens), ` +
          `over the ${PROMPT_CHAR_CAP}-char cap. originalContent (prompt slice) is ${built.originalContentChars} chars. ` +
          `The Builder will proceed but the model may truncate or refuse.`
        );
      }

      // Required log line — emit immediately before the model call.
      console.log(
        `[builder] prompt size: ~${built.estimatedTokens} tokens (${built.chars} chars)` +
        (sectionInfo
          ? ` [section mode: lines ${sectionInfo.startLine}-${sectionInfo.endLine} of ${sectionInfo.totalLines}]`
          : "")
      );

      // Build fallback chain
      const runId = this.extractRunId(assignment);
      const chain = this.buildInvocationChain(
        primaryProvider as Provider,
        primaryModel,
        prompt,
        assignment.tokenBudget,
        sectionInfo !== null,
        runId,
      );

      // Look up (or create) the per-run fallback context.
      const runCtx = this.getOrCreateRunContext(runId);

      console.log(
        `[builder] dispatching with fallback chain (${chain.length} entries) for run ${runId.slice(0, 8)} (projectRoot=${projectRoot}): ${chain.map(c => `${c.provider}/${c.model}`).join(" → ")}`
      );

      // Real model call via fallback-aware invoker
      const response = await invokeModelWithFallback(chain, runCtx);

      if (response.usedProvider !== primaryProvider) {
        console.warn(
          `[builder] PRIMARY FAILED — used fallback ${response.usedProvider}/${response.usedModel} ` +
          `instead of ${primaryProvider}/${primaryModel} (attempted: ${response.attemptedProviders.join(", ")})`
        );
        this.noteDecision(
          taskId,
          `Builder fell back from ${primaryProvider}/${primaryModel} to ${response.usedProvider}/${response.usedModel}`,
          `Primary provider failed mid-run; fallback chain promoted next entry`,
        );
      }

      // Process model response
      const { updatedContent, diff } = this.processModelResponse(
        response.text,
        relativePath,
        fullContent,
        sectionInfo !== null,
      );
      this.enforceForbiddenChanges(contract, updatedContent, fullContent);

      // Phase 11 — catch the wholesale-rewrite failure mode before it
      // reaches the merge gate. Pass the user request so the guard
      // can switch to strict single-export-loss mode when the user
      // didn't authorize any removal (the simple-targeted bugfix
      // case). See findRemovedExports + enforcePreservedExports for
      // context.
      enforcePreservedExports(
        fullContent,
        updatedContent,
        relativePath,
        assignment.intent?.userRequest,
      );

      if (updatedContent === fullContent) {
        throw new Error("Model returned no effective file changes");
      }

      // Final safety gate: never write raw diff text to a source file
      if (DiffApplier.looksLikeRawDiff(updatedContent)) {
        throw new Error(`SAFETY: Refusing to write raw diff text to ${relativePath}`);
      }

      // Prose-output safety gate: catch local / small models that ignore
      // the "return ONLY the full final file content" instruction and
      // emit conversational analysis + markdown instead of code. Seen in
      // real runs — qwen3.6:35b returned "I've reviewed the two
      // configuration files you shared. Here's a concise summary..."
      // which then got committed as TypeScript. Only applies to code
      // files (.ts, .tsx, .js, .jsx, .py, .rs, .go, .java, .rb).
      if (looksLikeConversationalProse(updatedContent, relativePath)) {
        throw new Error(
          `SAFETY: Builder output looks like conversational prose / markdown, not code for ${relativePath}. ` +
          `First 200 chars: ${updatedContent.slice(0, 200).replace(/\s+/g, " ")}`,
        );
      }

      // Apply the change
      await writeFile(targetPath, updatedContent, "utf8");
      this.logFileTouch(taskId, relativePath, "modify");
      this.noteDecision(taskId, `Applied builder patch to ${relativePath}`, `Contract goal: ${contract.goal}`);

      // Replace the synthetic line-by-line diff with git's real LCS-based
      // diff. buildUnifiedDiff() below is a positional comparator — it
      // doesn't know about insertions, so inserting a line at the top
      // makes every subsequent line appear as a removal + re-add. git
      // diff understands insertions and produces the minimal hunk.
      // Fall back to the synthetic diff if git isn't available (shouldn't
      // happen in a workspace, but be safe).
      const realDiff = await computeGitDiff(projectRoot, relativePath).catch(() => diff);
      const finalDiff = realDiff && realDiff.trim() ? realDiff : diff;

      const changes: FileChange[] = [{
        path: relativePath,
        operation: "modify",
        diff: finalDiff,
        originalContent: fullContent,
        content: updatedContent,
      }];

      const decisions: BuildDecision[] = [{
        description: `Applied contract-scoped update to ${relativePath}` +
          (sectionInfo ? ` (section-edit mode, lines ${sectionInfo.startLine}-${sectionInfo.endLine})` : ""),
        rationale: contract.goal,
        alternatives: ["Refuse patch outside scope", "Request narrower contract"],
      }];

      const cost: CostEntry = {
        model: response.usedModel,
        inputTokens: response.tokensIn,
        outputTokens: response.tokensOut,
        estimatedCostUsd: response.costUsd,
      };

      // Phase 8.5 — run provider-anomaly detection against the raw
      // response + produced changes. On the happy path (changes > 0 and
      // coherent response) this emits zero findings. It catches the
      // edge cases where the upstream prose / raw-diff / empty-change
      // gates didn't fire but the response still looks inconsistent
      // with the work produced — e.g. a completion claim that survived
      // content-identity but was glued to a trivial whitespace diff.
      const providerFindings: GuardFinding[] = classifyProviderAnomaly({
        responseText: response.text,
        filesChanged: changes.map((c) => c.path),
        verdict: "success",
        model: response.usedModel,
      }).findings as GuardFinding[];

      const output: BuilderResult["output"] = {
        kind: "builder",
        changes,
        decisions,
        needsCriticReview: true,
        contract,
        prompt,
        rawModelResponse: response.text,
        providerFindings,
      };

      // Compute builder confidence from actual run signals
      const originalLines = fullContent.split("\n").length;
      const changedLines = Math.abs(updatedContent.split("\n").length - originalLines) + (diff ? diff.split("\n").filter(l => l.startsWith("+") || l.startsWith("-")).length : 0);
      const builderConfidence = computeBuilderConfidence({
        diffApplied: true, // we got here, so diff applied
        sectionEdit: sectionInfo !== null,
        sectionRetention: sectionInfo ? updatedContent.split("\n").length / originalLines : undefined,
        usedFallback: response.usedProvider !== primaryProvider,
        linesChanged: changedLines,
        totalLines: originalLines,
        filesModified: 1,
      });

      this.eventBus?.emit({
        type: "builder_complete",
        payload: {
          runId: this.extractRunId(assignment),
          taskId,
          workerType: this.type,
          file: relativePath,
          // Transparency rule: surface the actual +/- diff live so the UI
          // can render it as the Builder finishes each file, rather than
          // hiding the change until the end-of-run patch artifact.
          diff,
          path: relativePath,
          operation: "modify",
          model: response.usedModel,
          provider: response.usedProvider,
          costUsd: cost.estimatedCostUsd,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          fellBack: response.usedProvider !== primaryProvider,
          sectionMode: sectionInfo !== null,
          sectionRange: sectionInfo
            ? { startLine: sectionInfo.startLine, endLine: sectionInfo.endLine, totalLines: sectionInfo.totalLines }
            : null,
          confidence: builderConfidence,
        },
      });

      return this.success(assignment, output, {
        cost,
        confidence: builderConfidence,
        touchedFiles: [
          { path: relativePath, operation: "read" },
          { path: relativePath, operation: "modify" },
        ],
        assumptions: [],
        issues: [],
        durationMs: Date.now() - startedAt,
      }) as BuilderResult;
    } catch (error) {
      this.eventBus?.emit({
        type: "task_failed",
        payload: {
          taskId,
          workerType: this.type,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      const { model } = this.getActiveModelConfig(configRoot);
      return this.failure(
        assignment,
        error instanceof Error ? error.message : String(error),
        { model, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        Date.now() - startedAt,
      ) as BuilderResult;
    }
  }

  protected emptyOutput(): BuilderOutput {
    return {
      kind: "builder",
      changes: [],
      decisions: [],
      needsCriticReview: true,
    };
  }

  // ─── Model Resolution ────────────────────────────────────────────

  /**
   * Resolve the active model configuration for a given projectRoot.
   * Each call reads .aedis/model-config.json from the supplied root
   * (with .zendorium/model-config.json as a legacy fallback), so
   * per-task projectRoot overrides honor per-repo model configurations
   * if the user has them.
   */
  private getActiveModelConfig(projectRoot: string): { model: string; provider: string } {
    try {
      const config = loadModelConfig(projectRoot);
      return { model: config.builder.model, provider: config.builder.provider };
    } catch {
      return { model: this.defaultModel, provider: this.defaultProvider };
    }
  }

  // ─── Fallback Chain Construction ────────────────────────────────

  private buildInvocationChain(
    primaryProvider: Provider,
    primaryModel: string,
    prompt: string,
    tokenBudget: number,
    sectionMode: boolean,
    runId?: string,
  ): InvokeConfig[] {
    const systemPrompt = sectionMode
      ? "You are the Builder worker in Aedis. You are editing a SECTION of a large file. Return ONLY a unified diff with ORIGINAL file line numbers (do not restart at 1). No markdown fences. No explanations. No full file content — that would corrupt the file."
      : "You are the Builder worker in Aedis. Obey the contract exactly. Return ONLY the full final file content. No markdown fences. No explanations.";

    const chain: InvokeConfig[] = [{
      provider: primaryProvider,
      model: primaryModel,
      prompt,
      systemPrompt,
      maxTokens: tokenBudget,
      ...(runId ? { runId } : {}),
    }];

    if (this.fallbackModel && this.fallbackModel.provider !== primaryProvider) {
      chain.push({
        provider: this.fallbackModel.provider,
        model: this.fallbackModel.model,
        prompt,
        systemPrompt,
        maxTokens: tokenBudget,
        ...(runId ? { runId } : {}),
      });
    }

    return chain;
  }

  // ─── Run Context Management ─────────────────────────────────────

  private extractRunId(assignment: WorkerAssignment): string {
    const intentAny = assignment.intent as { runId?: unknown; id?: unknown };
    if (typeof intentAny.runId === "string" && intentAny.runId) return intentAny.runId;
    if (typeof intentAny.id === "string" && intentAny.id) return intentAny.id;
    return assignment.task.id;
  }

  private getOrCreateRunContext(runId: string): RunInvocationContext {
    let ctx = this.runContexts.get(runId);
    if (!ctx) {
      ctx = createRunInvocationContext();
      this.runContexts.set(runId, ctx);
      while (this.runContexts.size > MAX_RUN_CONTEXTS) {
        const firstKey = this.runContexts.keys().next().value;
        if (firstKey === undefined) break;
        this.runContexts.delete(firstKey);
      }
    }
    return ctx;
  }

  // ─── Contract & Prompt ───────────────────────────────────────────

  private buildContract(assignment: WorkerAssignment): TaskContract {
    const file = assignment.task.targetFiles[0];
    const constraints = assignment.intent.constraints.map((c) => c.description);
    const forbiddenChanges = assignment.intent.exclusions ?? [];
    const interfaceRules = [
      "Do not change public names unless the task explicitly requires it.",
      "Preserve file-local style and module shape.",
      "Do not touch files outside the exact contract file.",
    ];
    return { file, goal: assignment.task.description, constraints, forbiddenChanges, interfaceRules };
  }

  private buildPrompt(
    contract: TaskContract,
    assignment: WorkerAssignment,
    promptContent: string,
    model: string,
    sectionInfo: SectionExtraction | null,
  ): BuiltPrompt {
    let fixedParts: string[];

    // CRITICAL: the charter-generated deliverable description is usually
    // just "Modify <file>" — it does NOT contain the user's actual ask.
    // Without including intent.userRequest the Builder is asked to modify
    // a file with no instruction on WHAT to change, and the model fills
    // the gap by hallucinating a plausible edit (e.g. deleting an array
    // element to "clean up"). Surface the original request first.
    const userRequest = assignment.intent?.userRequest?.trim() || "";
    if (sectionInfo) {
      fixedParts = [
        `You are the Builder worker on model ${model}.`,
        "You must obey the contract exactly.",
        `Target file: ${contract.file}`,
        userRequest ? `User request (this is what you must actually do): ${userRequest}` : "",
        `Deliverable: ${contract.goal}`,
        `Constraints: ${contract.constraints.join(" | ") || "none"}`,
        `Forbidden changes: ${contract.forbiddenChanges.join(" | ") || "none"}`,
        `Interface rules: ${contract.interfaceRules.join(" | ")}`,
        "",
        "SECTION-EDIT MODE — LARGE FILE",
        `You are editing lines ${sectionInfo.startLine}-${sectionInfo.endLine} of ${contract.file}.`,
        `The full file has ${sectionInfo.totalLines} lines. You are seeing ONLY the relevant section.`,
        sectionInfo.matchedFunction
          ? `This section is centered on the function/method: \`${sectionInfo.matchedFunction}\` (lines ${sectionInfo.funcStart}-${sectionInfo.funcEnd}).`
          : `This section was selected by ${sectionInfo.extractionMethod}.`,
        "",
        "OUTPUT FORMAT — CRITICAL:",
        "You MUST return a UNIFIED DIFF only. Do NOT return full file content.",
        "You MUST add or modify content to satisfy the goal. Deleting existing code is FORBIDDEN unless the contract explicitly requires removal.",
        "Returning the section as full content would replace the entire file with just this section",
        "and would lose the rest of the file. This is unrecoverable.",
        "",
        `The diff hunk header @@ -X,Y +X,Z @@ MUST use ORIGINAL file line numbers.`,
        `X must be a line number between ${sectionInfo.startLine} and ${sectionInfo.endLine}.`,
        "Line numbering does NOT restart at 1 for the section — use the actual file line numbers",
        "shown in the section below (each line is prefixed with its line number).",
        "",
        "Example diff format (return EXACTLY this format — no markdown fences, no explanations):",
        `--- a/${contract.file}`,
        `+++ b/${contract.file}`,
        `@@ -${sectionInfo.startLine},3 +${sectionInfo.startLine},4 @@`,
        ` line at ${sectionInfo.startLine}`,
        ` line at ${sectionInfo.startLine + 1}`,
        "+inserted new line",
        ` line at ${sectionInfo.startLine + 2}`,
        "",
        `Section content (lines ${sectionInfo.startLine}-${sectionInfo.endLine}, line numbers prefixed but NOT part of the file):`,
        this.numberSectionLines(promptContent, sectionInfo.startLine),
      ];
    } else {
      fixedParts = [
        `You are the Builder worker on model ${model}.`,
        "You must obey the contract exactly.",
        `Target file: ${contract.file}`,
        userRequest ? `User request (this is what you must actually do): ${userRequest}` : "",
        `Deliverable: ${contract.goal}`,
        `Constraints: ${contract.constraints.join(" | ") || "none"}`,
        `Forbidden changes: ${contract.forbiddenChanges.join(" | ") || "none"}`,
        `Interface rules: ${contract.interfaceRules.join(" | ")}`,
        "Return ONLY the full final file content for the target file. No markdown fences. No explanations. No prose. No review.",
        "MINIMUM-CHANGE DISCIPLINE:",
        "  1. Identify the smallest possible edit that satisfies the User request.",
        "  2. Keep every unrelated line BYTE-FOR-BYTE identical — same indentation, same trailing whitespace, same line endings, same quote style.",
        "  3. Do NOT reformat, re-wrap, reorder imports, reshuffle exports, change tabs↔spaces, or 'clean up' anything the request did not explicitly ask for.",
        "  4. If the request is to add a line/comment, your output should differ from the input by EXACTLY that line and no other.",
        "  5. If your edit would produce a diff larger than the request implies, STOP and return the original file unchanged.",
        "You MUST make exactly the change the User request describes. Do not invent or remove unrelated content. If the request is to add a comment, add a comment — do not also delete, rename, or reformat anything else.",
        // Phase 10.3 — Scout-to-Builder targeting bias. Tell the model
        // explicitly that relevant context files came from a scout
        // pass and are the preferred targets. Prevents drift to
        // invented file paths when the scope is already known.
        "TARGETING BIAS: any files listed in the 'Relevant context' section below were identified by a prior scout pass — prefer working within their scope. Do NOT invent new file paths when the relevant context already names candidate files.",
        // Phase 11 — export preservation. When the file has existing
        // named exports, list them explicitly so the model can't
        // accidentally rewrite the file as "just the function the
        // request mentions." Seen in stress-01..14: asked to fix one
        // function, the model returns a file containing only that
        // function, deleting 4-5 siblings the tests depend on.
        buildExportPreservationDirective(promptContent),
        "Current file:",
        promptContent,
      ];
    }

    const fixedJoined = fixedParts.join("\n\n");
    const fixedChars = fixedJoined.length;

    const remainingForContext = PROMPT_CHAR_CAP - fixedChars - CONTEXT_OVERHEAD_CHARS;
    const contextBudget = Math.min(Math.max(remainingForContext, 0), CONTEXT_CHAR_CAP);

    const layers = assignment.context.layers as ContextLayers;
    const layersTotal = layers.length;
    let contextBlock = "";
    let contextChars = 0;
    let layersIncluded = 0;
    const truncated: TruncatedFile[] = [];

    if (contextBudget > 0 && layersTotal > 0) {
      const built = this.assembleContextWithBudget(layers, contextBudget);
      contextBlock = built.context;
      contextChars = built.context.length;
      truncated.push(...built.truncated);
      layersIncluded = built.layersIncluded;
    } else if (layersTotal > 0) {
      const reason = contextBudget <= 0
        ? "fixed sections (instructions + content) consumed entire prompt budget"
        : "no context layers requested";
      for (let i = 0; i < layers.length; i++) {
        for (const file of layers[i].files) {
          truncated.push({
            path: file.path,
            chars: file.content.length,
            layerIndex: i,
            reason,
          });
        }
      }
    }

    const promptParts = [...fixedParts];
    if (contextBlock) {
      promptParts.push(`\nRelevant context:\n${contextBlock}`);
    }
    const prompt = promptParts.join("\n\n");
    const chars = prompt.length;
    const estimatedTokens = Math.ceil(chars / 4);

    return {
      prompt,
      chars,
      estimatedTokens,
      fixedChars,
      contextChars,
      contextBudget,
      truncated,
      layersIncluded,
      layersTotal,
      originalContentChars: promptContent.length,
      sectionMode: sectionInfo !== null,
    };
  }

  private numberSectionLines(content: string, startLineNum: number): string {
    return content
      .split("\n")
      .map((line, i) => `${(startLineNum + i).toString().padStart(5, " ")}: ${line}`)
      .join("\n");
  }

  private assembleContextWithBudget(
    layers: ContextLayers,
    charBudget: number,
  ): {
    readonly context: string;
    readonly truncated: TruncatedFile[];
    readonly layersIncluded: number;
  } {
    const SEP = "\n\n---\n\n";
    const truncated: TruncatedFile[] = [];
    const parts: string[] = [];
    let used = 0;
    let layersIncluded = 0;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      let anyFromThisLayer = false;
      for (const file of layer.files) {
        const entry = `FILE: ${file.path}\n${file.content}`;
        const cost = entry.length + (parts.length > 0 ? SEP.length : 0);
        if (used + cost > charBudget) {
          truncated.push({
            path: file.path,
            chars: file.content.length,
            layerIndex: i,
            reason: `would exceed ${charBudget}-char context budget (used=${used}, needed=${cost})`,
          });
          continue;
        }
        parts.push(entry);
        used += cost;
        anyFromThisLayer = true;
      }
      if (anyFromThisLayer) layersIncluded++;
    }

    return { context: parts.join(SEP), truncated, layersIncluded };
  }

  // ─── Response Processing ─────────────────────────────────────────
  //
  // Process model response. Handles three response formats:
  //   1. Unified diff (preferred) — apply hunks to the FULL file content
  //   2. Full file content in markdown fences — extract and use directly
  //   3. Raw full file content — use directly
  //
  // In SECTION-EDIT MODE, only path 1 is acceptable. Three safety gates
  // run: length retention, end-of-file structural check, and brace balance
  // delta-vs-original. See SECTION_LENGTH_RETAIN_FLOOR and
  // SECTION_BRACE_DELTA_TOLERANCE constants for thresholds.
  //
  // Note: this is a line-comment block, not a JSDoc, because the description
  // would otherwise need to reference block comment terminators which would
  // close the JSDoc early. esbuild caught exactly that hazard once already.
  //
  private processModelResponse(
    raw: string,
    relativePath: string,
    fullOriginalContent: string,
    sectionMode: boolean,
  ): { updatedContent: string; diff: string } {
    const stripped = this.stripMarkdownFences(raw);

    if (this.looksLikeDiff(stripped)) {
      console.log(
        `[Builder] Response is a unified diff, applying to ` +
        `${sectionMode
          ? `full file (${fullOriginalContent.length} chars, section mode)`
          : "original content"}`
      );
      const updatedContent = this.diffApplier.applyToString(stripped, fullOriginalContent);

      if (DiffApplier.looksLikeRawDiff(updatedContent)) {
        console.error(`[Builder] SAFETY: applyToString produced raw diff output, falling back to original`);
        throw new Error("Diff application produced raw diff text instead of patched source code");
      }

      // ─── SECTION-MODE SAFETY GATES ─────────────────────────────────
      if (sectionMode) {
        const ratio = updatedContent.length / fullOriginalContent.length;
        if (ratio < SECTION_LENGTH_RETAIN_FLOOR) {
          throw new Error(
            `section-mode diff safety check failed: result is ${updatedContent.length} chars vs ` +
            `original ${fullOriginalContent.length} chars (${(ratio * 100).toFixed(1)}% retained, ` +
            `threshold ${(SECTION_LENGTH_RETAIN_FLOOR * 100).toFixed(0)}%). ` +
            `Diff likely truncated the file. Aborting write.`
          );
        }

        const trimmedEnd = updatedContent.replace(/\s+$/, "");
        const lastNewline = trimmedEnd.lastIndexOf("\n");
        const lastLine = (lastNewline >= 0
          ? trimmedEnd.slice(lastNewline + 1)
          : trimmedEnd
        ).trimEnd();
        const lastChar = lastLine.slice(-1);
        const endsCleanly = (
          lastChar === "}" ||
          lastChar === ";" ||
          lastChar === ")" ||
          lastChar === "]" ||
          lastLine.endsWith("*/")
        );
        if (!endsCleanly) {
          throw new Error(
            `section-mode diff safety check failed: result is ${updatedContent.length} chars vs ` +
            `original ${fullOriginalContent.length} chars (${(ratio * 100).toFixed(1)}% retained), ` +
            `but file ends mid-statement. Last line: ` +
            `"${lastLine.slice(0, 100)}${lastLine.length > 100 ? "..." : ""}". ` +
            `File likely truncated mid-function. Aborting write.`
          );
        }

        // Gate 3: brace balance, DELTA-VS-ORIGINAL.
        let originalOpens = 0;
        let originalCloses = 0;
        for (let i = 0; i < fullOriginalContent.length; i++) {
          const ch = fullOriginalContent.charCodeAt(i);
          if (ch === 123 /* { */) originalOpens++;
          else if (ch === 125 /* } */) originalCloses++;
        }
        let resultOpens = 0;
        let resultCloses = 0;
        for (let i = 0; i < updatedContent.length; i++) {
          const ch = updatedContent.charCodeAt(i);
          if (ch === 123 /* { */) resultOpens++;
          else if (ch === 125 /* } */) resultCloses++;
        }
        const originalDelta = Math.abs(originalOpens - originalCloses);
        const resultDelta = Math.abs(resultOpens - resultCloses);
        const deltaIncrease = resultDelta - originalDelta;
        if (deltaIncrease > SECTION_BRACE_DELTA_TOLERANCE) {
          throw new Error(
            `section-mode diff safety check failed: brace imbalance worsened — possible truncation ` +
            `(original ${originalOpens} open / ${originalCloses} close, delta=${originalDelta}; ` +
            `result ${resultOpens} open / ${resultCloses} close, delta=${resultDelta}; ` +
            `delta increased by ${deltaIncrease}, threshold ${SECTION_BRACE_DELTA_TOLERANCE}; ` +
            `result is ${updatedContent.length} chars vs original ${fullOriginalContent.length})`
          );
        }

        console.log(
          `[Builder] Section-mode diff applied: ${fullOriginalContent.length} → ${updatedContent.length} chars ` +
          `(${(ratio * 100).toFixed(1)}% retained, ends with "${lastChar}", ` +
          `braces ${resultOpens}/${resultCloses} delta=${resultDelta} ` +
          `vs original delta=${originalDelta})`
        );
      }

      const finalContent = updatedContent.trimEnd() + "\n";
      return { updatedContent: finalContent, diff: stripped };
    }

    if (sectionMode) {
      throw new Error(
        `SECTION-MODE: model returned non-diff content. In section-edit mode, ` +
        `the response MUST be a unified diff so it can be applied to the full file. ` +
        `Got (first 200 chars): ${stripped.slice(0, 200)}`
      );
    }

    if (DiffApplier.looksLikeRawDiff(stripped)) {
      console.warn(`[Builder] Response looks like malformed diff, attempting to apply`);
      try {
        const updatedContent = this.diffApplier.applyToString(stripped, fullOriginalContent);
        if (!DiffApplier.looksLikeRawDiff(updatedContent)) {
          const finalContent = updatedContent.trimEnd() + "\n";
          return { updatedContent: finalContent, diff: stripped };
        }
      } catch {
        // Fall through
      }
      throw new Error("Model returned diff-like output that could not be applied as a patch");
    }

    console.log(`[Builder] Response is full file content, computing diff`);
    const updatedContent = stripped.trimEnd() + "\n";
    const diff = this.buildUnifiedDiff(relativePath, fullOriginalContent, updatedContent);
    return { updatedContent, diff };
  }

  private stripMarkdownFences(raw: string): string {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:diff|patch|typescript|ts|javascript|js|text)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fenced) return fenced[1];
    const firstBlock = trimmed.match(/```(?:diff|patch|typescript|ts|javascript|js|text)?\s*\n([\s\S]*?)\n```/);
    if (firstBlock) return firstBlock[1];
    return trimmed;
  }

  private looksLikeDiff(text: string): boolean {
    return (
      /^---\s+\S/m.test(text) &&
      /^\+\+\+\s+\S/m.test(text) &&
      /^@@\s+-\d+/m.test(text)
    );
  }

  private enforceForbiddenChanges(contract: TaskContract, updatedContent: string, originalContent: string): void {
    // Only check content the builder actually introduced — if the
    // forbidden string already existed in the original file, that's
    // not a builder violation.
    for (const forbidden of contract.forbiddenChanges) {
      if (!forbidden) continue;
      const loweredForbidden = forbidden.toLowerCase();
      if (
        updatedContent.toLowerCase().includes(loweredForbidden) &&
        !originalContent.toLowerCase().includes(loweredForbidden)
      ) {
        throw new Error(`Builder output violates forbidden change rule: ${forbidden}`);
      }
    }
  }

  private buildUnifiedDiff(filePath: string, originalContent: string, updatedContent: string): string {
    const originalLines = originalContent.split(/\r?\n/);
    const updatedLines = updatedContent.split(/\r?\n/);
    const max = Math.max(originalLines.length, updatedLines.length);
    const body: string[] = [];
    for (let i = 0; i < max; i++) {
      const before = originalLines[i];
      const after = updatedLines[i];
      if (before === after) {
        if (before !== undefined) body.push(` ${before}`);
        continue;
      }
      if (before !== undefined) body.push(`-${before}`);
      if (after !== undefined) body.push(`+${after}`);
    }
    return [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      `@@ -1,${originalLines.length} +1,${updatedLines.length} @@`,
      ...body,
    ].join("\n");
  }

  /**
   * Resolve a contract-relative path against the supplied projectRoot,
   * verify it stays within projectRoot, return the absolute path.
   * Takes projectRoot as a parameter (rather than reading this.projectRoot)
   * so per-task overrides via assignment.projectRoot work correctly.
   */
  private resolveTarget(file: string, projectRoot: string): string {
    // If file is an absolute path from the source repo (e.g. /mnt/ai/squidley-v2/...),
    // map it to the corresponding worktree path before boundary checking.
    const sourceRepo = (this as unknown as { projectRoot?: string }).projectRoot;
    if (sourceRepo && file.startsWith(sourceRepo)) {
      const rel = file.slice(sourceRepo.length).replace(/^[\\/]+/, "");
      file = resolve(projectRoot, rel);
    }
    const abs = resolve(projectRoot, file);
    const normalizedRoot = projectRoot.endsWith(sep) ? projectRoot : `${projectRoot}${sep}`;
    if (abs !== projectRoot && !abs.startsWith(normalizedRoot)) {
      throw new Error(`Builder refused out-of-scope path: ${file}`);
    }
    return abs;
  }

  /**
   * Express an absolute path as a forward-slashed path relative to the
   * supplied projectRoot. Takes projectRoot as a parameter so per-task
   * overrides work correctly.
   */
  private toRelative(absPath: string, projectRoot: string): string {
    return relative(projectRoot, absPath).replace(/\\/g, "/");
  }

  private logFileTouch(taskId: string, path: string, operation: "read" | "create" | "modify" | "delete"): void {
    if (!this.runState) return;
    recordFileTouch(this.runState, { filePath: path, operation, taskId });
  }

  private noteDecision(taskId: string, description: string, rationale: string): void {
    if (!this.runState) return;
    recordDecision(this.runState, {
      description,
      madeBy: this.name,
      taskId,
      alternatives: [],
      rationale,
    });
  }
}
