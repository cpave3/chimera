import { MockLanguageModelV3 } from 'ai/test';
import { expect, it } from 'vitest';
import { Agent } from '../src/agent';
import { LifecycleSource } from '../src/lifecycle';

it('publishes manual compaction through the same lifecycle as run compaction', async () => {
  const lifecycle = new LifecycleSource();
  const observed: string[] = [];
  lifecycle.subscribe((event) => {
    observed.push(event.type);
  });
  const agent = new Agent({
    cwd: '/tmp',
    model: { providerId: 'mock', modelId: 'mock', maxSteps: 1 },
    languageModel: new MockLanguageModelV3(),
    tools: {},
    sandboxMode: 'off',
    contextWindow: 200_000,
    lifecycle,
    compactor: {
      maybeCompact: async () => ({ ran: false }),
      compact: async () => ({
        summary: 'summary',
        tokensBefore: 100,
        tokensAfter: 20,
        messagesReplaced: 5,
      }),
    },
  });
  for await (const _event of agent.compactSession()) {
    /* drain */
  }
  await lifecycle.drain(agent.session.id);
  expect(observed).toEqual(['compaction_started', 'compaction_finished']);
});
