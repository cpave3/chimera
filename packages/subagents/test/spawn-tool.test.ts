import type { AgentEvent, ModelConfig, SandboxMode, SessionId } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSpawnAgentTool } from '../src/spawn-tool';
import * as spawnChildMod from '../src/spawn-child';
import type { SpawnAgentToolContext } from '../src/types';

const mockSpawnChimeraChild = vi.fn();
const mockTeardownChild = vi.fn();

vi.mock('../src/spawn-child', async () => {
  const actual = await vi.importActual<typeof import('../src/spawn-child')>('../src/spawn-child');
  return {
    ...actual,
    spawnChimeraChild: (...args: Parameters<typeof actual.spawnChimeraChild>) =>
      mockSpawnChimeraChild(...args),
    teardownChild: (...args: Parameters<typeof actual.teardownChild>) => mockTeardownChild(...args),
  };
});

function baseCtx(over: Partial<SpawnAgentToolContext> = {}): SpawnAgentToolContext {
  return {
    emit: () => {},
    parentAbortSignal: new AbortController().signal,
    parentSessionId: 'parent-1',
    cwd: '/tmp',
    defaultModelRef: 'anthropic/claude-haiku-4-5',
    sandboxMode: 'off',
    autoApprove: 'host',
    currentDepth: 0,
    maxDepth: 3,
    chimeraBin: '/usr/bin/false', // never invoked in these tests
    parentHasTty: true,
    ...over,
  };
}

function makeMockChildHandle(opts: {
  sessionId: SessionId;
  send?: (prompt: string, options: { signal: AbortSignal }) => AsyncIterable<AgentEvent>;
  interrupt?: () => Promise<void>;
}): spawnChildMod.ChildHandle {
  return {
    proc: {
      pid: 123,
      exitCode: null,
      signalCode: null,
    } as unknown as import('node:child_process').ChildProcess,
    client: {
      send: (_sessionId: SessionId, _prompt: string, options: { signal: AbortSignal }) =>
        opts.send!(_prompt, options),
      interrupt: async (_sessionId: SessionId) => {
        if (opts.interrupt) await opts.interrupt();
      },
    } as unknown as import('@chimera/client').ChimeraClient,
    url: 'http://127.0.0.1:9999',
    childSessionId: opts.sessionId,
    pid: 123,
  };
}

beforeEach(() => {
  mockSpawnChimeraChild.mockReset();
  mockTeardownChild.mockReset();
  mockTeardownChild.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildSpawnAgentTool — model index in description', () => {
  it('lists availableModels in the tool description with the first marked as default', () => {
    const ctx = baseCtx({
      availableModels: ['anthropic/claude-opus-4-7', 'anthropic/claude-haiku-4-5', 'openai/gpt-5'],
    });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as { description: string };
    expect(tool.description).toMatch(/Available models/);
    expect(tool.description).toMatch(/anthropic\/claude-opus-4-7 \(default\)/);
    expect(tool.description).toContain('anthropic/claude-haiku-4-5');
    expect(tool.description).toContain('openai/gpt-5');
  });

  it('omits the models block when availableModels is empty or undefined', () => {
    const tool = buildSpawnAgentTool(baseCtx()).tool as unknown as { description: string };
    expect(tool.description).not.toMatch(/Available models/);
    const toolEmpty = buildSpawnAgentTool(baseCtx({ availableModels: [] })).tool as unknown as {
      description: string;
    };
    expect(toolEmpty.description).not.toMatch(/Available models/);
  });
});

describe('buildSpawnAgentTool — depth enforcement', () => {
  it('returns an error result when currentDepth >= maxDepth', async () => {
    const events: AgentEvent[] = [];
    const ctx = baseCtx({
      currentDepth: 3,
      maxDepth: 3,
      emit: (ev) => events.push(ev),
    });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    const result = await tool.execute(
      { prompt: 'go', purpose: 'p', in_process: false },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(result.reason).toBe('error');
    expect(result.result).toMatch(/max subagent depth/);
    // No subagent_spawned should be emitted on depth-cap.
    expect(events.find((e) => e.type === 'subagent_spawned')).toBeUndefined();
  });
});

describe('buildSpawnAgentTool — in-process disabled', () => {
  it('returns an error if in_process is requested but no builder is configured', async () => {
    const events: AgentEvent[] = [];
    const ctx = baseCtx({ emit: (ev) => events.push(ev) });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    const result = await tool.execute(
      { prompt: 'go', purpose: 'p', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(result.reason).toBe('error');
    expect(result.result).toMatch(/in_process subagents are not enabled/);
  });
});

describe('buildSpawnAgentTool — in-process happy path', () => {
  it('emits subagent_spawned, forwards events, and emits subagent_finished', async () => {
    const events: AgentEvent[] = [];
    const sessionId: SessionId = 'child-sess-1';
    const builder: InProcessAgentBuilder = async ({
      cwd: _cwd,
      model: _model,
      sandboxMode: _sm,
      parentAbortSignal: _sig,
    }) => {
      // a tiny mock agent: emits a tool call, assistant_text_done, then run_finished
      const send = async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'assistant_text_delta', delta: 'hi' };
        yield {
          type: 'tool_call_start',
          callId: 'c1',
          name: 'bash',
          args: { command: 'echo hi' },
          target: 'host',
        };
        yield { type: 'assistant_text_done', text: 'hi from child' };
        yield { type: 'step_finished', stepNumber: 1, finishReason: 'stop' };
        yield { type: 'run_finished', reason: 'stop' };
      };
      return {
        sessionId,
        send: () => send(),
        interrupt: () => {},
        dispose: async () => {},
      };
    };
    const ctx = baseCtx({
      emit: (ev) => events.push(ev),
      inProcess: builder,
    });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    const result = await tool.execute(
      { prompt: 'do', purpose: 'investigate', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(result.reason).toBe('stop');
    expect(result.result).toBe('hi from child');
    expect(result.session_id).toBe(sessionId);
    expect(result.steps).toBe(1);
    expect(result.tool_calls_count).toBe(1);

    const spawned = events.find((e) => e.type === 'subagent_spawned');
    const finished = events.find((e) => e.type === 'subagent_finished');
    expect(spawned).toBeDefined();
    expect(finished).toBeDefined();
    // sub-stream events were forwarded
    const wraps = events.filter(
      (e): e is Extract<AgentEvent, { type: 'subagent_event' }> => e.type === 'subagent_event',
    );
    expect(wraps.length).toBeGreaterThan(0);
    // Order is preserved: parent's wrap stream matches the child's emission order.
    expect(wraps.map((w) => w.event.type)).toEqual([
      'assistant_text_delta',
      'tool_call_start',
      'assistant_text_done',
      'step_finished',
      'run_finished',
    ]);
  });

  it('forwards modelOptions[ref].maxOutputTokens onto the child ModelConfig', async () => {
    let receivedModel: ModelConfig | undefined;
    const builder: InProcessAgentBuilder = async ({ model }) => {
      receivedModel = model;
      return {
        sessionId: 'cs',
        send: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: 'run_finished', reason: 'stop' };
          })(),
        interrupt: () => {},
        dispose: async () => {},
      };
    };
    const ctx = baseCtx({
      inProcess: builder,
      modelOptions: { 'anthropic/claude-haiku-4-5': { maxOutputTokens: 16_384 } },
    });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    await tool.execute(
      { prompt: 'go', purpose: 'p', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(receivedModel?.maxOutputTokens).toBe(16_384);
  });

  it('leaves maxOutputTokens undefined on the child when not configured for that ref', async () => {
    let receivedModel: ModelConfig | undefined;
    const builder: InProcessAgentBuilder = async ({ model }) => {
      receivedModel = model;
      return {
        sessionId: 'cs',
        send: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: 'run_finished', reason: 'stop' };
          })(),
        interrupt: () => {},
        dispose: async () => {},
      };
    };
    const ctx = baseCtx({
      inProcess: builder,
      modelOptions: { 'other/model': { maxOutputTokens: 9999 } },
    });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    await tool.execute(
      { prompt: 'go', purpose: 'p', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(receivedModel?.maxOutputTokens).toBeUndefined();
  });

  it('returns reason="timeout" when timeout_ms elapses before run_finished', async () => {
    const events: AgentEvent[] = [];
    const builder: InProcessAgentBuilder = async () => {
      const send = async function* (
        _p: string,
        opts?: { signal?: AbortSignal },
      ): AsyncGenerator<AgentEvent> {
        yield { type: 'assistant_text_delta', delta: '...' };
        // hang until aborted (the spawn-tool's timeout will fire)
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) return resolve();
          opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        // never yield run_finished — timeout path is what we're testing
      };
      return {
        sessionId: 'child-timeout',
        send: (p, o) => send(p, o),
        interrupt: () => {},
        dispose: async () => {},
      };
    };
    const ctx = baseCtx({
      emit: (ev) => events.push(ev),
      inProcess: builder,
    });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    const result = await tool.execute(
      { prompt: 'go', purpose: 'p', in_process: true, timeout_ms: 50 },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(result.reason).toBe('timeout');
  });
});

describe('buildSpawnAgentTool — interrupt cascade', () => {
  it('aborts in-process child when parent signal aborts', async () => {
    const events: AgentEvent[] = [];
    const parentCtl = new AbortController();
    let interrupted = false;

    const builder: InProcessAgentBuilder = async () => {
      const send = async function* (
        _prompt: string,
        opts?: { signal?: AbortSignal },
      ): AsyncGenerator<AgentEvent> {
        yield { type: 'assistant_text_delta', delta: '...' };
        // wait for abort
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) return resolve();
          opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'run_finished', reason: 'interrupted' };
      };
      return {
        sessionId: 'child-int',
        send: (p, o) => send(p, o),
        interrupt: () => {
          interrupted = true;
        },
        dispose: async () => {},
      };
    };

    const ctx = baseCtx({
      emit: (ev) => events.push(ev),
      inProcess: builder,
      parentAbortSignal: parentCtl.signal,
    });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };

    const promise = tool.execute(
      { prompt: 'go', purpose: 'p', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    // give the generator a tick to subscribe
    await new Promise((r) => setTimeout(r, 10));
    parentCtl.abort();
    const result = await promise;
    expect(result.reason).toBe('interrupted');
    expect(interrupted).toBe(true);
  });
});

describe('buildSpawnAgentTool — parent CallId resolution', () => {
  it('uses ctx.resolveCallId(toolCallId) as parentCallId when wired', async () => {
    const events: AgentEvent[] = [];
    const builder: InProcessAgentBuilder = async () => ({
      sessionId: 'cs',
      send: () =>
        (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'assistant_text_done', text: 'ok' };
          yield { type: 'run_finished', reason: 'stop' };
        })(),
      interrupt: () => {},
      dispose: async () => {},
    });
    const ctx = baseCtx({
      emit: (ev) => events.push(ev),
      inProcess: builder,
      resolveCallId: (id) => (id === 'ai-sdk-call-7' ? 'AGENT_CALL_42' : undefined),
    });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    await tool.execute(
      { prompt: 'do', purpose: 'p', in_process: true },
      {
        abortSignal: new AbortController().signal,
        toolCallId: 'ai-sdk-call-7',
        messages: [],
      },
    );
    const spawned = events.find((e) => e.type === 'subagent_spawned');
    expect(spawned).toBeDefined();
    expect((spawned as { parentCallId: string }).parentCallId).toBe('AGENT_CALL_42');
    const finished = events.find((e) => e.type === 'subagent_finished');
    expect((finished as { parentCallId: string }).parentCallId).toBe('AGENT_CALL_42');
  });

  it('falls back to a synthetic id when resolveCallId is not provided', async () => {
    const events: AgentEvent[] = [];
    const builder: InProcessAgentBuilder = async () => ({
      sessionId: 'cs',
      send: () =>
        (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'run_finished', reason: 'stop' };
        })(),
      interrupt: () => {},
      dispose: async () => {},
    });
    const ctx = baseCtx({ emit: (ev) => events.push(ev), inProcess: builder });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    await tool.execute(
      { prompt: 'do', purpose: 'p', in_process: true },
      { abortSignal: new AbortController().signal, toolCallId: 'x', messages: [] },
    );
    const spawned = events.find((e) => e.type === 'subagent_spawned');
    expect((spawned as { parentCallId: string }).parentCallId).toBeTruthy();
  });
});

describe('buildSpawnAgentTool — child-process happy path (mocked)', () => {
  it('spawns child, drives events, tears down, and returns result', async () => {
    const events: AgentEvent[] = [];
    const childSessionId: SessionId = 'child-sess-c1';
    mockSpawnChimeraChild.mockImplementation(async () =>
      makeMockChildHandle({
        sessionId: childSessionId,
        send: async function* (_prompt, _opts) {
          yield { type: 'assistant_text_delta', delta: 'hello' };
          yield { type: 'assistant_text_done', text: 'hello from child' };
          yield { type: 'step_finished', stepNumber: 1, finishReason: 'stop' };
          yield { type: 'run_finished', reason: 'stop' };
        },
      }),
    );

    const ctx = baseCtx({ emit: (ev) => events.push(ev) });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    const result = await tool.execute(
      { prompt: 'do', purpose: 'test' },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(result.reason).toBe('stop');
    expect(result.result).toBe('hello from child');
    expect(result.session_id).toBe(childSessionId);
    expect(result.steps).toBe(1);
    expect(mockTeardownChild).toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'subagent_spawned')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'subagent_finished')).toHaveLength(1);
  });

  it('returns error when spawnChimeraChild throws (handshake failure)', async () => {
    const events: AgentEvent[] = [];
    mockSpawnChimeraChild.mockRejectedValue(new Error(' handshake timed out '));
    const ctx = baseCtx({ emit: (ev) => events.push(ev) });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    const result = await tool.execute(
      { prompt: 'do', purpose: 'test' },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    expect(result.reason).toBe('error');
    expect(result.result).toMatch(/handshake timed out/);
    expect(events.find((e) => e.type === 'subagent_spawned')).toBeUndefined();
  });

  it('propagates parent abort to child interrupt()', async () => {
    const events: AgentEvent[] = [];
    const parentCtl = new AbortController();
    let interrupted = false;
    const childSessionId: SessionId = 'child-sess-c2';
    mockSpawnChimeraChild.mockImplementation(async () =>
      makeMockChildHandle({
        sessionId: childSessionId,
        send: async function* (_prompt, opts) {
          yield { type: 'assistant_text_delta', delta: '...' };
          await new Promise<void>((resolve) => {
            if (opts.signal.aborted) return resolve();
            opts.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          yield { type: 'run_finished', reason: 'interrupted' };
        },
        interrupt: async () => {
          interrupted = true;
        },
      }),
    );
    const ctx = baseCtx({
      emit: (ev) => events.push(ev),
      parentAbortSignal: parentCtl.signal,
    });
    const tool = buildSpawnAgentTool(ctx).tool as unknown as {
      execute: (a: any, c: any) => Promise<any>;
    };
    const promise = tool.execute(
      { prompt: 'do', purpose: 'test' },
      { abortSignal: new AbortController().signal, toolCallId: 't', messages: [] },
    );
    await new Promise((r) => setTimeout(r, 10));
    parentCtl.abort();
    const result = await promise;
    expect(result.reason).toBe('interrupted');
    expect(interrupted).toBe(true);
  });
});

// Extra typing helpers; ai-sdk's tool().execute callback uses these.
type _Unused = ModelConfig | SandboxMode;
