# Contributing to Aedis

## Setup

```bash
git clone https://github.com/RootZ3n/Aedis.git
cd Aedis
cp .env.example .env
# Edit .env — see docs/PROVIDER-SETUP.md
npm ci
```

## Build

```bash
npm run build
```

## Test

```bash
npm test
```

All tests must pass before submitting a PR.

## Type check

```bash
npx tsc --noEmit
```

## Secrets scan

```bash
npm run security:secrets
```

This must pass. Never commit API keys, tokens, or credentials.

## Full validation

```bash
npm run check
```

Runs secrets scan, tests, build, and type check in sequence.

## Pull request expectations

- One logical change per PR.
- All validation must pass: `npm run check`.
- Include a clear description of what changed and why.
- If your change touches the approval flow, merge gate, or provider
  invocation, explain the safety implications.
- New features should include tests.
- Do not commit `.env`, API keys, or secrets under any circumstances.

## Safety philosophy

Aedis is a supervised build orchestrator. Its core safety contract:

- **Approval required by default.** Every code-modifying run pauses for
  human approval before committing. This is not optional for contributors
  to weaken without explicit justification.
- **Merge gate is not advisory.** One critical finding blocks the commit.
  On block, all changes are rolled back. Do not add "soft fail" paths.
- **Rollback is always available.** If any gate fails, the repo is
  restored to its pre-run state. New features must preserve this.
- **No hidden provider fallbacks.** Every model call must be declared in
  the fallback chain. Never add an implicit safety-net provider.
- **Receipts tell the truth.** If a run failed, the receipt says failed.
  Never suppress or rewrite failure states.

## Code style

- TypeScript, strict mode.
- No external linter config — keep it consistent with surrounding code.
- Prefer explicit types at module boundaries.
- No `any` at public API surfaces.

## License

By contributing, you agree that your contributions will be licensed under
the MIT License.
