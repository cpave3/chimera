import type { LanguageModel } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { askModel } from '../src/ask-model';

function modelThatSays(text: string) {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  }) as unknown as LanguageModel;
  return { model, prompts };
}

describe('askModel', () => {
  it('sends the system text and the question, and gives back the text of the answer', async () => {
    const { model, prompts } = modelThatSays('{"decision": "allow"}');

    const answer = await askModel({ model, system: 'You review.', prompt: 'May this run?' });

    expect(answer).toBe('{"decision": "allow"}');
    expect(JSON.stringify(prompts[0])).toContain('You review.');
    expect(JSON.stringify(prompts[0])).toContain('May this run?');
  });

  it('hands its signal to the model call, so a caller can stop it', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        signals.push(options.abortSignal);
        throw new Error('stopped by the caller');
      },
    }) as unknown as LanguageModel;
    const stop = new AbortController();

    await expect(
      askModel({ model, system: 's', prompt: 'p', signal: stop.signal }),
    ).rejects.toThrow(/stopped by the caller/);
    expect(signals).toEqual([stop.signal]);
  });
});
