# Persistent Receipts + Crash-Safe Audit Trail v1

## Lifecycle

Aedis now writes one durable JSON receipt per run under `state/receipts/runs/<runId>.json` and maintains a compact `state/receipts/index.json` for recent-run lookups.

The coordinator writes incrementally at these checkpoints:

- `run_started`: run file is created as soon as the `RunState` exists
- `planner_finished`: task graph and planning summary are persisted
- `worker_step`: worker start/completion/failure appends to the receipt
- `verification_result`: verification receipts are written as soon as they exist
- `failure_occurred`: merge blocks, cancellations, and other failures are recorded before final exit
- `run_completed`: final receipt, classification, confidence, and cost are written

Writes are atomic: the store writes a temp file and renames it into place. If the process dies mid-write, the previous committed JSON file remains intact.

## Crash Behavior

Runs that were still `RUNNING` when the server boots are reclassified to `CRASHED` during startup recovery. The receipt file is not deleted or replaced; it is updated in place with:

- `status: "CRASHED"`
- a completion timestamp
- a recovery error message
- a `startup_recovery` checkpoint

This means a mid-run crash still leaves:

- the run id on disk
- the last persisted phase/checkpoint
- any worker events already written
- the last known file/change/verification snapshot

The server and UI read from the persistent receipt index first, so run history after restart reflects durable receipt truth rather than only live process memory.
