# FAQ

## What is Aedis?

Aedis is a supervised AI build orchestrator. It takes a natural language
prompt, decomposes it into a governed execution plan, runs it through a
multi-worker pipeline (scout, builder, critic, verifier, integrator),
and produces verified code changes with full receipts. It requires human
approval before committing to your repo.

## Is it autonomous?

No. Aedis is supervised by design. Every code-modifying run pauses for
human approval before any commit is made. The operator reviews the
proposed diff and explicitly approves or rejects. Auto-promote can be
opted into for low-risk workflows, but it is off by default.

## Does it mutate my repo automatically?

Not by default. Aedis works in an isolated workspace (git worktree).
Changes are only applied to your repo after:
1. All verification gates pass (typecheck, lint, contracts, merge gate).
2. The operator explicitly approves the run.

If any gate fails, all changes are rolled back. Your repo is left
exactly as it was before the run.

## Why approval gates?

Trust. AI-generated code should be reviewed before it lands. The
approval gate is the hard boundary between "Aedis thinks this is good"
and "the operator agrees." One critical merge-gate finding blocks the
commit entirely — there is no "looks mostly good" override.

## What is TAILSCALE_ONLY?

Aedis ships with auth enabled by default, requiring Tailscale identity
for access. This protects the server from unauthorized use on shared
networks.

For local-only development (localhost, no Tailscale), set
`TAILSCALE_ONLY=true` in your `.env` to disable auth. This is safe when
the server is only reachable from your own machine.

## What providers are required?

With the default model configuration:

| Provider | Used for | Env var |
|----------|----------|---------|
| OpenRouter | Builder, Coordinator | `OPENROUTER_API_KEY` |
| Z.ai | Integrator, Escalation | `ZAI_API_KEY` |
| Ollama | Critic, Prompt normalizer | (local, no key) |

Anthropic, OpenAI, MiniMax, and ModelStudio are optional and only needed
if you configure them in `.aedis/model-config.json`.

See [docs/PROVIDER-SETUP.md](docs/PROVIDER-SETUP.md) for setup details.

## Do I need Ollama?

Yes, for the default configuration. The critic role uses `qwen3.5:9b`
and the prompt normalizer uses `qwen3.5:4b`, both via Ollama.

Install Ollama, start it (`ollama serve`), and pull the models:

```bash
ollama pull qwen3.5:9b
ollama pull qwen3.5:4b
```

If you override the critic and normalizer to use a cloud provider in
`.aedis/model-config.json`, Ollama is not required.

## What does safe failure mean?

When a run fails — model error, verification failure, merge-gate block —
Aedis rolls back every change the builder made. Created files are
removed. Modified files are restored from their original content.
Deleted files are recovered from git HEAD. The repo is left clean.

The receipt records exactly what happened, why it failed, and what to
try next.

## Where are receipts and logs?

- **Receipts** are visible in the UI at `http://localhost:18796` after
  each run. They include classification, confidence scores, cost, file
  list, and failure explanations.
- **Server logs** go to stdout/stderr. When running in the background,
  redirect to a file: `node dist/server/index.js > /tmp/aedis.log 2>&1 &`
- **Run history** is stored in the server's session state and accessible
  via `aedis sessions` and `aedis status <task-id>`.

## What should I do if doctor fails?

`aedis doctor` checks server health, build staleness, and provider
connectivity. Common fixes:

| Doctor says | Fix |
|-------------|-----|
| Server unreachable | Start the server: `npm run start:dist` |
| Stale server (commit mismatch) | Rebuild and restart: `npm run build && npm run start:dist` |
| Stale server (dist older than source) | Rebuild: `npm run build` |
| OpenRouter key not set | Add `OPENROUTER_API_KEY` to `.env` |
| OpenRouter key rejected | Rotate your key at openrouter.ai |
| ZAI key not set | Add `ZAI_API_KEY` to `.env` |
| Ollama unreachable | Start Ollama: `ollama serve` |
| Ollama missing models | Pull them: `ollama pull qwen3.5:9b && ollama pull qwen3.5:4b` |

See [docs/PROVIDER-SETUP.md](docs/PROVIDER-SETUP.md) for full provider
setup instructions.
