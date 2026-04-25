# Aedis Doctrine

> Originally written as the Zendorium Doctrine. The system was renamed to
> Aedis; the doctrine did not change.

## Prime Directive

**Maximize expected build quality per unit cost, subject to governance and rollback safety.**

Every architectural decision in Aedis flows from this. Quality is not optional, but overspending on trivial tasks is waste. Safety is non-negotiable.

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

## Routing Doctrine

These rules govern how a task gets a model — and when it shouldn't get one at all.

1. **Cheapest safe path first.** A task gets the lowest tier that meets the quality bar. The TrustRouter never escalates speculatively; escalation requires a concrete signal (capability floor, weak output, blast radius, risk).
2. **Deterministic before model.** When the change is mechanically describable — route insertion, import update, decorated-class extension, multi-file scaffold of a known shape — the deterministic transform pre-pass runs first. If it applies, the LLM Builder is bypassed entirely and the task is routed → brief → transform → verify → promote → receipt with zero model calls.
3. **Escalate on capability need or weak output, never preemptively.** Two escalation paths exist: capability-floor (the brief's minimum tier exceeds the router's pick) and weak-output retry (the builder produced empty diff, raw diff, prose, export loss, or a critic-rejected output). Both are bounded — weak-output retry caps at 2 attempts; capability-floor lifts the tier exactly once before the run.
4. **Never hide provider failure.** Empty responses, timeouts, HTTP errors, network errors, and circuit-breaker skips all surface in the receipt's `providerAttempts[]`. Fallback succeeding does not erase the failed attempts that came before it. Operators see what was tried.
5. **Never let fallback success bypass verifier / execution / merge gate.** A model call that succeeds via the fallback chain still produces output that goes through the same Critic → Verifier → Integrator → MergeGate → ExecutionGate pipeline as a primary success. Fallback is a routing concern, not a quality concern. The gates make their own decision.
6. **No Anthropic hot path unless the doctrine flag says otherwise.** Builder, Critic, and Integrator must not use `provider: "anthropic"` (primary or chain) without `AEDIS_ALLOW_ANTHROPIC=1`. The Phase 3 validator warns at config-load time. Anthropic is welcome for meta-work and for deliberate experiments; it must never be the silent default in the build pipeline.

---

## Trust Boundaries — What Is Real Today, What Is Future Work

Aedis must not let its own docs overstate its capabilities. As of the trust-routing-hardening pass (commits 44e876e through ac4b968), the following are **real**:

- **Builder routing is tier-aware end-to-end.** `TrustRouter.route()` produces a tier (`fast`/`standard`/`premium`) per builder dispatch from complexity + blast radius + quality bar; capability-floor escalates when the brief demands more; weak-output retry escalates again on empty/raw/prose/critic-rejected output.
- **Builder fallback chains are declarative.** Per-tier `chain[]` in `.aedis/model-config.json` is the source of truth; the legacy single-entry constructor fallback is appended only when no chain is declared.
- **Provider attempts are evidence in the receipt.** Every chain step (success, error, blacklist skip, circuit-breaker skip) is recorded with timing, cost, and outcome on `PersistentRunReceipt.providerAttempts[]`. Routing decisions and escalations are recorded on `routing[]`.
- **Empty / whitespace responses are classified as failures** at the provider layer — `InvokerError("empty_response")` advances the chain without poisoning the circuit breaker.
- **Cancellation propagates end-to-end** for the Builder and Critic execution paths that call `invokeModelWithFallback`. `Coordinator.cancel(runId)` triggers a per-run `AbortController`; in-flight HTTP requests are dropped, not waited for. Stale-result guards remain as a backstop.
- **Repair-audit-pass is audit-only.** It surfaces structural findings (broken imports, missing exports, stale markers) as advisory signals. It never modifies any file. The result shape carries an `auditOnly: true` literal-type invariant; no `repairsApplied` or `repairsAttempted` fields exist.

The following are **not yet real** and must not be claimed as such:

- **Non-Builder worker routing is not tier-aware.** Critic, Integrator, Scout, and Verifier read static `model-config[<role>]` assignments — they do not call `TrustRouter.route()`. A "standard tier" Critic does not exist; the Critic uses whatever model the config names. *Phase 6 documents this as the current state; a future phase may introduce per-worker tier routing if measured cost/quality data justifies it.*
- **Provider fallback success ≠ task success.** A Builder call that fell back from primary to entry-3 and produced compiling code can still be wrong. Verifier and merge gate are the authorities on whether the change is correct.
- **Audit findings ≠ repairs.** The repair-audit-pass surfaces structural smells. It does not fix them. A non-empty `findings[]` means the audit *noticed* something — nothing more.
- **Receipts are evidence, not proof of semantic correctness.** A receipt with `providerAttempts: [ok]`, `routing: [tier:standard]`, `executionVerified: true` does not prove the change is what the user asked for. Crucibulum (when scored against this run), the diff viewer, and the user's eyes are the final authority on intent satisfaction. The receipt records what happened, not what *should* have happened.
- **Real-world task validation is partial.** Single-file edits on TypeScript/Python/Crucible are confirmed working as of 2026-04-19. Multi-file semantic tasks, ambiguous-prompt rejection rates, bug-fix-with-hidden-failure detection, and fallback-under-real-provider-outage have not been measured in a controlled gauntlet. See [Replacement-Grade Checklist](#replacement-grade-checklist--do-not-claim-until).

---

## Replacement-Grade Checklist — Do Not Claim Until…

Aedis aspires to be a trusted Claude Code replacement for real-world development tasks. The infrastructure is now in place. The evidence is not yet sufficient. **Do not claim replacement-grade until every item below has measured pass data:**

- [ ] **Real task gauntlet passes.** A controlled run of multi-target prompts on at least three real repos (`more-input`, `absent-pianist`, `crucible`/`squidley-v2`) with verdicts, costs, times, and failure modes recorded in receipts.
- [ ] **Multi-file semantic tasks succeed repeatedly.** Not a one-off pass — three consecutive clean runs on a non-trivial multi-file change (≥ 3 files, cross-module, real semantic edit, not a sweep) with VERIFIED_SUCCESS and zero stale-result fallbacks.
- [ ] **Ambiguous prompt handling is measured.** A prompt set known to be under-specified is run through Loqui; the rejection rate (`clarify` vs erroneous `build`) is reported. Loqui must refuse to dispatch on the meta-prompt cases without exception.
- [ ] **Fallback / cancellation behavior verified under real provider failure.** A run that triggers a real provider 429 / timeout / network drop, with the receipt's `providerAttempts[]` showing the chain advancing correctly. A separate run cancelled mid-flight, with the in-flight HTTP call confirmed dropped (no late settlement applied to changes).
- [ ] **Cost / time / success / failure classifications are reported.** A summary table per repo: total runs, success rate, mean cost, mean wall time, failure-mode distribution. Not aggregated across repos — per-repo so the variance is visible.

Every item above is a testable claim. Until receipts back each one, the system is **promising**, not **trusted**. *The Phase 7 gauntlet will produce these numbers; until then, every external description of Aedis must qualify the readiness claim.*

---

## Model Assignments

Per-repo model selection lives in `.aedis/model-config.json` (with `.zendorium/model-config.json` read as a legacy fallback during the rename). Workers read the active assignment via `loadModelConfig()` on every execute, so configuration changes take effect on the next run without a process restart. The `DEFAULT_MODEL_CONFIG` in `server/routes/config.ts` is the *empty-config fallback* — it ships with the codebase but is overridden by any real `.aedis/model-config.json`.

Per-tier declarative fallback chains are supported via `ModelAssignment.chain[]` (added 2026-04-25 in `declarative-model-chains`). When a chain is declared, it is authoritative for that build. When no chain is declared, each worker's constructor-level fallback (`workers/builder.ts`, `workers/critic.ts` `fallbackModel`) is appended so single-entry configs still get *some* fallback. Both paths flow through `invokeModelWithFallback()` in `core/model-invoker.ts`. Default request timeout is **5 minutes** (300_000 ms) — see [Timeout Discipline](#timeout-discipline).

### Builder

- **Resolution order:** `.aedis/model-config.json` → `builderTiers[<tier>]` → `builder` → constructor fallback
- **Constructor default:** `qwen3.6-plus` on ModelStudio, with `moonshotai/kimi-k2` on OpenRouter as the legacy single-entry fallback
- **Real Aedis-on-Aedis config:** `xiaomi/mimo-v2.5` on OpenRouter for every role (per the in-repo `.aedis/model-config.json`)
- **Tier resolution:** `resolveBuilderChainForTier()` returns the full ordered chain (primary first, then declared `chain[]` entries deduped by `provider/model` identity)

Builder model defaults intentionally do *not* point at Anthropic. The doctrine is "no Anthropic in hot path" — the cheap-build promise depends on it. See [No Anthropic Hot Path](#no-anthropic-hot-path).

### Critic

- **Resolution order:** `.aedis/model-config.json` → `critic` → constructor fallback
- **`DEFAULT_MODEL_CONFIG.critic` (empty-config fallback):** `qwen3.5:9b` on local Ollama
- **Constructor default:** `qwen3.5:9b` on local Ollama (cheap, no API key, no rate limit)
- **Real Aedis-on-Aedis config:** `xiaomi/mimo-v2.5` on OpenRouter (overrides the constructor default)

The Critic gates the pipeline — its verdict decides whether work reaches Verify and Apply, or gets sent back to the Builder for rework. The active config is the source of truth; the constructor default exists only for environments without a `.aedis/model-config.json`.

The `DEFAULT_MODEL_CONFIG.critic` value was previously `claude-sonnet-4-6 / anthropic`, which silently routed every empty-config installation onto the paid Anthropic path — a no-Anthropic-hot-path doctrine violation. As of 2026-04-25 the default is `qwen3.5:9b / ollama`, matching the constructor default. A regression test in `server/routes/config.test.ts` asserts that `DEFAULT_MODEL_CONFIG` itself never re-introduces Anthropic in builder/critic/integrator.

### Other Roles

- **Scout:** `local` (zero-cost by design — pure context assembly, no model needed)
- **Verifier:** `local` (deterministic tests/types/lint hooks; not a model)
- **Integrator:** `glm-5.1` (ZhipuAI — strong at multi-file conflict resolution)
- **Escalation:** `glm-5.1` (same model used when standard tier needs lifting)
- **Coordinator:** `xiaomi/mimo-v2-pro` (OpenRouter — for orchestration prompts when needed)

Non-Builder workers are *not* tier-aware in the current implementation — they read the static `model-config[<role>]` assignment directly. See [Trust Boundaries](#trust-boundaries--what-is-real-today-what-is-future-work) for the full statement of what is and isn't routed today.

### Fallback Discipline

The fallback chain has evolved past "primary plus exactly one backup." Current discipline:

1. **Declarative chains.** Per-tier `chain[]` in `.aedis/model-config.json` lists the providers in order. The chain is data, not code; per-repo declarations are authoritative for that build. The constructor-level legacy fallback is appended only when no chain is declared.
2. **No retry-the-same-thing.** A provider that **times out** is blacklisted for the rest of that run. The blacklist lives in the per-run `RunInvocationContext` and is shared across all workers in the run.
3. **Empty content is a failure signal.** Empty / whitespace-only model output is classified as `InvokerError("empty_response")` at the provider layer (Phase 1). The chain advances to the next entry; the circuit breaker is *not* incremented (the infra worked; the model produced junk on this prompt) and the provider is *not* blacklisted (other prompts may succeed).
4. **Cross-run circuit breaker.** Repeated failures on a provider trip a persistent circuit breaker (`.aedis/circuit-breaker-state.json`) with half-life decay. Skipped providers are recorded as a `circuitBreakerSkips` entry in the receipt for transparency.
5. **Universal last-resort.** After the caller-provided chain is exhausted, the runtime makes one more attempt against the local Portum gateway (`localhost:18797`). Skipped if Portum was already in the chain or is blacklisted.
6. **Cost transparency holds.** The cost entry records the provider that *actually succeeded*. Receipts persist a full `providerAttempts[]` log (Phase 2) — every chain step (success, error, blacklist skip, circuit-breaker skip) with timing and cost. Operators can read the receipt to see exactly which providers were tried and why.
7. **Cancellation never blacklists or penalizes.** A user-initiated cancel (`Coordinator.cancel(runId)`) propagates an `AbortSignal` end-to-end (Phase 4). Cancelled errors (`InvokerError("cancelled")`) are *never* retried, *never* blacklisted, *never* incremented in the circuit breaker — cancellation is user intent, not provider fault.

If a build run consistently falls through to a non-primary entry of the declared chain, that is a signal — the primary is having a real outage, the API key is invalid, or rate limits are biting. The receipt's `providerAttempts[]` makes the pattern obvious.

### Timeout Discipline

`fetchWithRetry` in `core/model-invoker.ts` defaults to 300_000 ms (5 minutes) per request. This is the per-request hard cap — anything still pending at that point is aborted, the provider is blacklisted for the run, and the chain falls through to the next entry. The internal timeout signal is merged with any caller-supplied `AbortSignal` via `AbortSignal.any` so cancellation and timeout share the same plumbing.

The previous 2-minute cap was tripping ModelStudio on essentially every Builder call. The fix was the longer cap, not a different model — ModelStudio works fine when you let it finish.

### No Anthropic Hot Path

The cheap-build promise depends on the *hot path* (Builder, Critic, Integrator) not reaching for Anthropic. The Phase 3 validator `checkAnthropicHotPathDoctrine()` inspects every active `.aedis/model-config.json` and logs a one-time warning per project root if any hot-path role — primary, chain entry, or per-tier builder — uses `provider: "anthropic"`. The check respects `AEDIS_ALLOW_ANTHROPIC=1` as an explicit opt-in for users who have *deliberately* chosen Anthropic for a build.

Anthropic remains valid for meta-work (this very session, for example) and for deliberate quality experiments. It must never be the silent default.

---

## Governance Rules

1. **No raw shell access** — Workers cannot execute arbitrary commands. The Verifier runs tests through a controlled harness.
2. **No state mutation by workers** — Only the Coordinator and RunState tracker may mutate build state.
3. **Assumptions require acceptance** — Workers may propose assumptions; only the Coordinator may accept them, and acceptance is recorded.
4. **Scope is bounded** — Changes must trace to deliverables in the Charter. Unrelated "improvements" are rejected.
5. **Critic review is mandatory** above the complexity threshold — The TrustRouter enforces this.

---

## What Aedis Is Not

- **Not a code generator.** It's a build orchestration system that happens to use AI workers.
- **Not autonomous.** The Coordinator manages the pipeline; the user approves the intent and the final apply.
- **Not trust-by-default.** Every worker earns its routing tier through measured performance.
- **Not opaque.** Every decision, cost, assumption, and file touch is recorded and visible.
- **Not a self-repair system.** The `repair-audit-pass` surfaces structural findings; it does not fix anything. Claims like "Aedis repaired the imports" are wrong — it noticed them and surfaced them; the model or the human did the repair.
- **Not yet measured at replacement scale.** See the [Replacement-Grade Checklist](#replacement-grade-checklist--do-not-claim-until).

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
