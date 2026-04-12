# Loqui Unified Intent Routing v1

## Why

Loqui used to have two user-facing modes — **Ask** and **Build** — toggled by a segmented control in the chat form. If the user typed a question while Build was selected, the input went to the Coordinator as a build request. If the user asked for a build while Ask was selected, the input went to `askLoqui` as a Q&A. The split was the wrong abstraction: the user had to classify their own intent before typing, and the two paths had incompatible error behaviors.

Unified Intent Routing v1 removes the mode toggle. There is one input, one submit, and the backend decides which path to take based on what the user actually wrote.

## Shape

```
User input
  → Loqui UI  (POST /tasks/loqui/unified)
    → core/loqui-router.ts
      → core/loqui-intent.ts    (classifier: rule-based, deterministic)
    → action: build / answer / resume / clarify
  → dispatch:
      build   → submitBuildTask() → Coordinator.submit()   (existing pipeline)
      resume  → stitch prior-run prompt → submitBuildTask()
      answer  → askLoqui(effectivePrompt, repoPath)        (existing Q&A)
      clarify → return clarification text (no execution)
```

Every response carries the full decision envelope:

```jsonc
{
  "route": "build" | "answer" | "clarify",
  "intent": "build" | "question" | "explain" | "plan" | "dry_run" | "status" | "resume_run" | "unknown",
  "label": "Building" | "Answering" | "Explaining" | "Planning" | "Dry Run" | "Checking Status" | "Resuming" | "Clarifying",
  "reason": "Imperative construction verbs detected",
  "confidence": 0.8,
  "signals": ["build:imperative-build", "build:fix-bug", "..."],
  // + route-specific payload
}
```

The UI renders `label` as a chip on each message and exposes `reason` as a tooltip. Nothing is hidden.

## The classifier (`core/loqui-intent.ts`)

Rule-based, deterministic, no model calls. Each supported intent has a list of scored regex rules; every match contributes a weight; the highest-scoring intent wins, subject to tie-break rules.

Supported intents for v1:

- `build` — imperative construction / fix / refactor verbs
- `question` — factual ask about the repo (wh-word, trailing `?`)
- `explain` — "why", "explain", "walk me through"
- `plan` — "what would you", "the plan", "first step"
- `dry_run` — "don't change", "just show", "preview", "inspect first"
- `status` — "did it pass", "run status" — downgraded when there is no prior run
- `resume_run` — "continue", "try again", "resume" — requires prior-run context
- `unknown` — no rule fired strongly; safe fallback to `clarify`

### Tie-break rules (safety discipline)

These are the rules that keep the classifier from turning ambiguous input into a destructive run:

- **Rule A — dry-run beats build.** "Build the thing but don't change anything" has both build and dry_run signals. Dry run wins, because the user explicitly said not to execute.
- **Rule B — continuity requires context.** `resume_run` is zeroed when no `activeRunId`/`lastRunId` is in the context. `status` loses weight unless the user explicitly mentions "run"/"task"/"build". This stops "continue" from ever executing a ghost run.
- **Rule C — previous-message boost.** A short "try again" immediately after a failed build gets a confidence boost toward `resume_run`.
- **Rule D — interrogative downgrade.** A wh-word at the start of the sentence tones the build score down by one, so "what would you build next?" lands on `plan` rather than `build`.
- **Safe-fallback on close-call build.** If `build` wins by ≤1 point over a non-destructive competitor, the router demotes the decision to `clarify` and asks a concrete question instead of executing.

The classifier returns `signals[]` with every rule that fired, prefixed by its category (`build:`, `plan:`, etc.) plus any tie-break markers (`override:`, `downgrade:`, `safe-fallback:`). The UI reads the first few for its intent chip tooltip; logs persist the full list.

## The router (`core/loqui-router.ts`)

Pure function from classifier decision → route decision. No side effects.

- `build` → `effectivePrompt` is the raw input.
- `resume_run` → `effectivePrompt` is reframed as `"Continuation of the prior run: <input>"`; the server handler then stitches the actual prior run's prompt on top (see `findLatestTrackedRun` in `server/routes/tasks.ts`).
- `dry_run` → `effectivePrompt` is reframed as an explicit *describe, don't write* instruction, then goes to `askLoqui` via the `answer` action. The build pipeline is never invoked.
- `plan` / `explain` / `status` / `question` → similar reframing, all routed through `answer`.
- `clarify` → no dispatch at all; the handler returns the clarification string and the UI shows it as an assistant message with the `Clarifying` chip.

`build` and `resume` are the only two actions that touch the Coordinator. Everything else is non-destructive by construction.

## Backend wiring (`server/routes/tasks.ts`)

- `POST /tasks/loqui/unified` is the new unified entry point — the UI sends every chat message here.
- `submitBuildTask(ctx, prompt, repoPath, exclusions)` is a shared helper. Both the legacy `POST /tasks` (hero RUN button) and the unified route call it, so there's exactly one code path for "start a build." The execution-truth gate in the Coordinator is preserved as-is — the unified route does not bypass it.
- `findLatestTrackedRun()` gives the `resume` action a way to look up the prior run's original prompt without persisting Loqui-specific state.
- `POST /tasks/loqui` (legacy Q&A) is kept unchanged. The post-run Loqui summary follow-up (`maybeHandleLoquiBuildCompletion` in the UI) still hits the legacy endpoint directly — that call is system-generated, not user input, and does not need classification.

## UI (`ui/index.html`)

- The segmented Ask/Build toggle is gone, along with `setLoquiMode`, `restoreLoquiMode`, `runAskFromLoqui`, `runBuildFromLoqui`, and the `aedis.loquiMode` localStorage key.
- `submitLoqui` sends the raw input to `/tasks/loqui/unified` along with a lightweight `context` object (`activeRunId`, `lastRunId`, `lastRunVerdict`, `previousMessageWasBuild`) so the classifier can emit `resume_run` / `status` safely.
- `handleRouteResponse` back-tags the user's bubble with the intent label the router picked, then dispatches:
  - `build` / `resume` → optimistic run bookkeeping (same as hero form), WebSocket subscribe, pending-builds tracking for post-run summary.
  - `answer` → push assistant bubble with the answer.
  - `clarify` → push assistant bubble with the clarification question.
- Every message bubble renders an intent chip (`Building`, `Answering`, `Explaining`, `Planning`, `Dry Run`, `Checking Status`, `Resuming`, `Clarifying`) with a per-intent accent color.
- The thinking indicator uses `state.loqui.lastIntent` so "Building…" vs "Answering…" reflects the in-flight route.

## What stayed the same

- **Execution Truth Enforcement v1 is untouched.** Every `build` / `resume` action still goes through the Coordinator, which still runs the execution gate at the end and emits `execution_verified` / `execution_failed`.
- **The legacy hero form still works.** `POST /tasks` calls the same `submitBuildTask` helper, so the RUN button and Loqui's build path share one dispatch.
- **The legacy `POST /tasks/loqui` still works.** It's used for the post-run summary follow-up where classification would be noise.

## Failure modes the router will not hit

- **Silent escalation to build.** A close call between build and a non-destructive intent forces `clarify`, not execute. See `NON_DESTRUCTIVE_FALLBACK` in `loqui-intent.ts`.
- **Ghost resume.** `resume_run` is zeroed when no prior run is in the context, and the handler double-checks `findLatestTrackedRun()` before issuing the continuation prompt.
- **Hidden mode state.** There is no `state.loqui.mode` field anymore. The classifier is the only authority on which path a message takes, and its decision is visible on every bubble.

## Tests

- `core/loqui-intent.test.ts` — 27 tests: every example case from the task brief (build, question, plan, dry_run, explain, resume), every safety guard (ghost-run downgrade, dry-run-beats-build, ambiguous-build-to-clarify, empty input), and the router's label/effectivePrompt contract.
- Pre-existing test suites (memory, execution-gate, coordinator-execution-truth) remain passing — the Loqui changes are additive and do not touch the Coordinator pipeline.
