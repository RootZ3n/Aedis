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
 * Returns a VelumResult with the highest-severity decision found.
 */
export function scanInput(task: string, context?: string[]): VelumResult {
  const reasons: string[] = [];
  const flags: string[] = [];
  let maxSeverity: "allow" | "warn" | "review" | "block" = "allow";

  const textsToScan = [task, ...(context ?? [])];

  for (const text of textsToScan) {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(text)) {
        flags.push(pattern.flag);
        reasons.push(pattern.reason);
        maxSeverity = escalate(maxSeverity, pattern.severity);
      }
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
