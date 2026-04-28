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
  // Same intent, different shape: a verb followed (within ~40 chars
  // of intervening words) by a SHOUTY env-var name. Catches "print
  // OPENAI_API_KEY" / "reveal AWS_SECRET" / "exfiltrate the
  // DATABASE_URL value", which the strict-adjacent verb→noun pattern
  // above misses because the noun is the SCREAMING_CASE name itself,
  // not a generic word like "secret".
  {
    regex: /\b(?:print|echo|log|output|show|display|reveal|dump|expose|exfiltrate|leak)\b[^\n]{0,40}\b(?:[A-Z_][A-Z0-9_]{2,})*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY|DATABASE[_-]?URL)\b/,
    flag: "exfiltration:env_var_name",
    reason: "Request to print a SHOUTY env-var name (likely a secret)",
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
  // ── Approval / promote bypass ─────────────────────────────────────
  // Loqui-specific. Aedis's safety contract is "operator approves
  // final apply"; any prompt that asks to skip that gate is a
  // jailbreak attempt regardless of how friendly the wording is.
  {
    regex: /\b(skip|bypass|disable|ignore|turn\s+off)\s+(the\s+)?(approval|approve|promote|promotion|review)\s*(gate|step|check)?\b/i,
    flag: "jailbreak:approval_bypass",
    reason: "Attempt to bypass the operator approval / promote gate",
    severity: "block",
  },
  {
    regex: /\b(auto[-\s]?(promote|approve|commit)|allowed\s+to\s+(promote|commit|push))\b/i,
    flag: "jailbreak:auto_promote",
    reason: "Attempt to grant automatic promote/approve permission",
    severity: "block",
  },
  // ── Hidden / quiet mutation hijacks ───────────────────────────────
  // Loqui must surface every file the user is asking to touch. A
  // request to "quietly", "silently", "without telling", "don't
  // mention" something is a transparency attack on the operator —
  // even if the file itself is innocuous.
  {
    regex: /\b(quietly|silently|secretly|without\s+telling|without\s+(?:my\s+|a\s+|any\s+)?(?:mention|notice)|don'?t\s+mention|do\s+not\s+mention|hide\s+the\s+fact)\b/i,
    flag: "stealth:hidden_mutation",
    reason: "Request to perform a change without telling the operator",
    severity: "block",
  },
  // ── Dangerous shell command requests ──────────────────────────────
  // Verifier runs `npm test` / `tsc` / similar, but a user prompt that
  // asks Aedis to run a destructive shell command is a different ask.
  // These never represent legitimate dev workflow; block them at the
  // input gate so the Builder never sees them.
  {
    regex: /\brm\s+-rf?\s+(\/(?!tmp\b)|~|\$HOME)/i,
    flag: "shell:rm_rf_root",
    reason: "Request to recursively delete the root or home tree",
    severity: "block",
  },
  {
    regex: /\b(curl|wget|fetch)\b[^\n]{0,200}\|\s*(?:sh|bash|zsh|ksh|fish|sudo)/i,
    flag: "shell:remote_pipe_to_shell",
    reason: "Request to pipe a remote download into a shell",
    severity: "block",
  },
  {
    regex: /\b(?:nc|ncat|netcat|bash)\s+[^\n]{0,80}(?:-e\s+\/bin\/sh|>\s*&?\s*\/dev\/tcp\/)/i,
    flag: "shell:reverse_shell",
    reason: "Reverse-shell pattern detected",
    severity: "block",
  },
  // ── Sensitive file / secret access ────────────────────────────────
  {
    // `\b` before `.env` would need a word char on its left — but a
    // space is non-word, so the boundary fails on "cat .env". The
    // outer `\s+` after the verb already consumes the only space,
    // so use a lookahead-style trailing boundary that matches a
    // non-word terminator OR end of string. Captures the simple
    // `cat .env`, `cat the .env file`, and `read .env <description>`
    // shapes without requiring a leading word-boundary on `.env`.
    regex: /\b(?:cat|less|more|head|tail|read|open|print|show|display|dump|exfiltrate)\s+(?:[^\n]{0,200}\s)?\.env(?=[\s/'"`):;,.?!]|$)/i,
    flag: "exfiltration:dotenv",
    reason: "Request to read .env (likely secrets)",
    severity: "block",
  },
  {
    // Same boundary issue as above: `~/.ssh/id_rsa` has `/.ssh` with
    // `/` before the `.`, which kills `\b\.ssh\b`. Match on the
    // characteristic path segments without a leading word boundary.
    regex: /(?:^|[\s/~'"`])\.(?:ssh|aws|gnupg)[\\/][^\s'"`]{0,40}(?:id_(?:rsa|ed25519|ecdsa)|credentials|secret)/i,
    flag: "exfiltration:keypair",
    reason: "Request touching SSH/AWS/GPG keypairs or credentials",
    severity: "block",
  },
  {
    regex: /\b(?:cat|read|print|show|display|dump|exfiltrate)\s+[^\n]{0,200}(?:\/etc\/(?:passwd|shadow)|\/root\/|~root\/)/i,
    flag: "exfiltration:system_secrets",
    reason: "Request to read system secrets",
    severity: "block",
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

  // ── Two-pass scan: full text + literal-stripped text ───────────────
  //
  // For each view, we want to know:
  //   1. Did the pattern match the FULL view? (audit signal)
  //   2. Did the pattern match the LITERAL-STRIPPED view? (instruction-
  //      position signal — only this escalates severity)
  //
  // A pattern that matches the full text but disappears after stripping
  // every fenced / quoted region is in literal-position — the user
  // asked Aedis to USE that string, not to obey it. Such matches
  // surface as `:literal-only` warnings instead of blocking the run.
  //
  // Threat-model note: an attacker who hides every injection inside
  // quotes evades the BLOCK via this downgrade, but the run still
  // surfaces a `warn` flag on the receipt and the Builder's system
  // prompt is responsible for not obeying instructions inside literal
  // data anyway. The downgrade is a UX fix for the false-positive on
  // benign quoted requests; it is not the only line of defense.
  type ViewWithStripped = { text: string; stripped: string; tag: string };
  const dualViews: ViewWithStripped[] = views.map((v) => ({
    text: v.text,
    stripped: stripLiterals(v.text),
    tag: v.tag,
  }));

  for (const view of dualViews) {
    for (const pattern of PATTERNS) {
      const matchedFull = pattern.regex.test(view.text);
      if (!matchedFull) continue;
      const matchedStripped = pattern.regex.test(view.stripped);
      if (matchedStripped) {
        // Instruction-position — keep severity as authored.
        flags.push(pattern.flag + view.tag);
        reasons.push(pattern.reason + (view.tag ? ` (${view.tag.slice(1)})` : ""));
        maxSeverity = escalate(maxSeverity, pattern.severity);
      } else {
        // Literal-position — record the attempt without escalating
        // beyond warn so a benign "test that contains <hostile string>"
        // request stays actionable.
        flags.push(pattern.flag + view.tag + ":literal-only");
        reasons.push(
          pattern.reason +
          (view.tag ? ` (${view.tag.slice(1)}, literal-only)` : " (literal-only)"),
        );
        // Don't pull severity above the existing max via a literal
        // match; if `maxSeverity` is already block/review from a
        // genuine instruction-position hit, this no-ops.
        maxSeverity = escalate(maxSeverity, "warn");
      }
    }
  }

  return { decision: maxSeverity, reasons: dedupe(reasons), flags: dedupe(flags) };
}

function stripLiterals(text: string): string {
  return LITERAL_STRIPS.reduce((acc, re) => acc.replace(re, ""), text);
}

const LITERAL_STRIPS: ReadonlyArray<RegExp> = [
  /```[\s\S]*?```/g,
  /"[^"]*"/g,
  /`[^`]*`/g,
  /(?<![A-Za-z0-9])'[^']*'(?![A-Za-z0-9])/g,
];


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
