#!/usr/bin/env bash
# aedis-preflight — check host memory/swap headroom before a run.
#
# Phase 7 gauntlet exposed mid-run crashes correlated with exhausted
# swap (~976Mi/976Mi). After that, runtime was switched to compiled
# dist and an extra swapfile added on /home, but the host can still
# drift back into pressure (ollama loaded models, browser, etc.).
# This script is the cheap "is the floor still there?" check before
# starting a heavy run.
#
# Default: prints a one-line summary and returns 0 (warn-only). The
# Aedis service does NOT call this on startup — Zen runs it manually
# before gauntlet runs, or as ExecStartPre if explicitly opted into
# strict mode.
#
# Strict mode: set AEDIS_PREFLIGHT_STRICT=1 to make the script exit
# with status 1 when any threshold is breached. That mode is suitable
# for ExecStartPre or for blocking a gauntlet harness — but it must be
# opt-in so a normal restart never gets gated by transient swap use.
#
# Tunables (env vars):
#   AEDIS_PREFLIGHT_MIN_FREE_RAM_MB   (default: 2048)
#   AEDIS_PREFLIGHT_MIN_FREE_SWAP_MB  (default: 2048)
#   AEDIS_PREFLIGHT_MAX_SWAP_USED_PCT (default: 80)
#   AEDIS_PREFLIGHT_STRICT            (0|1, default: 0)

set -u

min_free_ram_mb=${AEDIS_PREFLIGHT_MIN_FREE_RAM_MB:-2048}
min_free_swap_mb=${AEDIS_PREFLIGHT_MIN_FREE_SWAP_MB:-2048}
max_swap_used_pct=${AEDIS_PREFLIGHT_MAX_SWAP_USED_PCT:-80}
strict=${AEDIS_PREFLIGHT_STRICT:-0}

# /proc/meminfo gives kB columns we can parse without depending on
# `free` formatting changing across distros.
meminfo=$(cat /proc/meminfo)
mem_total_kb=$(awk '/^MemTotal:/ {print $2}' <<<"$meminfo")
mem_avail_kb=$(awk '/^MemAvailable:/ {print $2}' <<<"$meminfo")
swap_total_kb=$(awk '/^SwapTotal:/ {print $2}' <<<"$meminfo")
swap_free_kb=$(awk '/^SwapFree:/ {print $2}' <<<"$meminfo")

mem_avail_mb=$(( mem_avail_kb / 1024 ))
swap_total_mb=$(( swap_total_kb / 1024 ))
swap_free_mb=$(( swap_free_kb / 1024 ))
swap_used_mb=$(( swap_total_mb - swap_free_mb ))

if [ "$swap_total_mb" -gt 0 ]; then
  swap_used_pct=$(( swap_used_mb * 100 / swap_total_mb ))
else
  swap_used_pct=0
fi

violations=()

if [ "$mem_avail_mb" -lt "$min_free_ram_mb" ]; then
  violations+=("RAM_AVAILABLE_LOW: ${mem_avail_mb}Mi available < ${min_free_ram_mb}Mi threshold")
fi

if [ "$swap_total_mb" -gt 0 ] && [ "$swap_free_mb" -lt "$min_free_swap_mb" ]; then
  violations+=("SWAP_FREE_LOW: ${swap_free_mb}Mi free < ${min_free_swap_mb}Mi threshold")
fi

if [ "$swap_total_mb" -gt 0 ] && [ "$swap_used_pct" -gt "$max_swap_used_pct" ]; then
  violations+=("SWAP_USED_HIGH: ${swap_used_pct}% used > ${max_swap_used_pct}% threshold")
fi

summary="ram_avail=${mem_avail_mb}Mi swap_total=${swap_total_mb}Mi swap_free=${swap_free_mb}Mi swap_used_pct=${swap_used_pct}% strict=${strict}"

if [ ${#violations[@]} -eq 0 ]; then
  echo "[aedis-preflight] OK  ${summary}"
  exit 0
fi

# Surface every violation; the user gets the whole story even when
# strict mode would have stopped at the first one.
echo "[aedis-preflight] WARN ${summary}"
for v in "${violations[@]}"; do
  echo "[aedis-preflight]   - ${v}"
done

if [ "$strict" = "1" ]; then
  echo "[aedis-preflight] STRICT mode set — exiting nonzero so the caller can refuse to start"
  exit 1
fi

echo "[aedis-preflight] non-strict mode — exit 0; set AEDIS_PREFLIGHT_STRICT=1 to gate"
exit 0
