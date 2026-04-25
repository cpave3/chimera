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
    const model = new MockLanguageModelV3({
      doStream: async () => ({
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
      }),
    }) as unknown as LanguageModel;

    const hits: Array<{ skillName: string; source: string }> = [];
    const agent = new Agent({
      cwd: '/tmp',
      // maxSteps: 1 so the mock stream runs one step; otherwise the AI SDK
      // loops on `tool-calls` finish and the mock replays forever.
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
    const model = new MockLanguageModelV3({
      doStream: async () => ({
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
      }),
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
    expect(() =>
      agent.pushEvent({ type: 'assistant_text_done', text: 'lost' }),
    ).not.toThrow();
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
});
