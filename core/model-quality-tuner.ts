/**
 * Model Quality Tuner — Adjusts prompts and verification based on model capabilities.
 *
 * Different models have different strengths and weaknesses. This module
 * provides model-specific tuning so weaker models get more structure
 * and tighter verification, while stronger models get more autonomy.
 *
 * Three tuning dimensions:
 *   1. Prompt tuning — more/less structured prompts
 *   2. Scope tuning — smaller/larger tasks per step
 *   3. Verification tuning — stricter/looser verification
 */

export interface ModelProfile {
  readonly provider: string;
  readonly model: string;
  readonly tier: 'strong' | 'medium' | 'weak';
  readonly capabilities: {
    readonly codeGeneration: number;   // 0-1, how good at generating code
    readonly codeReview: number;       // 0-1, how good at reviewing code
    readonly contextWindow: number;    // tokens
    readonly instructionFollowing: number; // 0-1, how well it follows instructions
    readonly reasoning: number;        // 0-1, reasoning capability
  };
  readonly tuning: {
    readonly promptStyle: 'minimal' | 'standard' | 'guided' | 'scaffolded';
    readonly maxFilesPerStep: number;
    readonly maxCharsPerFile: number;
    readonly verificationStrictness: 'relaxed' | 'standard' | 'strict';
    readonly requireTests: boolean;
    readonly requireDiffReview: boolean;
    readonly maxRetries: number;
    readonly cooldownMs: number;
  };
}

// ─── Model profiles ──────────────────────────────────────────────────

const MODEL_PROFILES: Record<string, ModelProfile> = {
  // Strong models — full autonomy
  'anthropic/claude-opus-4-7': {
    provider: 'anthropic', model: 'claude-opus-4-7', tier: 'strong',
    capabilities: { codeGeneration: 0.97, codeReview: 0.97, contextWindow: 200000, instructionFollowing: 0.97, reasoning: 0.97 },
    tuning: { promptStyle: 'minimal', maxFilesPerStep: 5, maxCharsPerFile: 80000, verificationStrictness: 'standard', requireTests: false, requireDiffReview: true, maxRetries: 2, cooldownMs: 2000 },
  },
  'anthropic/claude-sonnet-4-6': {
    provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'strong',
    capabilities: { codeGeneration: 0.95, codeReview: 0.95, contextWindow: 200000, instructionFollowing: 0.95, reasoning: 0.95 },
    tuning: { promptStyle: 'minimal', maxFilesPerStep: 5, maxCharsPerFile: 80000, verificationStrictness: 'standard', requireTests: false, requireDiffReview: true, maxRetries: 2, cooldownMs: 2000 },
  },
  'anthropic/claude-sonnet-4-5-20250514': {
    provider: 'anthropic', model: 'claude-sonnet-4-5-20250514', tier: 'strong',
    capabilities: { codeGeneration: 0.93, codeReview: 0.93, contextWindow: 200000, instructionFollowing: 0.93, reasoning: 0.93 },
    tuning: { promptStyle: 'minimal', maxFilesPerStep: 5, maxCharsPerFile: 80000, verificationStrictness: 'standard', requireTests: false, requireDiffReview: true, maxRetries: 2, cooldownMs: 2000 },
  },
  'openai/gpt-5.4': {
    provider: 'openai', model: 'gpt-5.4', tier: 'strong',
    capabilities: { codeGeneration: 0.92, codeReview: 0.90, contextWindow: 272000, instructionFollowing: 0.92, reasoning: 0.92 },
    tuning: { promptStyle: 'minimal', maxFilesPerStep: 5, maxCharsPerFile: 80000, verificationStrictness: 'standard', requireTests: false, requireDiffReview: true, maxRetries: 2, cooldownMs: 2000 },
  },

  // Medium models — standard handling
  'openrouter/xiaomi/mimo-v2.5-pro': {
    provider: 'openrouter', model: 'xiaomi/mimo-v2.5-pro', tier: 'medium',
    capabilities: { codeGeneration: 0.85, codeReview: 0.80, contextWindow: 1024000, instructionFollowing: 0.85, reasoning: 0.85 },
    tuning: { promptStyle: 'guided', maxFilesPerStep: 3, maxCharsPerFile: 60000, verificationStrictness: 'standard', requireTests: false, requireDiffReview: true, maxRetries: 3, cooldownMs: 3000 },
  },
  'openrouter/deepseek/deepseek-v4-pro': {
    provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', tier: 'medium',
    capabilities: { codeGeneration: 0.83, codeReview: 0.80, contextWindow: 128000, instructionFollowing: 0.83, reasoning: 0.83 },
    tuning: { promptStyle: 'guided', maxFilesPerStep: 3, maxCharsPerFile: 60000, verificationStrictness: 'standard', requireTests: false, requireDiffReview: true, maxRetries: 3, cooldownMs: 3000 },
  },
  'portum/qwen3.6-plus': {
    provider: 'portum', model: 'qwen3.6-plus', tier: 'medium',
    capabilities: { codeGeneration: 0.80, codeReview: 0.75, contextWindow: 131072, instructionFollowing: 0.80, reasoning: 0.80 },
    tuning: { promptStyle: 'guided', maxFilesPerStep: 2, maxCharsPerFile: 50000, verificationStrictness: 'strict', requireTests: true, requireDiffReview: true, maxRetries: 3, cooldownMs: 4000 },
  },

  // Weak models — more structure, tighter verification
  'openrouter/deepseek/deepseek-v4-flash': {
    provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', tier: 'weak',
    capabilities: { codeGeneration: 0.70, codeReview: 0.65, contextWindow: 128000, instructionFollowing: 0.70, reasoning: 0.65 },
    tuning: { promptStyle: 'scaffolded', maxFilesPerStep: 1, maxCharsPerFile: 30000, verificationStrictness: 'strict', requireTests: true, requireDiffReview: true, maxRetries: 4, cooldownMs: 5000 },
  },
  'openrouter/moonshotai/kimi-k2': {
    provider: 'openrouter', model: 'moonshotai/kimi-k2', tier: 'weak',
    capabilities: { codeGeneration: 0.68, codeReview: 0.65, contextWindow: 128000, instructionFollowing: 0.70, reasoning: 0.65 },
    tuning: { promptStyle: 'scaffolded', maxFilesPerStep: 1, maxCharsPerFile: 30000, verificationStrictness: 'strict', requireTests: true, requireDiffReview: true, maxRetries: 4, cooldownMs: 5000 },
  },
  'ollama/qwen3.5:9b': {
    provider: 'ollama', model: 'qwen3.5:9b', tier: 'weak',
    capabilities: { codeGeneration: 0.55, codeReview: 0.50, contextWindow: 32000, instructionFollowing: 0.60, reasoning: 0.50 },
    tuning: { promptStyle: 'scaffolded', maxFilesPerStep: 1, maxCharsPerFile: 20000, verificationStrictness: 'strict', requireTests: true, requireDiffReview: true, maxRetries: 5, cooldownMs: 5000 },
  },
};

const DEFAULT_PROFILE: ModelProfile = {
  provider: 'unknown', model: 'unknown', tier: 'medium',
  capabilities: { codeGeneration: 0.75, codeReview: 0.70, contextWindow: 128000, instructionFollowing: 0.75, reasoning: 0.70 },
  tuning: { promptStyle: 'standard', maxFilesPerStep: 2, maxCharsPerFile: 40000, verificationStrictness: 'standard', requireTests: false, requireDiffReview: true, maxRetries: 3, cooldownMs: 3000 },
};

// ─── Public API ──────────────────────────────────────────────────────

export function getModelProfile(provider: string, model: string): ModelProfile {
  const key = `${provider}/${model}`;
  return MODEL_PROFILES[key] ?? DEFAULT_PROFILE;
}

export function getModelTier(provider: string, model: string): ModelProfile['tier'] {
  return getModelProfile(provider, model).tier;
}

/**
 * Tune a Builder prompt for the specific model.
 * Weak models get more structure, explicit examples, and tighter constraints.
 */
export function tuneBuilderPrompt(
  basePrompt: string,
  provider: string,
  model: string,
): string {
  const profile = getModelProfile(provider, model);

  switch (profile.tuning.promptStyle) {
    case 'minimal':
      // Strong models — just the facts
      return basePrompt;

    case 'standard':
      // Medium models — add a structure reminder
      return `${basePrompt}

IMPORTANT: Return ONLY the modified file content. Do not include explanations, markdown, or code fences. Just the code.`;

    case 'guided':
      // Medium-weak models — explicit guidance
      return `${basePrompt}

INSTRUCTIONS:
1. Read the original file carefully
2. Make ONLY the changes required by the goal
3. Return the COMPLETE modified file content
4. Do NOT include explanations, markdown, or code fences
5. Do NOT add unrelated changes
6. Preserve all existing imports, exports, and structure
7. If you are unsure about a change, make the minimal safe change`;

    case 'scaffolded':
      // Weak models — maximum structure
      return `${basePrompt}

CRITICAL INSTRUCTIONS:
1. READ the original file completely before making changes
2. Make ONLY the specific changes required by the goal — nothing else
3. Return the COMPLETE modified file as plain text (no markdown, no code fences)
4. Preserve ALL existing code that is not being changed
5. Preserve ALL imports, exports, types, and interfaces
6. Do NOT add new imports unless absolutely necessary
7. Do NOT add comments unless the goal specifically asks for them
8. Do NOT reformat code that is not being changed
9. If the goal is ambiguous, make the MINIMAL safe change
10. Return ONLY the file content — no explanations, no preamble, no postamble

EXAMPLE OF CORRECT OUTPUT:
[the complete modified file content goes here, nothing else]`;
  }
}

/**
 * Tune verification strictness for the specific model.
 * Weak models get stricter verification.
 */
export function getVerificationConfig(provider: string, model: string) {
  const profile = getModelProfile(provider, model);

  return {
    strictness: profile.tuning.verificationStrictness,
    requireTests: profile.tuning.requireTests,
    requireDiffReview: profile.tuning.requireDiffReview,
    maxRetries: profile.tuning.maxRetries,
    cooldownMs: profile.tuning.cooldownMs,
    maxFilesPerStep: profile.tuning.maxFilesPerStep,
    maxCharsPerFile: profile.tuning.maxCharsPerFile,
  };
}

/**
 * Check if a model is strong enough for a given task complexity.
 */
export function isModelSufficient(
  provider: string,
  model: string,
  taskComplexity: 'simple' | 'moderate' | 'complex',
): boolean {
  const profile = getModelProfile(provider, model);

  switch (taskComplexity) {
    case 'simple':
      return profile.capabilities.codeGeneration >= 0.5;
    case 'moderate':
      return profile.capabilities.codeGeneration >= 0.7;
    case 'complex':
      return profile.capabilities.codeGeneration >= 0.85;
  }
}

/**
 * Recommend a model upgrade path when the current model is failing.
 */
export function recommendUpgrade(
  currentProvider: string,
  currentModel: string,
): { provider: string; model: string; reason: string } | null {
  const current = getModelProfile(currentProvider, currentModel);

  if (current.tier === 'strong') return null; // Already at the top

  // Upgrade path: weak → medium → strong
  if (current.tier === 'weak') {
    return {
      provider: 'portum',
      model: 'qwen3.6-plus',
      reason: `Upgrading from weak tier (${currentModel}) to medium tier for better quality`,
    };
  }

  if (current.tier === 'medium') {
    return {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      reason: `Upgrading from medium tier (${currentModel}) to strong tier for better quality`,
    };
  }

  return null;
}
