# Aedis Test Harness Framework
> Version 1.0 — 2026-04-21
> Purpose: Repeatable evaluation of Aedis on real repositories without content-identity traps

---

## Core Principle

**No "rebuild from scratch" tests.** The content-identity trap (model echoes source → empty diff) produces misleading failures. Every test must require genuine modification, addition, or deletion of code.

---

## Test Matrix

### Category 1 — Bug Fix (`bugfix`)
**Task template:** `Fix the bug at <file:line> where <symptom>`

| Criterion | Metric |
|-----------|--------|
| File changed | Diff contains the target file |
| Bug addressed | Model output ≠ original at target location |
| No regression | Other code in file unchanged (targeted diff) |
| Minimal blast | Changed lines < 50 |

**Failure modes to reject:**
- Empty diff (content-identity trap)
- "Fixed" by deleting or commenting out the broken code
- Fix introduces the same bug elsewhere

---

### Category 2 — Feature Addition (`feature`)
**Task template:** `Add <capability> to <existing module> without breaking existing API`

| Criterion | Metric |
|-----------|--------|
| New capability exists | New file or new exports in existing file |
| API compatible | Existing call sites still compile |
| No content-identity | Diff is not empty |
| Type-safe | `tsc --noEmit` passes |

**Failure modes to reject:**
- Model says "I added X" but X doesn't exist in the output
- Existing tests break

---

### Category 3 — Refactor (`refactor`)
**Task template:** `Extract <functionality> into a separate module. Maintain the existing interface.`

| Criterion | Metric |
|-----------|--------|
| Functionality moved | Old location calls new location |
| Interface preserved | Call signatures unchanged |
| No content-identity | Original file and new file are different |
| Tests pass | `npm test` / `pnpm test` unchanged |

**Failure modes to reject:**
- Model duplicated code instead of extracting (content-identity in disguise)
- Interface changed (breaking refactor)
- Tests silently broken

---

### Category 4 — Extension (`extend`)
**Task template:** `Extend <existing API> to support <new parameter/mode/format>`

| Criterion | Metric |
|-----------|--------|
| New parameter handled | Code branches for new input |
| Backwards compatible | Existing calls still work |
| No content-identity | Diff contains new logic |
| Compiles | `tsc --noEmit` passes |

---

### Category 5 — Security Hardening (`security`)
**Task template:** `<Input validation / auth check / sanitization> is missing at <location>. Add it without breaking existing flows.`

| Criterion | Metric |
|-----------|--------|
| Guard added | New conditional in target location |
| Existing flows work | Auth/path through existing logic unchanged |
| No content-identity | Diff adds logic, not just echoes |
| Compiles | `tsc --noEmit` passes |

**Specific failure mode:** Model adds a comment like `// TODO: add validation` instead of actual validation code.

---

### Category 6 — Test Coverage (`coverage`)
**Task template:** `Add tests for <untested function/module>. The tests should fail before the fix and pass after.`

| Criterion | Metric |
|-----------|--------|
| Tests written | New test file or test cases added |
| Tests fail on current code | New tests exercise broken behavior |
| Tests would pass on fix | Assertion matches expected fix behavior |
| No content-identity | Test file is not empty |

---

### Category 7 — Dependency/API Upgrade (`upgrade`)
**Task template:** `Update the <dependency/API call> from <old version> to <new version>. Handle any breaking changes.`

| Criterion | Metric |
|-----------|--------|
| Version updated | `package.json` / import path changed |
| Breaking changes handled | Code adapted for API differences |
| Compiles | `tsc --noEmit` passes |
| Tests pass | `pnpm test` passes |

---

### Category 8 — Performance (`perf`)
**Task template:** `<Function/loop> is slow. Optimize it to handle <workload> without changing the output.`

| Criterion | Metric |
|-----------|--------|
| Performance improved | Algorithm/structure changed |
| Output unchanged | Function returns same result |
| Compiles | `tsc --noEmit` passes |
| No content-identity | Implementation differs from original |

**Specific failure mode:** Model just wraps the slow code in a comment ("optimized").

---

## Standard Run Sequence

```
┌─────────────────────────────────────────────────────────────┐
│  PHASE 1: Scout                                             │
│  Read: source files, README, package.json, architecture    │
│  Output: relevant files, patterns, risk assessment         │
│  Gate: must identify ≥1 file to modify                      │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  PHASE 2: Builder                                            │
│  Read: Scout output + contract + target file content        │
│  Output: Diff (modified file content)                      │
│  Gate: diff must not be empty, model must not echo source  │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  PHASE 3: Critic                                            │
│  Read: Original + Builder output + contract                 │
│  Output: Issues list, change assessment                      │
│  Gate: No critical issues blocking merge                   │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  PHASE 4: Verifier                                          │
│  Read: Modified files + test suite                          │
│  Output: Compilation result, test run result                 │
│  Gate: tsc --noEmit passes, tests pass (or fail intentionally) │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│  PHASE 5: Integrator                                        │
│  Read: All phase outputs                                    │
│  Output: Final receipt, patch artifact, commit SHA          │
│  Gate: All prior gates passed                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Success Criteria Summary

| Test Category | Must Change | Must Compile | Must Pass |
|---------------|-------------|--------------|-----------|
| bugfix | Target file | ✓ | Existing tests |
| feature | New exports | ✓ | Existing tests |
| refactor | Interface same | ✓ | All tests |
| extend | New branches | ✓ | Existing tests |
| security | Guard added | ✓ | Existing tests |
| coverage | Tests added | ✓ | New tests fail intentionally |
| upgrade | Version changed | ✓ | All tests |
| perf | Algorithm differs | ✓ | Output same |

---

## Failure Mode Rejection Rules

### Rule 1 — No Empty Diff
```
IF diff is empty → FAIL immediately
REASON: content-identity trap detected
```

### Rule 2 — No Comment-Only "Fix"
```
IF output changes only comments (no logic change) → FAIL
REASON: model deferred the work, did not implement
```

### Rule 3 — No Partial Implementation
```
IF task says "add X and Y" but only X in diff → FAIL
REASON: incomplete execution
```

### Rule 4 — No Breaking API Changes
```
IF existing call site breaks after change → FAIL
REASON: refactor must be non-breaking
```

### Rule 5 — No Content-Identity in Disguise
```
IF newFile == originalFile (accounting for whitespace) → FAIL
REASON: model duplicated instead of modifying
```

### Rule 6 — No False Feature Claims
```
IF task says "I added feature X" but X not in output → FAIL
REASON: hallucinated completion
```

---

## Running the Harness

### Prerequisites
```bash
# Aedis running on port 18796
# Test repo cloned to /tmp/<repo-name>
# Working directory: /mnt/ai/aedis-scratch
```

### Standard Run Command
```bash
curl -s -X POST "http://127.0.0.1:18796/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "<TASK FROM TEST MATRIX>",
    "repoPath": "/tmp/<repo-path>",
    "quality_bar": "standard"
  }'
```

### Check Result
```bash
curl -s "http://127.0.0.1:18796/tasks/<task_id>" | python3 -m json.tool
curl -s "http://127.0.0.1:18796/tasks/<task_id>/receipts" | python3 -m json.tool | jq '.receipt'
```

### Automated Validation
```bash
# After run completes, check receipt for:
jq '.receipt.verdict'                          # must be "success"
jq '.receipt.executionVerified'                 # must be true
jq '.receipt.graphSummary.totalNodes'          # should be > 0
jq '[.receipt.executionEvidence[] | select(.operation=="modified")] | length'  # files changed
```

---

## Test Suite Manifest

| ID | Category | Repo | Task |
|----|----------|------|------|
| T1 | bugfix | `/tmp/remotion-test` | Fix `getInputProps` returning undefined for optional fields |
| T2 | feature | `/tmp/remotion-test` | Add WebCodecs video encoder support to player |
| T3 | refactor | `/tmp/remotion-test` | Extract `calculateTimeline` into a standalone util module |
| T4 | extend | `/tmp/remotion-test` | Add server-side rendering support to CLI |
| T5 | security | `/tmp/remotion-test` | Add input sanitization to user-provided composition names |
| T6 | coverage | `/tmp/remotion-test` | Add tests for `useVideoConfig` hook |
| T7 | upgrade | `/tmp/remotion-test` | Update `remotion-player` package to latest minor version |
| T8 | perf | `/tmp/remotion-test` | Optimize the frame scheduler to reduce jank at 60fps |

---

## Blast Radius Guidelines

| Change Scope | Files | Expected |
|-------------|-------|----------|
| Single-file fix | 1 | Most tasks |
| Module extension | 1-3 | feature, extend |
| Multi-package change | 3-10 | upgrade, refactor |
| Architectural | 10+ | (avoid until stack is stable) |

**Starting threshold:** Single-file or small multi-file changes only.
Large architectural changes require decomposition (wave planning) which is tested separately.
