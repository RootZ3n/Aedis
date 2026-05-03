import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { scoreBuilderQuality, type QualityInput } from './builder-quality-scorer.js';

function makeInput(overrides: Partial<QualityInput> = {}): QualityInput {
  return {
    rawResponse: 'export function foo() { return 42; }',
    changes: [{ file: 'src/foo.ts', oldContent: 'export function foo() { return 0; }', newContent: 'export function foo() { return 42; }' }],
    originalContent: 'export function foo() { return 0; }',
    goal: 'change return value to 42',
    prompt: 'Change the return value of foo to 42',
    model: 'qwen3.6-plus',
    ...overrides,
  };
}

describe('scoreBuilderQuality', () => {
  it('scores a good response highly', () => {
    const result = scoreBuilderQuality(makeInput());
    assert.ok(result.overall >= 0.7, `Expected >= 0.7, got ${result.overall}`);
    assert.equal(result.decision, 'proceed');
  });

  it('rejects empty responses', () => {
    const result = scoreBuilderQuality(makeInput({ rawResponse: '' }));
    assert.ok(result.overall < 0.5, `Expected < 0.5, got ${result.overall}`);
    assert.equal(result.decision, 'reject');
  });

  it('penalizes refusal responses', () => {
    const goodResult = scoreBuilderQuality(makeInput());
    const refusalResult = scoreBuilderQuality(makeInput({
      rawResponse: "I cannot modify this file because I don't have access.",
    }));
    assert.ok(refusalResult.overall < goodResult.overall, 'Refusal should score lower than good response');
    assert.ok(refusalResult.dimensions.structural < 0.5, 'Structural score should be low for refusal');
  });

  it('penalizes repeated content', () => {
    const repeated = Array(20).fill('same line repeated').join('\n');
    const result = scoreBuilderQuality(makeInput({ rawResponse: repeated }));
    assert.ok(result.dimensions.anomaly < 0.8, 'Should penalize repeated content');
  });

  it('penalizes extremely long responses', () => {
    const long = 'x'.repeat(60000);
    const result = scoreBuilderQuality(makeInput({ rawResponse: long }));
    assert.ok(result.dimensions.anomaly < 1.0, 'Should penalize extremely long response');
  });

  it('detects off-topic content', () => {
    const result = scoreBuilderQuality(makeInput({
      rawResponse: 'As an AI language model, I cannot access files. Here goes the explanation of the code.',
    }));
    assert.ok(result.dimensions.adherence < 0.8, 'Should penalize off-topic content');
  });

  it('handles zero changes gracefully', () => {
    const result = scoreBuilderQuality(makeInput({ changes: [] }));
    assert.ok(result.dimensions.diff < 0.5, 'Should penalize zero changes');
  });
});
