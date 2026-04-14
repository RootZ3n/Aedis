# Aedis Deep Analysis — Trust & Polish Stage
**Date**: 2026-04-14  
**Purpose**: Identify gaps, weaknesses, and improvement areas for building trust in large projects  
**Scope**: Full codebase — 90 files across core/, workers/, server/, router/, cli/

---

## Executive Summary

Aedis is a **sophisticated build orchestration system** with genuine depth: isolated workspaces, multi-layer security gates, execution truth enforcement, trust dashboards, post-run evaluation via Crucibulum, and a recovery engine. The architecture is sound. The trust mechanisms are real, not theater.

**But trust isn't just about having gates — it's about those gates never failing silently.** The gaps below are organized by how badly they could erode trust if they manifest during a real build.

---

## 🔴 CRITICAL — Could break trust irreversibly

### 1. Orphaned Workspaces on Crash-During-Approval

**What**: When `requireApproval=true`, the workspace is intentionally preserved during `awaiting_approval`. But if the Aedis process crashes or restarts while waiting, that workspace is orphaned — no recovery path exists. The run is stuck in `AWAITING_APPROVAL` with a dangling temp directory.

**Impact**: Disk leak + ambiguous state. User doesn't know if changes were applied. Workspace may contain partial changes that look "done."

**Fix**: 
- Add startup recovery that scans for `AWAITING_APPROVAL` runs and either resumes or rolls them back
- Add a TTL to pending approvals (default: 24h) with automatic rollback on expiry
- Store workspace path in the receipt so it can be cleaned up even after process restart

**Files**: `core/coordinator.ts` (lines ~1400-1440), `core/receipt-store.ts`

---

### 2. No Verification That Rollback Actually Worked

**What**: `rollbackChanges()` restores files from git, but never runs `git status --porcelain` to confirm the repo is actually clean afterward. If `git restore` fails silently (permissions, locked files, race condition), the repo is left dirty and the run reports "blocked" without the user knowing their repo is in a weird state.

**Impact**: Silent corruption of working tree. User thinks changes were rolled back but some remain.

**Fix**:
```typescript
// After rollback, verify cleanliness
const status = await exec("git", ["status", "--porcelain"], { cwd: projectRoot });
if (status.stdout.trim().length > 0) {
  console.error(`[coordinator] ROLLBACK INCOMPLETE — uncommitted changes remain:\n${status.stdout}`);
  // Persist CLEANUP_ERROR status with diff details
}
```

**Files**: `core/coordinator.ts` (rollbackChanges method)

---

### 3. Concurrent Memory Corruption

**What**: `project-memory.ts` reads and writes `.aedis/memory.json` as a single JSON file with no file locking. If two Aedis runs target the same repo concurrently (e.g., two prompts submitted in quick succession), they can corrupt memory.json through read-write races.

**Impact**: Memory loss — task patterns, file clusters, reliability tiers all gone. Aedes loses its learning. Worse: partially-written JSON causes `loadMemory()` to throw, which degrades every subsequent run on that repo to "no memory" mode.

**Fix**:
- Write to `.aedis/memory.json.tmp` then `rename()` (atomic on same filesystem)
- Or: use `fs.open` with `wx` flag for exclusive write
- Or: shard memory by run ID and merge on read

**Files**: `core/project-memory.ts` (saveMemory function)

---

## 🟠 HIGH — Could cause incorrect builds or wrong trust signals

### 4. Confidence Thresholds Are Hardcoded, Never Calibrated

**What**: The confidence gate (`confidence-gate.ts`) uses fixed thresholds: 0.85+ = apply, 0.70-0.84 = review, 0.50-0.69 = escalate, <0.50 = reject. The trust dashboard tracks calibration (overconfidence rate, underconfidence rate) but **never feeds back** to adjust these thresholds.

**Impact**: If Aedis becomes systematically overconfident on a task type, the dashboard shows it but the gate still says "apply." The user sees red flags in the trust dashboard but the system keeps auto-applying.

**Fix**: 
- After N runs, adjust thresholds based on calibration data
- Or: make thresholds per-archetype (different thresholds for "refactor" vs "auth" vs "migration")
- At minimum: add a "trust_override" flag that the dashboard can set to force "review" when overconfidence is detected

**Files**: `core/confidence-gate.ts`, `core/trust-dashboard.ts`, `core/coordinator.ts`

---

### 5. Hub Index Cache Staleness Within a Run

**What**: `hubIndexCache` in the Coordinator has a 5-minute TTL. But within a single multi-wave run, the Builder creates/modifies files. The hub index used for architectural context gating was computed before execution and doesn't reflect changes made during the run.

**Impact**: Wave 2 gets stale context about which files are most-imported, because Wave 1's changes to import graphs aren't reflected.

**Fix**:
- Invalidate hub index cache at the start of each wave
- Or: recompute hub index after each wave completes
- Or: pass the workspace's file list to the context gate instead of relying on the cached hub

**Files**: `core/coordinator.ts` (hubIndexCache, buildRepoHubIndex)

---

### 6. Velum Regex-Only Detection Has Blind Spots

**What**: Both Velum input and output guards use regex patterns exclusively. They miss:
- Base64-encoded payloads that decode to injection strings
- Unicode homoglyph attacks (Cyrillic а vs Latin a)
- Multi-stage injections split across lines
- Obfuscated exfiltration (char codes, string concatenation)

**Impact**: A sophisticated prompt injection could bypass both guards. For a system that handles auth, secrets, and production code, this is a real attack surface.

**Fix**:
- Add a lightweight LLM-based classifier as a secondary check for high-impact tasks
- Add base64/URL-decode preprocessing to catch encoded payloads
- Add Unicode normalization (NFKC) before pattern matching
- Consider: run Velum output through the Critic as a "security review" check

**Files**: `core/velum-input.ts`, `core/velum-output.ts`

---

### 7. Recovery Engine Can Loop on Same Failure

**What**: The recovery engine has per-strategy escalation control, but no global circuit breaker. If `retry_clearer_contract` fails, it tries `narrow_scope`, then `split_task_further`, etc. Each attempt costs tokens. After max recovery attempts, it escalates — but the per-attempt logging doesn't aggregate into a "this task has failed N times across M strategies" summary.

**Impact**: A user watching a stuck build sees it burning through recovery strategies without a clear "this is going nowhere" signal until the very end.

**Fix**:
- Add a global recovery budget (total USD or total attempts across all strategies)
- Emit a `recovery_stalled` event after 2+ strategies fail with the same failure type
- Add a "recovery summary" to the receipt showing all attempts and outcomes

**Files**: `core/recovery-engine.ts`, `core/coordinator.ts`

---

## 🟡 MEDIUM — Could degrade trust over time

### 8. No Audit Trail for Context Gate Decisions

**What**: The context gate (`context-gate.ts`) filters and merges context from multiple sources (memory, architectural index, pattern warnings, Aedis memory adapter). But the final gated context that workers receive has no receipt — there's no record of which files were included, which were excluded, and why.

**Impact**: When a builder produces unexpected output, there's no way to trace "the builder saw X because the context gate included file Y." Trust debugging is harder.

**Fix**:
- Add a `GatedContextReceipt` that logs all inclusion/exclusion decisions
- Store it on the ActiveRun and include in the RunReceipt
- Surface it in the trust dashboard as "context quality" metric

**Files**: `core/context-gate.ts`, `core/coordinator.ts`

---

### 9. Receipt Store Has No Corruption Recovery

**What**: The receipt store writes JSONL files. A crash mid-write corrupts the file. There's no backup, no checksum validation on read, and no recovery mechanism.

**Impact**: Lost audit trail. For a system where trust depends on receipts, losing receipts is losing trust.

**Fix**:
- Write to `.jsonl.tmp` then rename (atomic)
- Add a checksum line at the end of each receipt file
- On read, validate checksum and fall back to `.jsonl.bak` if corrupted
- Add a `receipt-store verify` CLI command

**Files**: `core/receipt-store.ts`

---

### 10. Test Coverage Gaps on Critical Trust Paths

**What**: 12 test files exist, but critical modules have zero coverage:
- `coordinator.ts` (3900+ lines, the brain) — no dedicated tests
- `recovery-engine.ts` — no tests
- `trust-router.ts` — no tests
- `workspace-manager.ts` — no tests
- `impact-classifier.ts` — no tests
- `context-gate.ts` — no tests
- `merge-gate.ts` — no tests
- `confidence-gate.ts` — no tests

**Impact**: Regressions in trust-critical code won't be caught until they reach production. For a system entering "trust building stage," this is a gap.

**Priority tests to add**:
1. `coordinator.test.ts` — end-to-end submit flow with mock workers
2. `merge-gate.test.ts` — critical finding blocks, advisory doesn't
3. `workspace-manager.test.ts` — create/discard/patch lifecycle
4. `recovery-engine.test.ts` — strategy selection, circuit breaking
5. `context-gate.test.ts` — inclusion/exclusion decisions

---

### 11. Proving Campaign State Is Fragile

**What**: Campaign registry is a single JSON file with no transactional writes. Same race condition as memory.json.

**Impact**: Lost campaign history, broken trust badges.

**Fix**: Same as memory — atomic write pattern.

**Files**: `core/proving-campaign.ts`

---

### 12. No "Trust Regressions" Alert

**What**: The trust dashboard detects drift and overconfidence, but there's no automatic alert when trust degrades. A user has to manually check the dashboard.

**Impact**: Slow discovery of trust problems. By the time someone checks, 50 runs have been overconfident.

**Fix**:
- Add a trust regression detector that fires `trust_regression` WebSocket events
- Add a threshold: if overconfidence rate > 30% in last 10 runs, auto-alert
- Surface in the Lumen UI as a persistent warning banner

**Files**: `core/trust-dashboard.ts`, `server/websocket.ts`

---

## 🟢 LOW — Polish and observability

### 13. No Per-Run Cost Budget Enforcement

**What**: `maxRunTimeoutSec` exists but there's no `maxRunCostUsd`. A runaway build can burn through expensive models without limit.

**Fix**: Add cost tracking per run with a configurable budget. Emit `cost_budget_exceeded` event.

---

### 14. Dry-Run Doesn't Include Velum Scanning

**What**: The dry-run planner produces a plan but doesn't run Velum input scanning. A user doing a dry-run won't see that their prompt would be blocked.

**Fix**: Run velumScanInput in the dry-run pipeline and surface the decision.

---

### 15. No "Why This Was Trusted" Explanation on Receipts

**What**: The receipt shows confidence scores and verdicts, but doesn't explain "this was trusted because: tests passed, integration passed, no sensitive files, low blast radius, memory says this pattern is reliable."

**Fix**: Add a `trustExplanation: string[]` to the RunReceipt that lists the positive trust signals, not just penalties.

---

### 16. Workspace Fallback Is Logged But Not Prevented

**What**: When workspace creation fails, the system falls back to writing directly to the source repo. This is logged as "UNSAFE" but execution continues. There's no way to configure "fail hard if workspace can't be created."

**Fix**: Add `requireWorkspace: boolean` to CoordinatorConfig. Default false for backward compatibility, but production deployments should set it true.

---

## Summary Matrix

| # | Issue | Severity | Trust Impact | Effort |
|---|-------|----------|-------------|--------|
| 1 | Orphaned workspaces on crash | CRITICAL | High — ambiguous state | Medium |
| 2 | Rollback not verified | CRITICAL | High — silent corruption | Low |
| 3 | Memory corruption (concurrent) | CRITICAL | High — learning loss | Low |
| 4 | Uncalibrated confidence thresholds | HIGH | High — wrong auto-decisions | Medium |
| 5 | Hub index stale within run | HIGH | Medium — bad context | Medium |
| 6 | Velum regex blind spots | HIGH | Medium — security bypass | Medium |
| 7 | Recovery engine no circuit breaker | HIGH | Medium — token burn | Low |
| 8 | No context gate audit trail | MEDIUM | Medium — debugging hard | Medium |
| 9 | Receipt store corruption | MEDIUM | High — lost audit trail | Low |
| 10 | Test coverage gaps | MEDIUM | High — regressions | High |
| 11 | Campaign state fragility | MEDIUM | Low — lost history | Low |
| 12 | No trust regression alerts | MEDIUM | Medium — slow discovery | Low |
| 13 | No cost budget | LOW | Low — token burn | Low |
| 14 | Dry-run skips Velum | LOW | Low — surprise blocks | Low |
| 15 | No trust explanation on receipts | LOW | Low — UX clarity | Low |
| 16 | Workspace fallback not preventable | LOW | Medium — safety | Low |

---

## Recommended Priority Order (Trust Building)

### Phase 1: "Never break trust" (this week)
1. **#3** — Atomic memory writes (30 min)
2. **#2** — Verify rollback cleanliness (1 hour)
3. **#9** — Atomic receipt writes + checksum (1 hour)
4. **#1** — Startup recovery for pending approvals (2 hours)

### Phase 2: "Trust signals are accurate" (next week)
5. **#4** — Calibrate confidence thresholds from trust dashboard (2 hours)
6. **#12** — Trust regression alerts (1 hour)
7. **#7** — Recovery circuit breaker (1 hour)
8. **#15** — Trust explanation on receipts (2 hours)

### Phase 3: "Trust is testable" (week after)
9. **#10** — Add tests for merge-gate, workspace-manager, recovery-engine (4 hours)
10. **#8** — Context gate audit trail (2 hours)
11. **#6** — Velum LLM secondary check for high-impact tasks (3 hours)

### Phase 4: "Trust is visible" (polish)
12. **#5** — Hub index invalidation per wave (1 hour)
13. **#13** — Cost budget enforcement (1 hour)
14. **#14** — Dry-run Velum scanning (30 min)
15. **#16** — requireWorkspace config option (30 min)
16. **#11** — Atomic campaign writes (30 min)

---

## What's Genuinely Good (Don't Touch)

These are solid and should be preserved as-is:

- **Execution Truth Enforcement** — The no-op detection with positive evidence requirement is excellent. This is the single most important trust mechanism.
- **Isolated workspaces** — Git worktree approach is correct. The fallback to source repo is the only weakness.
- **Multi-layer security** — Velum input + output + impact classifier + context gate is defense-in-depth.
- **Trust dashboard** — Historical calibration, drift detection, archetype analysis. Real observability, not vanity metrics.
- **Post-run Crucibulum evaluation** — External validation with disagreement analysis. This is how you build trust: let an independent system check your work.
- **MergeGate** — Hard blocking on critical findings. No "looks mostly good" path.
- **Dry-run capability** — Users can see what would happen before it happens.
- **Recovery engine** — Structured failure triage with escalation control. Not perfect (see #7) but the concept is right.
