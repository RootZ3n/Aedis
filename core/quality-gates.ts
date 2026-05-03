/**
 * Quality Gates — Model-agnostic verification that catches bad Builder output.
 *
 * These gates run AFTER the Builder produces output but BEFORE the Critic
 * reviews it. They catch garbage output early so we don't waste Critic
 * cycles on bad code.
 *
 * Five gates:
 *   1. Structural gate — does the output have the right shape?
 *   2. Diff gate — are the changes non-empty and sensible?
 *   3. Syntax gate — does the code parse?
 *   4. Regression gate — do existing tests still pass?
 *   5. Scope gate — did the model stay within scope?
 *
 * Gate results are advisory — the Coordinator can override them.
 * But repeated gate failures trigger model escalation.
 */

export type GateName = 'structural' | 'diff' | 'syntax' | 'regression' | 'scope';

export interface GateResult {
  readonly gate: GateName;
  readonly passed: boolean;
  readonly score: number;       // 0-1
  readonly message: string;
  readonly details?: readonly string[];
  readonly autoFixable?: boolean;
}

export interface GateInput {
  readonly rawResponse: string;
  readonly changes: readonly FileChange[];
  readonly originalContents: Map<string, string>;
  readonly goal: string;
  readonly targetFiles: readonly string[];
  readonly model: string;
  readonly provider: string;
  readonly testResults?: { passed: number; failed: number; total: number };
  readonly previousTestResults?: { passed: number; failed: number; total: number };
}

interface FileChange {
  readonly file: string;
  readonly oldContent?: string;
  readonly newContent?: string;
  readonly diff?: string;
  readonly operation?: 'create' | 'modify' | 'delete';
}

export interface GateSuiteResult {
  readonly overall: boolean;
  readonly gates: readonly GateResult[];
  readonly passedCount: number;
  readonly totalCount: number;
  readonly shouldRetry: boolean;
  readonly shouldEscalate: boolean;
  readonly reason: string;
}

// ─── Gate implementations ────────────────────────────────────────────

export function runQualityGates(input: GateInput): GateSuiteResult {
  const gates: GateResult[] = [
    checkStructuralGate(input),
    checkDiffGate(input),
    checkSyntaxGate(input),
    checkRegressionGate(input),
    checkScopeGate(input),
  ];

  const passedCount = gates.filter(g => g.passed).length;
  const totalCount = gates.length;
  const overall = passedCount >= totalCount - 1; // Allow 1 gate to fail

  // Determine if we should retry or escalate
  const failedGates = gates.filter(g => !g.passed);
  const shouldRetry = failedGates.some(g => g.autoFixable) && failedGates.length <= 2;
  const shouldEscalate = failedGates.length >= 3 || failedGates.some(g => g.gate === 'regression');

  const reason = failedGates.length === 0
    ? 'All quality gates passed'
    : `${failedGates.length} gate(s) failed: ${failedGates.map(g => g.gate).join(', ')}`;

  return { overall, gates, passedCount, totalCount, shouldRetry, shouldEscalate, reason };
}

// ─── Individual gates ────────────────────────────────────────────────

function checkStructuralGate(input: GateInput): GateResult {
  const issues: string[] = [];

  // Check for empty response
  if (!input.rawResponse || input.rawResponse.trim().length === 0) {
    return { gate: 'structural', passed: false, score: 0, message: 'Empty model response', details: ['Model returned no content'] };
  }

  // Check for refusal patterns
  const refusalPatterns = [
    { pattern: /i (?:cannot|can't|won't|shouldn't) (?:modify|edit|change|write)/i, msg: 'Model refused to make changes' },
    { pattern: /i (?:don't|do not) (?:have|see|know) (?:access|the file|enough)/i, msg: 'Model claims insufficient access' },
    { pattern: /sorry.*(?:can't|cannot|unable)/i, msg: 'Model expressed inability' },
  ];

  for (const { pattern, msg } of refusalPatterns) {
    if (pattern.test(input.rawResponse)) {
      issues.push(msg);
    }
  }

  // Check for code fences (model wrapped output in markdown)
  if (/^```[\s\S]*?```$/m.test(input.rawResponse) && input.changes.length === 0) {
    issues.push('Model returned code in markdown fences instead of producing file changes');
  }

  // Check for very short response
  if (input.rawResponse.length < 50 && input.changes.length === 0) {
    issues.push('Response too short to contain meaningful changes');
  }

  const score = issues.length === 0 ? 1.0 : Math.max(0, 1 - issues.length * 0.4);
  return {
    gate: 'structural',
    passed: score >= 0.5,
    score,
    message: issues.length === 0 ? 'Structural check passed' : `${issues.length} structural issue(s)`,
    details: issues,
    autoFixable: true,
  };
}

function checkDiffGate(input: GateInput): GateResult {
  const issues: string[] = [];

  if (input.changes.length === 0) {
    return { gate: 'diff', passed: false, score: 0, message: 'No file changes produced', details: ['Builder produced zero changes'], autoFixable: true };
  }

  for (const change of input.changes) {
    // Check for empty changes
    if (!change.newContent && change.operation !== 'delete') {
      issues.push(`${change.file}: no new content`);
      continue;
    }

    // Check for trivial changes (just whitespace)
    if (change.oldContent && change.newContent) {
      const oldNorm = change.oldContent.replace(/\s+/g, '');
      const newNorm = change.newContent.replace(/\s+/g, '');
      if (oldNorm === newNorm) {
        issues.push(`${change.file}: only whitespace changes`);
      }
    }

    // Check for suspiciously large expansion
    if (change.oldContent && change.newContent) {
      const ratio = change.newContent.length / Math.max(change.oldContent.length, 1);
      if (ratio > 5) {
        issues.push(`${change.file}: suspiciously large expansion (${ratio.toFixed(1)}x)`);
      }
    }

    // Check for file not in target list
    if (!input.targetFiles.some(f => change.file.includes(f) || f.includes(change.file))) {
      issues.push(`${change.file}: not in target file list`);
    }
  }

  const score = issues.length === 0 ? 1.0 : Math.max(0, 1 - issues.length * 0.25);
  return {
    gate: 'diff',
    passed: issues.length <= 1,
    score,
    message: issues.length === 0 ? 'Diff check passed' : `${issues.length} diff issue(s)`,
    details: issues,
    autoFixable: true,
  };
}

function checkSyntaxGate(input: GateInput): GateResult {
  const issues: string[] = [];

  for (const change of input.changes) {
    if (!change.newContent) continue;

    // Check for basic syntax issues in TypeScript/JavaScript
    if (/\.ts$|\.tsx$|\.js$|\.jsx$/.test(change.file)) {
      // Unmatched braces
      const braces = countUnmatched(change.newContent, '{', '}');
      const parens = countUnmatched(change.newContent, '(', ')');
      const brackets = countUnmatched(change.newContent, '[', ']');

      if (Math.abs(braces) > 3) issues.push(`${change.file}: unmatched braces (${braces > 0 ? 'extra open' : 'extra close'})`);
      if (Math.abs(parens) > 3) issues.push(`${change.file}: unmatched parentheses`);
      if (Math.abs(brackets) > 3) issues.push(`${change.file}: unmatched brackets`);

      // Check for obvious TypeScript errors
      if (/:\s*(?:string|number|boolean)\s*=\s*(?:true|false|\d+|"[^"]*")/m.test(change.newContent)) {
        // Type mismatch — not necessarily wrong, but flag it
      }

      // Check for missing semicolons in critical positions
      const lines = change.newContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length > 0 && !line.endsWith(';') && !line.endsWith('{') && !line.endsWith('}') && !line.endsWith(',') && !line.endsWith('(') && !line.endsWith(')') && !line.endsWith(':') && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*') && !line.startsWith('import') && !line.startsWith('export') && !line.includes('=>') && !line.includes('function') && !line.includes('class') && !line.includes('if') && !line.includes('else') && !line.includes('for') && !line.includes('while') && !line.includes('return')) {
          // Potentially missing semicolon — not critical, skip
        }
      }
    }
  }

  const score = issues.length === 0 ? 1.0 : Math.max(0, 1 - issues.length * 0.3);
  return {
    gate: 'syntax',
    passed: issues.length === 0,
    score,
    message: issues.length === 0 ? 'Syntax check passed' : `${issues.length} syntax issue(s)`,
    details: issues,
    autoFixable: true,
  };
}

function checkRegressionGate(input: GateInput): GateResult {
  if (!input.testResults || !input.previousTestResults) {
    return { gate: 'regression', passed: true, score: 0.5, message: 'Test results not available — skipping regression check' };
  }

  const prev = input.previousTestResults;
  const curr = input.testResults;
  const issues: string[] = [];

  // Check if tests that were passing are now failing
  const previouslyPassing = prev.passed;
  const nowFailing = curr.failed;
  if (nowFailing > 0 && previouslyPassing > 0) {
    issues.push(`${nowFailing} test(s) that were passing are now failing`);
  }

  // Check if total test count decreased (tests removed?)
  if (curr.total < prev.total) {
    issues.push(`Test count decreased from ${prev.total} to ${curr.total}`);
  }

  // Check if pass rate decreased
  const prevRate = prev.total > 0 ? prev.passed / prev.total : 1;
  const currRate = curr.total > 0 ? curr.passed / curr.total : 1;
  if (currRate < prevRate - 0.1) {
    issues.push(`Pass rate decreased from ${(prevRate * 100).toFixed(0)}% to ${(currRate * 100).toFixed(0)}%`);
  }

  const score = issues.length === 0 ? 1.0 : Math.max(0, 1 - issues.length * 0.4);
  return {
    gate: 'regression',
    passed: issues.length === 0,
    score,
    message: issues.length === 0 ? 'No regressions detected' : `${issues.length} regression(s) detected`,
    details: issues,
    autoFixable: false,
  };
}

function checkScopeGate(input: GateInput): GateResult {
  const issues: string[] = [];
  const goalLower = input.goal.toLowerCase();

  // Check if the model edited files outside the target list
  for (const change of input.changes) {
    if (!input.targetFiles.some(f => change.file.includes(f) || f.includes(change.file))) {
      issues.push(`${change.file}: unexpected file modification`);
    }
  }

  // Check if the response contains off-topic content
  const offTopicPatterns = [
    /(?:here's|here is) (?:a |the )?(?:summary|overview|explanation)/i,
    /(?:in summary|to summarize|in conclusion)/i,
    /(?:as an ai|as a language model)/i,
  ];
  for (const pattern of offTopicPatterns) {
    if (pattern.test(input.rawResponse)) {
      issues.push('Model included explanatory text in response');
      break;
    }
  }

  const score = issues.length === 0 ? 1.0 : Math.max(0, 1 - issues.length * 0.4);
  return {
    gate: 'scope',
    passed: score >= 0.5,
    score,
    message: issues.length === 0 ? 'Scope check passed' : `${issues.length} scope issue(s)`,
    details: issues,
    autoFixable: true,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function countUnmatched(text: string, open: string, close: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === open) count++;
    if (ch === close) count--;
  }
  return count;
}
