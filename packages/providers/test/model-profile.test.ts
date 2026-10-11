import { describe, expect, it } from 'vitest';
import { resolveModelProfile } from '../src/model-profile';

describe('resolveModelProfile', () => {
  const profileOf = (modelId: string, contextWindow = 200_000) =>
    resolveModelProfile({ modelId, contextWindow });

  it('gives GPT and Codex models the patch edit format and the lean prompt', () => {
    for (const modelId of ['gpt-5-codex', 'gpt-4.1', 'o3-mini', 'openai/gpt-5', 'codex-mini']) {
      expect(profileOf(modelId)).toMatchObject({ editFormat: 'patch', promptStyle: 'lean' });
    }
  });

  it('gives Claude models string-replace edits and the lean prompt', () => {
    for (const modelId of ['claude-opus-4-7', 'anthropic/claude-sonnet-4-5']) {
      expect(profileOf(modelId)).toMatchObject({ editFormat: 'replace', promptStyle: 'lean' });
    }
  });

  it('gives a model it does not know string-replace edits and the guided prompt', () => {
    for (const modelId of ['qwen3-coder', 'kimi-k2', 'glm-4.6', 'deepseek-r1']) {
      expect(profileOf(modelId)).toMatchObject({ editFormat: 'replace', promptStyle: 'guided' });
    }
  });

  it('uses the native tool names unless the model asks for another shape', () => {
    expect(profileOf('gpt-5-codex').toolCallShape).toBe('chimera');
    expect(
      resolveModelProfile({
        modelId: 'gpt-5-codex',
        contextWindow: 200_000,
        options: { toolCallShape: 'codex' },
      }).toolCallShape,
    ).toBe('codex');
  });

  it('lets config override one field and keeps the defaults for the rest', () => {
    const profile = resolveModelProfile({
      modelId: 'qwen3-coder',
      contextWindow: 200_000,
      options: { promptStyle: 'lean' },
    });
    expect(profile).toMatchObject({ promptStyle: 'lean', editFormat: 'replace' });
  });

  it('sizes the output budget at 8% of the window between 2k and 25k tokens', () => {
    expect(profileOf('m', 16_000).outputBudgetTokens).toBe(2_000);
    expect(profileOf('m', 200_000).outputBudgetTokens).toBe(16_000);
    expect(profileOf('m', 1_000_000).outputBudgetTokens).toBe(25_000);
  });
});
