/**
 * Impact Classification Gate — classifies task impact level before
 * the Builder runs. Drives approval requirements and verification
 * strictness.
 *
 * HIGH  → requireApproval = true
 * MEDIUM → stricter verification (strictVerification = true)
 * LOW   → normal execution
 */

export type ImpactLevel = "low" | "medium" | "high";

export interface ImpactClassification {
  readonly level: ImpactLevel;
  readonly reasons: string[];
}

// ─── HIGH patterns: auth, security, migrations, public API ──────────

const HIGH_TASK_PATTERNS: readonly RegExp[] = [
  /\b(auth|authentication|authorization|oauth|jwt|session|login|logout|signup|sign.?up|sign.?in)\b/i,
  /\b(security|vulnerability|cve|exploit|injection|xss|csrf|cors)\b/i,
  /\b(migration|migrate|schema\s+change|alter\s+table|drop\s+table|add\s+column)\b/i,
  /\b(public\s+api|api\s+endpoint|rest\s+api|graphql\s+schema|openapi|swagger)\b/i,
  /\b(secret|credential|password|token|api.?key|private.?key|certificate)\b/i,
  /\b(permission|rbac|acl|role|privilege|admin\s+access)\b/i,
  /\b(encryption|decrypt|hash|salt|bcrypt|argon)\b/i,
];

const HIGH_FILE_PATTERNS: readonly RegExp[] = [
  /\bauth[/\\]/i,
  /\bsecurity[/\\]/i,
  /\bmigration/i,
  /\.sql$/i,
  /\broute[sr]?\.(ts|js|py|go|rs)$/i,
  /\bapi[/\\]/i,
  /\bmiddleware[/\\].*auth/i,
  /\.env($|\.)/,
  /\bsecret/i,
  /\bcors\b/i,
];

/**
 * Classify the impact level of a task based on the prompt text
 * and the files it touches.
 */
export function classifyTask(task: string, files: string[]): ImpactClassification {
  const reasons: string[] = [];

  // Check HIGH task patterns
  for (const pattern of HIGH_TASK_PATTERNS) {
    if (pattern.test(task)) {
      reasons.push(`task matches high-impact pattern: ${pattern.source}`);
    }
  }

  // Check HIGH file patterns
  for (const file of files) {
    for (const pattern of HIGH_FILE_PATTERNS) {
      if (pattern.test(file)) {
        reasons.push(`file "${file}" matches high-impact pattern`);
        break; // one reason per file is enough
      }
    }
  }

  if (reasons.length > 0) {
    return { level: "high", reasons };
  }

  // MEDIUM: multiple files
  if (files.length > 1) {
    return {
      level: "medium",
      reasons: [`${files.length} files in scope`],
    };
  }

  return { level: "low", reasons: [] };
}
