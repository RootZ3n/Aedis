/**
 * Loqui Intent Classifier — Unified Intent Routing v1.
 *
 * Deterministic rule-based classifier that takes a freeform user
 * utterance and assigns it one of the supported Loqui intents. No
 * model calls, no network, no state outside the call itself —
 * classification is a pure function of the input text plus the
 * caller-supplied conversational context (last run, active run).
 *
 * The classifier is intentionally inspectable: every decision carries
 * a list of `signals` (the rules that matched) and a `confidence`
 * score. The router and the UI both read those fields so the user
 * can always see *why* Loqui chose the path it chose.
 *
 * Design principles:
 *
 *   1. Safe fallback first. When the signals conflict or no rule
 *      fires strongly, the classifier returns a non-destructive
 *      intent (question / explain / unknown) rather than `build`.
 *      Execution is never implicit.
 *
 *   2. Dry-run beats build when both fire. "show me the plan first,
 *      don't change anything" includes build-like verbs AND no-op
 *      markers — the no-op markers win, because they are an explicit
 *      user request to *not* execute.
 *
 *   3. Continuity is cheap. Follow-up phrases like "continue",
 *      "try again but safer", "why did that fail" only make sense
 *      against an active or recently completed run. The classifier
 *      requires a `lastRunId` in the context before it will emit
 *      `resume_run` / `status`, so an empty conversation can't
 *      accidentally be routed to a ghost run.
 *
 *   4. Rules are flat and readable. No machine learning, no lists
 *      of magic weights — just a scored sequence of regex matches
 *      with explicit tie-break rules. Adding a new rule means
 *      adding a new entry to one of the arrays below.
 */

// ─── Types ───────────────────────────────────────────────────────────

export type LoquiIntent =
  | "build"
  | "question"
  | "explain"
  | "plan"
  | "dry_run"
  | "status"
  | "resume_run"
  | "unknown";

export interface LoquiIntentContext {
  /** ID of the currently running task, if any. */
  readonly activeRunId?: string | null;
  /** ID of the most recently completed task (within this session). */
  readonly lastRunId?: string | null;
  /** Verdict of the most recently completed task. */
  readonly lastRunVerdict?: "success" | "partial" | "failed" | "aborted" | null;
  /**
   * True when the user's previous message in this session was itself
   * a build submission. Lets the classifier interpret "continue" and
   * "try again" as resume/retry rather than a fresh question.
   */
  readonly previousMessageWasBuild?: boolean;
  /**
   * Set when the previous Loqui turn asked the user for a file or
   * module path before it would build. The value is the original
   * prompt (the one that was clarification-blocked), so a path-only
   * follow-up can be merged with it. The classifier itself does not
   * read this field — the router does, via `resolvePathFollowUp`.
   */
  readonly awaitingScopeFor?: string;
  /**
   * Project root used to normalize an absolute path-only follow-up
   * to repo-relative form. Optional; when omitted, the follow-up is
   * still detected but the path stays absolute.
   */
  readonly projectRoot?: string;
}

export interface LoquiIntentDecision {
  readonly intent: LoquiIntent;
  /** 0–1 confidence in the chosen intent. */
  readonly confidence: number;
  /** Every rule that matched, in priority order. For inspection. */
  readonly signals: readonly string[];
  /** Short one-line reason suitable for UI display. */
  readonly reason: string;
  /**
   * True when the classifier wants the router to ask the user a
   * clarifying question instead of executing. Populated when two
   * strong signals conflict (e.g. "build but don't change anything").
   */
  readonly needsClarification: boolean;
  /**
   * Suggested clarifying question when `needsClarification` is true.
   * Always present when the flag is true, empty string otherwise.
   */
  readonly clarification: string;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Classify a raw Loqui utterance into one of the v1 intents.
 *
 * Returns a decision object with the chosen intent, the rules that
 * fired, a confidence score, a short human reason, and whether the
 * router should pause to ask for clarification. Never throws.
 */
export function classifyLoquiIntent(
  input: string,
  context: LoquiIntentContext = {},
): LoquiIntentDecision {
  const raw = (input ?? "").trim();
  if (raw.length === 0) {
    return {
      intent: "unknown",
      confidence: 0,
      signals: ["empty-input"],
      reason: "No input provided",
      needsClarification: false,
      clarification: "",
    };
  }

  const lower = raw.toLowerCase();
  const signals: string[] = [];

  // Detect scope, requirement, and vague-quality evidence up front so
  // the tie-break + specificity gates can consult them. See the
  // detector helpers below for the rules.
  const scope = detectScopeEvidence(raw, lower);
  const requirement = detectRequirementEvidence(raw, lower);
  const strongBuild = detectStrongBuildSignal(lower, scope, requirement);
  const vagueQuality = VAGUE_QUALITY_MARKERS.test(lower);

  // Collect raw signal strength for each candidate intent. Each rule
  // contributes a weighted score; the highest-scoring intent wins,
  // subject to tie-break rules below.
  const scores: Record<LoquiIntent, number> = {
    build: 0,
    question: 0,
    explain: 0,
    plan: 0,
    dry_run: 0,
    status: 0,
    resume_run: 0,
    unknown: 0,
  };

  for (const rule of BUILD_RULES) {
    if (rule.pattern.test(lower)) {
      scores.build += rule.weight;
      signals.push(`build:${rule.name}`);
    }
  }
  for (const rule of QUESTION_RULES) {
    if (rule.pattern.test(lower)) {
      scores.question += rule.weight;
      signals.push(`question:${rule.name}`);
    }
  }
  for (const rule of EXPLAIN_RULES) {
    if (rule.pattern.test(lower)) {
      scores.explain += rule.weight;
      signals.push(`explain:${rule.name}`);
    }
  }
  for (const rule of PLAN_RULES) {
    if (rule.pattern.test(lower)) {
      scores.plan += rule.weight;
      signals.push(`plan:${rule.name}`);
    }
  }
  for (const rule of DRY_RUN_RULES) {
    if (rule.pattern.test(lower)) {
      scores.dry_run += rule.weight;
      signals.push(`dry_run:${rule.name}`);
    }
  }
  for (const rule of STATUS_RULES) {
    if (rule.pattern.test(lower)) {
      scores.status += rule.weight;
      signals.push(`status:${rule.name}`);
    }
  }
  for (const rule of RESUME_RULES) {
    if (rule.pattern.test(lower)) {
      scores.resume_run += rule.weight;
      signals.push(`resume_run:${rule.name}`);
    }
  }

  // ── Tie-break rules ─────────────────────────────────────────────

  // Rule 0: scoped-build boost. If the user wrote a clear build
  // request — explicit action verb, named target (file, repo path,
  // or identifier), AND requirement evidence (behavior list, "should
  // X", tests called out, multi-clause spec) — push the build score
  // past competing intents like `explain` / `plan` that can match
  // *inside the requirement description*. Without this boost, a
  // prompt like "add Instructor Mode that explains key lines" gets
  // hijacked by `explain:explain-verb` (weight 3) and routed to Q&A
  // instead of execution. Aedis already has approval gates and
  // workspace isolation, so a clear scoped build request should reach
  // the build path; the gates handle safety from there.
  if (strongBuild) {
    scores.build += 4;
    signals.push("build:scoped-build-signal");
  }

  // Rule A: dry-run override. If the user mentioned build-ish verbs
  // AND explicit no-op markers ("don't change", "just show", "plan
  // first"), route to dry_run. This is the "show me what you'd do"
  // path and is the single most important safety rule in v1.
  if (scores.dry_run > 0 && scores.build > 0) {
    scores.dry_run += 2;
    scores.build = Math.max(0, scores.build - 1);
    signals.push("override:dry_run-beats-build");
  }

  // Rule B: continuity requires context. resume_run and status only
  // make sense against a known prior run. Without one, downgrade the
  // intent to question so the classifier doesn't emit a route to a
  // ghost run.
  const hasPriorRun = Boolean(context.activeRunId) || Boolean(context.lastRunId);
  if (!hasPriorRun) {
    if (scores.resume_run > 0) {
      signals.push("downgrade:resume_run-no-prior-run");
      scores.resume_run = 0;
    }
    // status can still fire for general repo-state questions ("what's
    // the state of things?") but we strip the run-specific weight.
    // Left intact when the user actually mentioned "run" or "task".
    if (scores.status > 0 && !/\b(run|task|build)\b/.test(lower)) {
      signals.push("downgrade:status-no-prior-run");
      scores.status = Math.max(0, scores.status - 1);
    }
  }

  // Rule C: previousMessageWasBuild tilts short utterances toward
  // continuity. "try again" alone is ambiguous; "try again" right
  // after a build failure is clearly a retry.
  if (context.previousMessageWasBuild && raw.length < 40) {
    if (scores.resume_run > 0) {
      scores.resume_run += 1;
      signals.push("boost:resume_run-after-build");
    }
  }

  // Rule D: a question mark alone is not enough to make something
  // build-worthy, even if build verbs are present. "can you build
  // the registry?" is still a build request, but "what would you
  // build next?" is a plan/question, so we only apply the tilt
  // when the sentence starts with an interrogative.
  if (/^(what|why|how|when|where|who|which)\b/.test(lower) && scores.build > 0) {
    scores.build = Math.max(0, scores.build - 1);
    signals.push("downgrade:build-interrogative-prefix");
  }

  // ── Pick winner ──────────────────────────────────────────────────

  const pick = pickWinner(scores);

  // Safe-fallback: no intent scored > 0 → unknown.
  if (pick.winner === "unknown" || pick.score === 0) {
    return {
      intent: "unknown",
      confidence: 0,
      signals,
      reason: "No intent rules matched",
      needsClarification: true,
      clarification:
        "I'm not sure if you want me to build something, answer a question, or plan. Can you rephrase?",
    };
  }

  // Safe-fallback for `build`: if build won but another
  // non-destructive intent is within 1 point, demand clarification.
  // This blocks the ambiguous "can we just improve this" case from
  // racing into execution. Skipped when the prompt has a strong
  // scoped-build signal — clear-target prompts must not be deflected
  // by an incidental "module"/"explain"/"propose" word in the spec.
  if (pick.winner === "build" && !strongBuild) {
    const competitor = nearestCompetitor(scores, "build");
    if (competitor && competitor.score >= pick.score - 1 && competitor.name !== "build") {
      const safe = NON_DESTRUCTIVE_FALLBACK[competitor.name] ?? "question";
      signals.push(`safe-fallback:${competitor.name}-vs-build`);
      return {
        intent: safe,
        confidence: 0.4,
        signals,
        reason: `Ambiguous between build and ${competitor.name}; defaulting to ${safe} for safety`,
        needsClarification: true,
        clarification:
          `This reads as ambiguous — I'd rather ${safe === "plan" ? "show you the plan first" : safe === "dry_run" ? "dry-run it first" : "answer first"} than execute on a guess. If you want me to build, name the target (file path, module, or identifier) and what should change.`,
      };
    }
  }

  if (pick.winner === "build") {
    // Specificity gate: a build intent MUST name a concrete target
    // (file path with extension, repo/module path, identifier, or a
    // specific noun the charter extractor can pick up). Prompts like
    // "build this", "first test of what you can do", "try something",
    // "show me what you can build" are meta-language, not specs —
    // routing them into execution lets the Builder invent arbitrary
    // changes. Force clarification in that case. The strong-scoped-
    // build signal already implies enough scope evidence to skip
    // this check.
    if (!strongBuild) {
      const hasMetaMarker = META_MARKERS.some((r) => r.test(lower));
      if (!scope.hasFilePath && !scope.hasRepoPath && !scope.hasIdentifier && hasMetaMarker) {
        signals.push("clarify:build-no-concrete-target");
        return {
          intent: "question",
          confidence: 0.3,
          signals,
          reason: "Build intent lacks a concrete target (no file/identifier named)",
          needsClarification: true,
          clarification:
            "That reads as exploratory — I need a concrete target before I'll build anything. Name a file (e.g. `core/foo.ts`), a module path (e.g. `modules/magister`), or describe the change you want (e.g. \"add input validation to estimateTokens\").",
        };
      }

      // Vague-quality gate: build verb + a vague quality marker
      // ("better", "improve", "cleaner", "nicer") with no concrete
      // deliverable evidence is a thin spec — the user named a
      // target but not a change. The Builder would invent arbitrary
      // edits. Force clarification. Prompts that pair the same
      // markers with a real spec (file path, "should X", tests, a
      // multi-clause behavior list) keep their build path because
      // strongBuild fires and short-circuits this gate.
      if (vagueQuality && !hasConcreteDeliverable(scope, requirement)) {
        signals.push("clarify:build-vague-quality-marker");
        return {
          intent: "question",
          confidence: 0.3,
          signals,
          reason: "Build verb plus vague quality marker; no concrete deliverable to act on",
          needsClarification: true,
          clarification:
            "\"Better\"/\"improve\" alone isn't enough to act on. What specifically should change — a behavior, a file, a constraint? Name it and I'll plan the build.",
        };
      }

      // Broad vague asks in large pasted context often include bullet
      // lists ("findings", audit notes, logs) that are not actual
      // deliverables. If the prompt asks for repo/project-wide
      // quality improvement without a file/module path, keep it on
      // the clarification path instead of treating the pasted list as
      // permission to invent edits.
      if (vagueQuality && !scope.hasFilePath && !scope.hasRepoPath && BROAD_UNSCOPED_MARKERS.test(lower)) {
        signals.push("clarify:build-broad-vague-scope");
        return {
          intent: "question",
          confidence: 0.3,
          signals,
          reason: "Broad vague quality request without concrete file or module scope",
          needsClarification: true,
          clarification:
            "That is too broad to build safely. Name the specific file, module, or behavior you want changed.",
        };
      }
    }
  }

  // Normal pick.
  const confidence = clamp01(pick.score / 5);
  const reason = strongBuild && pick.winner === "build"
    ? "Scoped build request: discovering files, producing plan, awaiting approval before source changes"
    : REASONS[pick.winner] ?? `Routed to ${pick.winner}`;
  return {
    intent: pick.winner,
    confidence,
    signals,
    reason,
    needsClarification: false,
    clarification: "",
  };
}

// ─── Rules ───────────────────────────────────────────────────────────

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly weight: number;
}

// Build: imperative construction verbs, file-creation language.
// Excludes hedged / investigative phrasing — those fall to plan or
// question.
const BUILD_RULES: readonly Rule[] = [
  { name: "imperative-build", pattern: /\b(build|implement|create|scaffold|generate|write|add|make)\b/, weight: 2 },
  { name: "refactor-verbs", pattern: /\b(refactor|rename|rewrite|restructure)\b/, weight: 2 },
  { name: "fix-bug", pattern: /\b(fix|patch|repair|resolve)\b/, weight: 2 },
  { name: "delete-verb", pattern: /\b(delete|remove|drop)\b/, weight: 2 },
  { name: "file-extension", pattern: /\.(ts|tsx|js|jsx|py|rs|go|md|json|ya?ml)\b/, weight: 1 },
  { name: "let-me-do", pattern: /\b(let'?s|let me)\s+(build|add|fix|make|ship|patch)/, weight: 2 },
  { name: "ship-verbs", pattern: /\b(ship|deliver|land|commit|push)\b/, weight: 1 },
];

// Question: what/where/how about the repo, no construction intent.
const QUESTION_RULES: readonly Rule[] = [
  { name: "wh-question", pattern: /^(what|where|how|which|who|when)\b/, weight: 2 },
  { name: "trailing-question", pattern: /\?$/, weight: 1 },
  { name: "does-the", pattern: /\b(does|is|are|do)\s+(the|this|that)\b/, weight: 1 },
  { name: "about-the-repo", pattern: /\b(codebase|repo|project|file|module|function|class)\b/, weight: 1 },
  { name: "find-locate", pattern: /\b(find|locate|search|look up|show me (where|which))\b/, weight: 2 },
  { name: "tell-me", pattern: /\btell me (about|more|how)\b/, weight: 2 },
];

// Explain: "why X", "explain X", "what does X do". Often overlaps
// with status when the user is asking about a prior run.
const EXPLAIN_RULES: readonly Rule[] = [
  { name: "explain-verb", pattern: /\bexplain\b/, weight: 3 },
  { name: "why", pattern: /\bwhy\b/, weight: 2 },
  { name: "what-does-x-do", pattern: /\bwhat (does|is|was) .{1,60}\b(do|used for|for|mean)\b/, weight: 2 },
  { name: "walk-me-through", pattern: /\b(walk me through|break (this|it) down|help me understand)\b/, weight: 3 },
  { name: "how-does", pattern: /\bhow (does|do|is|are)\b/, weight: 2 },
];

// Plan: "what would you change", "what's the plan", "first step".
// Plan differs from question in asking for a proposed approach.
const PLAN_RULES: readonly Rule[] = [
  { name: "what-would-you", pattern: /\bwhat would you\b/, weight: 3 },
  { name: "the-plan", pattern: /\b(the )?plan\b/, weight: 2 },
  { name: "first-step", pattern: /\b(first step|where would you start|what's next|next step)\b/, weight: 2 },
  { name: "propose-verb", pattern: /\b(propose|suggest|recommend)\b/, weight: 2 },
  { name: "should-we", pattern: /\b(should (we|i)|what should)\b/, weight: 1 },
];

// Dry run: explicit no-execution markers. When these fire alongside
// build rules, dry_run wins via the tie-break in Rule A.
const DRY_RUN_RULES: readonly Rule[] = [
  { name: "dont-change", pattern: /\b(don'?t (change|modify|touch|edit)|without (changing|modifying))\b/, weight: 3 },
  { name: "just-show", pattern: /\bjust (show|tell|walk)\b/, weight: 2 },
  { name: "show-me-first", pattern: /\b(show me (the plan|what)|plan first|dry[- ]?run)\b/, weight: 3 },
  { name: "preview", pattern: /\bpreview\b/, weight: 2 },
  { name: "not-yet", pattern: /\b(not yet|hold off|wait)\b/, weight: 1 },
  // "inspect it first" / "just inspect" / "only look" — the user
  // is asking Loqui to look without touching. Treated as dry-run
  // rather than question because the framing is about *action
  // deferral*, not about asking a factual question.
  { name: "inspect-first", pattern: /\b(inspect|only look|look (but|first))\b/, weight: 2 },
  { name: "just-inspect", pattern: /\bjust (inspect|look|check)\b/, weight: 3 },
];

// Status: "how's the run going", "did it fail", "what's the state".
// Heavily context-dependent; without a prior run, Rule B downgrades
// these unless the user explicitly names a run/task.
const STATUS_RULES: readonly Rule[] = [
  { name: "how-is-going", pattern: /\bhow (is|was|are) (it|the|that|this) (going|doing)\b/, weight: 3 },
  { name: "did-it-pass", pattern: /\b(did it|has it) (pass|fail|work|succeed)\b/, weight: 3 },
  { name: "run-status", pattern: /\b(run|task|build) (status|state|result|verdict)\b/, weight: 3 },
  { name: "whats-state", pattern: /\bwhat'?s (the )?(state|status)\b/, weight: 2 },
  { name: "show-receipt", pattern: /\b(receipt|last run|previous run)\b/, weight: 2 },
];

// Resume / retry: "continue", "try again", "pick up from there".
// Rule B demands a prior run before these are emitted.
const RESUME_RULES: readonly Rule[] = [
  { name: "continue", pattern: /^\s*continue\b/, weight: 3 },
  { name: "try-again", pattern: /\btry (again|once more|it again)\b/, weight: 3 },
  { name: "resume", pattern: /\bresume\b/, weight: 3 },
  { name: "pick-up", pattern: /\bpick up (from|where)\b/, weight: 2 },
  { name: "keep-going", pattern: /\b(keep going|carry on|go ahead)\b/, weight: 2 },
  { name: "retry-safer", pattern: /\btry again.{0,20}(safer|smaller|carefully)\b/, weight: 4 },
];

// ── Safe-fallback map ───────────────────────────────────────────────

// When build wins by a narrow margin, the router demotes it to the
// nearest non-destructive intent. This table defines which intent
// to pick based on which competitor was close.
const NON_DESTRUCTIVE_FALLBACK: Record<string, LoquiIntent> = {
  plan: "plan",
  dry_run: "dry_run",
  explain: "explain",
  question: "question",
  status: "status",
};

const REASONS: Partial<Record<LoquiIntent, string>> = {
  build: "Imperative construction verbs detected",
  question: "Interrogative phrasing about the repo",
  explain: "Explanation request",
  plan: "Planning / proposal request",
  dry_run: "Explicit no-execution markers",
  status: "Asking about a run state",
  resume_run: "Continuation of a prior run",
  unknown: "No intent rules matched",
};

// ─── Helpers ─────────────────────────────────────────────────────────

function pickWinner(scores: Record<LoquiIntent, number>): { winner: LoquiIntent; score: number } {
  let winner: LoquiIntent = "unknown";
  let score = 0;
  // Deterministic order: iterate in the order listed in the union
  // so ties break toward the earlier intent. This keeps
  // classification stable across runs.
  const order: LoquiIntent[] = [
    "resume_run",
    "status",
    "dry_run",
    "plan",
    "explain",
    "build",
    "question",
    "unknown",
  ];
  for (const intent of order) {
    if (scores[intent] > score) {
      score = scores[intent];
      winner = intent;
    }
  }
  return { winner, score };
}

function nearestCompetitor(
  scores: Record<LoquiIntent, number>,
  except: LoquiIntent,
): { name: LoquiIntent; score: number } | null {
  let best: { name: LoquiIntent; score: number } | null = null;
  for (const [name, s] of Object.entries(scores) as [LoquiIntent, number][]) {
    if (name === except) continue;
    if (s === 0) continue;
    if (!best || s > best.score) best = { name, score: s };
  }
  return best;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ─── Scoped-build detection ─────────────────────────────────────────
//
// A "scoped build" is the prompt shape Aedis is meant to handle:
// explicit imperative verb + named target + concrete requirements.
// These three bits are enough that the Coordinator's existing gates
// (Velum, target discovery, approval, scope-violation detection) can
// safely take it from here. Without these signals, the classifier
// falls back to clarification.

interface ScopeEvidence {
  /** `core/foo.ts`, `apps/api/src/auth.ts` — extension-bearing path. */
  readonly hasFilePath: boolean;
  /**
   * Repo / module / package path: `modules/magister`,
   * `/path/to/repo/modules/magister`, `src/foo`, `core/bar`.
   * No extension required — the charter extractor can resolve it.
   */
  readonly hasRepoPath: boolean;
  /** camelCase / PascalCase / snake_case identifier, ≥ 3 chars. */
  readonly hasIdentifier: boolean;
}

interface RequirementEvidence {
  /** "should", "must", "needs to", "behavior", "requirements". */
  readonly hasShould: boolean;
  /** "tests", "test cases", "unit tests", "spec". */
  readonly hasTests: boolean;
  /** Numbered or bulleted list (markers at line start). */
  readonly hasList: boolean;
  /**
   * Multi-clause spec: ≥ 2 sentence terminators, OR ", and"
   * conjunctions joining verbs, OR ≥ 3 commas in the body.
   */
  readonly hasMultiClause: boolean;
  /** Total word count. */
  readonly wordCount: number;
}

const STRONG_BUILD_VERBS = /\b(add|implement|build|create|fix|update|modify|wire|refactor|rewrite|write|scaffold|generate|patch|repair|rename|extend)\b/;

// Project-segment heads that strongly indicate a repo/module path
// even without a leading slash. Kept to common conventions so we
// don't false-match arbitrary `foo/bar` substrings.
const REPO_PATH_HEADS = /\b(modules?|src|core|packages?|apps?|libs?|server|client|workers?|services?|tools|scripts|tests?)\/[\w.\-]+/;

const VAGUE_QUALITY_MARKERS = /\b(better|improve(d|ment|ments)?|cleaner|nicer|nice|good|great|smarter|smart|polish(ed)?|refine(d)?|tidier?|tidy|prettier)\b/;

const BROAD_UNSCOPED_MARKERS = /\b(overall|whole repo|entire repo|everything|whatever|anything|wherever|across the repo|repository-wide|repo-wide)\b/;

const META_MARKERS: readonly RegExp[] = [
  /\bbuild this\b/,
  /\bfirst test\b/,
  /\btest of what\b/,
  /\bshow me what you can\b/,
  /\btry something\b/,
  /\btry anything\b/,
  /\bdo whatever\b/,
  /\bsurprise me\b/,
  /\banything you (can|want|like)\b/,
  /\bwhat can you (do|build|make)\b/,
];

function detectScopeEvidence(raw: string, lower: string): ScopeEvidence {
  const hasFilePath = /\b[\w.\-]+\.(ts|tsx|js|jsx|py|rs|go|md|json|ya?ml|html|css|sh|sql|toml)\b/.test(lower);
  // Absolute path (e.g. /path/to/repo/modules/magister) or a
  // segment-headed relative path (modules/foo, src/bar, core/baz).
  // The absolute-path check requires at least two path components so
  // we don't false-match a leading `/` in casual text.
  const hasAbsolutePath = /\/[\w.\-]+\/[\w.\-]+(?:\/[\w.\-]+)*/.test(raw);
  const hasRepoPath = hasAbsolutePath || REPO_PATH_HEADS.test(lower);
  const hasIdentifier =
    /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/.test(raw) ||  // camelCase
    /\b[A-Z][a-zA-Z0-9]{2,}\b/.test(raw) ||                 // PascalCase ≥ 3 chars
    /\b[a-z]+_[a-z]+\b/.test(raw);                          // snake_case
  return { hasFilePath, hasRepoPath, hasIdentifier };
}

function detectRequirementEvidence(raw: string, lower: string): RequirementEvidence {
  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  const hasShould =
    /\b(should|must|need(s)? to|has to|will|behaviou?r|requirements?|constraints?|deliverables?)\b/.test(lower);
  const hasTests = /\b(tests?|test cases?|unit tests?|spec|specs)\b/.test(lower);
  const hasList = /^\s*(?:[-*]|\d+[.)])\s+/m.test(raw);
  const sentenceTerminators = (raw.match(/[.;]/g) ?? []).length;
  const commaCount = (raw.match(/,/g) ?? []).length;
  const hasMultiClause =
    sentenceTerminators >= 2 ||
    /,\s+and\b/.test(lower) ||
    commaCount >= 3;
  return { hasShould, hasTests, hasList, hasMultiClause, wordCount };
}

function detectStrongBuildSignal(
  lower: string,
  scope: ScopeEvidence,
  requirement: RequirementEvidence,
): boolean {
  if (!STRONG_BUILD_VERBS.test(lower)) return false;
  // A file path or a repo/module path is itself strong scope evidence.
  // Verb + path is enough — the user has named *where* to act.
  if (scope.hasFilePath || scope.hasRepoPath) return true;
  // An identifier alone is weaker; require additional requirement
  // evidence so prompts like "Make Magister better" don't qualify.
  if (scope.hasIdentifier) {
    return (
      requirement.hasShould ||
      requirement.hasTests ||
      requirement.hasList ||
      requirement.hasMultiClause ||
      requirement.wordCount >= 15
    );
  }
  return false;
}

function hasConcreteDeliverable(
  scope: ScopeEvidence,
  requirement: RequirementEvidence,
): boolean {
  if (scope.hasFilePath || scope.hasRepoPath) return true;
  return (
    requirement.hasShould ||
    requirement.hasTests ||
    requirement.hasList ||
    requirement.hasMultiClause
  );
}
