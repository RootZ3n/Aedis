# Aedis Adversarial Stress Suite — Design Document

## Overview

25 tasks across bugfix, feature, refactor, extend, coverage, security, and perf categories.
Designed to **break Aedis**, not validate it. Targets weak spots in Scout context selection, Builder
diff generation, Critic review, and the classification pipeline.

---

## Test Design Philosophy

### What we're hunting

1. **Content-identity trap** — Builder echoes source, produces empty diff. Caught by classifier
   (`empty_diff`, `execution_unverified`). stress-23 is a deliberate trap: flipping `isEven`
   logic (same structure, different result) forces the model to actually change something.

2. **Phase 4 context filter brittleness** — The new multi-signal relevance scorer
   (`relevance-scorer.ts`) could over-filter or under-filter. Tasks with short or ambiguous
   prompts (stress-04, stress-13, stress-25) will reveal whether the scorer drops legitimate
   targets or admits noise.

3. **Classifier downgrade failures** — The `classifyResult` logic has specific pathways
   for downgrading `success` → `weak_success`:
   - `expectedFiles` not touched (line 219-227)
   - `minDiffLines` not met (line 228-236)
   - `verificationConfidence < 0.5` (line 237-241)

   If any pathway is broken or misordered, specific tasks will be misclassified.

4. **Multi-file coordination failures** — stress-08, stress-09, stress-10, stress-24 require
   the Builder to modify multiple files while maintaining import/export consistency. The
   Integrator must resolve cross-file dependencies correctly.

5. **Generic/weak prompts** — Stress-25 ("capitalize hello world") is deliberately ambiguous.
   The old Scout would match anything containing "capitalize" or "string". The new scorer
   should distinguish `src/utils.ts` from every other `.ts` file in the repo.

---

## Task Map — What Each Task Exposes

| ID | Type | Target Failure |
|----|------|----------------|
| stress-01 | bugfix | Off-by-one in recursive fib — tests algorithm understanding |
| stress-02 | bugfix | Empty string edge case — tests defensive coding awareness |
| stress-03 | bugfix | Exception → return value change — tests behavior-not-throwing awareness |
| stress-04 | bugfix | Return type mismatch (undefined vs null) — tests type precision |
| stress-05 | bugfix | Logic inversion bug (returns true when it should be false) |
| stress-06 | coverage | Missing test coverage for Stack — tests coverage gap detection |
| stress-07 | coverage | Missing tests for fibonacci — tests mathematical correctness |
| stress-08 | refactor | Multi-file extraction with re-exports — tests import graph maintenance |
| stress-09 | refactor | Single-function extraction — tests minimal refactor |
| stress-10 | refactor | Class extraction with generics — tests TypeScript generic handling |
| stress-11 | feature | Simple function addition — tests basic code generation |
| stress-12 | feature | Simple function (modulo) — tests algorithmic code gen |
| stress-13 | feature | Palindrome — tests string manipulation, moderate complexity |
| stress-14 | feature | String reverse — tests string manipulation, low complexity |
| stress-15 | extend | Extended divide with optional param — tests API extension discipline |
| stress-16 | extend | capitalize with locale — tests optional parameter handling |
| stress-17 | extend | Stack with maxSize — tests constructor extension, boundary logic |
| stress-18 | security | XSS sanitization — tests security-sensitive code generation |
| stress-19 | security | SQL injection escape — tests security-sensitive code gen |
| stress-20 | perf | Memoized fibonacci — tests optimization with algorithmic change |
| stress-21 | perf | Bitwise isEven — tests micro-optimization recognition |
| stress-22 | bugfix | Long string handling — tests edge case under load |
| stress-23 | bugfix | Content-identity trap — forces actual change (flip isEven) |
| stress-24 | feature | 3-file multi-target — tests wave planning / multi-file coordination |
| stress-25 | bugfix | Brittle/ambiguous prompt — tests Scout context filter precision |

---

## Anticipated Failure Patterns

### Pattern A: Empty Diff (content-identity)
**Likely tasks:** stress-23 (intentional trap), stress-22, any feature task where the model
"explains" the change rather than implementing it.

**Detection:** `outcome=failure, errorType=empty_diff`

**Root cause hypothesis:** Builder received wrong context (wrong file) or the model echoed
the prompt back without modification.

---

### Pattern B: Expected Files Not Touched
**Likely tasks:** stress-08 (math-utils extraction), stress-24 (multi-file), stress-09,
stress-10 — any refactor that creates a new file.

**Detection:** `outcome=weak_success, notes~="expected files not touched"`

**Root cause hypothesis:** Context gate didn't include the new file path in scope, or
Builder created the file but it wasn't included in `filesChanged` from execution evidence.

---

### Pattern C: Low Verification Confidence
**Likely tasks:** stress-18, stress-19 (security), stress-20 (perf — hard to verify
algorithm change was correct).

**Detection:** `outcome=weak_success, errorType=verification_low, notes~="verification confidence"`

**Root cause hypothesis:** Verification pipeline gave low confidence because no test
evidence exists for new security/perf functions, and the Verifier couldn't establish
correctness from static analysis alone.

---

### Pattern D: Scout Context Filter Dropping Target File
**Likely tasks:** stress-25 (ambiguous prompt), stress-13 (isPalindrome — "palindrome" might
not appear in existing files).

**Detection:** `outcome=failure, errorType=empty_diff` — no relevant files found.

**Root cause hypothesis:** Phase 4 relevance scorer scored the target file below threshold
because the prompt keyword ("palindrome") doesn't appear in any existing file's path.

---

### Pattern E: Multi-File Wave Ordering Failure
**Likely tasks:** stress-24 (3 files), stress-08 (2 files with import dependency).

**Detection:** `outcome=failure` or partial success with missing files.

**Root cause hypothesis:** Wave planning correctly ordered files but Integrator applied
them out of order, or Builder modified the wrong file first, breaking the import chain.

---

### Pattern F: Timeout / No Receipt
**Likely tasks:** stress-20 (fibonacci optimization — may cause long model thinking),
stress-22 (long string edge case).

**Detection:** `outcome=failure, errorType=timeout` or `errorType=unknown` with
`notes=["no receipt returned"]`

**Root cause hypothesis:** Model took > 20 minutes or the POST /tasks endpoint rejected
the task as ambiguous (stress-25).

---

## Classification Guide

| outcome | errorType | Meaning |
|---------|-----------|---------|
| success | none | Task completed as specified |
| weak_success | verification_low | Verification gave low confidence signal |
| weak_success | (none) | Partial implementation or expectedFiles missing |
| failure | empty_diff | Builder produced no disk changes (content-identity) |
| failure | execution_unverified | Execution gate rejected the work |
| failure | compile_fail | TypeScript compilation failed |
| failure | test_fail | Tests failed |
| failure | timeout | Task exceeded timeout |
| failure | runtime_exception | Runner or harness error |

---

## Running the Suite

```bash
# 1. Setup the fixture
#    This installs fixture dependencies if they are missing/stale,
#    then verifies `npm run typecheck` and `npm test`.
bash state/reliability/tasks/setup-stress-fixture.sh

# 2. Run against a running Aedis server
aedis reliability run state/reliability/tasks/stress-suite.json --label adversarial-v1

# 3. Inspect results
aedis reliability list
aedis reliability show <trial-id>

# 4. Diff against next run
aedis reliability diff <prev-trial-id> <curr-trial-id>

# 5. Via API
curl http://localhost:18796/reliability/trials/latest | jq .
```

The setup script is safe to re-run. It rewrites the fixture back to the
baseline contents, runs `npm install` only when the local install is missing
or out of date, and writes readiness status to
`/tmp/aedis-stress-fixture/.aedis/bootstrap-status.txt`.

---

## Interpreting Weak Success

`weak_success` is **intentional signal, not noise**. It means Aedis did work but
something was marginal:

- `verification_low`: The Verifier couldn't fully confirm correctness. For feature
  additions without existing tests, this is expected and acceptable.

- `expectedFiles not touched`: Aedis modified some files but missed the target.
  Investigate Scout's context — was the right file in scope?

**Weak success should NOT be treated as failure.** It is the harness telling you
"this worked but you should audit it." The CI gate only exits 2 on `failure`.

---

## What to Look For in the Regression Report

The `aedis reliability diff` output surfaces:

1. **Any `regression` (success→failure)** — Critical. Something that worked before
   now fails. Check if Phase 4 scorer, model invoker, or verification config changed.

2. **`degraded` (success→weak_success)** — Concerning. Quality dropped even if
   not a hard failure.

3. **`droppedTasks`** — New tasks in the current trial that didn't exist before.
   These are NOT regressions — they're new test coverage.

4. **`newTasks`** — Tasks from the previous trial that aren't in the current run.
   This means a task was removed from the suite — not a regression.

---

## Spot-Check Commands

```bash
# Check for empty diff failures across all trials
jq '[.results[] | select(.errorType=="empty_diff")]' state/reliability/trials/*.json

# Check for any execution_unverified
jq '[.results[] | select(.errorType=="execution_unverified")]' state/reliability/trials/*.json

# Get cost per success across all trials
jq '[.metrics.costPerSuccessUsd]' state/reliability/trials/*.json

# Find tasks that took longest
jq '[.results | sort_by(.durationMs) | reverse[] | {taskId, durationMs, costUsd}]' state/reliability/trials/*.json

# Check which tasks have highest iteration counts (Builder rework loops)
jq '[.results[] | select(.iterations > 1)]' state/reliability/trials/*.json
```
