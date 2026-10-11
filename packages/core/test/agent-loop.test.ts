import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APICallError, type LanguageModel, type ToolSet, tool } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, type AgentOptions } from '../src/agent';
import type { AgentEvent } from '../src/events';
import type { CompactorApi, ModelConfig } from '../src/types';

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

type Chunk = Record<string, unknown>;

/** The provider-level finish reason shape: the SDK reads `unified`. */
function finish(reason: string): { unified: string; raw: string } {
  return { unified: reason, raw: reason };
}
type StreamCall = { prompt: Array<{ role: string; content: unknown }> };

function toolCallStep(toolName: string, input: unknown = {}, toolCallId = 'call-1'): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: finish('tool-calls'), usage: USAGE },
  ];
}

function textStep(text: string, finishReason = 'stop'): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: finish(finishReason), usage: USAGE },
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

/** A step that fails the provider request the way a rate-limited API does. */
function failingStep(statusCode: number, message: string): () => Chunk[] {
  return () => {
    throw new APICallError({
      message,
      url: 'https://provider.test/v1/messages',
      requestBodyValues: {},
      statusCode,
      responseHeaders: { 'retry-after-ms': '1' },
      isRetryable: statusCode === 429 || statusCode >= 500,
    });
  };
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

  describe('stable system prompt', () => {
    function systemPromptOf(call: StreamCall): unknown {
      return call.prompt.filter((message) => message.role === 'system');
    }

    it('sends the same system prompt before and after a task list update', async () => {
      const { model, calls } = scriptedModel([toolCallStep('plan_work'), textStep('finished')]);
      const agent: Agent = buildAgent({
        languageModel: model,
        systemPrompt: 'You are a test agent.',
        tools: {
          plan_work: tool({
            description: 'records a task the way the task_list tool does',
            inputSchema: z.object({}),
            execute: async () => {
              agent.session.tasks = [{ content: 'write the code', status: 'in_progress' }];
              return { ok: true };
            },
          }),
        } as ToolSet,
      });

      await collect(agent);

      expect(calls).toHaveLength(2);
      expect(systemPromptOf(calls[1]!)).toEqual(systemPromptOf(calls[0]!));
    });
  });

  describe('provider error recovery', () => {
    it('retries a step that fails with a temporary provider error', async () => {
      const { model, calls } = scriptedModel([
        failingStep(429, 'rate limited'),
        textStep('recovered'),
      ]);
      const agent = buildAgent({ languageModel: model });

      const events = await collect(agent);

      const retries = events.filter((event) => event.type === 'provider_retry');
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ attempt: 1, maxAttempts: 4, error: 'rate limited' });
      expect(calls).toHaveLength(2);
      expect(finishReason(events)).toBe('stop');
    });

    it('does not retry once a tool call of the step has started', async () => {
      let executions = 0;
      const { model, calls } = scriptedModel([
        [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'deploy', input: '{}' },
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        ],
        textStep('should not be requested'),
      ]);
      const agent = buildAgent({
        languageModel: model,
        tools: {
          deploy: tool({
            description: 'has a side effect',
            inputSchema: z.object({}),
            execute: async () => {
              executions += 1;
              return { ok: true };
            },
          }),
        } as ToolSet,
      });

      const events = await collect(agent);

      expect(executions).toBe(1);
      expect(calls).toHaveLength(1);
      expect(events.some((event) => event.type === 'provider_retry')).toBe(false);
      expect(finishReason(events)).toBe('error');
    });

    it('ends the run with an error when every retry fails', async () => {
      const { model, calls } = scriptedModel(
        Array.from({ length: 6 }, () => failingStep(503, 'service unavailable')),
      );
      const agent = buildAgent({ languageModel: model });

      const events = await collect(agent);

      expect(events.filter((event) => event.type === 'provider_retry')).toHaveLength(4);
      expect(calls).toHaveLength(5);
      const finished = events.find((event) => event.type === 'run_finished');
      expect(finished).toMatchObject({ reason: 'error', error: 'service unavailable' });
    });

    it('compacts and resends a step the provider rejects for context length', async () => {
      const { model, calls } = scriptedModel([
        failingStep(400, 'prompt is too long: 250000 tokens > 200000 maximum'),
        textStep('fits now'),
      ]);
      const compactReasons: string[] = [];
      const compactor: CompactorApi = {
        maybeCompact: async () => ({ ran: false }),
        compact: async (session, reason) => {
          compactReasons.push(reason);
          session.messages.splice(0, session.messages.length, {
            role: 'user',
            content: 'summary of the conversation so far',
          });
          return {
            summary: 'summary',
            tokensBefore: 250_000,
            tokensAfter: 500,
            messagesReplaced: 1,
            strategy: 'summarize',
            prunedCount: 0,
            prunedTokensSaved: 0,
          };
        },
      };
      const agent = buildAgent({
        languageModel: model,
        compactor,
        compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      });

      const events = await collect(agent);

      expect(events.find((event) => event.type === 'compaction_started')).toMatchObject({
        reason: 'overflow',
      });
      expect(events.some((event) => event.type === 'compaction_finished')).toBe(true);
      // A threshold compaction may stop after pruning; an overflow needs the summary.
      expect(compactReasons).toEqual(['manual']);
      expect(calls).toHaveLength(2);
      expect(finishReason(events)).toBe('stop');
    });

    it('finishes the run on the fallback model when the primary stays unavailable', async () => {
      const primary = scriptedModel([
        ...Array.from({ length: 5 }, () => failingStep(529, 'overloaded')),
        textStep('primary is back'),
      ]);
      const fallback = scriptedModel([textStep('answered by the fallback')]);
      const agent = buildAgent({ languageModel: primary.model });
      agent.setFallbackModelResolver(() => ({
        status: 'ok',
        ref: 'backup/b',
        model: { providerId: 'backup', modelId: 'b', maxSteps: 10 },
        languageModel: fallback.model,
        contextWindow: 100_000,
        contextWindowIsApproximate: false,
      }));

      const firstRun = await collect(agent);

      expect(firstRun.find((event) => event.type === 'model_fallback')).toMatchObject({
        from: 'mock/m',
        to: 'backup/b',
        error: 'overloaded',
      });
      expect(fallback.calls).toHaveLength(1);
      expect(finishReason(firstRun)).toBe('stop');

      const secondRun = await collect(agent, 'again');

      expect(primary.calls).toHaveLength(6);
      expect(fallback.calls).toHaveLength(1);
      expect(finishReason(secondRun)).toBe('stop');
    });

    it('does not retry an error the provider will not accept later', async () => {
      const { model, calls } = scriptedModel([failingStep(401, 'invalid api key')]);
      const agent = buildAgent({ languageModel: model });

      const events = await collect(agent);

      expect(calls).toHaveLength(1);
      expect(finishReason(events)).toBe('error');
    });
  });

  describe('output cutoff', () => {
    function lastUserText(call: StreamCall): string {
      const user = call.prompt.filter((message) => message.role === 'user').at(-1);
      return JSON.stringify(user?.content ?? '');
    }

    it('asks the model to continue when its output is cut off', async () => {
      const { model, calls } = scriptedModel([
        textStep('the first half of a long answer', 'length'),
        textStep('and the second half'),
      ]);
      const agent = buildAgent({ languageModel: model });

      const events = await collect(agent);

      expect(calls).toHaveLength(2);
      expect(lastUserText(calls[1]!)).toContain('cut off');
      expect(events.filter((event) => event.type === 'output_continued')).toEqual([
        { type: 'output_continued', attempt: 1, maxAttempts: 2 },
      ]);
      expect(finishReason(events)).toBe('stop');
    });

    it('ends the run with output_limit after two continuations', async () => {
      const { model, calls } = scriptedModel(
        Array.from({ length: 4 }, () => textStep('still not finished', 'length')),
      );
      const agent = buildAgent({ languageModel: model });

      const events = await collect(agent);

      expect(calls).toHaveLength(3);
      expect(finishReason(events)).toBe('output_limit');
      expect(agent.session.status).toBe('idle');
    });
  });

  describe('file tracking', () => {
    it('records every file an apply_patch call changed', async () => {
      const { model } = scriptedModel([toolCallStep('apply_patch'), textStep('patched')]);
      const agent = buildAgent({
        languageModel: model,
        cwd: '/project',
        tools: {
          apply_patch: tool({
            description: 'stands in for the real apply_patch tool',
            inputSchema: z.object({}),
            execute: async () => ({
              files: [
                { path: 'src/a.ts', operation: 'updated', additions: 1, deletions: 1 },
                {
                  path: 'old/b.ts',
                  operation: 'moved',
                  movedTo: 'src/b.ts',
                  additions: 0,
                  deletions: 0,
                },
              ],
            }),
          }),
        } as ToolSet,
      });

      await collect(agent);

      expect([...agent.session.fileOps.writes].sort()).toEqual([
        resolve('/project/old/b.ts'),
        resolve('/project/src/a.ts'),
        resolve('/project/src/b.ts'),
      ]);
    });
  });

  describe('tool-call repair', () => {
    /** Run one tool call with raw argument text and report what the tool received. */
    async function callWith(
      rawInput: string,
      calledName = 'lookup',
    ): Promise<{ received: unknown[]; events: AgentEvent[] }> {
      const received: unknown[] = [];
      const { model } = scriptedModel([
        [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call-1', toolName: calledName, input: rawInput },
          { type: 'finish', finishReason: finish('tool-calls'), usage: USAGE },
        ],
        textStep('done'),
      ]);
      const agent = buildAgent({
        languageModel: model,
        tools: {
          lookup: tool({
            description: 'looks something up',
            inputSchema: z.object({
              path: z.string(),
              recursive: z.boolean().optional(),
              limit: z.number().int().optional(),
              tags: z.array(z.string()).optional(),
            }),
            execute: async (args) => {
              received.push(args);
              return { ok: true };
            },
          }),
        } as ToolSet,
      });
      return { received, events: await collect(agent) };
    }

    it('turns string booleans and numbers into the types the schema asks for', async () => {
      const { received } = await callWith('{"path":"src","recursive":"true","limit":"5"}');
      expect(received).toEqual([{ path: 'src', recursive: true, limit: 5 }]);
    });

    it('decodes arguments that were sent as a JSON string', async () => {
      const { received } = await callWith(JSON.stringify(JSON.stringify({ path: 'src' })));
      expect(received).toEqual([{ path: 'src' }]);
    });

    it('strips a code fence around the arguments', async () => {
      const { received } = await callWith('```json\n{"path":"src"}\n```');
      expect(received).toEqual([{ path: 'src' }]);
    });

    it('drops null for an optional argument and decodes an array sent as text', async () => {
      const { received } = await callWith('{"path":"src","limit":null,"tags":"[\\"a\\",\\"b\\"]"}');
      expect(received).toEqual([{ path: 'src', tags: ['a', 'b'] }]);
    });

    it('maps a wrongly cased tool name to the registered tool', async () => {
      const { received } = await callWith('{"path":"src"}', 'Lookup');
      expect(received).toEqual([{ path: 'src' }]);
    });

    it('reports a call it cannot repair to the model and keeps the run going', async () => {
      const { received, events } = await callWith('{"recursive":true}');

      expect(received).toEqual([]);
      const error = events.find((event) => event.type === 'tool_call_error');
      expect(error?.type === 'tool_call_error' ? error.error : '').toContain('path');
      expect(finishReason(events)).toBe('stop');
    });
  });
});
