# Provider Setup

Aedis uses multiple model providers. The default configuration requires
**OpenRouter**, **Z.ai**, and **Ollama**. All other providers are optional
and only needed if you customize `.aedis/model-config.json`.

## Default provider roles

| Role | Provider | Model | Env var |
|------|----------|-------|---------|
| Builder | OpenRouter | xiaomi/mimo-v2.5 | `OPENROUTER_API_KEY` |
| Coordinator | OpenRouter | xiaomi/mimo-v2.5 | `OPENROUTER_API_KEY` |
| Critic | Ollama (local) | qwen3.5:9b | — |
| Prompt normalizer | Ollama (local) | qwen3.5:4b | — |
| Integrator | Z.ai | glm-5.1 | `ZAI_API_KEY` |
| Escalation | Z.ai | glm-5.1 | `ZAI_API_KEY` |
| Scout | local | — | — |
| Verifier | local | — | — |

Anthropic is **not** in the hot path by default. See `DOCTRINE.md` "No
Anthropic Hot Path."

## 1. OpenRouter (required)

1. Create an account at [openrouter.ai](https://openrouter.ai).
2. Generate an API key from the dashboard.
3. Add to `.env`:
   ```
   OPENROUTER_API_KEY=<your-openrouter-api-key>
   ```
4. Verify:
   ```bash
   curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" \
     https://openrouter.ai/api/v1/auth/key | head -c 200
   ```
   A valid key returns JSON with `"data"`.

## 2. Z.ai (required for default integrator/escalation)

1. Get an API key from [z.ai](https://z.ai) or [open.bigmodel.cn](https://open.bigmodel.cn).
2. Add to `.env`:
   ```
   ZAI_API_KEY=...
   ```

## 3. Ollama (required for default critic + prompt normalizer)

Ollama runs models locally. No API key needed, but models must be
installed.

### Install Ollama

- **Linux:**
  ```bash
  curl -fsSL https://ollama.com/install.sh | sh
  ```
- **macOS:** Download from [ollama.com/download](https://ollama.com/download)

### Start Ollama

```bash
ollama serve
```

Ollama listens on `http://localhost:11434` by default. Override with
`OLLAMA_BASE_URL` in `.env` if using a different host/port.

### Pull required models

```bash
ollama pull qwen3.5:9b    # used by: critic
ollama pull qwen3.5:4b    # used by: prompt normalizer
```

### Verify

```bash
curl -s http://localhost:11434/api/tags | grep -o '"name":"[^"]*"'
```

You should see `qwen3.5:9b` and `qwen3.5:4b` in the output.

### Optional: vision model

If you enable vision (`AEDIS_VISION=true`), also pull a vision model:
```bash
ollama pull qwen3-vl:8b
```
Set `OLLAMA_VISION_MODEL=qwen3-vl:8b` in `.env`.

## 4. Optional providers

These are only needed if you add them to `.aedis/model-config.json`:

| Provider | Env var | Base URL env var |
|----------|---------|------------------|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| Anthropic | `ANTHROPIC_API_KEY` | — |
| MiniMax | `MINIMAX_API_KEY` | `MINIMAX_BASE_URL` |
| ModelStudio | `MODELSTUDIO_API_KEY` | `MODELSTUDIO_BASE_URL` |

## Checking provider status

After starting the server:

```bash
# Full provider check
aedis doctor

# Or check /health endpoint
curl -s http://127.0.0.1:18796/health | jq '.policy'
```

`aedis doctor` reports connectivity for OpenRouter and Ollama, lists
installed Ollama models, and flags missing required API keys.

## Custom model configuration

Override defaults by creating `.aedis/model-config.json` in your target
repo. Example:

```json
{
  "builder": {
    "model": "deepseek/deepseek-v4-flash",
    "provider": "openrouter",
    "chain": [
      { "provider": "openrouter", "model": "deepseek/deepseek-v4-flash" },
      { "provider": "openrouter", "model": "xiaomi/mimo-v2.5" }
    ]
  },
  "critic": {
    "model": "qwen3.5:9b",
    "provider": "ollama"
  }
}
```

The `chain[]` array declares fallback order. On timeout or error, the
runtime walks the chain. There is no hidden safety-net provider.

See `DOCTRINE.md` "Model Assignments" for the full discipline.
