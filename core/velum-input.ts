/**
 * Velum Input Guard — scans task input for prompt injection,
 * system override attempts, secret exfiltration, and jailbreak patterns.
 *
 * This is a pre-execution security gate. It does NOT replace the Critic.
 * It runs before the Builder touches anything.
 */

export interface VelumResult {
  readonly decision: "allow" | "warn" | "review" | "block";
  readonly reasons: string[];
  readonly flags: string[];
}

interface Pattern {
  regex: RegExp;
  flag: string;
  reason: string;
  severity: "block" | "review" | "warn";
}

const PATTERNS: readonly Pattern[] = [
  // Prompt injection — "ignore previous instructions"
  {
    regex: /ignore\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|rules?|prompts?|guidelines?|directions?)/i,
    flag: "prompt_injection:ignore_previous",
    reason: "Attempt to override previous instructions",
    severity: "block",
  },
  {
    regex: /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)/i,
    flag: "prompt_injection:disregard",
    reason: "Attempt to disregard prior instructions",
    severity: "block",
  },
  {
    regex: /forget\s+(everything|all|what)\s+(you|i)\s+(told|said|know)/i,
    flag: "prompt_injection:forget",
    reason: "Attempt to clear instruction memory",
    severity: "block",
  },
  // System override
  {
    regex: /you\s+are\s+now\s+(a|an|the|my)\s+/i,
    flag: "override:role_reassignment",
    reason: "Attempt to reassign system role",
    severity: "block",
  },
  {
    regex: /new\s+(system\s+)?instructions?:\s*/i,
    flag: "override:new_instructions",
    reason: "Attempt to inject new system instructions",
    severity: "block",
  },
  {
    regex: /\bsystem\s*:\s*/i,
    flag: "override:system_prefix",
    reason: "Attempt to use system-level prefix",
    severity: "review",
  },
  // Secret/env exfiltration
  {
    regex: /\b(print|echo|log|output|show|display|reveal|dump)\s+(all\s+)?(env|environment|secret|password|token|key|credential|api.?key)/i,
    flag: "exfiltration:secrets",
    reason: "Request to expose secrets or environment variables",
    severity: "block",
  },
  {
    regex: /process\.env/i,
    flag: "exfiltration:process_env",
    reason: "Direct reference to process.env",
    severity: "warn",
  },
  {
    regex: /\$\{?\b(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|AWS_SECRET|DATABASE_URL)\b/i,
    flag: "exfiltration:env_var_reference",
    reason: "Reference to sensitive environment variable",
    severity: "warn",
  },
  // Instruction nesting
  {
    regex: /```\s*(system|instruction|prompt)\b/i,
    flag: "nesting:code_block_injection",
    reason: "Suspicious instruction nesting in code block",
    severity: "review",
  },
  {
    regex: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/i,
    flag: "nesting:chat_template_injection",
    reason: "Chat template markers detected in input",
    severity: "block",
  },
  // Jailbreak patterns
  {
    regex: /\b(DAN|do\s+anything\s+now|jailbreak|bypass\s+(safety|filter|guard|restriction))\b/i,
    flag: "jailbreak:known_pattern",
    reason: "Known jailbreak pattern detected",
    severity: "block",
  },
  {
    regex: /\b(pretend|act\s+as\s+if)\s+(there\s+are\s+)?no\s+(rules?|restrictions?|limits?|guardrails?|filters?)/i,
    flag: "jailbreak:pretend_no_rules",
    reason: "Attempt to bypass safety rules via pretend scenario",
    severity: "block",
  },
  {
    regex: /in\s+(developer|debug|maintenance|admin|root)\s+mode/i,
    flag: "jailbreak:mode_switch",
    reason: "Attempt to switch to privileged mode",
    severity: "review",
  },
];

/**
 * Scan task input (and optional context strings) for security threats.
 *
 * In addition to raw-pattern matching, the scanner runs each text
 * through a set of lightweight preprocessing passes so cheap evasions
 * don't slide by:
 *
 *   1. NFKC unicode normalization — collapses homoglyphs (Cyrillic `а`
 *      vs Latin `a`, width-forms, ligatures) down to canonical forms
 *      before regex matching.
 *   2. Whitespace/zero-width stripping — blocks patterns where the
 *      attacker inserts spaces or zero-width joiners between letters.
 *   3. Cross-line reassembly — joins adjacent lines on the full text
 *      so patterns split across newlines still match.
 *   4. Bounded base64 / URL-decode inspection — when a plausible
 *      base64 or percent-encoded span is detected, the decoded payload
 *      is scanned once. Decoding is capped at 4 KB per span and 16 KB
 *      total per input so this can never become a DoS surface.
 *
 * Detections from preprocessed views are flagged with `:normalized`,
 * `:joined`, or `:decoded` suffixes so operators can see which evasion
 * class the attacker tried to use.
 */
export function scanInput(task: string, context?: string[]): VelumResult {
  const reasons: string[] = [];
  const flags: string[] = [];
  let maxSeverity: "allow" | "warn" | "review" | "block" = "allow";

  const textsToScan = [task, ...(context ?? [])];

  const views: Array<{ text: string; tag: string }> = [];
  for (const text of textsToScan) {
    if (!text) continue;
    views.push({ text, tag: "" });
    // NFKC normalization folds homoglyphs and width-variants.
    let normalized: string;
    try {
      normalized = text.normalize("NFKC");
    } catch {
      normalized = text;
    }
    if (normalized !== text) views.push({ text: normalized, tag: ":normalized" });
    // Strip zero-width characters + collapse internal whitespace.
    const stripped = normalized
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\s+/g, " ");
    if (stripped !== normalized) views.push({ text: stripped, tag: ":normalized" });
    // Cross-line reassembly — join all lines into a single line so
    // patterns split across newlines are still visible. Keep bounded
    // to the original text length so this is always O(n).
    const joined = text.replace(/[\r\n]+/g, " ");
    if (joined !== text) views.push({ text: joined, tag: ":joined" });
    // Bounded base64 / URL-decode inspection. Only scan spans that
    // look plausibly encoded so cost stays bounded.
    for (const decoded of decodeSuspiciousSpans(text)) {
      views.push({ text: decoded, tag: ":decoded" });
    }
  }

  for (const view of views) {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(view.text)) {
        flags.push(pattern.flag + view.tag);
        reasons.push(pattern.reason + (view.tag ? ` (${view.tag.slice(1)})` : ""));
        maxSeverity = escalate(maxSeverity, pattern.severity);
      }
    }
  }

  return { decision: maxSeverity, reasons: dedupe(reasons), flags: dedupe(flags) };
}

/**
 * Pull base64 and percent-encoded spans out of `text` and decode them
 * so the scanner can inspect the underlying payload. Bounded:
 *   - each span capped at MAX_DECODE_SPAN_CHARS of output
 *   - total decoded output across all spans capped at
 *     MAX_DECODE_TOTAL_CHARS
 *
 * Anything that fails to decode or is not printable-ASCII-ish is
 * discarded silently — this preprocessor is best-effort and must
 * never throw.
 */
function decodeSuspiciousSpans(text: string): string[] {
  const out: string[] = [];
  let budget = MAX_DECODE_TOTAL_CHARS;

  // Percent-encoded spans: at least 3 consecutive %HH triples.
  const urlMatches = text.match(/(?:%[0-9A-Fa-f]{2}){3,}/g) ?? [];
  for (const span of urlMatches) {
    if (budget <= 0) break;
    try {
      const decoded = decodeURIComponent(span).slice(0, MAX_DECODE_SPAN_CHARS);
      if (isPrintableAsciiIsh(decoded)) {
        out.push(decoded);
        budget -= decoded.length;
      }
    } catch {
      // malformed percent-encoding — skip
    }
  }

  // Base64 spans: 24+ contiguous base64 chars, optional padding.
  const b64Matches = text.match(/[A-Za-z0-9+/]{24,}={0,2}/g) ?? [];
  for (const span of b64Matches) {
    if (budget <= 0) break;
    if (span.length % 4 !== 0 && !/=$/.test(span)) continue;
    try {
      const raw = Buffer.from(span, "base64").toString("utf8").slice(0, MAX_DECODE_SPAN_CHARS);
      if (raw.length >= 8 && isPrintableAsciiIsh(raw)) {
        out.push(raw);
        budget -= raw.length;
      }
    } catch {
      // not valid base64 — skip
    }
  }

  return out;
}

const MAX_DECODE_SPAN_CHARS = 4 * 1024;
const MAX_DECODE_TOTAL_CHARS = 16 * 1024;

function isPrintableAsciiIsh(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0x20 && code <= 0x7E) || code === 0x09 || code === 0x0A || code === 0x0D) {
      printable++;
    }
  }
  return printable / s.length >= 0.85;
}

function dedupe<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

const SEVERITY_ORDER: Record<string, number> = {
  allow: 0,
  warn: 1,
  review: 2,
  block: 3,
};

function escalate(
  current: "allow" | "warn" | "review" | "block",
  incoming: "warn" | "review" | "block",
): "allow" | "warn" | "review" | "block" {
  return SEVERITY_ORDER[incoming] > SEVERITY_ORDER[current] ? incoming : current;
}
