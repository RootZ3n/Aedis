# Aedis

**Supervised AI build orchestration for repositories.**

Aedis is a supervised AI build orchestrator that plans, edits, verifies, and stages repository changes through explicit gates, receipts, and human approval.

Public RC mode is review-only by default. Aedis can prepare and verify changes in an isolated workspace, but source-repo promotion requires explicit trusted-write opt-in, a passing verifier, critic review of the actual diff, and human approval of the final diff.

## What Aedis Is

- Supervised AI build orchestration.
- A planning, editing, and verification pipeline.
- Receipt-driven change staging.
- A human-approved integration tool.
- Review-only by default in public RC mode.

## What Aedis Is Not

- Not a fully autonomous code replacement.
- Not a guaranteed rollback system. Aedis attempts rollback and records receipts; if rollback is incomplete, the final result is unsafe/failure and manual inspection is required.
- Not a guaranteed cheaper Claude Code replacement. Provider/model cost depends on your configuration and workload.
- Not safe for untrusted repositories without review.
- Not a reason to skip human diff review.
- Not a silent auto-merge tool.

## Ecosystem

- **Colosseum**: agent trial harness.
- **Crucible**: scoreboard and evidence viewer.
- **Verum**: adversarial trust and probing layer.
- **Aedis**: governed build orchestration.
- **Squidley Public**: broader AI control surface.

## Pipeline

```text
Prompt
  -> Coordinator
  -> Scout
  -> Builder
  -> Critic
  -> Verifier
  -> Integrator
  -> receipt + staged diff + human approval gate
```

Core guarantees are conservative:

- Writes are contained to the intended workspace/source root with realpath/lstat checks.
- Unsupported provider, model, or lane configuration fails closed by default.
- Rollback failure or incomplete cleanup dominates the final status.
- Source promotion is disabled by default for public RC.
- Promotion requires an approved final diff receipt.

## Quickstart

```bash
git clone https://github.com/RootZ3n/aedis
cd aedis
cp .env.example .env
npm ci
npm run build
npm run smoke
npm run verify:release
```

Expected smoke output:

```text
[smoke] OK - dist artifacts present for version ...
```

Expected release verification summary:

```text
# pass ...
# fail 0
[check-secrets] OK - no forbidden patterns in tracked files
[smoke] OK - dist artifacts present for version ...
```

Start the server after building:

```bash
npm run start:dist
```

Open [http://127.0.0.1:18796](http://127.0.0.1:18796).

The default bind is `127.0.0.1`. Binding to `0.0.0.0` requires both:

```bash
AEDIS_HOST=0.0.0.0
AEDIS_ALLOW_PUBLIC_BIND=true
```

Auth is enabled by default. `TAILSCALE_ONLY=true` keeps Tailscale identity enforcement enabled. For local-only development, `TAILSCALE_ONLY=false` disables auth; do not use that on a shared network.

## Configuration

Copy `.env.example` to `.env` and choose a model profile.

Local smoke mode:

```bash
AEDIS_MODEL_PROFILE=local-smoke
ollama pull qwen3.5:9b
ollama pull qwen3.5:4b
```

Full mode:

```bash
AEDIS_MODEL_PROFILE=default
OPENROUTER_API_KEY=<your-openrouter-key>
ZAI_API_KEY=<your-zai-key>
```

Public RC source promotion stays disabled unless explicitly enabled:

```bash
AEDIS_ALLOW_SOURCE_PROMOTION=true
AEDIS_TRUSTED_LOCAL_REPO_WRITES=true
```

Even with those flags, promotion still requires verifier pass, critic actual-diff review, and human diff approval.

## Useful Commands

```bash
npm run typecheck
npm run build
npm test
npm run security:secrets
npm run smoke
npm run audit:release
npm run verify:release
```

`npm audit --audit-level=moderate` is the dependency advisory gate used for release review.

## API

```bash
curl -X POST http://127.0.0.1:18796/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"add error handling to server/index.ts","repoPath":"/path/to/repo"}'
```

Dry run:

```bash
curl -X POST http://127.0.0.1:18796/tasks/dry-run \
  -H 'Content-Type: application/json' \
  -d '{"input":"refactor the context gate","repoPath":"/path/to/repo"}'
```

WebSocket events are available at `ws://127.0.0.1:18796/ws`.

## Status

Public RC hardening. Linux, macOS, and WSL2 are the expected install targets. Windows PowerShell is not yet verified.

## Docs

- [Provider Setup](docs/PROVIDER-SETUP.md)
- [Supervised Quickstart](docs/SUPERVISED-QUICKSTART.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Screenshots placeholder](docs/screenshots/README.md)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE)
