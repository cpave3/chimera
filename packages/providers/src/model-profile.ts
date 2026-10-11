import type { ModelProfile } from '@chimera/core';

export interface ResolveModelProfileInput {
  modelId: string;
  contextWindow: number;
  /** The model's entry under `models` in config.json; each field wins over the family default. */
  options?: Partial<Pick<ModelProfile, 'toolCallShape' | 'editFormat' | 'promptStyle'>>;
}

// GPT and Codex models are trained to edit with apply_patch. The id may carry
// a vendor prefix (OpenRouter-style `openai/gpt-5`).
const GPT_FAMILY = /(^|\/)(gpt-|chatgpt-|o\d|codex)/i;
const CLAUDE_FAMILY = /claude/i;

const OUTPUT_BUDGET_SHARE = 0.08;
const MIN_OUTPUT_BUDGET_TOKENS = 2_000;
const MAX_OUTPUT_BUDGET_TOKENS = 25_000;

export function resolveModelProfile(input: ResolveModelProfileInput): ModelProfile {
  const gpt = GPT_FAMILY.test(input.modelId);
  const known = gpt || CLAUDE_FAMILY.test(input.modelId);
  return {
    toolCallShape: input.options?.toolCallShape ?? 'chimera',
    editFormat: input.options?.editFormat ?? (gpt ? 'patch' : 'replace'),
    promptStyle: input.options?.promptStyle ?? (known ? 'lean' : 'guided'),
    outputBudgetTokens: Math.min(
      MAX_OUTPUT_BUDGET_TOKENS,
      Math.max(MIN_OUTPUT_BUDGET_TOKENS, Math.round(input.contextWindow * OUTPUT_BUDGET_SHARE)),
    ),
  };
}
