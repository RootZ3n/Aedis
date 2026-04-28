# Redaction

Aedis automatically strips private data before it reaches persisted outputs,
logs, WebSocket events, or the TUI.

## What is redacted

| Pattern | Label | Example |
|---------|-------|---------|
| `sk-*` (20+ chars) | `<redacted:api_key>` | OpenAI keys |
| `sk-proj-*`, `sk-or-*`, `sk-ant-*` | `<redacted:api_key>` | Project / OpenRouter / Anthropic keys |
| `ghp_*`, `github_pat_*` | `<redacted:api_key>` | GitHub tokens |
| `Bearer <token>` | `Bearer <redacted:token>` | Auth headers |
| `KEY=value` env assignments | `KEY=<redacted:secret>` | `.env`-style lines |
| PEM private key blocks | `<redacted:private_key>` | RSA/EC keys |
| JWTs (three-segment base64url) | `<redacted:jwt>` | Auth tokens |
| Email addresses | `<redacted:email>` | `user@example.com` |
| `/home/<user>` paths | `<redacted:path>` | Unix home dirs |
| `C:\Users\<user>` paths | `<redacted:path>` | Windows home dirs |

## Where redaction is applied

- **Receipt persistence** (`core/receipt-store.ts`): `writeRunFile()` calls `redactForReceipt()` before writing JSON to disk.
- **Burn-in JSONL** (`scripts/burn-in/test-burn-in.ts`, `test-burn-in-hard.ts`): Result rows are redacted before `appendFileSync`/`writeFileSync`.
- **Server logs** (`server/routes/tasks.ts`): Prompt slices and error messages are redacted before `console.log`/`console.error`.
- **WebSocket events** (`core/coordinator.ts`): The `run_started` event redacts the input payload.
- **Error tracking** (`server/routes/tasks.ts`): `tracked.error` is redacted before persistence and event emission.

## API

```typescript
import { redactText, redactObject, redactForReceipt, redactForModel, redactError } from "./core/redaction.js";

redactText(str)          // string -> string, applies all rules
redactObject(obj)        // deep clone + redact all string values
redactForReceipt(obj)    // alias for redactObject (receipt boundary)
redactForModel(str)      // alias for redactText (prompt boundary)
redactError(err)         // Error|string -> redacted string
```

## Limitations

- Redaction is regex-based. Novel secret formats not covered by the pattern list will pass through.
- Very short tokens (< 20 chars) are intentionally ignored to avoid false positives on code content.
- Redaction happens at write boundaries, not in-memory. Debug breakpoints on live objects will see raw values.
- `redactObject` performs a deep clone; for very large objects this has a cost.

## Adding new patterns

Edit `core/redaction.ts` and add a new entry to the `RULES` array:

```typescript
{ pattern: /your-regex/g, label: "<redacted:your_label>" },
```

Then add a test case in `core/redaction.test.ts`.
