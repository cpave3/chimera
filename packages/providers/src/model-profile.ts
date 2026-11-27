import type { ModelCapabilities, ModelProfile } from '@chimera/core';

export interface ResolveModelProfileInput {
  modelId: string;
  contextWindow: number;
  /** The model's entry under `models` in config.json; each field wins over the family default. */
  options?: Partial<Pick<ModelProfile, 'toolCallShape' | 'editFormat' | 'promptStyle'>>;
}

// GPT and Codex models are trained to edit with apply_patch. The id may carry
// a vendor prefix (OpenRouter-style `openai/gpt-5`) or be a bare proxy alias
// (`gpt`).
const GPT_FAMILY = /(^|\/)(gpt($|[-.\d])|chatgpt-|o\d|codex)/i;
const CLAUDE_FAMILY = /claude/i;

const OUTPUT_BUDGET_SHARE = 0.08;
const MIN_OUTPUT_BUDGET_TOKENS = 2_000;
const MAX_OUTPUT_BUDGET_TOKENS = 25_000;

/**
 * The bounded profile heuristic for generation budgets: 8% of the window,
 * clamped to [2_000, 25_000]. Used directly for the tool-output budget and,
 * capped by a discovered output limit, as the default `maxOutputTokens`.
 */
export function boundedOutputDefault(contextWindow: number): number {
  return Math.min(
    MAX_OUTPUT_BUDGET_TOKENS,
    Math.max(MIN_OUTPUT_BUDGET_TOKENS, Math.round(contextWindow * OUTPUT_BUDGET_SHARE)),
  );
}

/**
 * The default `maxOutputTokens` derived from discovery for a model whose
 * operator left the setting unset: the profile heuristic bounded by the
 * discovered output cap, and — so the value always satisfies its own
 * validation — by the context left above the discovered input cap. No value
 * is derived when the setting is unsupported, no output cap was discovered,
 * or the verified allowance leaves no usable room.
 */
export function derivedOutputDefault(
  capabilities: Pick<ModelCapabilities, 'limits' | 'settings'>,
  contextWindow: number,
): number | undefined {
  const limits = capabilities.limits;
  if (limits?.output.status !== 'discovered') return undefined;
  if (capabilities.settings.maxOutputTokens?.status !== 'supported') return undefined;
  let bounded = Math.min(boundedOutputDefault(contextWindow), limits.output.value);
  if (limits.context.status === 'discovered' && limits.input.status === 'discovered') {
    const outputRoom = limits.context.value - limits.input.value;
    if (outputRoom <= 0) return undefined;
    bounded = Math.min(bounded, outputRoom);
  }
  return bounded;
}

export function resolveModelProfile(input: ResolveModelProfileInput): ModelProfile {
  // A proxy alias (`sol`, `astra`) says nothing about the model behind it, but
  // asking for the codex tool shape does: it is a Codex-style model.
  const gpt = GPT_FAMILY.test(input.modelId) || input.options?.toolCallShape === 'codex';
  const known = gpt || CLAUDE_FAMILY.test(input.modelId);
  return {
    toolCallShape: input.options?.toolCallShape ?? 'chimera',
    editFormat: input.options?.editFormat ?? (gpt ? 'patch' : 'replace'),
    promptStyle: input.options?.promptStyle ?? (known ? 'lean' : 'guided'),
    outputBudgetTokens: boundedOutputDefault(input.contextWindow),
  };
}
