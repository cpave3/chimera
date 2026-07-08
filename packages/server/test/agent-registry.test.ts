import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type CompactorApi, type ModelConfig } from '@chimera/core';
import type { LanguageModel, ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agent-registry';

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
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ],
      }),
    }),
  }) as unknown as LanguageModel;
}

const model: ModelConfig = { providerId: 'mock', modelId: 'm', maxSteps: 10 };

describe('AgentRegistry compaction', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-registry-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function makeRegistry(compactor?: CompactorApi): AgentRegistry {
    return new AgentRegistry({
      factory: {
        build: async (init) => ({
          agent: new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('hi'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
            compactor,
          }),
        }),
      },
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
  }

  it('compact returns missing for unknown session', () => {
    const registry = makeRegistry();
    const result = registry.compact('nonexistent-session-id');
    expect(result).toBe('missing');
  });

  it('compact returns queued for idle session', async () => {
    const registry = makeRegistry();
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });
    const result = registry.compact(sessionId);
    expect(result).toBe('queued');
  });

  it('compact returns already-running when run is active', async () => {
    const registry = makeRegistry();
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });
    // Start a run
    const runPromise = registry.run(sessionId, 'hi');
    // Immediately try to compact before run finishes
    const compactResult = registry.compact(sessionId);
    await runPromise;
    expect(compactResult).toBe('already-running');
  });

  it('compact returns already-running when compaction is already active', async () => {
    const compactor: CompactorApi = {
      maybeCompact: async () => ({ ran: false }),
      compact: async () => {
        await new Promise((r) => setTimeout(r, 50));
      },
    };
    const registry = makeRegistry(compactor);
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });
    registry.compact(sessionId);
    // Try to compact again while first is still running
    const secondResult = registry.compact(sessionId);
    // Wait for the first compaction to finish
    const entry = registry.get(sessionId);
    await entry!.activeCompaction;
    expect(secondResult).toBe('already-running');
  });

  it('run returns already-running when compaction is active', async () => {
    const compactor: CompactorApi = {
      maybeCompact: async () => ({ ran: false }),
      compact: async () => {
        await new Promise((r) => setTimeout(r, 50));
      },
    };
    const registry = makeRegistry(compactor);
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });
    registry.compact(sessionId);
    const runResult = await registry.run(sessionId, 'hi');
    // Wait for compaction to finish
    const entry = registry.get(sessionId);
    await entry!.activeCompaction;
    expect(runResult).toBe('already-running');
  });

  it('compact updates compactionCount and lastCompactedAt on success', async () => {
    const compactor: CompactorApi = {
      maybeCompact: async () => ({ ran: false }),
      compact: async () => ({ summary: '', tokensBefore: 0, tokensAfter: 0, messagesReplaced: 0 }),
    };
    const registry = makeRegistry(compactor);
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });

    const before = Date.now();
    registry.compact(sessionId);
    const entry = registry.get(sessionId);
    await entry!.activeCompaction;

    expect(entry!.compactionCount).toBe(1);
    expect(entry!.lastCompactedAt).toBeGreaterThanOrEqual(before);
    expect(entry!.lastCompactedAt).toBeLessThanOrEqual(Date.now());
  });

  it('multiple compactions increment compactionCount', async () => {
    const compactor: CompactorApi = {
      maybeCompact: async () => ({ ran: false }),
      compact: async () => ({ summary: '', tokensBefore: 0, tokensAfter: 0, messagesReplaced: 0 }),
    };
    const registry = makeRegistry(compactor);
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });

    registry.compact(sessionId);
    let entry = registry.get(sessionId);
    await entry!.activeCompaction;

    registry.compact(sessionId);
    entry = registry.get(sessionId);
    await entry!.activeCompaction;

    expect(entry!.compactionCount).toBe(2);
  });

  it('compact publishes events on the bus', async () => {
    const compactor: CompactorApi = {
      maybeCompact: async () => ({ ran: false }),
      compact: async () => ({ summary: '', tokensBefore: 0, tokensAfter: 0, messagesReplaced: 0 }),
    };
    const registry = makeRegistry(compactor);
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });

    const events: string[] = [];
    const entry = registry.get(sessionId);
    entry!.bus.subscribe((env) => {
      events.push(env.type);
    });

    registry.compact(sessionId);
    await entry!.activeCompaction;

    expect(events).toContain('compaction_started');
    expect(events).toContain('compaction_finished');
  });

  it('compact publishes compaction_failed when compactor throws', async () => {
    const compactor: CompactorApi = {
      maybeCompact: async () => ({ ran: false }),
      compact: async () => {
        throw new Error('boom');
      },
    };
    const registry = makeRegistry(compactor);
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });

    const events: Array<{ type: string; error?: string }> = [];
    const entry = registry.get(sessionId);
    entry!.bus.subscribe((env) => {
      events.push({ type: env.type, error: (env as { error?: string }).error });
    });

    registry.compact(sessionId);
    await entry!.activeCompaction;

    expect(events.some((ev) => ev.type === 'compaction_failed' && ev.error === 'boom')).toBe(true);
    // compactionCount should NOT be incremented on failure
    expect(entry!.compactionCount).toBe(0);
  });

  it('compact publishes compaction_failed when no compactor is configured', async () => {
    const registry = makeRegistry();
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });

    const events: Array<{ type: string; error?: string }> = [];
    const entry = registry.get(sessionId);
    entry!.bus.subscribe((env) => {
      events.push({ type: env.type, error: (env as { error?: string }).error });
    });

    registry.compact(sessionId);
    await entry!.activeCompaction;

    expect(
      events.some((ev) => ev.type === 'compaction_failed' && ev.error === 'not configured'),
    ).toBe(true);
    expect(entry!.compactionCount).toBe(0);
    expect(entry!.lastCompactedAt).toBeNull();
  });
});

describe('AgentRegistry mid-run injectMessage', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-registry-inject-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /**
   * Builds a registry whose agent uses a model whose first `doStream` call
   * blocks on a gate promise the test controls. This keeps `entry.runActive`
   * true (the run's IIFE is awaiting the stream) so `injectMessage` exercises
   * the mid-run path. Once the test releases the gate, the stream completes
   * with a plain stop so the run finishes cleanly.
   */
  function makeGatedRegistry(gate: { resolve: () => void }): {
    registry: AgentRegistry;
    release: () => void;
  } {
    let call = 0;
    let releaseGate = () => {};
    const gatePromise = new Promise<void>((r) => {
      releaseGate = r;
    });
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        if (call === 1) {
          // Signal the test, then block until it releases the gate so the
          // run stays active while injectMessage is called.
          gate.resolve();
          await gatePromise;
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
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ],
          }),
        };
      },
    }) as unknown as LanguageModel;
    const registry = new AgentRegistry({
      factory: {
        build: async (init) => ({
          agent: new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: model,
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
          }),
        }),
      },
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    return { registry, release: releaseGate };
  }

  it('returns injected (not already-running) when a run is active', async () => {
    let gateFired = () => {};
    const gatePromise = new Promise<void>((r) => {
      gateFired = r;
    });
    const { registry, release } = makeGatedRegistry({ resolve: gateFired });
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });

    const events: string[] = [];
    const entry = registry.get(sessionId);
    entry!.bus.subscribe((env) => {
      events.push(env.type);
    });

    // Start the run (returns 'queued' immediately; run continues in the
    // background). Step 1's doStream blocks on the gate, keeping runActive.
    const status = await registry.run(sessionId, 'start');
    expect(status).toBe('queued');
    await gatePromise;

    // While the run is active, inject a message — must succeed, not 409.
    const state = await registry.injectMessage(sessionId, 'correction');
    expect(state).toBe('injected');

    // Release the gate so the stream completes and the run finishes.
    release();
    await entry!.activeRun;

    // The run emits user_message at the step boundary for the injection; plus
    // the initial user_message for 'start'. run_finished must be present.
    expect(events.filter((t) => t === 'user_message')).toHaveLength(2);
    expect(events).toContain('run_finished');
  });

  it('returns already-running when a compaction is active', async () => {
    const compactor: CompactorApi = {
      maybeCompact: async () => ({ ran: false }),
      compact: async () => {
        await new Promise((r) => setTimeout(r, 50));
      },
    };
    const registry = new AgentRegistry({
      factory: {
        build: async (init) => ({
          agent: new Agent({
            cwd: init.cwd,
            model: init.model,
            languageModel: textOnlyModel('hi'),
            tools: {} as ToolSet,
            sandboxMode: init.sandboxMode,
            home,
            contextWindow: 200_000,
            compactor,
          }),
        }),
      },
      instance: { pid: 1, cwd: '/tmp', version: '0.1.0', sandboxMode: 'off' },
    });
    const { sessionId } = await registry.create({ cwd: '/tmp', model, sandboxMode: 'off' });
    registry.compact(sessionId);
    const state = await registry.injectMessage(sessionId, 'x');
    const entry = registry.get(sessionId);
    await entry!.activeCompaction;
    expect(state).toBe('already-running');
  });
});
