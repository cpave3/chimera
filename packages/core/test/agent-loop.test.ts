import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LanguageModel, type ToolSet, tool } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, type AgentOptions } from '../src/agent';
import type { AgentEvent } from '../src/events';
import type { ModelConfig } from '../src/types';

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

type Chunk = Record<string, unknown>;
type StreamCall = { prompt: Array<{ role: string; content: unknown }> };

function toolCallStep(toolName: string, input: unknown = {}, toolCallId = 'call-1'): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
  ];
}

function textStep(text: string, finishReason = 'stop'): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason, usage: USAGE },
  ];
}

/**
 * A model that plays one scripted step per `doStream` call and records the
 * call options, so tests can assert on what each step sent. A step given as
 * a function may throw to simulate a failed provider request.
 */
function scriptedModel(steps: Array<Chunk[] | (() => Chunk[])>): {
  model: LanguageModel;
  calls: StreamCall[];
} {
  const calls: StreamCall[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options: unknown) => {
      const step = steps[calls.length] ?? textStep('done');
      calls.push(options as StreamCall);
      const chunks = typeof step === 'function' ? step() : step;
      return { stream: simulateReadableStream({ chunks }) };
    },
  }) as unknown as LanguageModel;
  return { model, calls };
}

function makeModel(): ModelConfig {
  return { providerId: 'mock', modelId: 'm', maxSteps: 10 };
}

describe('Agent loop', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-agent-loop-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function buildAgent(overrides: Partial<AgentOptions> & Pick<AgentOptions, 'languageModel'>) {
    return new Agent({
      cwd: '/tmp',
      model: makeModel(),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      ...overrides,
    });
  }

  async function collect(agent: Agent, message = 'go'): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of agent.run(message)) events.push(event);
    return events;
  }

  function finishReason(events: AgentEvent[]): string | undefined {
    const finished = events.find((event) => event.type === 'run_finished');
    return finished?.type === 'run_finished' ? finished.reason : undefined;
  }

  describe('idle response timeout', () => {
    it('lets a tool run longer than responseTimeoutMs', async () => {
      const { model } = scriptedModel([toolCallStep('slow'), textStep('finished')]);
      const agent = buildAgent({
        languageModel: model,
        responseTimeoutMs: 60,
        tools: {
          slow: tool({
            description: 'takes longer than the response timeout',
            inputSchema: z.object({}),
            execute: async () => {
              await new Promise((resolve) => setTimeout(resolve, 200));
              return { ok: true };
            },
          }),
        } as ToolSet,
      });

      const events = await collect(agent);

      expect(events.some((event) => event.type === 'tool_call_result')).toBe(true);
      expect(finishReason(events)).toBe('stop');
    });
  });
});
