import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LanguageModel, type ToolSet, tool } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, buildPermissionRequest, type VisionModelResolution } from '../src/agent';
import type { AgentEvent } from '../src/events';
import { newSessionId } from '../src/ids';
import { emptyUsage, type ModelConfig, type Session } from '../src/types';

function makeModel(): ModelConfig {
  return { providerId: 'mock', modelId: 'm', maxSteps: 10 };
}

let currentAgentRef: Agent | undefined;

function textOnlyModel(text: string): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: text },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

describe('Agent', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-agent-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('constructs with a fresh session when no sessionId is given', () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: textOnlyModel('hi'),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    expect(agent.session.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(agent.session.status).toBe('idle');
    expect(agent.session.messages).toEqual([]);
  });

  it('uses the requested custom session id and name for a fresh session', () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: textOnlyModel('hi'),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      sessionId: 'release.2026-07_11',
      sessionName: 'Release investigation',
      home,
      contextWindow: 200_000,
    });

    expect(agent.session.id).toBe('release.2026-07_11');
    expect(agent.session.name).toBe('Release investigation');
  });

  it('runs a single-turn no-tool conversation and emits expected events', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: textOnlyModel('hello there'),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: string[] = [];
    for await (const ev of agent.run('hi')) {
      events.push(ev.type);
      if (ev.type === 'run_finished') {
        expect(ev.reason).toBe('stop');
      }
    }

    expect(events).toContain('session_started');
    expect(events).toContain('user_message');
    expect(events).toContain('assistant_text_delta');
    expect(events).toContain('assistant_text_done');
    expect(events).toContain('step_finished');
    expect(events[events.length - 1]).toBe('run_finished');
  });

  it('passes part.id through on emitted assistant_text_delta and assistant_text_done', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: textOnlyModel('hello'),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const deltaIds: (string | undefined)[] = [];
    const doneIds: (string | undefined)[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'assistant_text_delta') deltaIds.push(ev.id);
      if (ev.type === 'assistant_text_done') doneIds.push(ev.id);
    }
    expect(deltaIds).toEqual(['t1']);
    expect(doneIds).toEqual(['t1']);
  });

  it('forwards model.maxOutputTokens to the language model call options', async () => {
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'ok' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      }),
    });
    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 10, maxOutputTokens: 12_345 },
      languageModel: mock as unknown as LanguageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    for await (const _ev of agent.run('hi')) {
      // drain
    }
    expect(mock.doStreamCalls.length).toBeGreaterThan(0);
    expect(mock.doStreamCalls[0].maxOutputTokens).toBe(12_345);
  });

  it('omits maxOutputTokens from the call when the model config does not set it', async () => {
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'ok' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      }),
    });
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: mock as unknown as LanguageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    for await (const _ev of agent.run('hi')) {
      // drain
    }
    expect(mock.doStreamCalls[0].maxOutputTokens).toBeUndefined();
  });

  it('passes registered tools through to the language model call', async () => {
    const mock = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'ok' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      }),
    });
    const bashTool = tool({
      description: 'Run a shell command',
      inputSchema: z.object({ command: z.string() }),
      execute: async () => ({ stdout: '', stderr: '', exit_code: 0 }),
    });
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: mock as unknown as LanguageModel,
      tools: { bash: bashTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    for await (const _ev of agent.run('list files')) {
      // drain
    }

    expect(mock.doStreamCalls[0].tools?.map((entry) => entry.name)).toEqual(['bash']);
  });

  it('awaitCallId resolves to distinct CallIds for parallel tool-calls (resolveCallId races)', async () => {
    const lookups: Array<{
      aiSdkId: string;
      sync: string | undefined;
      async: string | undefined;
    }> = [];
    const captureTool = tool({
      description: 'capture',
      inputSchema: z.object({ tag: z.string() }),
      execute: async (input, opts) => {
        const aiSdkId = (opts as { toolCallId?: string }).toolCallId ?? 'unknown';
        const agentRef = currentAgentRef;
        // Sync lookup mirrors the legacy spawn-tool fast-path: a single
        // microtask yield, then `resolveCallId`. Demonstrates the race —
        // expected to be `undefined` for at least one of two parallel calls.
        await Promise.resolve();
        const sync = agentRef?.resolveCallId(aiSdkId);
        // Async lookup is the deterministic fix.
        const asyncResolved = agentRef ? await agentRef.awaitCallId(aiSdkId) : undefined;
        lookups.push({ aiSdkId, sync, async: asyncResolved });
        return { tag: (input as { tag: string }).tag };
      },
    });
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'ai-1',
                  toolName: 'capture',
                  input: JSON.stringify({ tag: 'A' }),
                },
                {
                  type: 'tool-call',
                  toolCallId: 'ai-2',
                  toolName: 'capture',
                  input: JSON.stringify({ tag: 'B' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'done' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
      languageModel: model,
      tools: { capture: captureTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    currentAgentRef = agent;
    try {
      for await (const _ev of agent.run('go')) {
        // drain
      }
    } finally {
      currentAgentRef = undefined;
    }
    // Both lookups must succeed and return DISTINCT CallIds.
    expect(lookups).toHaveLength(2);
    const a = lookups.find((l) => l.aiSdkId === 'ai-1');
    const b = lookups.find((l) => l.aiSdkId === 'ai-2');
    // Async-resolved CallIds are always defined and distinct.
    expect(a?.async).toBeDefined();
    expect(b?.async).toBeDefined();
    expect(a?.async).not.toBe(b?.async);
  });

  it('returns a tool-result error and continues when the model calls an unknown tool', async () => {
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'bad-call',
                  toolName: 'apply_patch',
                  input: JSON.stringify({ patch: 'nope' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'recovered' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('go')) {
      events.push(ev);
    }

    expect(callCount).toBe(2);
    expect(events.some((ev) => ev.type === 'tool_call_error')).toBe(true);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1].prompt);
    expect(secondPrompt).toContain("unavailable tool 'apply_patch'");
    expect(secondPrompt).toContain('tool-result');
  });

  it('does NOT swallow text in step 2 when the provider reuses the step-1 text-id', async () => {
    // Regression: 54480b0 added a per-run `finalizedTextIds` Set to suppress
    // intra-stream replay of the same text-id. Some OpenAI-shape providers
    // (notably synthetic.new + Kimi-K2.5/GLM-5.1) restart text-id numbering
    // at each step's `doStream`, so step-2 text legitimately uses the same
    // id as step-1. The dedup must NOT drop that — it's new content.
    const readTool = tool({
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: 'ok', total_lines: 1, truncated: false }),
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: 'first step text' },
                { type: 'text-end', id: '0' },
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'read',
                  input: JSON.stringify({ path: 'x' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'second step synthesis' },
              { type: 'text-end', id: '0' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
      languageModel: model,
      tools: { read: readTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const dones: string[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'assistant_text_done') dones.push(ev.text);
    }
    expect(dones).toEqual(['first step text', 'second step synthesis']);
  });

  it('does NOT swallow a second text block in the same step that reuses an already-finalized text-id with new content', async () => {
    // Regression: synthetic.new providers (Kimi/GLM) sometimes emit a final
    // summary text within the same step as initial reasoning text — both
    // sharing the same text-id, with a tool call between them. The agent
    // must emit the second block as new content, not suppress it as a
    // replay. Pre-fix, `finalizedTextIds` retained the id past the
    // tool-call boundary and only cleared on `finish-step`, so the final
    // text was silently dropped during streaming (showing up only in the
    // persisted session log on resume).
    const noopTool = tool({
      description: 'noop',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: "I'll check..." },
                { type: 'text-end', id: 't1' },
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'noop',
                  input: JSON.stringify({}),
                },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'Done!' },
                { type: 'text-end', id: 't1' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: { noop: noopTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const dones: string[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'assistant_text_done') dones.push(ev.text);
    }
    expect(dones).toEqual(["I'll check...", 'Done!']);
  });

  it('emits reasoning_text_delta/reasoning_text_done for reasoning parts', async () => {
    // Provider-side chunks use `delta`; streamText's fullStream exposes `text`.
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'Hmm... ' },
            { type: 'reasoning-delta', id: 'r1', delta: 'let me think.' },
            { type: 'reasoning-end', id: 'r1' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Hello' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      }),
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const reasoningDeltas: string[] = [];
    const reasoningDones: string[] = [];
    const textDones: string[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'reasoning_text_delta') reasoningDeltas.push(ev.delta);
      if (ev.type === 'reasoning_text_done') reasoningDones.push(ev.text);
      if (ev.type === 'assistant_text_done') textDones.push(ev.text);
    }
    expect(reasoningDeltas).toEqual(['Hmm... ', 'let me think.']);
    expect(reasoningDones).toEqual(['Hmm... let me think.']);
    expect(textDones).toEqual(['Hello']);
  });

  it('flushes unconcluded text when a second text-start reuses the same id mid-step', async () => {
    const noopTool = tool({
      description: 'noop',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'first block' },
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'noop',
                  input: JSON.stringify({}),
                },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'second block' },
                { type: 'text-end', id: 't1' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: { noop: noopTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const dones: string[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'assistant_text_done') dones.push(ev.text);
    }
    expect(dones).toEqual(['first block', 'second block']);
  });

  it('flushes unconcluded reasoning on reasoning-start id reuse mid-step', async () => {
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'reasoning-start', id: 'r1' },
                { type: 'reasoning-delta', id: 'r1', delta: 'think1' },
                { type: 'reasoning-start', id: 'r1' },
                { type: 'reasoning-delta', id: 'r1', delta: 'think2' },
                { type: 'reasoning-end', id: 'r1' },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'Hello' },
                { type: 'text-end', id: 't1' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const reasoningDones: string[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'reasoning_text_done') reasoningDones.push(ev.text);
    }
    expect(reasoningDones).toEqual(['think1', 'think2']);
  });

  it('suppresses re-emitted text-start/text-delta/text-end for an already-finalized text-id', async () => {
    // The AI SDK can replay the same text-id across step boundaries when
    // `response.messages` consolidates multiple emitted parts back into one.
    // The agent must drop the second cycle so the TUI doesn't visibly stream
    // a duplicate entry.
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'hello ' },
            { type: 'text-delta', id: 't1', delta: 'world' },
            { type: 'text-end', id: 't1' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'hello ' },
            { type: 'text-delta', id: 't1', delta: 'world' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            },
          ],
        }),
      }),
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const deltas: string[] = [];
    const dones: string[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'assistant_text_delta') deltas.push(ev.delta);
      if (ev.type === 'assistant_text_done') dones.push(ev.text);
    }
    expect(deltas).toEqual(['hello ', 'world']);
    expect(dones).toEqual(['hello world']);
  });

  it('suppresses replayed reasoning parts for an already-finalized reasoning-id', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'think ' },
            { type: 'reasoning-delta', id: 'r1', delta: 'hard' },
            { type: 'reasoning-end', id: 'r1' },
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'think ' },
            { type: 'reasoning-delta', id: 'r1', delta: 'hard' },
            { type: 'reasoning-end', id: 'r1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            },
          ],
        }),
      }),
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const deltas: string[] = [];
    const dones: string[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'reasoning_text_delta') deltas.push(ev.delta);
      if (ev.type === 'reasoning_text_done') dones.push(ev.text);
    }
    expect(deltas).toEqual(['think ', 'hard']);
    expect(dones).toEqual(['think hard']);
  });

  it('generates synthetic reasoning ids when the same id carries different content', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'first' },
            { type: 'reasoning-end', id: 'r1' },
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'second' },
            { type: 'reasoning-end', id: 'r1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            },
          ],
        }),
      }),
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const dones: string[] = [];
    const ids: (string | undefined)[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'reasoning_text_done') {
        dones.push(ev.text);
        ids.push(ev.id);
      }
    }
    expect(dones).toEqual(['first', 'second']);
    expect(ids[0]).toBe('r1');
    expect(ids[1]).toBe('r1#1');
  });

  it('interleaves reasoning and text chunks within a single step', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'hmm... ' },
            { type: 'reasoning-end', id: 'r1' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Hello' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            },
          ],
        }),
      }),
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const reasoningDeltas: string[] = [];
    const reasoningDones: string[] = [];
    const textDeltas: string[] = [];
    const textDones: string[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'reasoning_text_delta') reasoningDeltas.push(ev.delta);
      if (ev.type === 'reasoning_text_done') reasoningDones.push(ev.text);
      if (ev.type === 'assistant_text_delta') textDeltas.push(ev.delta);
      if (ev.type === 'assistant_text_done') textDones.push(ev.text);
    }
    expect(reasoningDeltas).toEqual(['hmm... ']);
    expect(reasoningDones).toEqual(['hmm... ']);
    expect(textDeltas).toEqual(['Hello']);
    expect(textDones).toEqual(['Hello']);
  });

  it('emits no reasoning events for an empty reasoning block', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-end', id: 'r1' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Hi' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      }),
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const reasoningEvents: string[] = [];
    const textDones: string[] = [];
    for await (const ev of agent.run('hi')) {
      if (ev.type === 'reasoning_text_delta' || ev.type === 'reasoning_text_done') {
        reasoningEvents.push(ev.type);
      }
      if (ev.type === 'assistant_text_done') textDones.push(ev.text);
    }
    expect(reasoningEvents).toEqual([]);
    expect(textDones).toEqual(['Hi']);
  });

  it('interrupt during run yields run_finished with reason interrupted', async () => {
    // A stream that never finishes naturally (long delay).
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 50,
          chunkDelayInMs: 50,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'x' },
            { type: 'text-delta', id: 't1', delta: 'y' },
            { type: 'text-delta', id: 't1', delta: 'z' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
            },
          ],
        }),
      }),
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: { type: string; reason?: string }[] = [];
    // Interrupt shortly after start.
    setTimeout(() => agent.interrupt(), 30);
    for await (const ev of agent.run('go')) {
      events.push({ type: ev.type, reason: (ev as { reason?: string }).reason });
    }
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('run_finished');
    expect(terminal?.reason).toBe('interrupted');
  });

  it('raisePermissionRequest emits a permission_request event and awaits resolution', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: textOnlyModel('ok'),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    // Start a run in the background so currentQueue is attached.
    const runEvents: string[] = [];
    const runPromise = (async () => {
      for await (const ev of agent.run('trigger')) {
        runEvents.push(ev.type);
      }
    })();

    // Wait for session_started to fire so queue is active.
    await new Promise((r) => setTimeout(r, 10));

    const req = buildPermissionRequest({
      tool: 'bash',
      command: 'rm -rf foo',
      cwd: '/tmp',
    });
    const p = agent.raisePermissionRequest(req);
    agent.resolvePermission(req.requestId, 'allow');
    const res = await p;
    expect(res.decision).toBe('allow');
    expect(res.remembered).toBe(false);
    await runPromise;
  });

  it('emits skill_activated on a read of a known SKILL.md path', async () => {
    const readTool = tool({
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: 'ok', total_lines: 1, truncated: false }),
    });
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'read',
                  input: JSON.stringify({ path: '.chimera/skills/pdf/SKILL.md' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'done' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const hits: Array<{ skillName: string; source: string }> = [];
    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
      languageModel: model,
      tools: { read: readTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      skillActivation: (readPath) =>
        readPath === '.chimera/skills/pdf/SKILL.md'
          ? { skillName: 'pdf', source: 'project' }
          : undefined,
      contextWindow: 200_000,
    });

    for await (const ev of agent.run('go')) {
      if (ev.type === 'skill_activated') {
        hits.push({ skillName: ev.skillName, source: ev.source });
      }
    }
    expect(hits).toEqual([{ skillName: 'pdf', source: 'project' }]);
  });

  it('does not emit skill_activated when read path is not a skill', async () => {
    const readTool = tool({
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: '', total_lines: 0, truncated: false }),
    });
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'read',
                  input: JSON.stringify({ path: 'src/index.ts' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'done' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const events: string[] = [];
    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
      languageModel: model,
      tools: { read: readTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      skillActivation: () => undefined,
      contextWindow: 200_000,
    });
    for await (const ev of agent.run('go')) events.push(ev.type);
    expect(events).not.toContain('skill_activated');
  });

  it('tool-call steps do not count toward maxSteps; only stop steps do', async () => {
    // With maxSteps: 1 and three iterations (two tool-calls + one stop),
    // the run should complete without hitting max_steps.
    const noopTool = tool({
      description: 'noop',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        callCount += 1;
        if (callCount <= 2) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: `c${callCount}`,
                  toolName: 'noop',
                  input: JSON.stringify({}),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'done' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
      languageModel: model,
      tools: { noop: noopTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: string[] = [];
    for await (const ev of agent.run('go')) events.push(ev.type);
    const runFinished = events.filter((e) => e === 'run_finished');
    expect(runFinished.length).toBe(1);
    // If max_steps were hit after the first stop step (which is the only
    // terminal step counting toward maxSteps: 1), the run would end with
    // reason max_steps. With our change, tool-call steps don't count, so
    // the run completes normally with reason stop.
    // The last event in the array is guaranteed to be run_finished.
    expect(events[events.length - 1]).toBe('run_finished');
  });

  it('resolvePermission with remember fires the registered handler', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: textOnlyModel('ok'),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    let rememberedScope: unknown = null;
    agent.setRememberHandler((_id, scope) => {
      rememberedScope = scope;
    });

    const runPromise = (async () => {
      for await (const _ev of agent.run('trigger')) {
        // drain
      }
    })();
    await new Promise((r) => setTimeout(r, 10));

    const req = buildPermissionRequest({
      tool: 'bash',
      command: 'pnpm test',
      cwd: '/tmp',
    });
    const p = agent.raisePermissionRequest(req);
    agent.resolvePermission(req.requestId, 'allow', { scope: 'session' });
    const res = await p;
    expect(res.remembered).toBe(true);
    expect(rememberedScope).toEqual({ scope: 'session' });
    await runPromise;
  });
});

function modelCallingTool(toolName: string): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName,
            input: JSON.stringify({}),
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

function silentModel(): LanguageModel {
  // Awaits the abort signal so `interrupt()` can cleanly end the run.
  return new MockLanguageModelV3({
    doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          await new Promise<void>((resolve) => {
            if (!abortSignal) return;
            if (abortSignal.aborted) return resolve();
            abortSignal.addEventListener('abort', () => resolve(), { once: true });
          });
          controller.close();
        },
      }),
    }),
  }) as unknown as LanguageModel;
}

describe('Agent.pushEvent', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-agent-push-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('lets a tool inject events into the active run stream', async () => {
    let agent!: Agent;
    const inject = tool({
      description: 'inject',
      inputSchema: z.object({}),
      execute: async () => {
        agent.pushEvent({
          type: 'subagent_event',
          subagentId: 'sa1',
          event: { type: 'assistant_text_done', text: 'injected' },
        });
        return 'ok';
      },
    });
    agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
      languageModel: modelCallingTool('inject'),
      tools: { inject } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: import('../src/events').AgentEvent[] = [];
    for await (const ev of agent.run('go')) events.push(ev);

    const wrapped = events.find(
      (e): e is Extract<import('../src/events').AgentEvent, { type: 'subagent_event' }> =>
        e.type === 'subagent_event',
    );
    expect(wrapped).toBeDefined();
    expect(wrapped?.subagentId).toBe('sa1');
  });

  it('is a no-op when no run is active', () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
      languageModel: silentModel(),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    expect(() => agent.pushEvent({ type: 'assistant_text_done', text: 'lost' })).not.toThrow();
  });
});

describe('Agent.signal', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-agent-signal-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('reflects the live abort controller and fires on interrupt()', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
      languageModel: silentModel(),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    const drained: import('../src/events').AgentEvent[] = [];
    const drain = (async () => {
      for await (const ev of agent.run('go')) drained.push(ev);
    })();

    await new Promise((r) => setTimeout(r, 10));
    const signal = agent.signal;
    expect(signal.aborted).toBe(false);
    agent.interrupt();
    expect(signal.aborted).toBe(true);
    await drain;
    const finished = drained.find(
      (e): e is Extract<import('../src/events').AgentEvent, { type: 'run_finished' }> =>
        e.type === 'run_finished',
    );
    expect(finished?.reason).toBe('interrupted');
  });

  describe('stop hook', () => {
    it('blocks stop and retries with a user_message when stop hook returns blocked', async () => {
      let fireCount = 0;
      const stopHook = {
        async fire() {
          fireCount++;
          if (fireCount === 1) {
            return { blocked: true, reason: 'lint failed' };
          }
          return { blocked: false };
        },
      };

      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: textOnlyModel('hello'),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        stopHook,
      });

      const events: string[] = [];
      for await (const ev of agent.run('hi')) {
        events.push(ev.type);
      }

      // Should see a second user_message from the retry.
      const userMessages = events.filter((t) => t === 'user_message');
      expect(userMessages.length).toBe(2); // original + retry
      expect(fireCount).toBe(2);
      expect(events[events.length - 1]).toBe('run_finished');
    });

    it('includes additionalContext in the retry user_message when provided', async () => {
      let fireCount = 0;
      const stopHook = {
        async fire() {
          fireCount++;
          if (fireCount === 1) {
            return {
              blocked: true,
              reason: 'lint failed',
              additionalContext: 'Run pnpm biome:lint',
            };
          }
          return { blocked: false };
        },
      };

      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: textOnlyModel('hello'),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        stopHook,
      });

      const userMessages: { content: string }[] = [];
      for await (const ev of agent.run('hi')) {
        if (ev.type === 'user_message') {
          userMessages.push({ content: ev.content });
        }
      }

      expect(userMessages.length).toBe(2);
      expect(userMessages[1]?.content).toContain('lint failed');
      expect(userMessages[1]?.content).toContain('Run pnpm biome:lint');
    });

    it('emits run_finished normally when stop hook allows', async () => {
      const stopHook = {
        async fire() {
          return { blocked: false };
        },
      };

      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: textOnlyModel('hi'),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        stopHook,
      });

      const events: string[] = [];
      for await (const ev of agent.run('hi')) {
        events.push(ev.type);
      }

      expect(events.filter((t) => t === 'user_message').length).toBe(1);
      expect(events[events.length - 1]).toBe('run_finished');
    });

    it('skips stop hook on error terminal reason', async () => {
      let fireCount = 0;
      const stopHook = {
        async fire() {
          fireCount++;
          return { blocked: true, reason: 'should not fire' };
        },
      };

      const model = new MockLanguageModelV3({
        doStream: async () => {
          throw new Error('model failure');
        },
      }) as unknown as LanguageModel;

      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: model,
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        stopHook,
      });

      const events: string[] = [];
      for await (const ev of agent.run('hi')) {
        events.push(ev.type);
      }

      expect(fireCount).toBe(0);
      expect(events[events.length - 1]).toBe('run_finished');
    });

    it('caps retries at MAX_STOP_RETRIES and emits run_finished with max_steps', async () => {
      let fireCount = 0;
      const stopHook = {
        async fire() {
          fireCount++;
          return { blocked: true, reason: 'always blocked' };
        },
      };

      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: textOnlyModel('hello'),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        stopHook,
      });

      const events: { type: string; reason?: string }[] = [];
      for await (const ev of agent.run('hi')) {
        events.push({ type: ev.type, reason: (ev as { reason?: string }).reason });
      }

      const finished = events.find((e) => e.type === 'run_finished');
      expect(finished?.reason).toBe('max_steps');
      expect(fireCount).toBe(5);
    });
  });

  describe('setUserModelOverride', () => {
    it('applies a model change on an idle agent', () => {
      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: textOnlyModel('x'),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
      });
      agent.setModelChangeResolver((ref) => {
        const [providerId, modelId] = ref.split('/');
        return {
          model: { providerId, modelId, maxSteps: 5 },
          languageModel: textOnlyModel('new'),
          systemPrompt: 'changed',
          contextWindow: 100_000,
          contextWindowIsApproximate: false,
        };
      });
      const result = agent.setUserModelOverride('other/new');
      expect(result.status).toBe('applied');
      if (result.status === 'applied') {
        expect(result.from).toBe('mock/m');
        expect(result.to).toBe('other/new');
      }
      expect(agent.session.model.providerId).toBe('other');
      expect(agent.session.model.modelId).toBe('new');
      expect(agent.session.userModelOverride).toBe('other/new');
    });

    it('returns noop when the target matches the current model', () => {
      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: textOnlyModel('x'),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
      });
      const result = agent.setUserModelOverride('mock/m');
      expect(result.status).toBe('applied');
      if (result.status === 'applied') {
        expect(result.from).toBe('mock/m');
        expect(result.to).toBe('mock/m');
      }
    });

    it('returns invalid when the resolver is not registered', () => {
      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: textOnlyModel('x'),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
      });
      // no resolver set
      const result = agent.setUserModelOverride('other/new');
      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.error).toContain('not registered');
      }
    });

    it('returns running when the agent is mid-run', async () => {
      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: textOnlyModel('x'),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
      });

      const runPromise = (async () => {
        for await (const _ev of agent.run('go')) {
          // no-op
        }
      })();

      await new Promise((r) => setTimeout(r, 1));
      const result = agent.setUserModelOverride('other/new');
      expect(result.status).toBe('running');
      agent.interrupt();
      await runPromise;
    });
  });

  describe('response timeout', () => {
    it('emits run_finished { reason: "timeout" } when stream stalls', async () => {
      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: silentModel(),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        responseTimeoutMs: 50,
      });

      const events: string[] = [];
      for await (const ev of agent.run('hi')) {
        events.push(ev.type);
      }

      expect(events[events.length - 1]).toBe('run_finished');
    });

    it('fires timeoutHook when step times out', async () => {
      let timeoutFired = false;
      const timeoutHook = {
        async fire() {
          timeoutFired = true;
        },
      };

      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: silentModel(),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        responseTimeoutMs: 50,
        timeoutHook,
      });

      const events = [] as { type: string; reason?: string }[];
      for await (const ev of agent.run('hi')) {
        events.push({ type: ev.type, reason: (ev as { reason?: string }).reason });
      }

      expect(timeoutFired).toBe(true);
      const finished = events.find((e) => e.type === 'run_finished');
      expect(finished?.reason).toBe('timeout');
    });

    it('disables timeout when responseTimeoutMs is 0', async () => {
      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: silentModel(),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        responseTimeoutMs: 0,
      });

      // With timeout disabled, a stalled run never finishes on its own.
      // Interrupt it after a short delay to prove it was still running.
      const drained: { type: string; reason?: string }[] = [];
      const drain = (async () => {
        for await (const ev of agent.run('hi')) {
          drained.push({ type: ev.type, reason: (ev as { reason?: string }).reason });
        }
      })();

      await new Promise((r) => setTimeout(r, 10));
      expect(drained.find((e) => e.type === 'run_finished')).toBeUndefined();
      agent.interrupt();
      await drain;
      expect(drained[drained.length - 1]?.reason).toBe('interrupted');
    });

    it('fires timeoutHook but not stopHook on timeout', async () => {
      let timeoutFired = false;
      let stopFired = false;
      const timeoutHook = {
        async fire() {
          timeoutFired = true;
        },
      };
      const stopHook = {
        async fire() {
          stopFired = true;
          return { blocked: false };
        },
      };

      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: silentModel(),
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        responseTimeoutMs: 50,
        timeoutHook,
        stopHook,
      });

      for await (const ev of agent.run('hi')) {
        if (ev.type === 'run_finished') break;
      }

      expect(timeoutFired).toBe(true);
      expect(stopFired).toBe(false);
    });
  });

  describe('interrupt hook', () => {
    it('fires interruptHook on manual interrupt()', async () => {
      let interruptFired = false;
      const interruptHook = {
        async fire() {
          interruptFired = true;
        },
      };
      // A long stream so we can interrupt mid-flight.
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            initialDelayInMs: 10,
            chunkDelayInMs: 50,
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'hello' },
            ],
          }),
        }),
      }) as unknown as LanguageModel;

      const agent = new Agent({
        cwd: '/tmp',
        model: makeModel(),
        languageModel: model,
        tools: {} as ToolSet,
        sandboxMode: 'off',
        home,
        contextWindow: 200_000,
        interruptHook,
      });

      // Drain async generator in background so we can interrupt.
      const drain = (async () => {
        for await (const _ev of agent.run('go')) {
          // consume
        }
      })();
      await new Promise((r) => setTimeout(r, 20));
      agent.interrupt();
      await drain;

      expect(interruptFired).toBe(true);
    });
  });
});

describe('system prompt composition (tasks + plan handoff)', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-agent-sys-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function textMock() {
    return new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'ok' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        }),
      }),
    });
  }

  function makeAgent(mock: MockLanguageModelV3, initialMode?: string) {
    return new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: mock as unknown as LanguageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      systemPrompt: 'base prompt',
      initialMode,
    });
  }

  function systemOf(call: { prompt: Array<{ role: string; content: unknown }> }): string {
    const sys = call.prompt.find((m) => m.role === 'system');
    return typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content ?? '');
  }

  it('injects the live task list into the system prompt', async () => {
    const mock = textMock();
    const agent = makeAgent(mock);
    agent.session.tasks = [
      { content: 'write failing test', status: 'completed' },
      { content: 'implement feature', status: 'in_progress' },
    ];
    for await (const _ev of agent.run('hi')) {
      // drain
    }
    const system = systemOf(mock.doStreamCalls[0]);
    expect(system).toContain('base prompt');
    expect(system).toContain('# Current tasks');
    expect(system).toContain('- [completed] write failing test');
    expect(system).toContain('- [in_progress] implement feature');
  });

  it('omits the tasks block when the list is empty', async () => {
    const mock = textMock();
    const agent = makeAgent(mock);
    for await (const _ev of agent.run('hi')) {
      // drain
    }
    expect(systemOf(mock.doStreamCalls[0])).not.toContain('# Current tasks');
  });

  it('adds a one-shot plan-handoff note on the first run after leaving plan mode', async () => {
    const mock = textMock();
    const agent = makeAgent(mock, 'plan');
    const switched = agent.queueModeSwitch('build');
    expect(switched.status).toBe('applied');

    for await (const _ev of agent.run('looks good, go ahead')) {
      // drain
    }
    expect(systemOf(mock.doStreamCalls[0])).toContain('# Plan accepted');

    for await (const _ev of agent.run('next message')) {
      // drain
    }
    const secondRunCall = mock.doStreamCalls[mock.doStreamCalls.length - 1];
    expect(systemOf(secondRunCall)).not.toContain('# Plan accepted');
  });

  it('adds the handoff note when the switch is drained at run start', async () => {
    const mock = textMock();
    const agent = makeAgent(mock, 'plan');
    // Queue the switch as if a run were active, then let run() drain it.
    agent.queueModeSwitch('build');
    for await (const _ev of agent.run('approved')) {
      // drain
    }
    expect(systemOf(mock.doStreamCalls[0])).toContain('# Plan accepted');
  });

  it('injects a user message with image parts when read tool returns an image', async () => {
    const imageData = 'data:image/png;base64,abc123';
    const readTool = tool({
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ kind: 'image', data: imageData, mime: 'image/png' }),
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'read',
                  input: JSON.stringify({ path: 'screenshot.png' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'I see the image.' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
      languageModel: model,
      tools: { read: readTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: string[] = [];
    for await (const ev of agent.run('look at this')) {
      events.push(ev.type);
    }

    // The run should complete normally.
    expect(events[events.length - 1]).toBe('run_finished');

    // Find the user message that was injected after the tool result.
    const userMessages = agent.session.messages.filter(
      (msg): msg is { role: 'user'; content: unknown } => msg.role === 'user',
    );
    expect(userMessages.length).toBeGreaterThanOrEqual(2);

    // The last user message should be the image injection.
    const lastUser = userMessages[userMessages.length - 1];
    expect(Array.isArray(lastUser.content)).toBe(true);
    const parts = lastUser.content as Array<{ type: string; image?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('image');
    expect(parts[0].image).toBe(imageData);
  });
});

describe('vision routing', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-agent-vision-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function textMock(text: string) {
    return new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: text },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    });
  }

  async function writeTestImage(name = 'shot.png'): Promise<string> {
    const path = join(home, name);
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return path;
  }

  function okResolution(visionMock: MockLanguageModelV3): VisionModelResolution {
    return {
      status: 'ok',
      ref: 'vis/v',
      model: { providerId: 'vis', modelId: 'v', maxSteps: 10, vision: true },
      languageModel: visionMock as unknown as LanguageModel,
      contextWindow: 100_000,
      contextWindowIsApproximate: false,
    };
  }

  it('routes a run with user images to the vision model and reverts after', async () => {
    const primary = textMock('primary');
    const vision = textMock('vision');
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: primary as unknown as LanguageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    agent.setVisionModelResolver(() => okResolution(vision));
    const imagePath = await writeTestImage();

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('what is this?', [imagePath])) {
      events.push(ev);
    }

    expect(vision.doStreamCalls).toHaveLength(1);
    expect(primary.doStreamCalls).toHaveLength(0);

    const types = events.map((ev) => ev.type);
    const started = events.find((ev) => ev.type === 'vision_route_started');
    expect(started).toMatchObject({ from: 'mock/m', to: 'vis/v', trigger: 'user_images' });
    const ended = events.find((ev) => ev.type === 'vision_route_ended');
    expect(ended).toMatchObject({ restored: 'mock/m' });
    expect(types.indexOf('vision_route_started')).toBeGreaterThan(types.indexOf('user_message'));
    expect(types.indexOf('vision_route_ended')).toBeLessThan(types.indexOf('run_finished'));

    for await (const _ev of agent.run('follow-up, no image')) {
      // drain
    }
    expect(primary.doStreamCalls).toHaveLength(1);
    expect(vision.doStreamCalls).toHaveLength(1);
    expect(agent.session.userModelOverride).toBeNull();
    expect(agent.session.model.providerId).toBe('mock');
  });

  it('does not route when the active model is vision-capable', async () => {
    const primary = textMock('primary');
    const vision = textMock('vision');
    const agent = new Agent({
      cwd: '/tmp',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 10, vision: true },
      languageModel: primary as unknown as LanguageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    agent.setVisionModelResolver(() => okResolution(vision));
    const imagePath = await writeTestImage();

    const types: string[] = [];
    for await (const ev of agent.run('what is this?', [imagePath])) {
      types.push(ev.type);
    }

    expect(primary.doStreamCalls).toHaveLength(1);
    expect(vision.doStreamCalls).toHaveLength(0);
    expect(types).not.toContain('vision_route_started');
  });

  it('fails the turn upfront with an actionable error when no vision fallback exists', async () => {
    const primary = textMock('primary');
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: primary as unknown as LanguageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    const imagePath = await writeTestImage();

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('see this', [imagePath])) {
      events.push(ev);
    }

    const finished = events.find((ev) => ev.type === 'run_finished');
    expect(finished).toMatchObject({ reason: 'error' });
    expect((finished as { error?: string }).error).toContain('defaultVisionModel');
    expect((finished as { error?: string }).error).toContain('mock/m');
    expect(events.some((ev) => ev.type === 'user_message')).toBe(true);
    expect(primary.doStreamCalls).toHaveLength(0);
    expect(agent.session.messages).toHaveLength(0);
    expect(agent.session.status).toBe('error');
  });

  it('routes when images arrived via appendMessage and the run itself has none', async () => {
    const primary = textMock('primary');
    const vision = textMock('vision');
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: primary as unknown as LanguageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    agent.setVisionModelResolver(() => okResolution(vision));
    const imagePath = await writeTestImage();

    await agent.appendMessage('context screenshot', [imagePath]);
    const types: string[] = [];
    for await (const ev of agent.run('what do you see?')) {
      types.push(ev.type);
    }

    expect(vision.doStreamCalls).toHaveLength(1);
    expect(primary.doStreamCalls).toHaveLength(0);
    expect(types).toContain('vision_route_started');
  });

  it('reports the vision model context window on usage_updated during a routed turn', async () => {
    const primary = textMock('primary');
    const vision = textMock('vision');
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: primary as unknown as LanguageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    agent.setVisionModelResolver(() => okResolution(vision));
    const imagePath = await writeTestImage();

    const windows: number[] = [];
    for await (const ev of agent.run('look', [imagePath])) {
      if (ev.type === 'usage_updated') windows.push(ev.contextWindow);
    }

    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every((w) => w === 100_000)).toBe(true);
  });

  it('reverts to the primary model after an interrupted vision turn', async () => {
    const primary = textMock('primary');
    const slowVision = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 10,
          chunkDelayInMs: 50,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'looking...' },
          ],
        }),
      }),
    });
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: primary as unknown as LanguageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    let resolverCalls = 0;
    agent.setVisionModelResolver(() => {
      resolverCalls += 1;
      return okResolution(slowVision);
    });
    const imagePath = await writeTestImage();

    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const ev of agent.run('look', [imagePath])) {
        events.push(ev);
      }
    })();
    await new Promise((r) => setTimeout(r, 20));
    agent.interrupt();
    await drain;

    const types = events.map((ev) => ev.type);
    expect(types).toContain('vision_route_ended');
    expect(types.indexOf('vision_route_ended')).toBeLessThan(types.indexOf('run_finished'));
    expect(agent.session.model.providerId).toBe('mock');

    // The interrupted turn never produced an assistant reply, so the image
    // is still unseen: the follow-up must re-engage routing freshly (new
    // resolver call + started event) rather than reuse a leaked override.
    const followUpTypes: string[] = [];
    const followUp = (async () => {
      for await (const ev of agent.run('plain follow-up')) {
        followUpTypes.push(ev.type);
      }
    })();
    await new Promise((r) => setTimeout(r, 20));
    agent.interrupt();
    await followUp;

    expect(resolverCalls).toBe(2);
    expect(followUpTypes).toContain('vision_route_started');
    expect(primary.doStreamCalls).toHaveLength(0);
  });

  function readToolCallMock() {
    return new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'read',
              input: JSON.stringify({ path: '/tmp/screenshot.png' }),
            },
            {
              type: 'finish',
              finishReason: 'tool-calls',
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    });
  }

  const imageReadTool = tool({
    description: 'read',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => ({
      kind: 'image',
      data: 'data:image/png;base64,abc123',
      mime: 'image/png',
    }),
  });

  it('switches the rest of the run to the vision model when the read tool returns an image', async () => {
    const primary = readToolCallMock();
    const vision = textMock('vision sees it');
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: primary as unknown as LanguageModel,
      tools: { read: imageReadTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    agent.setVisionModelResolver(() => okResolution(vision));

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('open the screenshot')) {
      events.push(ev);
    }

    expect(primary.doStreamCalls).toHaveLength(1);
    expect(vision.doStreamCalls).toHaveLength(1);
    const started = events.find((ev) => ev.type === 'vision_route_started');
    expect(started).toMatchObject({ from: 'mock/m', to: 'vis/v', trigger: 'tool_image' });
    const types = events.map((ev) => ev.type);
    expect(types.indexOf('vision_route_ended')).toBeLessThan(types.indexOf('run_finished'));
  });

  it('records the read path on injected image parts so later turns can re-read the file', async () => {
    const primary = readToolCallMock();
    const vision = textMock('vision sees it');
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: primary as unknown as LanguageModel,
      tools: { read: imageReadTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    agent.setVisionModelResolver(() => okResolution(vision));

    for await (const _ev of agent.run('open the screenshot')) {
      // drain
    }

    const injected = agent.session.messages.filter(
      (msg) => msg.role === 'user' && Array.isArray(msg.content),
    );
    const imagePart = (injected[injected.length - 1].content as Array<Record<string, unknown>>)[0];
    expect(imagePart.type).toBe('image');
    expect(imagePart.providerOptions).toEqual({ chimera: { sourcePath: '/tmp/screenshot.png' } });
  });

  it('continues the run and warns once when a tool image appears with no vision fallback', async () => {
    let call = 0;
    const primary = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'read',
                  input: JSON.stringify({ path: '/tmp/screenshot.png' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: {
                    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 5, text: 5, reasoning: 0 },
                  },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'cannot see it' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              },
            ],
          }),
        };
      },
    });
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: primary as unknown as LanguageModel,
      tools: { read: imageReadTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('open the screenshot')) {
      events.push(ev);
    }

    const unavailable = events.filter((ev) => ev.type === 'vision_route_unavailable');
    expect(unavailable).toHaveLength(1);
    expect((unavailable[0] as { reason: string }).reason).toContain('resolver');
    const finished = events.find((ev) => ev.type === 'run_finished');
    expect(finished).toMatchObject({ reason: 'stop' });
    expect(primary.doStreamCalls).toHaveLength(2);
  });

  function seededAgent(opts: {
    languageModel: LanguageModel;
    messages: unknown[];
    model?: ModelConfig;
  }) {
    return new Agent({
      cwd: '/tmp',
      model: opts.model ?? makeModel(),
      languageModel: opts.languageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      session: {
        id: newSessionId(),
        parentId: null,
        children: [],
        cwd: '/tmp',
        createdAt: 1,
        messages: opts.messages as Session['messages'],
        toolCalls: [],
        status: 'idle',
        model: opts.model ?? makeModel(),
        sandboxMode: 'off',
        usage: emptyUsage(),
        mode: 'build',
        userModelOverride: null,
        fileOps: { reads: new Set(), writes: new Set() },
      },
    });
  }

  it('substitutes historical images with a re-readable placeholder for non-vision models', async () => {
    const primary = textMock('primary');
    const vision = textMock('vision');
    const imagePath = await writeTestImage();
    const agent = seededAgent({
      languageModel: primary as unknown as LanguageModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', image: imagePath },
          ],
        },
        { role: 'assistant', content: 'It shows a bar chart.' },
      ],
    });
    agent.setVisionModelResolver(() => okResolution(vision));

    for await (const _ev of agent.run('tell me more')) {
      // drain
    }

    expect(primary.doStreamCalls).toHaveLength(1);
    const promptJson = JSON.stringify(primary.doStreamCalls[0].prompt);
    expect(promptJson).toContain(`[Image: ${imagePath}`);
    expect(promptJson).toContain('vis/v');
    expect(promptJson).toContain('read');
    expect(promptJson).not.toContain('iVBOR');

    const seeded = agent.session.messages[0] as { content: Array<{ type: string }> };
    expect(seeded.content.some((part) => part.type === 'image')).toBe(true);
  });

  it('drops the re-read hint when the image file no longer exists', async () => {
    const primary = textMock('primary');
    const vision = textMock('vision');
    const agent = seededAgent({
      languageModel: primary as unknown as LanguageModel,
      messages: [
        { role: 'user', content: [{ type: 'image', image: join(home, 'gone.png') }] },
        { role: 'assistant', content: 'A diagram.' },
      ],
    });
    agent.setVisionModelResolver(() => okResolution(vision));

    for await (const _ev of agent.run('and?')) {
      // drain
    }

    const promptJson = JSON.stringify(primary.doStreamCalls[0].prompt);
    expect(promptJson).toContain('no longer exists');
    expect(promptJson).not.toContain('Read the file again');
  });

  it('tells the model how the user can enable vision when no fallback is configured', async () => {
    const primary = textMock('primary');
    const imagePath = await writeTestImage();
    const agent = seededAgent({
      languageModel: primary as unknown as LanguageModel,
      messages: [
        { role: 'user', content: [{ type: 'image', image: imagePath }] },
        { role: 'assistant', content: 'noted' },
      ],
    });

    for await (const _ev of agent.run('and?')) {
      // drain
    }

    const promptJson = JSON.stringify(primary.doStreamCalls[0].prompt);
    expect(promptJson).toContain('defaultVisionModel');
    expect(promptJson).toContain(imagePath);
  });

  it('marks inline images without a source path as not viewable', async () => {
    const primary = textMock('primary');
    const vision = textMock('vision');
    const agent = seededAgent({
      languageModel: primary as unknown as LanguageModel,
      messages: [
        { role: 'user', content: [{ type: 'image', image: 'data:image/png;base64,legacy' }] },
        { role: 'assistant', content: 'noted' },
      ],
    });
    agent.setVisionModelResolver(() => okResolution(vision));

    for await (const _ev of agent.run('and?')) {
      // drain
    }

    const promptJson = JSON.stringify(primary.doStreamCalls[0].prompt);
    expect(promptJson).toContain('previously provided inline');
    expect(promptJson).not.toContain('base64,legacy');
  });

  it('substitutes a text note when a vision model image path cannot be read', async () => {
    const vision = textMock('vision');
    const agent = seededAgent({
      model: { providerId: 'mock', modelId: 'm', maxSteps: 10, vision: true },
      languageModel: vision as unknown as LanguageModel,
      messages: [
        { role: 'user', content: [{ type: 'image', image: join(home, 'missing.png') }] },
        { role: 'assistant', content: 'noted' },
      ],
    });

    for await (const _ev of agent.run('and?')) {
      // drain
    }

    const promptJson = JSON.stringify(vision.doStreamCalls[0].prompt);
    expect(promptJson).toContain('[Image unavailable');
    expect(promptJson).toContain('missing.png');
  });

  it('instructs the vision model to describe images only while routed', async () => {
    const primary = textMock('primary');
    const vision = textMock('vision');
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: primary as unknown as LanguageModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    agent.setVisionModelResolver(() => okResolution(vision));
    const imagePath = await writeTestImage();

    for await (const _ev of agent.run('look', [imagePath])) {
      // drain
    }
    const systemOf = (call: { prompt: Array<{ role: string; content: unknown }> }) => {
      const sys = call.prompt.find((m) => m.role === 'system');
      return typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content ?? '');
    };
    expect(systemOf(vision.doStreamCalls[0])).toContain('# Vision turn');

    for await (const _ev of agent.run('plain follow-up')) {
      // drain
    }
    expect(systemOf(primary.doStreamCalls[0])).not.toContain('# Vision turn');
  });

  it('elides the base64 payload from read-image tool results in every prompt', async () => {
    const primary = readToolCallMock();
    const vision = textMock('vision sees it');
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: primary as unknown as LanguageModel,
      tools: { read: imageReadTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    agent.setVisionModelResolver(() => okResolution(vision));

    for await (const _ev of agent.run('open the screenshot')) {
      // drain
    }

    // The vision step's prompt carries the image once, as the injected user
    // image part — not a second time as JSON text inside the tool result.
    const visionPrompt = vision.doStreamCalls[0].prompt as Array<{
      role: string;
      content: unknown;
    }>;
    const toolMessage = visionPrompt.find((msg) => msg.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(JSON.stringify(toolMessage)).toContain('elided');
    expect(JSON.stringify(toolMessage)).not.toContain('base64,abc123');
    const hasUserImagePart = visionPrompt.some(
      (msg) =>
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        (msg.content as Array<{ type: string }>).some((part) => part.type === 'file'),
    );
    expect(hasUserImagePart).toBe(true);
  });

  it('drains mid-run injected messages at the next step boundary', async () => {
    // Step 1 emits a tool call whose body injects a correction mid-run; step 2
    // must see that correction in its prompt and respond to it. Exercises the
    // core injection path: injectRunMessage -> pendingInjectMessages -> drain
    // after the tool-call step -> terminal-step continue -> model responds.
    let agentRef: Agent | undefined;
    const echoTool = tool({
      description: 'echo',
      inputSchema: z.object({ text: z.string() }),
      execute: async () => {
        // Inject while step 1 is in flight (tool executing). The buffer is
        // only read at the step boundary, after this returns.
        agentRef?.injectRunMessage('CORRECTION: use uppercase');
        return { ok: true };
      },
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'let me echo' },
                { type: 'text-end', id: 't1' },
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'echo',
                  input: JSON.stringify({ text: 'x' }),
                },
                {
                  type: 'finish',
                  finishReason: 'tool-calls',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'OK UPPERCASE' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: { echo: echoTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    agentRef = agent;

    const events: AgentEvent[] = [];
    for await (const ev of agent.run('echo something')) {
      events.push(ev);
    }

    // Two doStream calls: step 1 (tool call) + step 2 (response to correction).
    const calls = (model as unknown as { doStreamCalls: unknown[] }).doStreamCalls;
    expect(calls).toHaveLength(2);
    // The injected correction appears in step 2's prompt.
    const step2Prompt = JSON.stringify(
      (model as unknown as { doStreamCalls: Array<{ prompt: unknown }> }).doStreamCalls[1]!.prompt,
    );
    expect(step2Prompt).toContain('CORRECTION: use uppercase');
    // A user_message event was emitted for the injection.
    expect(
      events.some((ev) => ev.type === 'user_message' && ev.content === 'CORRECTION: use uppercase'),
    ).toBe(true);
    // The model's final text reflects acting on the correction.
    const dones = events
      .filter((ev) => ev.type === 'assistant_text_done')
      .map((ev) => (ev as { text: string }).text);
    expect(dones).toContain('OK UPPERCASE');
  });

  it('drops pending mid-run injects when the run is interrupted', async () => {
    // An interrupted step must not carry injects into the next run — the
    // drain sits after the terminalReason !== 'stop' break, and a fresh run
    // clears the buffer. Verify by injecting during a tool call that aborts,
    // then asserting a subsequent run starts clean.
    let agentRef: Agent | undefined;
    const slowTool = tool({
      description: 'slow',
      inputSchema: z.object({}),
      execute: async () => {
        agentRef?.injectRunMessage('should be dropped');
        // Abort the run from within the tool.
        agentRef?.interrupt();
        return { ok: true };
      },
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'slow',
              input: JSON.stringify({}),
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

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: { slow: slowTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });
    agentRef = agent;

    for await (const _ev of agent.run('go')) {
      // drain; run aborts inside the tool
    }
    expect(agent.session.status).toBe('idle');

    // A fresh run should not see the dropped injection in its prompt.
    const cleanModel = textOnlyModel('done');
    const cleanAgent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: cleanModel,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      session: agent.session,
    });
    for await (const _ev of cleanAgent.run('next')) {
      // drain
    }
    const promptJson = JSON.stringify(
      (cleanModel as unknown as { doStreamCalls: Array<{ prompt: unknown }> }).doStreamCalls[0]
        .prompt,
    );
    expect(promptJson).not.toContain('should be dropped');
  });
});
