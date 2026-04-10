# Zendorium Doctrine

## Prime Directive

**Maximize expected build quality per unit cost, subject to governance and rollback safety.**

Every architectural decision in Zendorium flows from this. Quality is not optional, but overspending on trivial tasks is waste. Safety is non-negotiable.

---

## Core Principles

### 1. Cheapest Acceptable Path Wins

A one-line typo fix does not need a premium-tier model. A security-sensitive auth refactor does. The TrustRouter evaluates complexity, blast radius, and risk signals to route each task to the minimum tier that meets the quality bar. Cost efficiency is a feature, not a compromise.

### 2. Trust Is Earned via Crucibulum, Not Assumed

No worker or model gets trust by default. Trust scores come from Crucibulum benchmarks — seeded bugs, known-good patches, measured accuracy. A model that claims 95% accuracy but scores 72% on Crucibulum gets routed accordingly. Trust degrades if not re-validated.

### 3. Every Decision Is Visible

The RunState records every task, assumption, file touch, decision, cost entry, and coherence check. If it's not in the RunState, it didn't happen. There is no hidden state, no side-channel mutations, no "trust me" operations. Full audit trail, always.

### 4. The Intent Object Is Immutable (Except at Coordinator Checkpoints)

Once the Coordinator seals an IntentObject, no worker may modify it. The intent represents the agreed-upon build objective — changing it mid-execution would undermine coherence. Only the Coordinator can create a new version at explicit checkpoints, with a recorded reason. Version history is preserved.

### 5. Workers See Intent, Not Just File Tasks

Workers receive the full IntentObject alongside their task assignment. A Builder modifying `auth.ts` knows *why* — is it a security fix? A refactor? A new feature? This context lets workers make coherent decisions aligned with the build's purpose rather than optimizing locally in ways that break global coherence.

### 6. Global Coherence Checked Pre and Post Build

Before execution begins, a coherence check validates that the plan covers all deliverables without conflicts. After execution completes, a second check validates that results match intent, no unexpected files were touched, and no deliverables were dropped. Coherence failures block the apply step.

---

## Architectural Invariants

### The Build Pipeline

```
User Request
    → CharterGenerator (analyze + structure)
    → Coordinator (seal IntentObject, plan tasks)
    → Scout (gather context, assess risk)
    → Builder (produce changes)
    → Critic (review for correctness + coherence)
    → Verifier (tests, types, lint)
    → Integrator (merge, resolve conflicts, final coherence)
    → Apply (only if all checks pass)
```

### Worker Contract

Every worker:
- Receives a `WorkerAssignment` containing the task, full intent, assembled context, and upstream results
- Returns a `WorkerResult` with output, issues, cost, confidence, touched files, and assumptions
- Never mutates the IntentObject, RunState, or context directly
- Reports all files it reads or modifies
- Tracks and reports its token consumption and cost

### Context Assembly

Context is layered and budget-aware:
1. **Target files** — always included
2. **Direct dependencies** — imports/exports of targets
3. **Patterns** — type definitions and interfaces used by targets
4. **Tests** — existing test coverage
5. **Similar implementations** — sibling files doing comparable work

Layers fill from highest priority (1) outward. When budget is exhausted, lower layers are omitted. Workers get relevant context, not the whole codebase.

### Trust Routing

The TrustRouter considers:
- **Complexity** — file count, dependency depth, task type, description signals
- **Blast radius** — direct/transitive files, public API, data layer
- **Risk signals** — security, production, destructive operations
- **Quality bar** — from the Charter, sets minimum acceptable tier
- **Crucibulum scores** — historical worker/model accuracy

Tier escalation is one-directional: signals can push a task to a higher tier, never a lower one. The cheapest tier that satisfies all constraints wins.

### Rollback Safety

Every change must be revertible. The Integrator preserves original file contents. The RunState records every file touch. If verification fails or coherence breaks, the entire changeset can be discarded without side effects. There is no "partial apply" — it's all or nothing.

---

## Cost Transparency

Every model call produces a cost entry: model name, input tokens, output tokens, estimated USD. The RunState aggregates costs across all tasks. The Coordinator can enforce budget constraints from the IntentObject. Users see the full cost breakdown, always.

---

## Model Assignments

Default model assignments are defined in `server/routes/config.ts` (`DEFAULT_MODEL_CONFIG`) and overridden per-project by `.zendorium/model-config.json` if present. Workers read the active assignment via `loadModelConfig()` on every execute, so configuration changes take effect on the next run without a process restart.

Per-role fallbacks are NOT stored in `model-config.json` — they are hardcoded in each worker's constructor (`workers/builder.ts`, `workers/critic.ts`) via the `fallbackModel` field. Both Builder and Critic use the same `invokeModelWithFallback()` mechanism in `core/model-invoker.ts`. The default request timeout is **5 minutes** (300_000 ms) — raised from 2 minutes after ModelStudio was identified as slow but functional under heavy load.

### Builder

- **Primary:** `qwen3.6-plus` (ModelStudio via `MODELSTUDIO_API_KEY`)
- **Fallback:** `claude-sonnet-4-6` (Anthropic direct via `ANTHROPIC_API_KEY`)

ModelStudio's qwen3.6-plus is the Builder's workhorse. It is significantly cheaper per token than Sonnet and produces solid diff-application output for the contract scope the Builder enforces. It is also slow — calls regularly run 60–180 seconds, occasionally pushing toward the 5-minute timeout cap. That latency is acceptable; the previous 2-minute timeout was not.

If ModelStudio times out, returns an HTTP error, or is otherwise unreachable, the chain promotes Anthropic Sonnet 4.6 — same model the Critic uses as primary. The fallback exists so a transient ModelStudio outage cannot stall the entire pipeline, and so quality stays high when the cheap path fails.

### Critic

- **Primary:** `claude-sonnet-4-6` (Anthropic direct via `ANTHROPIC_API_KEY`)
- **Fallback:** `qwen3.5:9b` (local Ollama, free)

The Critic gates the entire pipeline — its verdict decides whether work reaches Verify and Apply, or gets sent back to the Builder for rework. A stronger model here pays for itself by catching issues that would otherwise burn a verification cycle (or worse, ship a broken build). Sonnet has measurably better track record on the diff-review and contract-compliance checks the Critic runs.

If Anthropic is down, the chain falls back to the local qwen3.5:9b on Ollama. Local Ollama has no API key, no rate limit, no auth check — it is the floor. The Critic's verdicts under fallback are still better than no review at all.

### Other Roles

- **Scout:** `local` (mock, zero-cost — pure context assembly, no model needed)
- **Verifier:** `local` (mock — runs deterministic tests/types/lint, not a model)
- **Integrator:** `glm-5.1` (ZhipuAI — strong at multi-file conflict resolution)
- **Escalation:** `glm-5.1` (ZhipuAI — same model used when standard tier fails)
- **Coordinator:** `xiaomi/mimo-v2-pro` (OpenRouter — used for orchestration prompts when needed)

These roles do not currently have fallback chains. If they need that discipline later, the same `invokeModelWithFallback()` + per-run blacklist pattern from Builder/Critic can be ported in.

### Fallback Discipline

The fallback chain is intentionally short — primary plus exactly one backup. This is by design:

1. **No silent escalation.** If the primary fails, exactly one fallback handles it. We do not silently chain through three paid providers and run up the bill.
2. **No retry-the-same-thing.** A provider that times out once in a run is blacklisted for the rest of that run. The blacklist is shared across both Builder and Critic via per-run scoping (keyed by `intent.runId`), so a ModelStudio timeout in the Builder is also remembered if the Critic happens to need ModelStudio later in the same run.
3. **Quality and local both have a place.** Builder's fallback is the Critic's primary (Sonnet) — quality backstop for the cheap path. Critic's fallback is local Ollama — availability floor for the quality path. Together they cover the two failure modes that matter: paid provider down, or local-only environment.
4. **Cost transparency holds.** The cost entry on the receipt records the provider that *actually succeeded*, not the one that was attempted first. The `builder_complete` and `critic_review` events both carry a `fellBack: boolean` so the UI and receipt stream can flag fallback events.

If a build run consistently falls through to the Builder fallback, that is a signal — ModelStudio is having a real outage, the API key is invalid, or rate limits are biting. The receipt stream will show it as a flood of `fellBack: true` events, and the operator can act.

### Timeout Discipline

`fetchWithTimeout` in `core/model-invoker.ts` defaults to 300_000 ms (5 minutes). This is the per-request hard cap — anything still pending at that point is aborted, the provider is blacklisted for the run, and the chain falls through to the fallback. Workers that need a tighter bound can pass an explicit `timeoutMs` to the underlying provider call, but Builder and Critic both rely on the default.

The previous 2-minute cap was tripping ModelStudio on essentially every Builder call. The fix was the longer cap, not a different model — ModelStudio works fine when you let it finish.

---

## Governance Rules

1. **No raw shell access** — Workers cannot execute arbitrary commands. The Verifier runs tests through a controlled harness.
2. **No state mutation by workers** — Only the Coordinator and RunState tracker may mutate build state.
3. **Assumptions require acceptance** — Workers may propose assumptions; only the Coordinator may accept them, and acceptance is recorded.
4. **Scope is bounded** — Changes must trace to deliverables in the Charter. Unrelated "improvements" are rejected.
5. **Critic review is mandatory** above the complexity threshold — The TrustRouter enforces this.

---

## What Zendorium Is Not

- **Not a code generator.** It's a build orchestration system that happens to use AI workers.
- **Not autonomous.** The Coordinator manages the pipeline; the user approves the intent and the final apply.
- **Not trust-by-default.** Every worker earns its routing tier through measured performance.
- **Not opaque.** Every decision, cost, assumption, and file touch is recorded and visible.

---

## Design Maxims

> "If it's not in the RunState, it didn't happen."

> "Cheapest path that clears the quality bar."

> "Trust is a number, not a feeling."

> "Workers see purpose, not just tasks."

> "Coherence is checked, not hoped for."

> "A timed-out provider does not get a second chance in the same run."

> "The Critic gates the pipeline — pay for the better model there."

> "Slow is not the same as broken."
