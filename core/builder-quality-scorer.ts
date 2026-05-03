/**
 * Builder Quality Scorer — Real-time quality assessment of Builder output.
 *
 * Scores the Builder's raw model response + produced changes before
 * they enter the Critic pipeline. Catches garbage output early so
 * the Coordinator can retry with a stronger model or narrower scope
 * instead of wasting Critic/Verifier cycles on bad code.
 *
 * Five dimensions:
 *   1. Structural completeness — does the output have the right shape?
 *   2. Diff quality — are the changes sensible and non-empty?
 *   3. Code quality signals — does the code look right?
 *   4. Prompt adherence — did the model follow the contract?
 *   5. Anomaly detection — does the output look like garbage/hallucination?
 *
 * Decision thresholds:
 *   0.70+ → proceed to Critic
 *   0.50–0.69 → retry with stronger model or narrower scope
 *   below 0.50 → reject immediately, do not waste Critic cycles
 */

export type QualityDimension =
  | 'structural'
  | 'diff'
  | 'code'
  | 'adherence'
  | 'anomaly';

export interface QualityScore {
  readonly overall: number;
  readonly dimensions: Record<QualityDimension, number>;
  readonly issues: readonly string[];
  readonly decision: 'proceed' | 'retry' | 'reject';
  readonly retryReason?: string;
}

export interface QualityInput {
  /** The raw model response text. */
  readonly rawResponse: string;
  /** The produced file changes. */
  readonly changes: readonly FileChange[];
  /** The original file content (before changes). */
  readonly originalContent: string;
  /** The task contract/goal. */
  readonly goal: string;
  /** The prompt that was sent to the model. */
  readonly prompt: string;
  /** The model that was used. */
  readonly model: string;
  /** Section-edit mode flag. */
  readonly sectionEdit?: boolean;
}

interface FileChange {
  readonly file: string;
  readonly oldContent?: string;
  readonly newContent?: string;
  readonly diff?: string;
  readonly operation?: 'create' | 'modify' | 'delete';
}

// ─── Weight configuration ────────────────────────────────────────────

const WEIGHTS: Record<QualityDimension, number> = {
  structural: 0.20,
  diff: 0.25,
  code: 0.25,
  adherence: 0.15,
  anomaly: 0.15,
};

const PROCEED_THRESHOLD = 0.70;
const RETRY_THRESHOLD = 0.50;

// ─── Main scorer ─────────────────────────────────────────────────────

export function scoreBuilderQuality(input: QualityInput): QualityScore {
  const dimensions: Record<QualityDimension, number> = {
    structural: scoreStructural(input),
    diff: scoreDiff(input),
    code: scoreCode(input),
    adherence: scoreAdherence(input),
    anomaly: scoreAnomaly(input),
  };

  const issues: string[] = [];

  // Collect issues from each dimension
  if (dimensions.structural < 0.5) issues.push('Output lacks expected structural elements');
  if (dimensions.diff < 0.5) issues.push('Diff quality is poor or empty');
  if (dimensions.code < 0.5) issues.push('Code quality signals are weak');
  if (dimensions.adherence < 0.5) issues.push('Model did not follow the contract');
  if (dimensions.anomaly < 0.5) issues.push('Anomaly detected in output');

  // Weighted overall score
  const overall = Number(
    Object.entries(dimensions)
      .reduce((sum, [dim, score]) => sum + score * WEIGHTS[dim as QualityDimension], 0)
      .toFixed(3)
  );

  // Decision
  let decision: QualityScore['decision'];
  let retryReason: string | undefined;

  if (overall >= PROCEED_THRESHOLD) {
    decision = 'proceed';
  } else if (overall >= RETRY_THRESHOLD) {
    decision = 'retry';
    retryReason = determineRetryReason(dimensions, input);
  } else {
    decision = 'reject';
    retryReason = `Quality too low (${overall}) — ${issues.join('; ')}`;
  }

  return { overall, dimensions, issues, decision, retryReason };
}

// ─── Dimension scorers ───────────────────────────────────────────────

function scoreStructural(input: QualityInput): number {
  let score = 1.0;
  const response = input.rawResponse;

  // Check for expected structural elements
  if (!response || response.trim().length === 0) return 0.1;

  // Check for code blocks or diff markers
  const hasCodeBlock = /```[\s\S]*?```/.test(response);
  const hasDiffMarkers = /^[\+\-]/m.test(response) || /@@.*@@/.test(response);
  const hasFileReference = input.changes.length > 0 || /(?:file|change|edit|modify|patch)/i.test(response);

  if (!hasCodeBlock && !hasDiffMarkers && !hasFileReference) score -= 0.4;
  if (input.changes.length === 0 && !hasDiffMarkers) score -= 0.4;

  // Check for refusal patterns — refusals are critical failures
  const refusalPatterns = [
    /i (?:cannot|can't|won't|shouldn't|am unable to)/i,
    /i (?:don't|do not) (?:have|see|know|understand)/i,
    /sorry.*(?:can't|cannot|unable)/i,
    /i'm (?:not|unable|unable to)/i,
  ];
  for (const pattern of refusalPatterns) {
    if (pattern.test(response)) {
      return 0.1; // Refusal is a near-total failure
    }
  }

  return Math.max(0, score);
}

function scoreDiff(input: QualityInput): number {
  if (input.changes.length === 0) return 0.05;

  let score = 1.0;

  // Check if changes are non-empty
  const hasRealChanges = input.changes.some(c =>
    c.newContent && c.oldContent && c.newContent !== c.oldContent
  );
  if (!hasRealChanges) score -= 0.6;

  // Check diff quality
  for (const change of input.changes) {
    if (change.operation === 'delete' && !change.newContent) {
      // Deletions are fine
      continue;
    }
    if (!change.newContent || change.newContent.trim().length === 0) {
      score -= 0.2;
      continue;
    }
    // Check for trivial changes (just whitespace)
    const oldNormalized = (change.oldContent ?? '').replace(/\s+/g, '');
    const newNormalized = (change.newContent ?? '').replace(/\s+/g, '');
    if (oldNormalized === newNormalized) {
      score -= 0.15;
    }
    // Check for very large changes relative to original
    const originalSize = (change.oldContent ?? '').length;
    const newSize = change.newContent.length;
    if (originalSize > 0 && newSize > originalSize * 3) {
      score -= 0.1; // Suspiciously large expansion
    }
  }

  return Math.max(0, score);
}

function scoreCode(input: QualityInput): number {
  let score = 1.0;
  const response = input.rawResponse;

  // Empty response is a major code quality issue
  if (!response || response.trim().length === 0) return 0.1;

  // Check for common code quality signals
  const hasImports = /import\s+/.test(response) || /require\s*\(/.test(response);
  const hasExports = /export\s+/.test(response) || /module\.exports/.test(response);
  const hasFunctionDef = /function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|class\s+\w+/.test(response);
  const hasTypeAnnotations = /:\s*(?:string|number|boolean|void|any|unknown|Promise|Array|Record)/.test(response);

  // TypeScript/JavaScript specific
  const isTSFile = input.changes.some(c => /\.ts$|\.tsx$/.test(c.file));

  if (isTSFile) {
    // Check for syntax issues
    const unmatchedBraces = countUnmatched(response, '{', '}');
    const unmatchedParens = countUnmatched(response, '(', ')');
    const unmatchedBrackets = countUnmatched(response, '[', ']');

    if (Math.abs(unmatchedBraces) > 2) score -= 0.15;
    if (Math.abs(unmatchedParens) > 2) score -= 0.1;
    if (Math.abs(unmatchedBrackets) > 2) score -= 0.1;

    // Check for console.log pollution (not necessarily bad, but suspicious in production)
    const consoleLogs = (response.match(/console\.log/g) || []).length;
    if (consoleLogs > 5) score -= 0.1;
  }

  // Check for placeholder/hallucination patterns
  const placeholderPatterns = [
    /\{\{\s*(?:TODO|FIXME|PLACEHOLDER|XXX)\s*\}\}/i,
    /\/\/\s*TODO.*(?:implement|add|fix|write)/i,
    /\.\.\.(?:rest|more|etc)/i,
    /(?:here|there)\s+(?:goes|comes)\s+(?:the|a)/i,
  ];
  for (const pattern of placeholderPatterns) {
    if (pattern.test(response)) {
      score -= 0.1;
    }
  }

  return Math.max(0, score);
}

function scoreAdherence(input: QualityInput): number {
  let score = 1.0;
  const response = input.rawResponse;
  const goal = input.goal.toLowerCase();

  // Empty response completely fails adherence
  if (!response || response.trim().length === 0) return 0.1;

  // Check if the response addresses the goal
  const goalWords = goal.split(/\s+/).filter(w => w.length > 3);
  const responseLower = response.toLowerCase();
  const addressedWords = goalWords.filter(w => responseLower.includes(w));

  if (goalWords.length > 0) {
    const coverage = addressedWords.length / goalWords.length;
    if (coverage < 0.2) score -= 0.4; // Model completely ignored the goal
    else if (coverage < 0.4) score -= 0.2;
  }

  // Check for off-topic content
  const offTopicPatterns = [
    /(?:as an ai|as a language model|i am a)/i,
    /(?:i cannot|can't) (?:access|read|see|modify)/i,
    /(?:in general|generally speaking|typically)/i,
  ];
  for (const pattern of offTopicPatterns) {
    if (pattern.test(response)) {
      score -= 0.15;
      break;
    }
  }

  // Section-edit: check if the model edited the right section
  if (input.sectionEdit && input.changes.length > 0) {
    // If section-edit but the model produced changes outside the section,
    // that's a quality issue (should have been caught by refusal detection,
    // but some models edit the wrong section silently)
    score -= 0.05; // Small penalty — the section-refusal retry may have fixed it
  }

  return Math.max(0, score);
}

function scoreAnomaly(input: QualityInput): number {
  let score = 1.0;
  const response = input.rawResponse;

  // Check for repeated content (hallucination loop)
  const lines = response.split('\n');
  const uniqueLines = new Set(lines);
  if (lines.length > 10 && uniqueLines.size < lines.length * 0.5) {
    score -= 0.3; // Lots of repeated lines
  }

  // Check for extremely long response (possible generation loop)
  if (response.length > 50000) {
    score -= 0.2;
  }

  // Check for garbled output (mixed languages, random characters)
  const nonAsciiRatio = (response.match(/[^\x00-\x7F]/g) || []).length / Math.max(response.length, 1);
  if (nonAsciiRatio > 0.3) {
    score -= 0.2;
  }

  // Check for JSON.parse attempts in response (model outputting raw JSON instead of code)
  if (/^\s*[\{\[]/.test(response) && /[\}\]]\s*$/.test(response)) {
    try {
      JSON.parse(response);
      score -= 0.15; // Model output JSON instead of code
    } catch {
      // Not valid JSON — fine
    }
  }

  // Check for model echoing the prompt
  const promptEcho = input.prompt.slice(0, 200);
  if (response.includes(promptEcho)) {
    score -= 0.2;
  }

  return Math.max(0, score);
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

function determineRetryReason(
  dimensions: Record<QualityDimension, number>,
  input: QualityInput,
): string {
  const weakest = Object.entries(dimensions)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 2)
    .map(([dim]) => dim);

  const reasons: string[] = [];
  if (weakest.includes('structural')) reasons.push('output structure is poor');
  if (weakest.includes('diff')) reasons.push('diff quality is weak');
  if (weakest.includes('code')) reasons.push('code quality signals are low');
  if (weakest.includes('adherence')) reasons.push('model did not follow the contract');
  if (weakest.includes('anomaly')) reasons.push('anomalies detected in output');

  return `Quality below threshold — weakest dimensions: ${reasons.join(', ')}`;
}
