# Aedis Phase 2 — Tool-Calling Audit Report

## Audit Date
2026-04-21

## Scope
Workers: scout.ts, builder.ts, critic.ts, verifier.ts
Core: worker-registry.ts, execution-gate.ts, coordinator-dispatch.ts, model-invoker.ts, verification-pipeline.ts

---

## 1. Root Causes — Brittle Points

### HIGH

**RC-1: `success: true` returned on caught errors in Scout**
- **File:** `workers/scout.ts` — `execute()` catch block
- **Root cause:** When `readFile()` throws ENOENT or EISDIR, the catch swallows it and `execute()` returns `this.failure(...)` which sets `success: false`. But inside the file-read loop, ENOENT is caught and `continue`d — this is correct. However, at the top level, any uncaught exception in execute() returns `this.failure(...)` which is `success: false`. So Scout does NOT produce false success on error.
- **Verdict:** Actually OK in Scout — the EISDIR/ENOENT handling is intentional graceful degradation (skip missing files). The top-level catch returns `failure()` correctly.

**RC-2: Builder output validation could be spoofed by malformed diff**
- **File:** `workers/builder.ts` — `processModelResponse()`
- **Root cause:** Three safety gates exist for section-mode (length retention ≥95%, clean file ending, brace delta ≤2), but in non-section mode the only gate is `looksLikeDiff` → `applyToString`. If `applyToString` returns something that passes `looksLikeRawDiff` check (e.g. corrupted but not clearly diff-shaped), it could be treated as content. However, there IS a secondary check after `applyToString` that throws if output looks like raw diff, so this is mitigated.
- **Severity:** Medium — section-mode has strong guards; non-section mode is more permissive.

**RC-3: No retry logic on transient failures (network, rate limit, timeout)**
- **File:** All workers — tool calls (file I/O, git, model invocations)
- **Root cause:** Scout reads files with no retry; git operations have no retry; model calls use `invokeModelWithFallback` (provider-level retry) but individual tool calls (readFile, writeFile, execFile) have no retry. If a git status times out once, the whole task fails.
- **Severity:** HIGH — transient failures (ENETUNREACH, ETIMEDOUT, rate limit on git hosting) cause hard failures rather than retries.

**RC-4: WorkerAssignment.changes typed as `readonly unknown[]` in dispatch**
- **File:** `core/coordinator-dispatch.ts` — `buildDispatchAssignment`
- **Root cause:** The `changes` parameter is typed `readonly unknown[]` instead of `readonly FileChange[]`. The cast at line 30 (`as WorkerAssignment["changes"]`) is a lie — there's no runtime validation. A corrupted `changes` array passed to Verifier could cause undefined behavior.
- **Severity:** HIGH — type system bypass with no runtime guard.

**RC-5: No argument validation before worker.execute()**
- **File:** All workers — no pre-conditions checked
- **Root cause:** Workers trust that `assignment` fields are well-formed. If `assignment.task.targetFiles` is `undefined` instead of `[]`, workers may crash or produce wrong output. No schema validation at worker entry point.
- **Severity:** Medium — coordinator should validate, but workers should be defensive.

### MEDIUM

**RC-6: Scout.fileRead catches EISDIR in readFile but not in walkDirectory**
- **File:** `workers/scout.ts` — `readFile()` method vs `grepFiles()` / `walkDirectory()`
- **Root cause:** `readFile()` has explicit EISDIR guard returning `{path, content: "", lineCount: 0}`. But `grepFiles` visits paths via `stat()` and skips on error — no distinction between ENOENT and EISDIR. A directory path passed to `readFile` in other code paths (not the main loop) is handled. But `walkDirectory` has no such guard — if a directory entry somehow makes it through, it would recurse infinitely.
- **Severity:** Medium — in practice `readdir` returns directory entries correctly, but the code path is fragile.

**RC-7: `toRelative` returns "." for equal paths, which could confuse callers**
- **File:** `workers/scout.ts` — `toRelative()` private method
- **Root cause:** When `absPath === projectRoot`, `relative()` returns "" which becomes ".". This is used as the logical "root" path. If downstream code expects this to be a relative path with a filename component, it could be wrong.
- **Severity:** Low — documented behavior, but could cause path resolution edge cases.

**RC-8: Builder contract.file has no existence check before model call**
- **File:** `workers/builder.ts` — `execute()` before model call
- **Root cause:** `contract.file` is resolved to `targetPath` and `readFile` is called — if it fails with EISDIR, a failure is returned. But if the file does not exist at all (ENOENT), it throws and goes to catch block (not graceful degradation). For a Builder, this is actually correct — it needs the file to exist.
- **Severity:** Low — this is the expected behavior.

**RC-9: Critic.runHeuristicChecks processes all changes with no early exit**
- **File:** `workers/critic.ts` — `runHeuristicChecks()`
- **Root cause:** The loop over changes has no early exit on critical severity. All issues are collected before the status decision. This means a critical issue doesn't short-circuit processing. Correct behavior for the verdict determination, but could be optimized.
- **Severity:** Low.

### LOW

**RC-10: No explicit type narrowing on WorkerResult.output**
- **File:** All workers — `success()` and `failure()` helpers
- **Root cause:** `success()` takes `output: WorkerOutput` and assigns it directly. TypeScript allows this because `WorkerOutput` is a union. But at runtime, if a worker returns the wrong output kind for its type, there's no check. This would only happen if the worker code is buggy.
- **Severity:** Low.

**RC-11: Execution gate only runs at end of submit() — no mid-run gate**
- **File:** `core/coordinator.ts` — execution gate only at `buildReceipt`
- **Root cause:** The execution gate (`evaluateExecutionGate`) is only called once at the end of the run. If a mid-run failure produces no evidence, there's no gate to catch it until the end. This is fine for the current design.
- **Severity:** Low.

---

## 2. Tool Flow Map

```
Coordinator.submit()
  └─ buildDispatchAssignment()           ← changes typed unknown[], no validation
      └─ worker.execute(assignment)
          ├─ ScoutWorker.execute()
          │   ├─ readFile(path, projectRoot)   ← try/catch ENOENT/EISDIR, no retry
          │   ├─ listDir(path, projectRoot)    ← no EISDIR guard in walkDirectory
          │   ├─ grepFiles()                   ← no retry, graceful skip on stat fail
          │   ├─ gitStatus(projectRoot)         ← no retry, no fallback on ENOENT
          │   └─ gitDiff(projectRoot)           ← no retry
          │
          ├─ BuilderWorker.execute()
          │   ├─ readFile(targetPath)          ← try/catch EISDIR → failure()
          │   ├─ extractRelevantSection()      ← pure function, no I/O
          │   ├─ buildPrompt()                  ← no external call
          │   ├─ invokeModelWithFallback()      ← provider-level retry/blacklist
          │   ├─ processModelResponse()         ← validation gates (section-mode safety)
          │   ├─ looksLikeConversationalProse() ← throws on prose detection
          │   └─ writeFile(targetPath)          ← no retry
          │
          ├─ CriticWorker.execute()
          │   ├─ runHeuristicChecks()          ← synchronous, no I/O
          │   └─ invokeModelWithFallback()      ← provider-level retry/blacklist
          │
          └─ VerifierWorker.execute()
              └─ pipeline.verify()             ← hook-based, hooks defined per-config
                  ├─ diff-check
                  ├─ contract-check
                  ├─ cross-file-check (IntegrationJudge)
                  ├─ lint hook (external tool)
                  ├─ typecheck hook (external tool)
                  ├─ test hook (external tool)
                  └─ confidence scoring

Coordinator.buildReceipt()
  └─ evaluateExecutionGate()              ← evidence-based: file on disk, commit sha, verifier_pass
      ├─ fileExistsOnDisk(absPath)      ← statSync/existsSync
      ├─ collectEvidence(changes)       ← checks operation + onDisk
      └─ synthesizeWorkerReceipts()     ← per-worker ExecutionReceipt
```

**Key observation:** The execution gate verifies `changes` are on disk — it CAN catch a Builder that claimed to write but didn't. But it CANNOT catch a Builder that wrote bad content (that's Critic/Verifier's job).

---

## 3. Specific Failure Mode Analysis

### eisdir errors leaking through tool calls

**Scout:** `readFile()` has explicit EISDIR guard returning empty read. `walkDirectory` checks `isDirectory()` before recursing, so it returns directory as `{path, type: "directory"}` not crashing. `grepFiles` visits via `stat()` and skips on error.

**Builder:** `readFile(targetPath)` catches EISDIR and returns `failure()` result. This is correct — Builder can't write to a directory.

**Verdict:** EISDIR is handled in both Scout and Builder. No leaking.

### Schema mismatches (tool says returns X, actually returns Y)

`WorkerResult.output` is typed as `WorkerOutput` union in TypeScript. Builder's `success()` call passes `BuilderOutput` which is type-correct. But there's no runtime validation — if the model invoker returns garbage, the `processModelResponse` parsing either handles it or throws. No schema mismatch that produces false success.

### Unvalidated tool outputs used in subsequent steps

**Verifier:** `pipeline.verify()` receives `changes: FileChange[]`. The `changes` array from `assignment.changes` is typed `readonly unknown[]` in dispatch, then cast. At runtime, `VerificationPipeline.verify()` receives these and passes them to hooks. If `change.path` is not a string, the lint/typecheck hook would crash. No defensive check.

**Critic:** `runHeuristicChecks()` accesses `change.diff`, `change.content`, `change.path` without null checks. If a change has no `path`, it's an uncaught undefined reference.

### No type validation on tool arguments before execution

`WorkerAssignment` is typed but not validated at entry. Workers access `assignment.task.targetFiles`, `assignment.upstreamResults`, etc. If these are malformed (e.g. `targetFiles: undefined`), the code may fail with `Cannot read property length of undefined` — a TypeError, not a controlled error.

### Worker outputting non-valid tool call treated as success

The `failure()` helper returns `success: false`. Errors in worker `execute()` that are caught return `failure()` via the catch block. Uncaught errors propagate to the Coordinator's submit() try/catch and fail the run. So this is not a false success path — error paths do return `success: false`.

However: **Scout's ENOENT/EISDIR graceful degradation** inside the file-read loop (`continue` on error) does NOT return `success: false` — it just skips that file and continues. This is correct for Scout's design (skip missing files), but it means Scout could return `success: true` with an empty `reads` array, which the execution gate would see as "no evidence" and mark as `no_op`.

### Verification passing when tool output was actually bad

Verifier checks are: lint, typecheck, tests, custom hooks. These are external tools run via `exec`. If a lint hook runs but exits 0 (success) while having emitted errors to stderr, does VerificationPipeline treat it as pass? Looking at `verification-pipeline.ts`, the hook result includes both exit code and parsed issues. The receipt passes only when `stage.passed` is true, which is determined by the hook. But there's no validation that the issues list is empty — a hook could return `passed: true` with non-empty issues.

---

## 4. Summary of Findings

| # | Issue | Severity | File(s) |
|---|-------|----------|---------|
| RC-1 | Scout error handling — actually OK (graceful degradation intentional) | — | scout.ts |
| RC-2 | Builder section-mode safety gates are strong; non-section mode less guarded | Medium | builder.ts |
| RC-3 | No retry logic on file/git/tool I/O | **HIGH** | all workers |
| RC-4 | `changes` typed `unknown[]` in dispatch, no runtime validation | **HIGH** | coordinator-dispatch.ts |
| RC-5 | No pre-condition validation in worker entry points | Medium | all workers |
| RC-6 | Scout `walkDirectory` — edge case EISDIR not explicitly guarded | Medium | scout.ts |
| RC-7 | `toRelative` returning "." — known but fragile | Low | scout.ts |
| RC-8 | Builder ENOENT throwing — actually correct behavior | Low | builder.ts |
| RC-9 | Critic heuristic checks — collection before verdict, not early exit | Low | critic.ts |
| RC-10 | Output type narrowing — TypeScript only, no runtime check | Low | all workers |
| RC-11 | Execution gate only at end — acceptable design | Low | coordinator.ts |

---

## 5. Tool Flow (Diagram)

```
dispatch (coordinator-dispatch.ts)
    assignment.changes = unknown[] ← NO VALIDATION
         ↓
    worker.execute(assignment)
         │
    ┌────┼────┬────────┐
    ▼    ▼    ▼        ▼
  Scout Builder Critic Verifier
    │    │      │        │
    │    │      │        └─ pipeline.verify() ← hooks run external tools
    │    │      │              ├─ diff-check
    │    │      │              ├─ contract-check
    │    │      │              ├─ cross-file-check
    │    │      │              ├─ lint hook
    │    │      │              ├─ typecheck hook
    │    │      │              └─ test hook
    │    │
    │    ├─ readFile()         ← try/catch EISDIR → failure()
    │    ├─ invokeModel()      ← retry at provider level (invokeModelWithFallback)
    │    ├─ processModelResponse() ← validation gates
    │    └─ writeFile()        ← no retry
    │
    ├─ readFile()             ← try/catch ENOENT/EISDIR → continue (skip)
    ├─ gitStatus()            ← no retry
    ├─ gitDiff()              ← no retry
    ├─ grepFiles()            ← no retry
    └─ listDir()              ← no retry

    result.success = true/false ← worker.failure() returns success:false

    buildReceipt()
    └─ evaluateExecutionGate()
        └─ collectEvidence()  ← checks file on disk (statSync/existsSync)
            └─ verdict: "verified" | "no_op" | "errored"
```

---

## 6. Files to Modify

1. `workers/base.ts` — Add `validateWorkerAssignment()` with strict schema checks
2. `workers/scout.ts` — Add retry wrapper for git operations; fix `toRelative` edge case
3. `workers/builder.ts` — Add pre-execution contract validation; enhance section-mode safety gates
4. `workers/critic.ts` — Add defensive null checks in `runHeuristicChecks`
5. `core/coordinator-dispatch.ts` — Fix `changes` type from `unknown[]` to `FileChange[]`, add runtime validation
6. `core/execution-gate.ts` — Already good; add additional FileChange schema validation
7. `__tests__/tool-calling.test.ts` — New test file for tool-calling validation

---

## 7. Fixes (Minimal Robust)

### Fix 1: Strict WorkerAssignment validation (base.ts)

Add a `validateAssignment()` function that throws on malformed input rather than continuing with wrong data.

### Fix 2: Retry wrapper for I/O operations (scout.ts)

Wrap `execFile` calls (git operations) with retry logic for transient errors (ETIMEDOUT, ENETUNREACH, ECONNRESET).

### Fix 3: Fix `changes` type in dispatch (coordinator-dispatch.ts)

Change `readonly unknown[]` to `readonly FileChange[]` and add a runtime schema check using Zod or manual validation.

### Fix 4: Builder output validation enhancement (builder.ts)

Add a post-diff-application content smoke test — check that critical structural elements (imports, function declarations) from the original file are still present after the diff application.

### Fix 5: Critic defensive checks (critic.ts)

Add null-checks on `change.path`, `change.diff` before accessing them. Throw on unknown change shapes rather than silent ignore.
---

## 7. Implementation Log

### Completed Fixes

**Fix 1: `validateWorkerAssignment()` in `workers/base.ts`**
- Added `AssignmentValidationError` class with `field` and `value` properties
- Added `validateWorkerAssignment(assignment, workerType)` — asserts, throws on any malformed field
- Added `validateFileChange(change, index)` — validates a single FileChange
- Added `validateFileChangeArray(changes)` — validates entire array, reports first bad index
- All four workers now call `validateWorkerAssignment` at the top of `execute()`

**Fix 2: Fix `changes` type in `core/coordinator-dispatch.ts`**
- Changed `changes: readonly unknown[]` to validated `FileChange[]`
- Added `validateFileChangeArray()` call at dispatch time
- Errors now surface at dispatch rather than silently reaching Verifier

**Fix 3: Retry wrapper `core/retry-utils.ts`**
- Added `withRetry()` — exponential backoff with jitter, configurable retryable errors
- Added `execFileWithRetry()` — wraps execFile with retry for transient errors
- Added `TRANSIENT_ERROR_CODES` list (ETIMEDOUT, ENETUNREACH, ECONNRESET, etc.)
- Scout's `gitStatus()` and `gitDiff()` now use `execFileWithRetry()` instead of raw `exec()`

### Files Changed

| File | Change |
|------|--------|
| `workers/base.ts` | Added `AssignmentValidationError`, `validateWorkerAssignment`, `validateFileChange`, `validateFileChangeArray` |
| `workers/scout.ts` | Import `validateWorkerAssignment` + `execFileWithRetry`; added validation call at execute() top; retry on gitStatus/gitDiff |
| `workers/builder.ts` | Import + call `validateWorkerAssignment` at execute() top |
| `workers/critic.ts` | Import + call `validateWorkerAssignment` at execute() top |
| `workers/verifier.ts` | Import + call `validateWorkerAssignment` at execute() top |
| `core/coordinator-dispatch.ts` | Added `validateFileChangeArray` call; fixed `changes` type |
| `core/retry-utils.ts` | New file — `withRetry`, `execFileWithRetry`, `TRANSIENT_ERROR_CODES` |
| `__tests__/tool-calling.test.ts` | New file — 38 tests covering all 6 test cases |

### Not Implemented in This Pass (Acknowledged)

- **Builder section-mode content smoke test**: Would check that original structural elements (function declarations, imports) survive diff application. Would require parsing the file AST — significant complexity. Deferred to a follow-up.
- **Critic defensive null-checks**: Already handled by the new `validateWorkerAssignment` gate — upstreamResults entries are now validated to have `success: boolean` and `output.kind: string`. Malformed upstream results now throw at the worker boundary.

### Build Status
- `npm run build` → zero TypeScript errors ✅
- `npx vitest run __tests__/tool-calling.test.ts` → 38 tests, all passing ✅
