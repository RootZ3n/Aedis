/**
 * Velum Output Guard — scans builder diffs for hardcoded secrets,
 * auth bypass patterns, security check disabling, and suspicious
 * outbound calls.
 *
 * This is a post-build security gate. It does NOT replace the Critic.
 * It runs after the Builder produces a diff and before the Critic reviews.
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
  // Hardcoded secrets
  {
    regex: /(?:^|\s)(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key|auth[_-]?token)\s*[:=]\s*["'][A-Za-z0-9+/=_\-]{16,}["']/im,
    flag: "secret:hardcoded_key",
    reason: "Hardcoded API key or secret token in diff",
    severity: "block",
  },
  {
    regex: /(?:^|\s)(?:password|passwd)\s*[:=]\s*["'][^"']{4,}["']/im,
    flag: "secret:hardcoded_password",
    reason: "Hardcoded password in diff",
    severity: "block",
  },
  {
    regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/m,
    flag: "secret:private_key",
    reason: "Private key material in diff",
    severity: "block",
  },
  {
    regex: /\bghp_[A-Za-z0-9]{36,}\b/,
    flag: "secret:github_token",
    reason: "GitHub personal access token in diff",
    severity: "block",
  },
  {
    regex: /\bsk-[A-Za-z0-9]{20,}\b/,
    flag: "secret:openai_key",
    reason: "OpenAI API key pattern in diff",
    severity: "block",
  },
  {
    regex: /\bAKIA[A-Z0-9]{16}\b/,
    flag: "secret:aws_access_key",
    reason: "AWS access key ID in diff",
    severity: "block",
  },
  // Auth bypass
  {
    regex: /(?:auth|authentication|authorization)\s*[:=]\s*(?:false|disabled|none|off|skip)/i,
    flag: "auth:bypass",
    reason: "Authentication disabled or bypassed",
    severity: "block",
  },
  {
    regex: /\bisAdmin\s*[:=]\s*true\b/i,
    flag: "auth:admin_escalation",
    reason: "Hardcoded admin privilege escalation",
    severity: "review",
  },
  {
    regex: /\btrust[_-]?proxy\s*[:=]\s*true\b/i,
    flag: "auth:trust_proxy",
    reason: "Proxy trust enabled — verify this is intentional",
    severity: "warn",
  },
  // Disabling validation / security checks
  {
    regex: /(?:eslint-disable|@ts-ignore|@ts-nocheck|noqa|noinspection).*(?:security|auth|xss|injection|sanitiz)/i,
    flag: "disable:security_lint",
    reason: "Security lint rule disabled",
    severity: "review",
  },
  {
    regex: /(?:verify|validate|sanitize|escape|check)\s*[:=]\s*false\b/i,
    flag: "disable:validation",
    reason: "Validation or sanitization disabled",
    severity: "review",
  },
  {
    regex: /\bno[_-]?verify\b|\b--no-verify\b/i,
    flag: "disable:no_verify",
    reason: "Verification bypass flag detected",
    severity: "warn",
  },
  // Suspicious outbound calls
  {
    regex: /\bfetch\s*\(\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)/i,
    flag: "outbound:fetch_external",
    reason: "Outbound fetch to external URL",
    severity: "warn",
  },
  {
    regex: /\bexec(?:File|Sync)?\s*\(\s*["'](?:curl|wget|nc|ncat)\b/i,
    flag: "outbound:shell_network",
    reason: "Shell-based network command in code",
    severity: "review",
  },
  {
    regex: /\beval\s*\(/i,
    flag: "dangerous:eval",
    reason: "eval() call detected — potential code injection",
    severity: "review",
  },
];

/**
 * Scan a diff string for security issues in builder output.
 * Only scans added lines (lines starting with +) to avoid
 * flagging removed code.
 */
export function scanDiff(diff: string): VelumResult {
  const reasons: string[] = [];
  const flags: string[] = [];
  let maxSeverity: "allow" | "warn" | "review" | "block" = "allow";

  // Extract only added lines from the diff (lines starting with +, excluding +++ headers)
  const addedLines = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");

  if (addedLines.length === 0) {
    return { decision: "allow", reasons: [], flags: [] };
  }

  for (const pattern of PATTERNS) {
    if (pattern.regex.test(addedLines)) {
      flags.push(pattern.flag);
      reasons.push(pattern.reason);
      maxSeverity = escalate(maxSeverity, pattern.severity);
    }
  }

  return { decision: maxSeverity, reasons, flags };
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
