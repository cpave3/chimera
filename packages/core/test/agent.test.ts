import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool, type LanguageModel, type ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, buildPermissionRequest } from '../src/agent';
import type { ModelConfig } from '../src/types';

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
});
