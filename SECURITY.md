# Security

## Scope

Aedis is a build orchestrator that calls external model providers using API keys held in the operator's environment. Those keys must never be committed to this repository.

## Policy: no real keys in the repo

- The repository ships **`.env.example`** with empty placeholders. That is the only env file ever tracked.
- Real provider keys live in `.env` (and historical `.env.backup-*` files) on the operator's machine. They are listed in `.gitignore` and must not be added to the index.
- Aedis runtime state — `.aedis/`, `state/`, `receipts/`, plus `*.backup`, `*.bak`, `*.key`, `*.pem`, `*.token`, `*.secret` — is also gitignored. Worker memory snapshots and provider attempt logs occasionally contain redacted prompt context; we keep them off the index regardless.

## Pre-commit/pre-push gate

Two npm scripts wrap the policy:

```bash
npm run security:secrets   # scan tracked files for provider key patterns
npm run check              # security:secrets + tests + build + tsc --noEmit
```

`security:secrets` calls `scripts/check-secrets.sh`, which prefers [gitleaks](https://github.com/gitleaks/gitleaks) if installed and falls back to a self-contained pattern scan otherwise. The fallback scans `git ls-files` only (so untracked `.env` files on disk are intentionally not scanned — they cannot reach the index) and redacts any matched token to `<prefix>...<last4>` before printing.

Patterns the gate fails on:

- `sk-...` keys with 16+ alphanumeric characters (Anthropic, OpenAI, OpenRouter, MiniMax)
- `Bearer <token>` with a 20+ character literal
- `OPENAI_API_KEY=`, `ANTHROPIC_API_KEY=`, `OPENROUTER_API_KEY=`, `MINIMAX_API_KEY=`, `MODELSTUDIO_API_KEY=`, `DASHSCOPE_API_KEY=`, `ZAI_API_KEY=` followed by a non-empty value

### Allowlisted fixtures

Exactly one literal string is allowlisted, used by `server/routes/providers.test.ts` to assert the API never serializes a real key:

- `sk-secret-not-to-leak`

Add new fixtures only by editing the `allowlist[]` array at the top of `scripts/check-secrets.sh`. Never allowlist a real key.

## What to do if a key leaks

1. **Revoke the key immediately** at the provider console. Confirm the rotation took effect (a follow-up call should return 401).
2. **Rotate any credentials with shared lineage** — same tenant, same org, anything generated in the same session.
3. **Determine exposure surface.** If the key was only on disk in an ignored file, the rotation is sufficient. If it was committed and pushed:
   - `git log --all -G"<key-prefix>"` to identify carrier commits.
   - Treat the leak as already public — assume anyone watching the repo has the value.
4. **Decide whether to rewrite history.** Rewrites are cosmetic once a commit hits a public remote (mirrors and search caches retain the blob), but they reduce future incidental discovery. If you do rewrite, use `git filter-repo --invert-paths --path <file>` followed by `git push --force-with-lease`.
5. **Update this repo and `.gitignore`** to prevent the same shape recurring. The current ignore set (top of `.gitignore`) covers `.env`, `.env.*`, `*.env*`, `*.backup`, `*.bak`, `*.key`, `*.pem`, `*.token`, `*.secret`, `.aedis/`, `state/`, `receipts/`.
6. **Note the incident** in the operator's local notes if it informs how the next leak is handled.

## Reporting

Aedis is a single-author project; report security issues directly to the maintainer at the email on the GitHub profile. Do not file public issues for unpatched vulnerabilities.
