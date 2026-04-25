import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool, type LanguageModel, type ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/agent';
import type { AgentEvent } from '../src/events';

function makeModelWithEchoCall(): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'echo',
            input: JSON.stringify({ msg: 'hello' }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

describe('Agent — tool formatters', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-disp-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('attaches `display` to tool_call_start and tool_call_result when a formatter is registered', async () => {
    const echo = tool({
      description: 'echo',
      inputSchema: z.object({ msg: z.string() }),
      execute: async (args: { msg: string }) => ({ echoed: args.msg }),
    });
    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
      languageModel: makeModelWithEchoCall(),
      tools: { echo } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
    });
    agent.setToolFormatters({
      echo: (args: { msg: string }, result?: { echoed: string }) => ({
        summary: result ? `${args.msg} → ${result.echoed}` : args.msg,
      }),
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('go')) events.push(ev);

    const start = events.find((e): e is Extract<AgentEvent, { type: 'tool_call_start' }> =>
      e.type === 'tool_call_start',
    );
    const done = events.find((e): e is Extract<AgentEvent, { type: 'tool_call_result' }> =>
      e.type === 'tool_call_result',
    );
    expect(start?.display).toEqual({ summary: 'hello' });
    expect(done?.display).toEqual({ summary: 'hello → hello' });
  });

  it('omits `display` and survives when the formatter throws', async () => {
    const echo = tool({
      description: 'echo',
      inputSchema: z.object({ msg: z.string() }),
      execute: async (args: { msg: string }) => ({ echoed: args.msg }),
    });
    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
      languageModel: makeModelWithEchoCall(),
      tools: { echo } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
    });
    agent.setToolFormatters({
      echo: () => {
        throw new Error('boom');
      },
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('go')) events.push(ev);

    const start = events.find((e): e is Extract<AgentEvent, { type: 'tool_call_start' }> =>
      e.type === 'tool_call_start',
    );
    expect(start).toBeDefined();
    expect(start?.display).toBeUndefined();
    // Run still finishes cleanly — the formatter error must not propagate.
    expect(events.at(-1)?.type).toBe('run_finished');
  });
});
