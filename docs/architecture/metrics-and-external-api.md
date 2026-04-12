# Metrics + External API Layer v1

## Why

External systems (Squidley being the first) need to inspect Aedis without touching its internals. Before this phase there was no way to ask "how is Aedis doing?" without subscribing to the WebSocket event stream and reconstructing the state yourself. This phase adds four read-only HTTP endpoints that project the tracked-run registry into stable, documented shapes.

All four endpoints are grounded in data Aedis already populates: `TrackedRun.receipt` (the `RunReceipt` written by the Coordinator) and the fields the Human-Readable Execution + Trust Layer v1 attaches to it. Nothing new is computed at request time. Nothing is stored. Every response is a fresh projection of the current in-memory registry.

## Endpoints

### `GET /metrics`

Aggregate snapshot across every tracked run.

```jsonc
{
  "totalRuns": 12,
  "successfulRuns": 8,        // classification === "VERIFIED_SUCCESS"
  "failedRuns": 2,            // classification === "FAILED" (or aborted)
  "partialRuns": 1,           // classification === "PARTIAL_SUCCESS"
  "noOpRuns": 1,              // classification === "NO_OP"
  "inFlightRuns": 0,          // no terminal receipt yet
  "successRate": 0.6667,      // successful / terminalRuns (excludes inFlight)
  "totalCostUsd": 1.245,
  "avgCostPerRunUsd": 0.113,
  "avgFilesTouched": 3.25,
  "avgConfidence": 0.72,
  "lastRunSummary": {
    "taskId": "task_abc12345",
    "runId": "run_xyz…",
    "classification": "VERIFIED_SUCCESS",
    "headline": "Aedis updated 3 files and all changes passed verification. Confidence: 86%.",
    "confidence": 0.86,
    "filesTouched": 3,
    "costUsd": 0.0342,
    "verdict": "success",
    "submittedAt": "…",
    "completedAt": "…",
    "executionVerified": true
  },
  "generatedAt": "2026-04-11T18:10:00.000Z"
}
```

Discipline notes:
- `successRate` excludes `inFlightRuns` from the denominator so an idle queue doesn't dilute the number.
- `avgCostPerRunUsd` / `avgFilesTouched` / `avgConfidence` are computed over runs that have a receipt with the respective field. Empty queues return `0` rather than `NaN`.
- `lastRunSummary` is the newest tracked run (sorted by `submittedAt` desc, computed once when `getAllTrackedRuns()` is called).
- Every numeric field is rounded to 2 / 4 / 6 decimal places so JSON output is stable.

### `GET /runs`

Recent tracked runs, newest first.

```jsonc
{
  "runs": [
    {
      "id": "task_abc12345",
      "runId": "run_xyz…",
      "status": "complete",
      "classification": "VERIFIED_SUCCESS",
      "summary": "Aedis updated 3 files and all changes passed verification. Confidence: 86%.",
      "costUsd": 0.0342,
      "filesTouched": 3,
      "confidence": 0.86,
      "timestamp": "…",
      "completedAt": "…",
      "executionVerified": true
    }
    // … up to `limit` items, default 20, max 100
  ],
  "total": 1,
  "source": "tracked-runs"
}
```

Query params:
- `limit` — max items to return (default 20, capped at 100)
- `status` — filter by tracked status or by classification (e.g. `complete`, `failed`, `VERIFIED_SUCCESS`, `NO_OP`)

**Backwards compat:** when the tracked-run registry is empty (fresh boot, tests), the route falls back to the pre-v1 event-bus projection and sets `"source": "event-bus"`. Existing clients that read the legacy shape continue to work.

### `GET /runs/:id`

Full run detail. Accepts either `task_id` or `runId`.

```jsonc
{
  "id": "task_abc12345",
  "runId": "run_xyz…",
  "status": "complete",
  "prompt": "build a capability registry",
  "submittedAt": "…",
  "completedAt": "…",
  "receipt": { /* full RunReceipt with humanSummary, executionEvidence, etc. */ },
  "filesChanged": [
    { "path": "core/capability-registry.ts", "operation": "create" },
    { "path": "core/index.ts", "operation": "modify" }
  ],
  "summary": {
    "classification": "VERIFIED_SUCCESS",
    "headline": "Aedis updated 3 files …",
    "narrative": "Aedis created core/capability-registry.ts, modified core/index.ts …",
    "verification": "pass"
  },
  "confidence": {
    "overall": 0.86,
    "planning": 0.9,
    "execution": 0.88,
    "verification": 0.94
  },
  "errors": [
    // empty for verified success; populated for FAILED / NO_OP / PARTIAL with
    // { source: stage, message: rootCause, suggestedFix }
  ],
  "executionVerified": true,
  "executionGateReason": "Execution verified: 2 file(s) modified, 1 file(s) created",
  "blastRadius": { "level": "low", "estimatedFiles": 3, "rationale": "~3 file(s) · …" },
  "totalCostUsd": 0.0342,
  "source": "tracked-runs"
}
```

**Backwards compat:** when `id` matches neither a tracked task_id nor a tracked runId, the route falls back to the pre-v1 active-run probe, then to the event-bus history. The legacy active-run and event-bus response shapes are unchanged.

### `GET /loqui?question=&repoPath=`

Lightweight GET variant of `POST /tasks/loqui`. Returns a grounded answer plus the list of repo files the project-memory + gated-context layer flagged as relevant.

```jsonc
{
  "answer": "The auth entry point is server/middleware/auth.ts, which …",
  "confidence": 0.75,
  "relatedFiles": ["server/middleware/auth.ts", "core/intent.ts"],
  "reason": "base:0.40 for any produced answer · grounding: +0.20 for 2 related file(s) · language known (typescript): +0.05"
}
```

Confidence heuristic (deliberately simple, every contribution exposed via `reason`):

- **0.40** baseline for any produced answer
- **+0.10 per related file**, capped at +0.40
- **+0.05** when the project memory has a known language
- **-0.50** when the answer looks like a Loqui error string (`Loqui: …error/could not/HTTP/empty/not set`)

Final value clamped to `[0, 1]` and rounded to 2 decimals.

Grounding: `relatedFiles` comes from the same `loadMemory` → `gateContext` path the Coordinator uses at plan time — so "what does Loqui think is relevant to this question" matches "what Aedis would include in context if this were a real build."

## Grounding discipline

Every field on every response traces to a `RunReceipt` field the Coordinator already populated:

| Response field | Grounded in |
|---|---|
| `classification` | `receipt.humanSummary.classification` |
| `summary` / `headline` / `narrative` | `receipt.humanSummary.headline` / `narrative` |
| `filesChanged` | `receipt.humanSummary.whatChanged` with fallback to `receipt.executionEvidence` (file_* kinds) |
| `confidence` | `receipt.humanSummary.confidence` |
| `errors` | `receipt.humanSummary.failureExplanation` + `tracked.error` |
| `executionVerified` / `executionGateReason` | `receipt.executionVerified` / `receipt.executionGateReason` |
| `blastRadius` | `receipt.humanSummary.blastRadius` with fallback to `receipt.blastRadius` |
| `costUsd` / `totalCostUsd` | `receipt.totalCost.estimatedCostUsd` |
| `successRate` | counts of `humanSummary.classification` === VERIFIED_SUCCESS |
| `lastRunSummary` | the newest entry in `getAllTrackedRuns()` |
| `relatedFiles` (loqui) | `gateContext(loadMemory(repoPath), question).relevantFiles` |

The only dry-run-specific logic in this layer is the `GET /loqui` confidence heuristic — which is a deliberate, inspectable projection over pre-existing signals, not a new state machine.

## Integration points

### `core/metrics.ts` (new, pure functions)

- `computeMetrics(runs, now?)` — aggregates a `TrackedRunLike[]` into a `MetricsSnapshot`.
- `projectRunList(runs, limit)` — projects a registry into list items.
- `projectRunDetail(run)` — projects a single tracked run into the detail shape.
- `TrackedRunLike` — typed locally so the module has no Fastify or server dependency. The route handlers pass the real `TrackedRun[]` through with a cast; the two shapes are compatible.

### `core/metrics.test.ts` (new, 11 tests)

- **Aggregation**: empty registry → zeroed snapshot; single verified success → `successRate = 1`; mixed verified / failed / in-flight → correct averages with in-flight excluded from the denominator; no-op and partial are NOT counted as successful; `lastRunSummary` reflects the newest run.
- **List projection**: returns lightweight list items grounded in receipts; respects the `limit`.
- **Detail projection**: verified success exposes receipts + files + summary + confidence; failed run surfaces errors with a `suggestedFix`; in-flight run (no receipt) returns a legible skeleton; missing run returns `null`.

### `server/routes/tasks.ts` (additive)

- Added `getAllTrackedRuns()` export. Returns a newest-first snapshot of the tracked-run registry so external routes can read without touching the private Map or creating a second source of truth.
- Exported the `TrackedRun` type so the metrics module and other routes can type-check against it.

### `server/routes/runs.ts` (additive)

- `GET /runs` — now prefers the tracked-run registry and projects via `projectRunList`. Falls back to the pre-v1 event-bus projection when the registry is empty. Response carries a new `source: "tracked-runs" | "event-bus"` field so callers can tell which path produced it.
- `GET /runs/:id` — now checks the tracked-run registry first (by `task_id` or by `runId`). Falls back to the active-run probe, then to the event-bus history. The existing active-run and event-bus shapes are unchanged.

### `server/routes/metrics.ts` (new)

Thin Fastify handler. One route: `GET /`. Delegates all aggregation to `computeMetrics()`.

### `server/routes/loqui.ts` (new)

Thin Fastify handler. One route: `GET /?question=&repoPath=`. Validates the query params, probes the repoPath for existence, loads memory + gated context, calls `askLoqui`, then composes the response with the confidence heuristic.

### `server/index.ts` (additive)

Two new `server.register` calls:
```ts
await server.register(metricsRoutes, { prefix: "/metrics" });
await server.register(loquiRoutes, { prefix: "/loqui" });
```

No other server changes. All existing routes (`/tasks`, `/runs`, `/workers`, `/health`, `/config`, `/ws`) are untouched.

## What didn't change

- **Coordinator pipeline** — untouched. The external API is a pure read layer.
- **Worker contract** — untouched.
- **Execution Truth Enforcement v1** — untouched. The API reports whatever the execution gate produced; it never bypasses or overrides.
- **Existing routes** — `POST /tasks`, `POST /tasks/loqui`, `POST /tasks/loqui/unified`, `POST /tasks/dry-run`, `GET /tasks/:id`, `GET /tasks/:id/receipts` all continue to work unchanged. The new `GET /runs` and `GET /runs/:id` carry a `source` field that legacy clients can ignore.
- **Authentication** — unchanged. The external API rides under the same Tailscale auth (or local dev disable) that the rest of the routes use.

## Tests

Full suite: **101 tests pass. `tsc --noEmit` clean.**

End-to-end smoke tests (scratch scripts, not checked in):

1. **Empty-registry** — booted the full server with `createServer`, hit `GET /metrics` (got zeroed snapshot), hit `GET /runs` (fell back to event-bus), hit `GET /loqui` (got `{ answer, confidence: 0.45, relatedFiles: [] }` — the OpenRouter call failed without an API key, the confidence heuristic correctly penalized the error-shaped answer).

2. **Populated-registry** — built a minimal Fastify instance with `tasks`, `runs`, and `metrics` routes plus a mock Coordinator that returns a canned verified-success receipt. `POST /tasks` → 202 → registered. `GET /metrics` → `totalRuns: 1, successful: 1, successRate: 1, totalCost: 0.05, lastRunSummary.classification: VERIFIED_SUCCESS`. `GET /runs` → `source: "tracked-runs"`, first run carries classification + summary headline + cost. `GET /runs/:id` → `source: "tracked-runs"`, classification + files: 2 + confidence: 0.88.

## Success criterion

From the brief: *"External systems (Squidley) can inspect Aedis, understand performance, retrieve results, and ask repo questions without touching internal code."*

Squidley can now:

- `curl $AEDIS/metrics` → get a grounded snapshot of how Aedis is doing.
- `curl $AEDIS/runs?limit=20` → get the last N runs with full human summaries.
- `curl $AEDIS/runs/<task_id>` → get the full detail including files changed, confidence, errors.
- `curl "$AEDIS/loqui?question=what+handles+auth&repoPath=/repo"` → ask a repo question grounded in project memory.

No WebSocket subscription required. No internal imports required. No schema contortions — everything is documented, stable, and backwards-compatible.
