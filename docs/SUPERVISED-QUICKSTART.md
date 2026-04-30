# Supervised-Mode Quickstart

> One-page operator guide for running Aedis as your primary repo tool with
> a human in the loop. Every change passes through approval; nothing
> auto-promotes to source unless you opt in explicitly.

## 1. Build and start

```bash
git clone https://github.com/RootZ3n/aedis
cd aedis
cp .env.example .env             # add your provider keys
npm ci
npm run build
node dist/server/index.js > /tmp/aedis.log 2>&1 &
```

Server listens on `http://127.0.0.1:18796`. Logs land in `/tmp/aedis.log`.

For development against source (auto-reload, slower startup, no built dist):

```bash
npm start                         # tsx server/index.ts
```

## 2. Doctor — confirm the runtime is fresh

```bash
npx tsx cli/aedis.ts doctor
```

Reports server pid + commit, local commit, and a `STALE SERVER` block if
any of three conditions fire (commit mismatch, dist older than source,
server uptime predates latest build). **Exit 2 on stale.** Override with
`--allow-stale-server` only when intentional.

## 3. Verify the safe default policy

```bash
curl -s http://127.0.0.1:18796/health | jq .policy
```

Expected on a fresh boot:

```json
{
  "autoPromote": false,
  "approvalRequired": true,
  "destructiveOps": "blocked",
  "laneMode": "primary_only",
  "shadowPromoteAllowed": false,
  "requireWorkspace": true
}
```

`shadowPromoteAllowed` is a **structural** false — the workspace-role
guard in `promoteToSource` makes it impossible to flip. To opt out of
the others (unsafe), set env vars before starting:

- `AEDIS_REQUIRE_APPROVAL=false` — skip the approval gate
- `AEDIS_AUTO_PROMOTE=true` — auto-promote on `VERIFIED_SUCCESS`

The double-negative on `AEDIS_REQUIRE_APPROVAL` is intentional — you
have to type the unsafe value verbatim.

## 4. Submit a task

```bash
curl -X POST http://127.0.0.1:18796/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "add a doc comment to formatVerdictBadge in core/run-summary.ts",
    "repoPath": "/path/to/your/repo"
  }'
```

Response includes `task_id` and `run_id`. The run executes in an
isolated git worktree — your source repo is untouched until you approve.

## 5. Review in the TUI

```bash
npx tsx cli/tui/index.tsx
```

Top bar shows the safety policy and a red `⚠ STALE SERVER` banner if the
running server is stale. Dashboard rows show one line per run with the
lane indicator (`[L→C 2c sel:shadow-1]` for `local_then_cloud` rescue).

| key | action |
|---|---|
| `↑` `↓` | select run |
| `enter` | open run detail |
| `c` (in detail) | open Candidate Lanes panel — shows ★ on selected lane |
| `s` | submit a new prompt |
| `a` | approve the highlighted run (only valid for `AWAITING_APPROVAL`) |
| `r` | reject the highlighted run |
| `t` | toggle terminal-history filter |
| `q` | quit |

The Candidate Lanes panel surfaces primary vs shadow with model attribution
(intent vs actual), disqualification reason, and the ★ marker on the lane
selection picked.

## 6. Approve or reject

From the TUI: select the run, press `a` (approve) or `r` (reject).

From curl:

```bash
curl -X POST http://127.0.0.1:18796/approvals/$RUN_ID/approve
curl -X POST http://127.0.0.1:18796/approvals/$RUN_ID/reject
```

Approval applies the workspace commit to your source repo; rejection
discards the workspace and leaves source untouched.

## 7. Burn-in — exercise one scenario

```bash
# List + run a single scenario
npx tsx scripts/burn-in/test-burn-in.ts --scenario burn-in-09-command-loop

# Lane-rescue scenario (cloud-shadow spend; opt in)
npx tsx scripts/burn-in/test-burn-in.ts \
  --scenario burn-in-11-lane-rescue \
  --allow-shadow-cost
```

The harness auto-rejects any `AWAITING_APPROVAL` run, so source stays
clean. Results append to the OS temp directory by default, or to
`AEDIS_BURN_RESULTS` when set.

`--summary` prints the latest invocation's results without re-running:

```bash
npx tsx scripts/burn-in/test-burn-in.ts --summary
```

## 8. Lane config — opt into local-then-cloud rescue

Per-repo `.aedis/lane-config.json` controls multi-lane execution.
Four `mode` values are defined, but only one is currently dispatched:

```json
{
  "mode": "local_then_cloud",   // ✅ active — local primary, cloud shadow on fallback
  "primary": { "lane": "local",  "provider": "ollama",     "model": "qwen3.5:9b" },
  "shadow":  { "lane": "cloud",  "provider": "openrouter", "model": "xiaomi/mimo-v2.5" }
}
```

The following modes are **scaffolded but not yet dispatched** — they are
accepted by the parser (so config files are valid) but have no live code path:

| mode | what it does | status |
|------|-------------|--------|
| `primary_only` | single lane, no shadow | ✅ active (default) |
| `local_then_cloud` | local primary; cloud shadow fires only if primary fails verification | ✅ active |
| `local_vs_cloud` | parallel primary+shadow, pick best | 🔧 scaffolded |
| `cloud_with_local_check` | cloud primary; local shadow validates output | 🔧 scaffolded |

To register a shadow intent today, use `local_then_cloud`. When the
scaffolded modes are wired, this table will be updated to mark them active.

**Cost warning.** `local_then_cloud` only fires the cloud shadow when
the local primary fails verification. When it fires, you get a single
extra cloud model call charged to that run. The coordinator logs a
`SHADOW LANE … this is a SECOND model call — operator-visible cost will
be charged to this run` line *before* the dispatch so you can correlate
spend.

`primary_only` (default when `lane-config.json` is absent) runs a single
lane on the model in `.aedis/model-config.json` — no shadow, no rescue,
no extra spend.

## 9. Stale server — what to do

If the doctor or burn-in reports `STALE SERVER`:

```bash
pkill -f "node dist/server/index.js"
npm run build
node dist/server/index.js > /tmp/aedis.log 2>&1 &
```

The TUI's red banner clears on the next poll once the server is fresh.
If you genuinely need to run against a stale server (e.g. reproducing a
last-known-good behavior), pass `--allow-stale-server` to burn-in or
`--allow-stale` to doctor.

## 10. Cleanup and recovery

- **Orphaned approvals on restart.** When the server starts, it scans
  for `AWAITING_APPROVAL` runs from a previous session and rolls each
  back (logged as `STARTUP RECOVERY`). Source stays untouched.
- **Workspace residue.** Worktrees live under `AEDIS_TMPDIR` when set,
  otherwise under `os.tmpdir()/aedis-ws-*`, and are cleaned up on cancel /
  reject / finalize. To inspect leftovers:

  ```bash
  ls "${AEDIS_TMPDIR:-/tmp}" | grep aedis-ws-
  git worktree list                # see active worktrees
  git worktree remove <path>       # then remove the directory if needed
  ```

- **Receipts.** All runs persist to `state/receipts/<runId>.json` (gitignored)
  and stream over WebSocket at `ws://127.0.0.1:18796/ws`.
- **Reset everything (destructive).** Stop the server, then:

  ```bash
  rm -rf state/ data/sessions/ .aedis/circuit-breaker-state.json
  ```

  This wipes run history, sessions, and the cross-run circuit-breaker
  state. Your source repo is not affected.

---

For the full architectural picture see `DOCTRINE.md`. For the security
model and key-leak playbook see `SECURITY.md`. For the burn-in framework
see `TEST-HARNESS.md`.
