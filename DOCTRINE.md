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
