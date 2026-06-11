import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tool, type LanguageModel, type ToolSet } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent';
import type { CompactorApi, Session } from '../src/types';

function makeModel(): { providerId: 'mock'; modelId: 'm'; maxSteps: number } {
  return { providerId: 'mock', modelId: 'm', maxSteps: 1 };
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

describe('file-ops tracking', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-compaction-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('adds read path to session.fileOps.reads on tool-result', async () => {
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
              toolCallId: 'c1',
              toolName: 'read',
              input: JSON.stringify({ path: './src/foo.ts' }),
            },
            {
              type: 'tool-result',
              toolCallId: 'c1',
              output: { content: 'ok' },
            },
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
      cwd: '/project',
      model: makeModel(),
      languageModel: model,
      tools: { read: readTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    for await (const _ev of agent.run('go')) {
      // drain
    }

    expect(agent.session.fileOps.reads.has(resolve('/project/src/foo.ts'))).toBe(true);
    expect(agent.session.fileOps.writes.size).toBe(0);
  });

  it('adds write path to session.fileOps.writes on tool-result', async () => {
    const writeTool = tool({
      description: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ bytes_written: 4, created: true }),
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'write',
              input: JSON.stringify({ path: './bar.ts', content: 'hi' }),
            },
            {
              type: 'tool-result',
              toolCallId: 'c1',
              output: { bytes_written: 4 },
            },
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
      cwd: '/project',
      model: makeModel(),
      languageModel: model,
      tools: { write: writeTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    for await (const _ev of agent.run('go')) {
      // drain
    }

    expect(agent.session.fileOps.writes.has(resolve('/project/bar.ts'))).toBe(true);
    expect(agent.session.fileOps.reads.size).toBe(0);
  });

  it('adds edit path to session.fileOps.writes on tool-result', async () => {
    const editTool = tool({
      description: 'edit',
      inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
      execute: async () => ({ replacements: 1, startLine: 1, contextBefore: [], contextAfter: [] }),
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'edit',
              input: JSON.stringify({ path: './src/index.ts', old_string: 'a', new_string: 'b' }),
            },
            {
              type: 'tool-result',
              toolCallId: 'c1',
              output: { replacements: 1 },
            },
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
      cwd: '/project',
      model: makeModel(),
      languageModel: model,
      tools: { edit: editTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    for await (const _ev of agent.run('go')) {
      // drain
    }

    expect(agent.session.fileOps.writes.has(resolve('/project/src/index.ts'))).toBe(true);
    expect(agent.session.fileOps.reads.size).toBe(0);
  });

  it('moves a path from reads to writes when the file is first read then written', async () => {
    const readTool = tool({
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => ({ content: 'ok', total_lines: 1, truncated: false }),
    });
    const writeTool = tool({
      description: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async () => ({ bytes_written: 4, created: false }),
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
              input: JSON.stringify({ path: './same.ts' }),
            },
            {
              type: 'tool-result',
              toolCallId: 'c1',
              output: { content: 'ok' },
            },
            {
              type: 'tool-call',
              toolCallId: 'c2',
              toolName: 'write',
              input: JSON.stringify({ path: './same.ts', content: 'new' }),
            },
            {
              type: 'tool-result',
              toolCallId: 'c2',
              output: { bytes_written: 3 },
            },
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
      cwd: '/project',
      model: makeModel(),
      languageModel: model,
      tools: { read: readTool, write: writeTool } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    for await (const _ev of agent.run('go')) {
      // drain
    }

    const absPath = resolve('/project/same.ts');
    // Both read and write should be tracked; the compaction layer's
    // formatFilesBlock handles the "modified-only" semantics.
    expect(agent.session.fileOps.reads.has(absPath)).toBe(true);
    expect(agent.session.fileOps.writes.has(absPath)).toBe(true);
  });
});

describe('compaction trigger', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-compaction-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function makeAgent(compactor: CompactorApi | undefined, enabled: boolean) {
    return new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: textOnlyModel('hi'),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 10_000,
      compaction: { enabled, reserveTokens: 1_000, keepRecentTokens: 500, thresholdPercent: 85 },
      compactor,
    });
  }

  function okCompact(): CompactorApi['compact'] {
    return vi.fn().mockImplementation(async (session: Session) => {
      session.messages.splice(0, session.messages.length, {
        role: 'assistant',
        content: 'summary',
      });
      return { summary: 'summary', tokensBefore: 100, tokensAfter: 10, messagesReplaced: 5 };
    });
  }

  it('compacts at run start when the projected prompt exceeds the trigger', async () => {
    const compact = okCompact();
    const compactor: CompactorApi = { maybeCompact: vi.fn(), compact };
    const agent = makeAgent(compactor, true);
    // Pre-existing history big enough that the char/4 estimate crosses the
    // 8500-token trigger for the 10k window.
    agent.session.messages.push({ role: 'user', content: 'x'.repeat(40_000) });

    for await (const _ev of agent.run('go')) {
      // drain
    }

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(agent.session, 'threshold');
    const hasSummary = agent.session.messages.some(
      (m) => m.role === 'assistant' && m.content === 'summary',
    );
    expect(hasSummary).toBe(true);
  });

  it('does not compact at run start below the trigger', async () => {
    const compact = vi.fn();
    const compactor: CompactorApi = { maybeCompact: vi.fn(), compact };
    const agent = makeAgent(compactor, true);

    for await (const _ev of agent.run('go')) {
      // drain
    }
    expect(compact).not.toHaveBeenCalled();
  });

  it('does not compact when compaction.enabled is false', async () => {
    const compact = vi.fn();
    const compactor: CompactorApi = { maybeCompact: vi.fn(), compact };
    const agent = makeAgent(compactor, false);
    agent.session.messages.push({ role: 'user', content: 'x'.repeat(40_000) });

    for await (const _ev of agent.run('go')) {
      // drain
    }
    expect(compact).not.toHaveBeenCalled();
  });

  it('does not throw when no compactor is provided', async () => {
    const agent = makeAgent(undefined, true);
    agent.session.messages.push({ role: 'user', content: 'x'.repeat(40_000) });
    for await (const _ev of agent.run('go')) {
      // drain
    }
    expect(true).toBe(true);
  });

  it('emits compaction_failed and finishes the run when compact throws', async () => {
    const compactor: CompactorApi = {
      maybeCompact: vi.fn(),
      compact: vi.fn().mockRejectedValue(new Error('llm timeout')),
    };
    const agent = makeAgent(compactor, true);
    agent.session.messages.push({ role: 'user', content: 'x'.repeat(40_000) });

    const events: Array<{ type: string; error?: string }> = [];
    for await (const ev of agent.run('go')) {
      events.push(ev);
    }

    const fail = events.find((e) => e.type === 'compaction_failed');
    expect(fail).toBeDefined();
    expect(fail?.error).toBe('llm timeout');
    expect(events.at(-1)?.type).toBe('run_finished');
  });
});

describe('Agent.compactSession', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-compaction-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('yields compaction_failed when no compactor is configured', async () => {
    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: textOnlyModel('hi'),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
    });

    const events: Array<{ type: string; error?: string }> = [];
    for await (const ev of agent.compactSession()) {
      events.push(ev);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'compaction_failed', error: 'not configured' });
  });

  it('invokes compact with manual reason when compactor is provided', async () => {
    const compactFn = vi.fn().mockResolvedValue({ summary: '', tokensBefore: 0, tokensAfter: 0, messagesReplaced: 0 });
    const compactor: CompactorApi = {
      maybeCompact: vi.fn().mockResolvedValue(false),
      compact: compactFn,
    };

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: textOnlyModel('hi'),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      compactor,
    });

    const events: string[] = [];
    for await (const ev of agent.compactSession()) {
      events.push(ev.type);
    }

    expect(compactFn).toHaveBeenCalledTimes(1);
    expect(compactFn).toHaveBeenCalledWith(agent.session, 'manual');
    expect(events).toContain('compaction_started');
    expect(events).toContain('compaction_finished');
  });

  it('yields compaction_failed when compact throws', async () => {
    const compactor: CompactorApi = {
      maybeCompact: vi.fn().mockResolvedValue(false),
      compact: vi.fn(() => Promise.reject(new Error('disk full'))),
    };

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: textOnlyModel('hi'),
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      compactor,
    });

    const events: Array<{ type: string; error?: string }> = [];
    for await (const ev of agent.compactSession()) {
      events.push(ev);
    }

    expect(events.map((e) => e.type)).toContain('compaction_failed');
    const fail = events.find((e) => e.type === 'compaction_failed');
    expect(fail?.error).toBe('disk full');
  });
});

describe('mid-run auto-compaction', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-midrun-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function twoStepModel(step1InputTokens: number): LanguageModel {
    const doStream = vi
      .fn()
      .mockImplementationOnce(async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'probe',
              input: JSON.stringify({}),
            },
            {
              type: 'finish',
              finishReason: 'tool-calls',
              usage: {
                inputTokens: { total: step1InputTokens, noCache: step1InputTokens, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      }))
      .mockImplementation(async () => ({
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
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      }));
    return new MockLanguageModelV3({ doStream }) as unknown as LanguageModel;
  }

  function probeTool() {
    return tool({
      description: 'probe',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
  }

  function makeAgent(compactor: CompactorApi, step1InputTokens: number) {
    return new Agent({
      cwd: '/project',
      model: { providerId: 'mock', modelId: 'm', maxSteps: 5 },
      languageModel: twoStepModel(step1InputTokens),
      tools: { probe: probeTool() } as unknown as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 10_000,
      compaction: {
        enabled: true,
        reserveTokens: 1_000,
        keepRecentTokens: 500,
        thresholdPercent: 85,
      },
      compactor,
    });
  }

  it('compacts between steps when real usage crosses the threshold', async () => {
    const compact = vi.fn().mockImplementation(async (session: Session) => {
      session.messages.splice(0, session.messages.length, {
        role: 'assistant',
        content: 'summary',
      });
      return {
        summary: 'summary',
        tokensBefore: 9_000,
        tokensAfter: 100,
        messagesReplaced: 3,
        strategy: 'prune',
        prunedCount: 2,
        prunedTokensSaved: 8_000,
      };
    });
    const compactor: CompactorApi = { maybeCompact: vi.fn(), compact };

    // Step 1 reports inputTokens 9000 of a 10k window (threshold 8500) — the
    // between-steps check must compact before step 2.
    const events: string[] = [];
    const agent = makeAgent(compactor, 9_000);
    for await (const ev of agent.run('go')) {
      events.push(ev.type);
    }

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith(agent.session, 'threshold');
    // Compaction events landed mid-run: after the first step_finished and
    // before the run finished.
    const startedIdx = events.indexOf('compaction_started');
    expect(startedIdx).toBeGreaterThan(events.indexOf('step_finished'));
    expect(events.indexOf('compaction_finished')).toBeLessThan(events.indexOf('run_finished'));
    expect(events[events.length - 1]).toBe('run_finished');
  });

  it('does not compact mid-run when usage stays below the threshold', async () => {
    const compact = vi.fn();
    const compactor: CompactorApi = { maybeCompact: vi.fn(), compact };
    const agent = makeAgent(compactor, 1_000);
    for await (const _ev of agent.run('go')) {
      // drain
    }
    expect(compact).not.toHaveBeenCalled();
  });

  it('continues the run and latches off when mid-run compaction fails', async () => {
    const compact = vi.fn().mockRejectedValue(new Error('summarizer down'));
    const compactor: CompactorApi = { maybeCompact: vi.fn(), compact };
    const events: string[] = [];
    const agent = makeAgent(compactor, 9_000);
    for await (const ev of agent.run('go')) {
      events.push(ev.type);
    }
    expect(events).toContain('compaction_failed');
    expect(events[events.length - 1]).toBe('run_finished');
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('does not re-compact when compaction fails to get under the threshold', async () => {
    const compact = vi.fn().mockImplementation(async () => ({
      summary: 's',
      tokensBefore: 9_000,
      tokensAfter: 8_900,
      messagesReplaced: 0,
      strategy: 'prune',
      prunedCount: 0,
      prunedTokensSaved: 0,
    }));
    const compactor: CompactorApi = { maybeCompact: vi.fn(), compact };
    // Messages stay huge after "compaction" — estimate mode still over
    // threshold, but the ineffective latch must stop a retry loop.
    const agent = makeAgent(compactor, 9_000);
    agent.session.messages.push({ role: 'user', content: 'x'.repeat(40_000) });
    for await (const _ev of agent.run('go')) {
      // drain
    }
    expect(compact).toHaveBeenCalledTimes(1);
  });
});
