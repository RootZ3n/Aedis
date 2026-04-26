#!/usr/bin/env bash
# Aedis secret-scanning gate.
#
# Scans tracked files for real-looking provider API keys and bearer tokens.
# Used by `npm run security:secrets` and as the secret check inside
# `npm run check`. Exits non-zero on any unallowlisted match.
#
# Prefers gitleaks if installed (richer rule set); otherwise runs a
# pattern-grep over tracked files only. Output is redacted: any matched
# token appears as `<prefix>...<last4>`.
#
# Allowlist: a single test fixture (`sk-secret-not-to-leak`) used by
# server/routes/providers.test.ts to assert the API never serializes a
# real key. Anything else is a fail.

set -u

cd "$(dirname "$0")/.."
repo_root="$(pwd)"

# ─── Prefer gitleaks if present ──────────────────────────────────────
if command -v gitleaks >/dev/null 2>&1; then
  echo "[check-secrets] using gitleaks"
  exec gitleaks detect --source . --redact --verbose --no-banner
fi

echo "[check-secrets] gitleaks not installed; using built-in pattern scan"

# Allowlisted fixture strings. Each is a literal substring that, if
# matched alongside a forbidden pattern, is NOT counted as a finding.
allowlist=(
  "sk-secret-not-to-leak"
)

# Forbidden patterns — extended regex, evaluated against each tracked
# file. Each entry is `LABEL|REGEX`. Patterns are intentionally tight
# enough to require key-shaped values (16+ alphanumerics, etc.) so
# placeholder lines in `.env.example` and templated `Bearer ${apiKey}`
# expressions in source do not trip the gate.
patterns=(
  "openai/anthropic/openrouter sk- token|\\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}"
  "Bearer literal token|Bearer[[:space:]]+[A-Za-z0-9_.+/=-]{20,}"
  "OPENAI_API_KEY assignment|OPENAI_API_KEY=[A-Za-z0-9_.+/=-]{8,}"
  "ANTHROPIC_API_KEY assignment|ANTHROPIC_API_KEY=[A-Za-z0-9_.+/=-]{8,}"
  "OPENROUTER_API_KEY assignment|OPENROUTER_API_KEY=[A-Za-z0-9_.+/=-]{8,}"
  "MINIMAX_API_KEY assignment|MINIMAX_API_KEY=[A-Za-z0-9_.+/=-]{8,}"
  "MODELSTUDIO_API_KEY assignment|MODELSTUDIO_API_KEY=[A-Za-z0-9_.+/=-]{8,}"
  "DASHSCOPE_API_KEY assignment|DASHSCOPE_API_KEY=[A-Za-z0-9_.+/=-]{8,}"
  "ZAI_API_KEY assignment|ZAI_API_KEY=[A-Za-z0-9_.+/=-]{8,}"
)

# Files to scan: tracked files only, excluding this script itself
# (which legitimately mentions every pattern above). NUL-delimited so
# whitespace in paths is safe.
mapfile -d '' files < <(
  git ls-files -z --cached -- ':!scripts/check-secrets.sh' \
    2>/dev/null
)

if [ "${#files[@]}" -eq 0 ]; then
  echo "[check-secrets] no tracked files to scan (is this a git repo?)" >&2
  exit 2
fi

redact() {
  # Redact tokens in matched lines. Keeps prefix (sk-, Bearer ) plus up
  # to 4 leading chars and last 4 chars; replaces the middle with
  # `...REDACTED...`. Catches the same shapes as the patterns above.
  sed -E '
    s/(sk-[A-Za-z0-9_-]{0,4})[A-Za-z0-9_-]{8,}([A-Za-z0-9_-]{4})/\1...REDACTED...\2/g
    s/(Bearer[[:space:]]+[A-Za-z0-9_.+\/=-]{0,4})[A-Za-z0-9_.+\/=-]{8,}([A-Za-z0-9_.+\/=-]{4})/\1...REDACTED...\2/g
    s/((OPENAI|ANTHROPIC|OPENROUTER|MINIMAX|MODELSTUDIO|DASHSCOPE|ZAI)_API_KEY=[A-Za-z0-9_.+\/=-]{0,4})[A-Za-z0-9_.+\/=-]{4,}([A-Za-z0-9_.+\/=-]{4})/\1...REDACTED...\3/g
  '
}

is_allowlisted() {
  local line="$1"
  for token in "${allowlist[@]}"; do
    if [[ "$line" == *"$token"* ]]; then
      return 0
    fi
  done
  return 1
}

findings=0

for entry in "${patterns[@]}"; do
  label="${entry%%|*}"
  regex="${entry#*|}"

  # grep -E on the whole file set; -I skips binary; -n adds line nums;
  # -H forces filename even with one file.
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    if is_allowlisted "$match"; then
      continue
    fi
    if [ "$findings" -eq 0 ]; then
      echo ""
      echo "=========================================="
      echo "[check-secrets] FORBIDDEN PATTERN FOUND"
      echo "=========================================="
    fi
    echo ""
    echo "rule: $label"
    printf '%s\n' "$match" | redact
    findings=$((findings + 1))
  done < <(grep -InHE "$regex" -- "${files[@]}" 2>/dev/null)
done

if [ "$findings" -gt 0 ]; then
  echo ""
  echo "=========================================="
  echo "[check-secrets] $findings finding(s); blocking commit/push"
  echo "=========================================="
  echo "If a finding is a known test fixture, add its literal string"
  echo "to the allowlist[] array in scripts/check-secrets.sh."
  exit 1
fi

echo "[check-secrets] OK — no forbidden patterns in tracked files"
exit 0
