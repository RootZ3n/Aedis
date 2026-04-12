# Human-Readable Execution + Trust Layer v1

## Why

Aedis was already a governed build system with receipts, trust routing, and audit trails before this phase. What it wasn't was *legible*. A user could stare at a successful run and not know what changed, how risky it was, or how confident Aedis actually was in its work. A failed run surfaced a stack trace, not a reason.

Trust Layer v1 turns the raw receipt data into a user-facing story: classification, blast radius, confidence, failure explanation, cost. Every field is grounded in the `RunReceipt` the Coordinator already populates — nothing new is asked of workers, and the coordinator pipeline is untouched. The layer is purely additive.

## What lands on the receipt

Every `RunReceipt` now carries two new fields:

```ts
interface RunReceipt {
  // ... all pre-existing fields unchanged ...
  readonly humanSummary: RunSummary | null;
  readonly blastRadius: BlastRadiusEstimate | null;
}
```

`humanSummary` is the composed story. `blastRadius` is the planning-time estimate, captured before execution so the UI can render it as a projected-risk chip the moment the intent locks.

```ts
interface RunSummary {
  classification: "VERIFIED_SUCCESS" | "PARTIAL_SUCCESS" | "NO_OP" | "FAILED";
  classificationReason: string;
  classificationReasonCode: string;
  headline: string;            // one-sentence product-tone summary
  narrative: string;           // full paragraph, same tone
  whatWasAttempted: string;    // original user prompt
  whatChanged: FileChangeSummary[];
  filesTouchedCount: number;
  verification: "pass" | "fail" | "pass-with-warnings" | "not-run";
  blastRadius: BlastRadiusEstimate;
  confidence: ConfidenceBreakdown;
  cost: RunCostSummary;
  failureExplanation: FailureExplanation | null;
  factors: string[];           // classifier audit trail
}
```

## The modules (all additive, all pure functions)

### `core/execution-classification.ts`

Maps a `RunReceipt` to one of four classifications with a reason and a factor list:

- **VERIFIED_SUCCESS** — success verdict + executionVerified=true + verification clean.
- **PARTIAL_SUCCESS** — partial verdict + executionVerified=true; e.g. pass-with-warnings, advisory findings, failed nodes but real evidence.
- **NO_OP** — the execution gate blocked the run as a no-op (includes the empty-graph special case) *or* a regression slipped an unverified success through (defensive — forced to NO_OP instead of letting it pass).
- **FAILED** — aborted, thrown error, verification fail, merge block.

The rule list is explicit and ordered; every decision returns the specific rule code (`gate-no-op`, `merge-blocked`, `verification-fail`, `unverified-verdict`, ...) so the UI can show audit info on hover.

### `core/blast-radius.ts`

Wraps the numeric `ScopeClassification.blastRadius` (already computed in `scope-classifier.ts`) into a three-bucket level — low / medium / high — with:

- `estimatedFiles` — best-guess file count, from charterTargets or projected from the raw score
- `scopeType` — passed through from the classifier
- `rationale` — one-line plain-English explanation
- `signals[]` — which rules contributed (`destructive-verb`, `security-sensitive`, `decompose-recommended`, ...)

Level picker: architectural/migration scopes are always `high`; destructive verb + security-sensitive prompt is `high` even at low raw score; raw score ≥10 is `high`; ≥4 or `recommendDecompose` is `medium`; otherwise `low`.

### `core/confidence-scoring.ts`

Produces a `ConfidenceBreakdown` with four scores:

- `planning` — scored from scope type (single-file 0.9, multi-file 0.7, architectural 0.4, migration 0.35) with a -0.1 penalty when the planner wants to decompose.
- `execution` — 0 when the gate did not verify; otherwise 0.75 base + bonuses for ≥3 evidence items, a real commit SHA, and worker confidence; minus 0.15 per failed graph node.
- `verification` — 0.6 + 0.4·pipelineConfidence on pass; 0.5 + 0.25·pipelineConfidence on pass-with-warnings; 0.05 on fail; 0.25 when verification was not run.
- `overall` — `0.2·planning + 0.35·execution + 0.45·verification`. Verification carries the most weight because it is the gate that tests whether the changes work.

Every score carries a `basis[]` list showing the exact contributions that built it, so hover tooltips in the UI can explain *why* a run came in at 86% vs 53%.

### `core/failure-explainer.ts`

Rule-based pattern matcher over failure signals in the receipt. Returns `{ code, stage, rootCause, suggestedFix, evidence }`. Covers:

- empty graph → "rephrase to name a file, or ask for a plan first"
- ENOENT / EACCES / EEXIST on the gate-error path → filesystem-specific fix
- API key / 401 / 403 → "check ANTHROPIC_API_KEY / OPENROUTER_API_KEY"
- provider timeout → "switch to fallback model or retry"
- merge blocker mentioning typecheck → "run `npx tsc --noEmit`"
- merge blocker mentioning lint → "run the linter locally"
- merge blocker mentioning invariant/coherence → "inspect the integration judge report"
- verification failure → matches typecheck / failing test variants
- generic failed nodes → "open the worker grid, inspect the failed node"
- aborted → "re-submit when ready"
- fallback → "check the worker grid / Lumen log; if nothing is visible, try a tighter scope"

Every branch returns both a root cause *and* a concrete next step — the user never sees "it failed" in isolation.

### `core/run-summary.ts`

Composes everything above into a `RunSummary` and builds the headline + narrative in the product brief's tone:

- VERIFIED_SUCCESS: "Aedis updated 3 files and all changes passed verification. Confidence: 86%. (abc12345)."
- PARTIAL_SUCCESS: "Aedis updated 3 files but some checks raised warnings. Confidence: 62%."
- NO_OP: "Aedis did not change any files. Confidence: 25%."
- FAILED: "Aedis failed to complete the task. Confidence: 12%."

The narrative adds a short paragraph with the change list, verification outcome, blast radius, cost, and — on any non-VERIFIED_SUCCESS — the failure explainer's root cause and suggested fix.

## Integration points

### Coordinator (`core/coordinator.ts`)

Three small additive changes, no pipeline refactor:

1. **Phase 1b — blast radius estimate.** Right after `classifyScope`, compute `estimateBlastRadius(...)`, log it, and emit a `blast_radius_estimated` event. Attached to `ActiveRun.blastRadius` so `buildReceipt` can forward it.

2. **ActiveRun state.** Two new fields: `rawUserPrompt` (for the summary's "what was attempted" line) and `blastRadius` (pass-through).

3. **buildReceipt composition.** After the existing receipt shape is built, call `generateRunSummary` on it and attach the result as `humanSummary`. The summary reads receipt fields exclusively, so the receipt remains the single source of truth.

4. **Event emission.** A new private `emitRunSummary(runId, receipt)` fires `run_summary` alongside `execution_verified` / `execution_failed`, right before `run_complete`. The `run_complete` payload gains a `classification` field so the UI can still render legible state if it misses the dedicated `run_summary` event for any reason.

Total coordinator diff: ~100 lines, all additive. No worker contract change. No refactor of `determineVerdict`, `executeGraph`, or `dispatchNode`.

### Events (`server/websocket.ts`)

Two new event types:

- `blast_radius_estimated` — payload carries level, scope type, estimated files, raw score, decompose recommendation, rationale, signals. Emitted once per run, right after scope classification.
- `run_summary` — payload carries the full RunSummary. Emitted once per run, at the terminal transition, just before `run_complete`.

### UI (`ui/index.html`)

One new panel, one new renderer, two new event handlers, no layout redesign:

- **Trust Summary panel** — full-width, sits between the Task Graph / Lumen row and Run History. Hidden until `blast_radius_estimated` or `run_summary` fires. Renders:
  - classification chip (VERIFIED_SUCCESS / PARTIAL_SUCCESS / NO_OP / FAILED), color-coded
  - narrative paragraph in the product's brief tone
  - five metric tiles: files touched, verification, blast radius, cost, confidence (with a progress-meter bar)
  - changes preview (first 5 `op:path` entries)
  - on non-VERIFIED_SUCCESS: a dashed red card with root cause + suggested fix
- **`blast_radius_estimated` handler** — populates `state.active.blastRadius` and drops a Lumen line with the projected level + rationale.
- **`run_summary` handler** — populates `state.active.runSummary` and drops a big Lumen line with the classification icon and headline. The Lumen log and the Trust Summary panel are fed from the same source of truth.

The old `run_complete` handler is unchanged — it still defers to `execution_verified` / `execution_failed` when present, and now also defers to `run_summary` because that event fires before it.

## Grounding discipline

Every field on `RunSummary` traces to a field on `RunReceipt` the Coordinator already populated *before* this phase:

| Summary field | Grounded in |
|---|---|
| `classification` | `verdict`, `executionVerified`, `executionGateReason`, `verificationReceipt.verdict`, `mergeDecision.action`, `graphSummary.totalNodes` |
| `whatChanged` | `executionEvidence[]` (file_* kinds) + `executionReceipts[].filesTouched` |
| `filesTouchedCount` | count of the above |
| `verification` | `verificationReceipt.verdict` |
| `blastRadius` | `scopeClassification` + `charter.deliverables.length` + prompt text |
| `confidence.planning` | `scopeClassification.type` + `recommendDecompose` |
| `confidence.execution` | `executionVerified` + `executionEvidence.length` + `commitSha` + `graphSummary.failed` + average worker confidence |
| `confidence.verification` | `verificationReceipt.verdict` + `verificationReceipt.confidenceScore` |
| `cost` | `totalCost` |
| `failureExplanation` | `executionGateReason` + `mergeDecision.primaryBlockReason` + `verificationReceipt.blockers` + `verificationReceipt.summary` |
| `headline` / `narrative` | assembled from all of the above |

Nothing is invented. There is no second LLM call, no ad-hoc state, and no worker contract change.

## What didn't change

- **Coordinator pipeline** — same phases, same gates, same dispatch logic. The trust layer hooks in at scope-classification time (blast radius) and at receipt-build time (summary).
- **Worker contract** — `WorkerResult` is unchanged. The optional `executionReceipt` field added in Execution Truth Enforcement v1 is still optional.
- **Execution Truth Enforcement v1** — untouched. The gate still forces verdict overrides and emits `execution_verified` / `execution_failed`. The trust layer reads the gate's output, does not bypass it.
- **Unified Loqui routing** — untouched. The summary is invoked for any build (including builds submitted from Loqui) because it hooks in at the Coordinator layer, below the router.
- **Legacy endpoints** — `POST /tasks`, `POST /tasks/loqui`, `POST /tasks/loqui/unified` all work unchanged. None of them need to know about the summary — it rides on the receipt and the event stream.

## Tests

`core/run-summary.test.ts` — 29 tests covering:

- **Classification rules** — VERIFIED_SUCCESS, PARTIAL_SUCCESS, NO_OP (gate + empty-graph), FAILED (gate errored, verification fail, merge blocked, aborted), and the defensive `unverified-verdict` regression check.
- **Blast radius** — single-file → low, multi-file → medium, architectural → high, destructive+security → high at low raw score, rationale is plain English.
- **Confidence** — verified success → high, unverified → execution=0, failed verification tanks overall, basis has per-stage explanations.
- **Failure explainer** — empty graph, ENOENT, EACCES, API key missing, merge blocker typecheck, gate no-op, aborted.
- **Composed summary** — verified success headline in the brief's tone, no-op headline that does NOT claim success, failed run attaches a failure explanation with root cause + suggested fix, cost is rendered as a display-friendly dollar string.

Full suite: **72 tests pass** (27 Loqui + 4 memory + 10 execution-gate + 2 coordinator + 29 run-summary). `tsc --noEmit` clean.

## Success criterion

A user can now look at a run and immediately understand what happened, what changed, whether it worked, and how risky it was — from the Trust Summary panel alone, without reading logs. Every piece is inspectable, every classification carries its factor list, every confidence score carries its basis, and every failure carries a concrete fix.
