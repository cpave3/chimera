import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type AgentEvent, loadSession, persistSession } from '@chimera/core';
import { APICallError, jsonSchema, tool } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Compactor, type CompactorOptions, estimateTokens } from '../src';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function generated(text = '## Goal\nFix the build\n## Next Steps\nRun tests') {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage,
    warnings: [],
  };
}

function conversationModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'recovered' },
          { type: 'text-end', id: 'answer' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ],
      }),
    }),
  });
}

describe('real compaction recovery', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-recovery-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function agentWith(
    summaryModel: MockLanguageModelV3,
    options: Partial<CompactorOptions> = {},
    languageModel = conversationModel(),
  ) {
    const config = { enabled: true, reserveTokens: 2_000, keepRecentTokens: 1_000 };
    const compactor = new Compactor({
      home,
      config,
      contextWindow: 16_000,
      resolveModel: async () => summaryModel,
      ...options,
    });
    const agent = new Agent({
      cwd: '/tmp',
      home,
      model: { providerId: 'mock', modelId: 'main', maxSteps: 3 },
      languageModel,
      tools: {},
      sandboxMode: 'off',
      contextWindow: 16_000,
      compaction: config,
      compactor,
    });
    agent.session.messages.push({
      role: 'user',
      content: 'Fix the build.\n' + 'history '.repeat(20_000),
    });
    return agent;
  }

  async function run(agent: Agent) {
    const events: AgentEvent[] = [];
    for await (const event of agent.run('Run tests next')) events.push(event);
    return events;
  }

  it('bounds the summary request so an already overflowing session can continue', async () => {
    const requests: number[] = [];
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async (options) => {
          const size = JSON.stringify(options.prompt).length;
          requests.push(size);
          if (size > 14_000) throw new Error('maximum context length exceeded');
          return generated();
        },
      }),
    );
    const events = await run(agent);
    expect(requests.length).toBeGreaterThan(0);
    expect(Math.max(...requests)).toBeLessThan(14_000);
    expect(events.some((event) => event.type === 'compaction_finished')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', reason: 'stop' });
    expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
  });

  it('recovers with explicit loss warnings when the summary model stays unavailable', async () => {
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error('summary service unavailable');
        },
      }),
    );
    const events = await run(agent);
    expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
    expect(events.find((event) => event.type === 'compaction_finished')).toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining('summary service unavailable')]),
    });
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', reason: 'stop' });
  });

  it('retries a temporary summary failure before using an excerpt', async () => {
    let attempts = 0;
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async () => {
          attempts++;
          if (attempts === 1) throw new Error('service unavailable');
          return generated('## Goal\nKeep the important decision');
        },
      }),
    );
    await run(agent);
    expect(attempts).toBe(2);
    expect(JSON.stringify(agent.session.messages)).toContain('Keep the important decision');
  });

  it('puts a deadline on a summary model that never resolves', async () => {
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async () => {
          await stalled;
          return generated();
        },
      }),
      { requestTimeoutMs: 10 },
    );
    const pending = run(agent);
    try {
      const result = await Promise.race([
        pending,
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 700)),
      ]);
      expect(result).not.toBe('hung');
      expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
    } finally {
      release();
      await pending;
    }
  });

  it('uses the utility model after the selected compaction model fails', async () => {
    const selected = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('selected model unavailable');
      },
    });
    const utility = new MockLanguageModelV3({
      doGenerate: async () => generated('## Goal\nUtility model summary'),
    });
    const refs: string[] = [];
    const agent = agentWith(selected, {
      fallbackModel: 'mock/utility',
      resolveModel: async (ref) => {
        refs.push(ref);
        return ref === 'mock/utility' ? utility : selected;
      },
    });
    await run(agent);
    expect(refs).toContain('mock/utility');
    expect(JSON.stringify(agent.session.messages)).toContain('Utility model summary');
  });

  it('does not silently replace the conversation with an empty summary', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated('  ') }));
    const events = await run(agent);
    expect(events.find((event) => event.type === 'compaction_finished')).toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining('empty summary')]),
    });
    expect(JSON.stringify(agent.session.messages)).toContain('Fix the build');
  });

  it('recovers even when the configured keep-tail contains the whole over-limit history', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }), {
      config: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 100_000 },
    });
    const events = await run(agent);
    expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
    expect(JSON.stringify(agent.session.messages)).toContain('Run tests next');
    expect(events.find((event) => event.type === 'compaction_finished')).toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining('recovery')]),
    });
  });

  it('uses the active agent window rather than the shared compactor launch window', async () => {
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async () => generated('oversized summary '.repeat(10_000)),
      }),
      { contextWindow: 200_000 },
    );
    await run(agent);
    expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
  });

  it('reserves output space in the summary model own smaller window', async () => {
    const calls: { prompt: number; output: number | undefined }[] = [];
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async (options) => {
          calls.push({
            prompt: JSON.stringify(options.prompt).length,
            output: options.maxOutputTokens,
          });
          return generated();
        },
      }),
      {
        resolveContextWindow: () => 2_000,
        resolveCallOptions: async () => ({ maxOutputTokens: 16_000 }),
      },
    );
    await run(agent);
    expect(calls[0].prompt).toBeLessThan(1_500);
    expect(calls[0].output).toBeLessThanOrEqual(500);
  });

  it('shrinks again when the provider rejects the first compacted prompt too', async () => {
    let attempts = 0;
    const main = new MockLanguageModelV3({
      doStream: async (options) => {
        if (++attempts <= 2) {
          return {
            stream: simulateReadableStream({
              chunks: [{ type: 'error', error: new Error('maximum context length exceeded') }],
            }),
          };
        }
        return conversationModel().doStream(options);
      },
    });
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async () => generated('## Goal\n' + 'summary '.repeat(300)),
      }),
      {},
      main,
    );
    const events = await run(agent);
    expect(attempts).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', reason: 'stop' });
    expect(
      events.filter((event) => event.type === 'compaction_started' && event.reason === 'overflow'),
    ).toHaveLength(2);
  });

  it('checks before an output continuation, not only after tool calls', async () => {
    const prompts: number[] = [];
    const main = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt).length);
        if (prompts.length === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'text-start', id: 'long' },
                { type: 'text-delta', id: 'long', delta: 'output '.repeat(8_000) },
                { type: 'text-end', id: 'long' },
                { type: 'finish', finishReason: { unified: 'length', raw: 'length' }, usage },
              ],
            }),
          };
        }
        return conversationModel().doStream(options);
      },
    });
    const agent = agentWith(
      new MockLanguageModelV3({ doGenerate: async () => generated() }),
      {},
      main,
    );
    await run(agent);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBeLessThan(16_000);
  });

  it('includes the system prompt in the first-request projection', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }));
    agent.session.messages.splice(0, agent.session.messages.length, {
      role: 'user',
      content: 'x'.repeat(12_000),
    });
    agent.setSystemPrompt('instructions '.repeat(2_000));
    const events = await run(agent);
    expect(events.some((event) => event.type === 'compaction_started')).toBe(true);
  });

  it('interrupts an in-flight summary without rewriting the conversation', async () => {
    let release!: () => void;
    let requested!: () => void;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async () => {
          requested();
          await stalled;
          return generated();
        },
      }),
    );
    const pending = run(agent);
    await started;
    agent.interrupt();
    try {
      const result = await Promise.race([
        pending,
        new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 100)),
      ]);
      expect(result).not.toBe('hung');
      expect(estimateTokens(agent.session.messages)).toBeGreaterThan(8_000);
      expect((result as AgentEvent[]).at(-1)).toMatchObject({
        type: 'run_finished',
        reason: 'interrupted',
      });
    } finally {
      release();
      await pending;
    }
  });

  it('persists a manual compaction before reporting it finished', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }));
    await persistSession(
      agent.session,
      {
        type: 'message_appended',
        messages: agent.session.messages,
        toolCalls: [],
        usage: agent.session.usage,
      },
      home,
    );
    for await (const event of agent.compactSession()) {
      if (event.type === 'compaction_finished') break;
    }
    const restored = await loadSession(agent.session.id, home);
    expect(estimateTokens(restored.messages)).toBeLessThan(8_000);
    expect(restored.messages).toEqual(agent.session.messages);
  });

  it('does not let a run race a manual compaction through the SDK', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }));
    const manual = agent.compactSession()[Symbol.asyncIterator]();
    await manual.next();
    let unexpected: AsyncIterable<AgentEvent> | undefined;
    try {
      expect(() => {
        unexpected = agent.run('racing turn');
      }).toThrow('Agent is already running');
    } finally {
      await manual.return?.();
      if (unexpected)
        for await (const _event of unexpected) {
          /* drain */
        }
    }
    expect((await run(agent)).at(-1)).toMatchObject({ type: 'run_finished', reason: 'stop' });
  });

  it('reports a failed compaction log write without abandoning recovered history', async () => {
    const blocked = join(home, 'not-a-directory');
    await writeFile(blocked, 'blocked');
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }), {
      home: blocked,
    });
    const events = await run(agent);
    expect(events.find((event) => event.type === 'compaction_finished')).toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining('compaction log')]),
    });
    expect(estimateTokens((await loadSession(agent.session.id, home)).messages)).toBeLessThan(
      8_000,
    );
  });

  it('still summarizes if recall archival fails', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }), {
      createPruner: () => ({
        prune: async () => {
          throw new Error('archive unavailable');
        },
      }),
    });
    const events = await run(agent);
    expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
    expect(events.find((event) => event.type === 'compaction_finished')).toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining('archive unavailable')]),
    });
  });

  it('does not accept prune-only success against the wrong model window', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }), {
      contextWindow: 200_000,
      createPruner: () => ({
        prune: async (messages) => {
          messages[0] = { role: 'user', content: 'x'.repeat(40_000) };
          return { archivedCount: 1, tokensSaved: 30_000, archived: [] };
        },
      }),
    });
    await run(agent);
    expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
  });

  it('keeps an oversized new user request visible instead of only summarizing it', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }));
    const events: AgentEvent[] = [];
    for await (const event of agent.run(
      'LATEST INSTRUCTION\n' + 'blob '.repeat(10_000) + '\nEND OF REQUEST',
    ))
      events.push(event);
    const lastUser = agent.session.messages
      .slice()
      .reverse()
      .find((message) => message.role === 'user');
    expect(lastUser?.content).toContain('LATEST INSTRUCTION');
    expect(lastUser?.content).toContain('END OF REQUEST');
    expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
  });

  it('records truncated summary input and retains the original history in the recovery log', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }));
    const original = [...agent.session.messages];
    const events = await run(agent);
    expect(events.find((event) => event.type === 'compaction_finished')).toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining('Summary input was truncated')]),
    });
    const log = JSON.parse(
      (
        await readFile(
          join(home, '.chimera', 'sessions', `${agent.session.id}.compactions.jsonl`),
          'utf8',
        )
      ).trim(),
    );
    expect(log.recoveryMessages[0]).toEqual(original[0]);
    expect(log.warnings.join(' ')).toContain('truncated');
  });

  it('surfaces snapshot persistence failures after recovering in memory', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }));
    await mkdir(join(home, '.chimera', 'sessions', agent.session.id, 'events.jsonl'), {
      recursive: true,
    });
    const events = await run(agent);
    expect(events.find((event) => event.type === 'compaction_finished')).toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining('persist')]),
    });
    expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
  });

  it('recognizes overflow details even when a gateway returns HTTP 500', async () => {
    let attempts = 0;
    const main = new MockLanguageModelV3({
      doStream: async (options) => {
        if (++attempts === 1)
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'error',
                  error: new APICallError({
                    message: 'Gateway rejected request',
                    url: 'https://example.invalid',
                    requestBodyValues: {},
                    statusCode: 500,
                    responseBody: '{"error":"context_length_exceeded"}',
                  }),
                },
              ],
            }),
          };
        return conversationModel().doStream(options);
      },
    });
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async () => generated('## Goal\n' + 'summary '.repeat(300)),
      }),
      {},
      main,
    );
    const events = await run(agent);
    expect(
      events.some((event) => event.type === 'compaction_started' && event.reason === 'overflow'),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', reason: 'stop' });
  });

  it('does not trust under-reported provider usage below the estimated prompt floor', async () => {
    const prompts: number[] = [];
    const main = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt).length);
        if (prompts.length <= 7)
          return {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: 'tool-call',
                  toolCallId: `read-${prompts.length}`,
                  toolName: 'probe',
                  input: '{}',
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
                  usage,
                },
              ],
            }),
          };
        return conversationModel().doStream(options);
      },
    });
    const agent = agentWith(
      new MockLanguageModelV3({ doGenerate: async () => generated() }),
      {},
      main,
    );
    agent.setTools({
      probe: tool({
        description: 'probe',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: async () => 'tool output '.repeat(700),
      }),
    });
    const events = await run(agent);
    expect(Math.max(...prompts)).toBeLessThan(40_000);
    expect(events.filter((event) => event.type === 'compaction_finished').length).toBeGreaterThan(
      1,
    );
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', reason: 'stop' });
  });

  it('stops with an actionable error if the fixed prompt cannot fit even after recovery', async () => {
    let attempts = 0;
    const main = new MockLanguageModelV3({
      doStream: async () => {
        attempts++;
        return {
          stream: simulateReadableStream({
            chunks: [{ type: 'error', error: new Error('maximum context length exceeded') }],
          }),
        };
      },
    });
    const agent = agentWith(
      new MockLanguageModelV3({ doGenerate: async () => generated() }),
      {},
      main,
    );
    const events = await run(agent);
    expect(attempts).toBeLessThanOrEqual(9);
    expect(events.at(-1)).toMatchObject({
      type: 'run_finished',
      reason: 'error',
      error: expect.stringContaining('/model'),
    });
    expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
  });

  it('does not serialize image payloads into the summary request', async () => {
    const prompts: string[] = [];
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async (options) => {
          prompts.push(JSON.stringify(options.prompt));
          return generated();
        },
      }),
    );
    agent.setVisionModelResolver(() => ({
      status: 'ok',
      ref: 'mock/vision',
      model: { ...agent.session.model, modelId: 'vision', vision: true },
      languageModel: conversationModel(),
      contextWindow: 16_000,
      contextWindowIsApproximate: false,
    }));
    agent.session.messages.push({
      role: 'user',
      content: [
        {
          type: 'image',
          image: `data:image/png;base64,${'DO_NOT_SUMMARIZE_BASE64'.repeat(30_000)}`,
        },
      ],
    });
    await run(agent);
    expect(prompts.join('')).not.toContain('DO_NOT_SUMMARIZE_BASE64');
    expect(prompts.join('')).toContain('image omitted');
  });

  it('recovers from tool-pair boundary expansion without leaving orphaned results', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }));
    agent.session.messages.push(
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'huge-call',
            toolName: 'probe',
            input: { blob: 'x'.repeat(40_000) },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'huge-call',
            toolName: 'probe',
            output: { type: 'text', value: 'small result' },
          },
        ],
      },
    );
    const events = await run(agent);
    expect(estimateTokens(agent.session.messages)).toBeLessThan(8_000);
    const calls = new Set(
      agent.session.messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.flatMap((part) => (part.type === 'tool-call' ? [part.toolCallId] : []))
          : [],
      ),
    );
    for (const message of agent.session.messages) {
      if (message.role === 'tool')
        for (const part of message.content) {
          if (part.type === 'tool-result') expect(calls.has(part.toolCallId)).toBe(true);
        }
    }
    expect(events.find((event) => event.type === 'compaction_finished')).toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining('kept tail')]),
    });
  });

  it('includes tool schemas in the first-request projection', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }));
    agent.session.messages.splice(0, agent.session.messages.length, {
      role: 'user',
      content: 'x'.repeat(12_000),
    });
    agent.setTools({
      probe: tool({
        description: 'probe',
        inputSchema: jsonSchema({
          type: 'object',
          description: 'schema '.repeat(4_000),
          properties: {},
        }),
      }),
    });
    const events = await run(agent);
    expect(events.some((event) => event.type === 'compaction_started')).toBe(true);
  });

  it('does not commit partial pruning when interrupted', async () => {
    let release!: () => void;
    let requested!: () => void;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }), {
      createPruner: () => ({
        prune: async (messages) => {
          messages[0] = { role: 'user', content: 'partially pruned' };
          requested();
          await stalled;
          return { archivedCount: 1, tokensSaved: 30_000, archived: [] };
        },
      }),
    });
    const original = agent.session.messages[0];
    const pending = run(agent);
    await started;
    agent.interrupt();
    const events = await pending;
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.session.messages[0]).toEqual(original);
    expect(events.at(-1)).toMatchObject({ type: 'run_finished', reason: 'interrupted' });
  });

  it('does not truncate history that already fits the summary model input budget', async () => {
    const prompts: string[] = [];
    const agent = agentWith(
      new MockLanguageModelV3({
        doGenerate: async (options) => {
          prompts.push(JSON.stringify(options.prompt));
          return generated();
        },
      }),
    );
    agent.session.messages.splice(0, agent.session.messages.length, {
      role: 'user',
      content: `${'before '.repeat(1_000)}IMPORTANT MIDDLE DECISION${'after '.repeat(1_000)}`,
    });
    for await (const _event of agent.compactSession()) {
      /* drain */
    }
    expect(prompts.join('')).toContain('IMPORTANT MIDDLE DECISION');
  });

  it('keeps the original unpruned history in the recovery log', async () => {
    const agent = agentWith(new MockLanguageModelV3({ doGenerate: async () => generated() }), {
      createPruner: () => ({
        prune: async (messages) => {
          messages[0] = { role: 'user', content: 'pruned '.repeat(12_000) };
          return { archivedCount: 1, tokensSaved: 20_000, archived: [] };
        },
      }),
    });
    const original = agent.session.messages[0];
    await run(agent);
    const log = JSON.parse(
      (
        await readFile(
          join(home, '.chimera', 'sessions', `${agent.session.id}.compactions.jsonl`),
          'utf8',
        )
      ).trim(),
    );
    expect(log.recoveryMessages[0]).toEqual(original);
  });
});
