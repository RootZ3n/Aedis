import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { getModelProfile, getModelTier, tuneBuilderPrompt, getVerificationConfig, isModelSufficient, recommendUpgrade } from './model-quality-tuner.js';

describe('getModelProfile', () => {
  it('returns strong profile for claude-sonnet-4-6', () => {
    const profile = getModelProfile('anthropic', 'claude-sonnet-4-6');
    assert.equal(profile.tier, 'strong');
    assert.equal(profile.tuning.promptStyle, 'minimal');
    assert.equal(profile.tuning.verificationStrictness, 'standard');
  });

  it('returns medium profile for qwen3.6-plus', () => {
    const profile = getModelProfile('portum', 'qwen3.6-plus');
    assert.equal(profile.tier, 'medium');
    assert.equal(profile.tuning.promptStyle, 'guided');
  });

  it('returns weak profile for deepseek-v4-flash', () => {
    const profile = getModelProfile('openrouter', 'deepseek/deepseek-v4-flash');
    assert.equal(profile.tier, 'weak');
    assert.equal(profile.tuning.promptStyle, 'scaffolded');
    assert.equal(profile.tuning.requireTests, true);
  });

  it('returns default profile for unknown model', () => {
    const profile = getModelProfile('unknown', 'unknown-model');
    assert.equal(profile.tier, 'medium');
  });
});

describe('getModelTier', () => {
  it('returns correct tiers', () => {
    assert.equal(getModelTier('anthropic', 'claude-sonnet-4-6'), 'strong');
    assert.equal(getModelTier('portum', 'qwen3.6-plus'), 'medium');
    assert.equal(getModelTier('openrouter', 'deepseek/deepseek-v4-flash'), 'weak');
  });
});

describe('tuneBuilderPrompt', () => {
  it('returns minimal prompt for strong models', () => {
    const result = tuneBuilderPrompt('base prompt', 'anthropic', 'claude-sonnet-4-6');
    assert.equal(result, 'base prompt');
  });

  it('adds structure reminder for standard models', () => {
    const result = tuneBuilderPrompt('base prompt', 'portum', 'qwen3.6-plus');
    assert.ok(result.length > 'base prompt'.length, 'Should add tuning text');
    assert.ok(result.includes('IMPORTANT') || result.includes('modified file'), 'Should contain guidance');
  });

  it('adds explicit guidance for guided models', () => {
    const result = tuneBuilderPrompt('base prompt', 'openrouter', 'deepseek/deepseek-v4-flash');
    assert.ok(result.length > 'base prompt'.length, 'Should add tuning text');
    assert.ok(result.includes('INSTRUCTIONS') || result.includes('guidance'), 'Should contain guidance');
  });

  it('adds maximum structure for scaffolded models', () => {
    const result = tuneBuilderPrompt('base prompt', 'ollama', 'qwen3.5:9b');
    assert.ok(result.length > 'base prompt'.length, 'Should add tuning text');
    assert.ok(result.includes('CRITICAL') || result.includes('EXAMPLE') || result.includes('instructions'), 'Should contain maximum structure');
  });
});

describe('getVerificationConfig', () => {
  it('returns standard verification for strong models', () => {
    const config = getVerificationConfig('anthropic', 'claude-sonnet-4-6');
    assert.equal(config.strictness, 'standard');
    assert.equal(config.requireTests, false);
  });

  it('returns strict verification for weak models', () => {
    const config = getVerificationConfig('openrouter', 'deepseek/deepseek-v4-flash');
    assert.equal(config.strictness, 'strict');
    assert.equal(config.requireTests, true);
    assert.ok(config.maxRetries >= 4);
  });
});

describe('isModelSufficient', () => {
  it('strong models handle complex tasks', () => {
    assert.equal(isModelSufficient('anthropic', 'claude-sonnet-4-6', 'complex'), true);
  });

  it('weak models cannot handle complex tasks', () => {
    assert.equal(isModelSufficient('ollama', 'qwen3.5:9b', 'complex'), false);
  });

  it('weak models can handle simple tasks', () => {
    assert.equal(isModelSufficient('ollama', 'qwen3.5:9b', 'simple'), true);
  });
});

describe('recommendUpgrade', () => {
  it('returns null for strong models', () => {
    assert.equal(recommendUpgrade('anthropic', 'claude-sonnet-4-6'), null);
  });

  it('recommends upgrade for weak models', () => {
    const rec = recommendUpgrade('ollama', 'qwen3.5:9b');
    assert.ok(rec !== null);
    assert.equal(rec!.tier ?? 'medium', 'medium');
  });
});
