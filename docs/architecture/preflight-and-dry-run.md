# Preflight + Dry Run System v1

## Why

Before this phase, Loqui's `dry_run` intent routed to the Q&A path with a reframed prompt telling the model "describe, don't write." The model would then hallucinate a plan — sometimes right, sometimes wrong, never grounded in the actual planner the Coordinator uses at runtime. That's not a dry-run; that's a guess.

Preflight + Dry Run System v1 makes "what would you do?" produce a real answer:

1. A **preflight validator** catches obvious problems (missing paths, vague instructions, destructive verbs with no target) at the edge, before anything else runs.
2. A **dry-run planner** composes the existing planning primitives (Charter → scope → ChangeSet → planner → blast radius → confidence) and returns a structured `DryRunPlan` the UI can render as concrete steps, file list, risk, cost, and confidence.

Nothing is executed. No workers run. No files change. The plan the user sees is the plan the Coordinator would run if they submitted the same request for real — because both paths share the same planning primitives.

## Shape

```
user input
  → POST /tasks/loqui/unified        (Loqui chat)
    → routeLoquiInput                (loqui-router.ts)
      → classifyLoquiIntent          (loqui-intent.ts — "dry_run" class)
    → action: dry_run
  → generateDryRun(input, repoPath)  (core/dry-run.ts)
    → runPreflight(...)              (core/preflight.ts)
    → CharterGenerator.analyzeRequest + generateCharter
    → classifyScope
    → createChangeSet
    → planChangeSet
    → estimateBlastRadius            (reuses trust-layer module)
    → predictive confidence          (pre-execution variant)
    → cost estimate                  (back-of-envelope range)
  → DryRunPlan returned to the UI
  → UI renders as structured chat bubble with the Dry Run intent chip
```

The same `generateDryRun` function is exposed via `POST /tasks/dry-run` for API clients that already know they want a plan.

## Preflight (`core/preflight.ts`)

Deterministic rule list. Every rule returns a `PreflightFinding` with a severity (`ok` / `warn` / `block`), a message, and a concrete suggestion. A single `block` finding is enough to prevent execution; `warn`s surface in the dry-run output so the user sees them but can still proceed.

Rules:

1. **empty-input** → block. Request has no content.
2. **trivial-input** → block. Fewer than 2 meaningful words.
3. **missing-repo-path** → block. No repoPath supplied.
4. **invalid-repo-path** → block. repoPath does not exist on disk.
5. **all-targets-missing** → warn. All named target files are missing on disk. Warn rather than block because the user may be asking Aedis to create them.
6. **some-targets-missing** → warn. Some of the named targets are missing.
7. **vague-instruction** → block. No concrete verb and no target files, or hedging language with no target.
8. **soft-ambiguity** → warn. Charter analyzer flagged ambiguities but the request is still plannable.
9. **destructive-no-target** → block. Destructive verb with no named target file or module.
10. **security-sensitive** → warn. Prompt mentions auth / tokens / credentials / permissions.
11. **target-outside-root** → block. Absolute path target outside the repo root.
12. **production-sensitive** → warn. Prompt mentions prod / deploy / release / migration.

Safe-fallback discipline: when in doubt, prefer `warn` over `block`. The user should be able to proceed against our advice; preflight's job is to make sure they're *informed*.

## Dry-run planner (`core/dry-run.ts`)

Standalone module that imports the existing planning primitives directly. No Coordinator changes.

- **Preflight first.** If preflight blocks, the planner still runs the parts it can (charter analysis, target extraction) and returns a partial plan with `blocked: true`. The UI shows the user what *would* have been planned plus the reason it can't proceed.
- **Charter analysis + generation** — via `CharterGenerator.analyzeRequest` / `generateCharter` / `generateDefaultConstraints`. Exposed as pure methods so the planner can call them without instantiating a Coordinator.
- **Scope classification** — via `classifyScope` (pure function).
- **ChangeSet construction** — via `createChangeSet` (pure function).
- **Wave planning** — via `planChangeSet` (pure function).
- **Blast radius** — via `estimateBlastRadius` from the trust layer. Same function the Coordinator calls in Phase 1b, so the dry-run risk level matches the runtime projection.
- **Cost estimate** — back-of-envelope range. Tuned against observed real-run costs: small single-file fixes sit under a penny, multi-file refactors in the 5–25 cent range, architectural changes can reach a dollar or more. Produces a `minUsd / maxUsd / display` shape so the UI shows order of magnitude, not false precision.
- **Predictive confidence** — a pre-execution variant of the post-run `scoreRunConfidence`. Reads only planning signals (scope type, blast level, preflight outcome) because there is no receipt yet. Weighted `0.25·planning + 0.35·execution + 0.4·verification`. Every basis string is preserved for UI tooltips.

### Steps list

Eight possible stages, ordered as the Coordinator would run them:

```
preflight → charter → scout → builder[×waves] → critic → verifier → integrator
```

Each `DryRunStep` carries `stage`, `description`, `tools` (tsc, scout-worker, diff-applier, merge-gate, ...), and `targetFiles`. Multi-file plans fan out into one builder step per wave. Single-file plans collapse into one builder step.

### Narrative + headline

Headline: `"Aedis would run N steps across M files (multi-file scope). Confidence: 65%."` — matches the brief's product tone.

Narrative: multi-sentence paragraph listing the objective, preflight outcome, step order, files likely touched, risk level rationale, cost range, and predictive confidence.

## Router (`core/loqui-router.ts`)

The `dry_run` intent now routes to a new `"dry_run"` action instead of the `"answer"` action:

- **Before v1:** `dry_run` → `answer` with a reframed prompt ("describe, don't write"). Model hallucinated a plan.
- **After v1:** `dry_run` → `dry_run`. Server handler calls `generateDryRun(originalInput, repoPath)` and returns the grounded `DryRunPlan`.

Every other Loqui intent (`build`, `answer`, `resume`, `clarify`) is unchanged.

## Server routes (`server/routes/tasks.ts`)

- **`POST /tasks/loqui/unified`** — gains a `dry_run` case in its switch. Response envelope shape: `{ route: "dry_run", intent, label, reason, confidence, signals, original_input, plan }` where `plan` is the full `DryRunPlan`.
- **`POST /tasks/dry-run`** — new direct entry point for API clients that want a plan without going through the classifier. Accepts `{ input, repoPath }`, returns `{ plan }`.

No existing route shapes change. The hero RUN button, legacy `POST /tasks`, and legacy `POST /tasks/loqui` all work unchanged.

## UI (`ui/index.html`)

- `handleRouteResponse` gains a `dry_run` case that calls `formatDryRunPlanForChat(plan)` and pushes an assistant bubble with the structured plan as text. The raw `DryRunPlan` is stashed on the message so follow-up actions (e.g. "run it for real") can reuse it later.
- `formatDryRunPlanForChat` renders the plan as a multi-line chat bubble:
  - headline
  - preflight block / warn findings (if any)
  - steps list (stage: description — files)
  - files likely touched
  - one-line footer: `Risk · Cost · Confidence`
- The Loqui bubble already has `white-space: pre-wrap`, so the multi-line format renders naturally.
- The `Dry Run` intent chip (purple, from the trust-layer styling) is applied automatically via the existing `renderIntentBadge` because the router's label pass-through still works.

No layout redesign. No new panel. The dry-run bubble lives in the Loqui chat where the user asked for it.

## Grounding discipline

Every field on `DryRunPlan` is derived from the same primitives the Coordinator uses at runtime:

| Dry-run field | Grounded in |
|---|---|
| `preflight` | `runPreflight` (same rule list used if we wired it into submit) |
| `filesLikelyTouched` | `charter.deliverables[].targetFiles` (charter.ts) |
| `riskLevel` | `estimateBlastRadius(scope, files, prompt).level` (blast-radius.ts) |
| `blastRadius` | same |
| `scope` | `classifyScope(prompt, files)` (scope-classifier.ts) |
| `steps` | `planChangeSet(changeSet, prompt).waves` + fixed stage order (multi-file-planner.ts) |
| `estimatedCost` | charter file count + plan wave count + quality bar |
| `confidence` | scope + blast + preflight (no receipt, predictive) |
| `headline` / `narrative` | composed from the above |

The only piece that is not shared with the Coordinator pipeline is the cost estimator — it is a dry-run-specific projection because real cost comes from the receipt after execution. Everything else is a literal call into the same function.

## Tests

- `core/dry-run.test.ts` — 18 tests covering:
  - **Preflight (9):** empty input, trivial input, missing repoPath, invalid repoPath, vague prompt, destructive verb with no target, missing named target → warn not block, security-sensitive → warn, clean request → ok.
  - **Dry-run (9):** clean single-file request returns every stage, blocked preflight still returns a partial plan, empty-target "build a capability registry" still plans against the charter's placeholder deliverable, vague prompt blocks, destructive+security surface produces high risk, cost estimate is a valid range, confidence carries basis lines, narrative names risk/cost/confidence, the success criterion ("what would you do?" returns a plan without executing).
- `core/loqui-intent.test.ts` — one test updated to reflect the new `dry_run` → `dry_run` action (no longer `dry_run` → `answer` with reframed prompt).

Full suite: **90 tests pass, `tsc --noEmit` clean.**

## What stayed the same

- **Coordinator pipeline** — untouched. No new submissions, no new phases, no refactor. The dry-run path is completely parallel to the execution path.
- **Execution Truth Enforcement v1** — untouched. Dry-run never touches the execution gate because it never submits a task.
- **Loqui Unified Intent Routing v1** — same classifier, same router structure. The only change is one case in the switch statement now routes to `"dry_run"` instead of `"answer"`.
- **Trust Layer v1** — `estimateBlastRadius` is shared across dry-run and post-run paths, so the projected risk level matches what the user sees after the run.

## Success criterion

From the brief: *"User can ask 'what would you do?' and Aedis responds with a clear plan without executing anything."*

```
user: "show me the plan for in core/foo.ts, add a helper"
  → router picks dry_run
  → generateDryRun produces a 10-step plan, 2 files, low risk, $0.02–$0.32, 65% confidence
  → UI shows the structured plan in the Loqui chat
```

No Coordinator.submit call. No workers. No files touched. Plan is grounded in the same primitives Aedis would use for real.
