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

  it('invokes maybeCompact before streamText when compaction.enabled is true', async () => {
    const model = textOnlyModel('hi');
    const maybeCompact = vi.fn().mockResolvedValue({ ran: false });
    const compactor: CompactorApi = {
      maybeCompact,
      compact: vi.fn().mockResolvedValue({ summary: '', tokensBefore: 0, tokensAfter: 0, messagesReplaced: 0 }),
    };

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      compactor,
    });

    for await (const _ev of agent.run('go')) {
      // drain
    }

    expect(maybeCompact).toHaveBeenCalledTimes(1);
    expect(maybeCompact).toHaveBeenCalledWith(agent.session);
  });

  it('does not invoke maybeCompact when compaction.enabled is false', async () => {
    const model = textOnlyModel('hi');
    const maybeCompact = vi.fn().mockResolvedValue({ ran: false });
    const compactor: CompactorApi = {
      maybeCompact,
      compact: vi.fn().mockResolvedValue({ summary: '', tokensBefore: 0, tokensAfter: 0, messagesReplaced: 0 }),
    };

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 },
      compactor,
    });

    for await (const _ev of agent.run('go')) {
      // drain
    }

    expect(maybeCompact).not.toHaveBeenCalled();
  });

  it('does not invoke maybeCompact when no compactor is provided', async () => {
    const model = textOnlyModel('hi');

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    });

    for await (const _ev of agent.run('go')) {
      // drain
    }
    // Just should not throw.
    expect(true).toBe(true);
  });

  it('mutates session.messages when maybeCompact returns ran: true', async () => {
    const model = textOnlyModel('hi');
    const compactor: CompactorApi = {
      maybeCompact: vi.fn().mockImplementation(async (session: Session) => {
        // Simulate a successful compaction that replaces messages.
        session.messages = [{ role: 'assistant', content: 'summary' }];
        return { ran: true, summary: 'summary', tokensBefore: 100, tokensAfter: 10, messagesReplaced: 5 };
      }),
      compact: vi.fn().mockResolvedValue({ summary: '', tokensBefore: 0, tokensAfter: 0, messagesReplaced: 0 }),
    };

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      compactor,
    });

    for await (const _ev of agent.run('go')) {
      // drain
    }

    expect(compactor.maybeCompact).toHaveBeenCalledTimes(1);
    const hasSummary = agent.session.messages.some(
      (m) => m.role === 'assistant' && m.content === 'summary',
    );
    expect(hasSummary).toBe(true);
  });

  it('emits compaction_failed when maybeCompact throws', async () => {
    const model = textOnlyModel('hi');
    const compactor: CompactorApi = {
      maybeCompact: vi.fn().mockRejectedValue(new Error('llm timeout')),
      compact: vi.fn().mockResolvedValue({ summary: '', tokensBefore: 0, tokensAfter: 0, messagesReplaced: 0 }),
    };

    const agent = new Agent({
      cwd: '/tmp',
      model: makeModel(),
      languageModel: model,
      tools: {} as ToolSet,
      sandboxMode: 'off',
      home,
      contextWindow: 200_000,
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      compactor,
    });

    const events: Array<{ type: string; error?: string }> = [];
    for await (const ev of agent.run('go')) {
      events.push(ev);
    }

    const fail = events.find((e) => e.type === 'compaction_failed');
    expect(fail).toBeDefined();
    expect(fail?.error).toBe('llm timeout');
    // The run should still finish normally.
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
