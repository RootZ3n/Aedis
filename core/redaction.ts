/**
 * Redaction — automatic private data stripping for Aedis outputs.
 *
 * Applied at persistence/display boundaries (receipts, burn-in JSONL,
 * server logs, TUI, provider attempt summaries). Does NOT mutate
 * in-memory objects used for debugging; always returns new values.
 *
 * Stable replacement labels preserve field structure for diagnostics:
 *   <redacted:api_key>  <redacted:token>  <redacted:secret>
 *   <redacted:email>    <redacted:path>   <redacted:jwt>
 *   <redacted:private_key>
 */

// ─── Pattern registry ────────────────────────────────────────────────

interface RedactionRule {
  readonly pattern: RegExp;
  readonly label: string;
}

const RULES: readonly RedactionRule[] = [
  // API keys — order matters: longer prefixes first
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: "<redacted:api_key>" },
  { pattern: /\bghp_[A-Za-z0-9]{36,}\b/g, label: "<redacted:api_key>" },
  { pattern: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g, label: "<redacted:api_key>" },
  { pattern: /\bsk-proj-[A-Za-z0-9\-_]{20,}\b/g, label: "<redacted:api_key>" },
  { pattern: /\bsk-or-[A-Za-z0-9\-_]{20,}\b/g, label: "<redacted:api_key>" },
  // Generic sk-* (OpenAI-style) — must NOT match short test placeholders
  { pattern: /\bsk-[A-Za-z0-9\-_]{20,}\b/g, label: "<redacted:api_key>" },

  // Bearer tokens in headers
  { pattern: /\b(Bearer\s+)[A-Za-z0-9\-_\.]{20,}/gi, label: "$1<redacted:token>" },

  // Private key blocks (PEM)
  { pattern: /-----BEGIN\s[\w\s]+?PRIVATE KEY-----[\s\S]*?-----END\s[\w\s]+?PRIVATE KEY-----/g, label: "<redacted:private_key>" },

  // JWTs — three base64url segments separated by dots
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, label: "<redacted:jwt>" },

  // .env-style assignments: KEY=value (single line)
  {
    pattern: /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|MINIMAX_API_KEY|MODELSTUDIO_API_KEY|ZAI_API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTH_TOKEN)\s*=\s*\S+/gi,
    label: "$1=<redacted:secret>",
  },

  // Home / user paths — Unix
  { pattern: /\/home\/[a-z_][a-z0-9_-]*/gi, label: "<redacted:path>" },
  // Home / user paths — Windows
  { pattern: /C:\\Users\\[A-Za-z0-9_.\- ]+/gi, label: "<redacted:path>" },

  // Emails — partial mask: keep first char + domain
  { pattern: /\b[A-Za-z0-9._%+\-]{2,}@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, label: "<redacted:email>" },
];

// ─── Core text redaction ─────────────────────────────────────────────

export function redactText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const rule of RULES) {
    // Reset lastIndex for global regexes reused across calls
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.label);
  }
  return out;
}

// ─── Deep object redaction ───────────────────────────────────────────

export function redactObject<T>(input: T): T {
  return cloneAndRedact(input) as T;
}

function cloneAndRedact(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.map(cloneAndRedact);
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = cloneAndRedact(v);
    }
    return out;
  }

  return value;
}

// ─── Boundary-specific helpers ───────────────────────────────────────

/**
 * Redact for receipt persistence. Same as redactObject — receipts get
 * full treatment since they are written to disk and may be shared.
 */
export function redactForReceipt<T>(input: T): T {
  return redactObject(input);
}

/**
 * Redact for model prompts. Currently identical to redactText — can be
 * made stricter later (e.g. strip all env vars, paths) without
 * changing the receipt contract.
 */
export function redactForModel(input: string): string {
  return redactText(input);
}

/**
 * Redact an error message or stack trace for safe logging.
 */
export function redactError(err: unknown): string {
  if (err instanceof Error) {
    return redactText(`${err.message}\n${err.stack ?? ""}`).trim();
  }
  return redactText(String(err));
}
