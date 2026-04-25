# AEDIS

**Governed AI Build Orchestrator**

*The anti-CC. Cheap, governed, auditable, self-aware.*

---

Aedis takes a natural language prompt, decomposes it into a governed execution plan, dispatches it through a 5-worker pipeline, verifies the output against hard contracts, and commits real code changes to a git repo — or rolls everything back if any gate fails.

Not a chatbot wrapper. Not a prompt-and-pray loop. A build system with receipts, rollback, and a merge gate that means it.

## Benchmark

7 tasks completed on its own codebase. Every one passed the merge gate and committed clean.

| Metric | Value |
|---|---|
| Tasks completed | 7 |
| Total cost | **$0.17** |
| Avg cost per task | **$0.024** |
| Most expensive task | $0.038 |
| Equivalent CC sessions | $5 -- 10 |

All five workers reporting:

| Worker | Role | Confidence |
|---|---|---|
| Scout | File discovery, risk assessment, dependency mapping | 0.92 |
| Builder | Model-driven code generation with contract scope | -- |
| Critic | Adversarial review, request-changes loop | 0.84 |
| Verifier | Type check, lint, contract validation | 0.95 |
| Integrator | Cross-file merge, final coherence pass | 1.00 |

## Cost Comparison

| Task type | Aedis | Claude Code |
|---|---|---|
| Add JSDoc comment | $0.02 | ~$0.50 |
| Multi-file feature | $0.04 | ~$2.00 |
| Full session (10 tasks) | $0.25 | $5 -- 10 |

Builder model selection lives per-repo in `.aedis/model-config.json` with declarative `chain[]` fallbacks. The default in-repo configuration uses `xiaomi/mimo-v2.5` on OpenRouter for the hot-path roles. Anthropic is *not* in the hot path by default — see `DOCTRINE.md` "No Anthropic Hot Path." Scout and Verifier are local (zero-cost). Coordinator, MergeGate, VerificationPipeline, and ContextAssembler run locally with no model calls.

## Architecture

```
prompt
  |
  v
Coordinator ─── CharterGenerator ─── ScopeClassifier
  |                                        |
  v                                        v
TaskGraph ─── Scout ─── Builder ─── Critic ─── Verifier ─── Integrator
  |               |         |          |           |             |
  v               v         v          v           v             v
ContextGate   FileRead   ModelCall   Review    TypeCheck     MergeGate
  |                         |                                    |
  v                         v                                    v
ProjectMemory          DiffApplier                        git commit / rollback
```

**Coordinator** (`core/coordinator.ts`) — Master orchestrator. Owns the full lifecycle: charter, intent, task graph, dispatch, rehearsal loop, verification, merge gate, commit, receipt. Never does work itself — orchestrates workers and enforces governance.

**MergeGate** (`core/merge-gate.ts`) — Hard stop before commit. Collects findings from IntegrationJudge, VerificationPipeline, and change-set gate. One critical finding blocks. No "looks mostly good" path. On block: rolls back every file the Builder touched, including restoring deleted files from git HEAD.

**VerificationPipeline** (`core/verification-pipeline.ts`) — Multi-stage verification: diff check, contract check, cross-file coherence, lint, typecheck, custom hooks. Produces a receipt with confidence score. Supports per-wave verification for multi-file plans.

**Workers** (`workers/`) — Five specialized workers, each with a single responsibility:
- **Scout** — Reads files, maps dependencies, estimates complexity, assesses risk. No model calls.
- **Builder** — Single-file contract-scoped code generation. Reads the file, builds a contract from the charter, calls the model, applies the diff, enforces forbidden-change rules. Section-edit mode for large files (extracts relevant window, applies unified diff back to full file).
- **Critic** — Reviews Builder output against the contract. Can request changes (triggers rehearsal loop) or approve.
- **Verifier** — Runs typecheck, lint, and custom hooks against changed files.
- **Integrator** — Final cross-file merge and coherence check.

**ProjectMemory** (`core/project-memory.ts`) — Persistent per-repo knowledge. Tracks recent files, task summaries, and file clusters that change together. Feeds into ContextGate so the next run knows what worked, what failed, and which files are related.

**ContextGate** (`core/context-gate.ts`) — Controls what context each worker sees. Wave-aware: in multi-file plans, builders only see their wave's invariants and sibling files. Minimal-context discipline — nothing from later waves, nothing from elsewhere in the repo.

**PromptNormalizer** (`core/prompt-normalizer.ts`) — Rewrites vague prompts into explicit engineering instructions. Uses a local model (Qwen 3.5 4B via Ollama) with quality gate — rejects normalization that mangles the original intent.

**Loqui** (`core/loqui.ts`, `core/loqui-router.ts`) — Conversational interface for repo reasoning. Single input, intent-classified routing: build, answer, resume, dry-run, or clarify. The UI sends every message through Loqui — there's no mode to pick.

**Vision** (`core/vision.ts`) — Optional post-build self-check. Captures a screenshot of the running UI and analyzes it for visible errors. Enabled via `AEDIS_VISION=true`.

**Portum** — Universal last-resort gateway. Local HTTP proxy at `localhost:18797`. Tried once after the caller-provided fallback chain is exhausted, skipped if Portum was already in the chain or is blacklisted. Per-run timeout blacklisting and a cross-run circuit breaker (`.aedis/circuit-breaker-state.json`) sit in front of every chain step.

**TrustRouter** (`router/trust-router.ts`) — Routes Builder tasks to tiers (fast/standard/premium) from complexity + blast radius + quality bar. Capability-floor and weak-output retry escalate the tier when the brief demands more or the model produced empty/raw/prose/critic-rejected output. *Non-Builder workers (Critic, Integrator, Scout, Verifier) read static `model-config[<role>]` assignments and are not yet tier-routed* — see `DOCTRINE.md` "Trust Boundaries."

**Provider transparency** — Every chain step (success, error, blacklist skip, circuit-breaker skip, empty-response, cancellation) is recorded with timing and cost on `PersistentRunReceipt.providerAttempts[]`. The routing decision and any escalations are recorded on `routing[]`. Operators can see exactly which providers were tried and why without re-deriving from logs.

**End-to-end cancellation** — `Coordinator.cancel(runId)` triggers a per-run `AbortController`; in-flight provider HTTP requests are dropped immediately rather than waiting to settle. Cancelled errors are never retried, never blacklisted, never penalize the circuit breaker.

**Audit-only structural pass** — `repair-audit-pass` surfaces structural smells (broken imports, missing exports, stale markers) as advisory merge-gate findings. It never modifies any file. Receipts say so explicitly.

## Key Features

**Hard merge gate with rollback.** The MergeGate is not advisory. One critical finding blocks the commit. On block, the Coordinator restores every modified file from `originalContent`, removes created files, and recovers deleted files from git HEAD. The repo is left exactly as the user started.

**Wave-aware multi-file execution.** Large tasks are decomposed into waves by the planner. Each wave is verified independently. A failing wave blocks downstream waves and surfaces as a critical merge-gate finding. Builders in each wave see only their wave's invariants.

**Execution truth enforcement.** The ExecutionGate runs after every other gate and is the single authority on whether the run produced real, verifiable work. A "success" from the verdict logic that produces zero evidence is forced to "failed." The receipt tells the truth.

**Project memory.** Every task is recorded: prompt, verdict, commit SHA, cost, files touched. File clusters that change together are learned automatically. The next run's ContextGate uses this to surface relevant files and landmines.

**Scope classifier.** Classifies prompts as single-file, multi-file, or architectural before execution. Oversized requests are flagged early. Blast radius is estimated and attached to the receipt.

**Loqui conversational reasoning.** Ask questions about the repo, plan changes before committing, resume failed runs, or get dry-run previews — all through the same input. Intent classification happens server-side.

**Vision self-check.** Post-build screenshot analysis catches visual regressions that type checks miss. Optional, runs only when `AEDIS_VISION=true`.

**Portum universal fallback.** Never stuck on one provider. The fallback chain tries the next provider on timeout or error, with per-run blacklisting so a flaky provider doesn't slow down every task.

**Human-readable receipts.** Every run produces a structured receipt with: classification, headline, confidence breakdown (planning/execution/verification), blast radius, cost, file list, failure explanation, and next steps. The UI renders this — users never read logs.

## Quick Start

```bash
git clone https://github.com/RootZ3n/aedis
cd aedis
cp .env.example .env
npm ci
npm run build
npm run start:dist
```

Open [http://localhost:18796](http://localhost:18796).

Type a prompt. Watch the worker grid light up. Read the receipt.

## API

```bash
# Submit a build task
curl -X POST http://localhost:18796/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "add error handling to server/index.ts", "repoPath": "/path/to/repo"}'

# Ask Loqui a question
curl -X POST http://localhost:18796/tasks/loqui/unified \
  -H 'Content-Type: application/json' \
  -d '{"input": "what does the merge gate do?", "repoPath": "/path/to/repo"}'

# Dry run (no execution)
curl -X POST http://localhost:18796/tasks/dry-run \
  -H 'Content-Type: application/json' \
  -d '{"input": "refactor the context gate", "repoPath": "/path/to/repo"}'
```

WebSocket at `ws://localhost:18796/ws` for live events. Send `{"type":"subscribe","runId":"..."}` after connect.

## Stack

TypeScript. Fastify. WebSocket. No framework. No ORM. No build step beyond `tsc`.

Models: per-repo selection via `.aedis/model-config.json` with declarative `chain[]` fallbacks. The default in-repo configuration is `xiaomi/mimo-v2.5` on OpenRouter for hot-path roles, with the local Portum gateway as the universal last-resort. Qwen 3.5 4B (local via Ollama) for prompt normalization. See `DOCTRINE.md` "Model Assignments" for the full picture, including the no-Anthropic-in-hot-path rule.

## Status

Active development. Running in production on TypeScript monorepos. Building itself for $0.024 per task.

---

*Built by [Zen](https://github.com/RootZ3n). Governed by design.*
