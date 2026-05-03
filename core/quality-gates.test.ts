import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { runQualityGates, type GateInput } from './quality-gates.js';

function makeInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    rawResponse: 'export function foo() { return 42; }',
    changes: [{ file: 'src/foo.ts', oldContent: 'export function foo() { return 0; }', newContent: 'export function foo() { return 42; }' }],
    originalContents: new Map([['src/foo.ts', 'export function foo() { return 0; }']]),
    goal: 'change return value to 42',
    targetFiles: ['src/foo.ts'],
    model: 'qwen3.6-plus',
    provider: 'portum',
    ...overrides,
  };
}

describe('runQualityGates', () => {
  it('passes all gates for good output', () => {
    const result = runQualityGates(makeInput());
    assert.equal(result.overall, true);
    assert.ok(result.passedCount >= 4, `Expected >= 4 passed, got ${result.passedCount}`);
    assert.equal(result.shouldRetry, false);
    assert.equal(result.shouldEscalate, false);
  });

  it('flags structural issues for empty response', () => {
    const result = runQualityGates(makeInput({ rawResponse: '' }));
    const structural = result.gates.find(g => g.gate === 'structural');
    assert.ok(structural, 'Should have structural gate');
    assert.ok(structural!.score < 0.5, 'Structural score should be low for empty response');
  });

  it('fails diff gate for zero changes', () => {
    const result = runQualityGates(makeInput({ changes: [] }));
    const diff = result.gates.find(g => g.gate === 'diff');
    assert.equal(diff?.passed, false);
  });

  it('detects regressions when test results worsen', () => {
    const result = runQualityGates(makeInput({
      testResults: { passed: 8, failed: 2, total: 10 },
      previousTestResults: { passed: 10, failed: 0, total: 10 },
    }));
    const regression = result.gates.find(g => g.gate === 'regression');
    assert.equal(regression?.passed, false);
    assert.ok(result.shouldEscalate, 'Should escalate on regression');
  });

  it('passes regression gate when no test results available', () => {
    const result = runQualityGates(makeInput());
    const regression = result.gates.find(g => g.gate === 'regression');
    assert.equal(regression?.passed, true);
  });

  it('flags unexpected file modifications', () => {
    const result = runQualityGates(makeInput({
      changes: [{ file: 'src/unrelated.ts', oldContent: 'a', newContent: 'b' }],
    }));
    const scope = result.gates.find(g => g.gate === 'scope');
    assert.ok(scope, 'Should have scope gate');
    assert.ok(scope!.score < 1.0, 'Scope score should be reduced for unexpected modifications');
    assert.ok(scope!.details && scope!.details.length > 0, 'Should have details about unexpected modifications');
  });

  it('flags refusal responses', () => {
    const result = runQualityGates(makeInput({
      rawResponse: "I cannot modify this file.",
    }));
    const structural = result.gates.find(g => g.gate === 'structural');
    assert.ok(structural, 'Should have structural gate');
    assert.ok(structural!.score < 0.7, 'Structural score should be low for refusal');
  });
});
