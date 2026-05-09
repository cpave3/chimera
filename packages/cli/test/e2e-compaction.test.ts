import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { Agent } from '@chimera/core';
import type { AgentEvent } from '@chimera/core';
import type { AgentFactory } from '@chimera/server';
import { AgentRegistry, buildApp, startServer } from '@chimera/server';
import { ChimeraClient } from '@chimera/client';
import { Compactor, estimateTokens } from '@chimera/compaction';
import { checkCompactionInvariant, resolveCompactionConfig } from '@chimera/cli';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Build messages that estimate above a given threshold. */
function makeLongMessages(count: number, charsPerMessage: number): { role: 'user'; content: string }[] {
  return Array.from({ length: count }, () => ({
    role: 'user' as const,
    content: 'x'.repeat(charsPerMessage),
  }));
}

/** Stub model that returns a fixed summary text for compaction. */
function summaryModel(summaryText: string): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      text: summaryText,
      content: [{ type: 'text', text: summaryText }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  }) as unknown as LanguageModel;
}

/** Stub model for normal agent runs that returns a short text response. */
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

describe('chimera compaction E2E', () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-compaction-e2e-'));
    workspace = join(home, 'workspace');
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('threshold trigger compacts and preserves tail with structured summary', {
    timeout: 30000,
  }, async () => {
    const longMessages = makeLongMessages(20, 2000);
    const tokenEstimate = estimateTokens(longMessages);
    expect(tokenEstimate).toBeGreaterThan(450);

    const cannedSummary = [
      '## Goal',
      '',
      '## Constraints',
      '',
      '## Progress',
      '### Done',
      '### In Progress',
      '### Blocked',
      '## Key Decisions',
      '',
      '## Next Steps',
      '',
      '## Critical Context',
      '',
      '<files>',
      '  <modified>/src/main.ts</modified>',
      '</files>',
    ].join('\n');

    const factory: AgentFactory = {
      build: async (init) => {
        const compactionConfig = resolveCompactionConfig({ config: {} });
        const resolvedWindow = 500;
        const compactor = new Compactor({
          config: { ...compactionConfig, reserveTokens: 50, keepRecentTokens: 100 },
          contextWindow: resolvedWindow,
          resolveModel: async () => summaryModel(cannedSummary),
          home,
        });

        const agent = new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: textOnlyModel('done.'),
          tools: {},
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: resolvedWindow,
          compaction: compactionConfig,
          compactor,
        });
        agent.session.messages.push(...longMessages);
        agent.session.fileOps.writes.add(resolve(init.cwd, 'src/main.ts'));
        return { agent };
      },
    };

    const registry = new AgentRegistry({
      factory,
      instance: { pid: process.pid, cwd: workspace, version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const server = await startServer({ app });
    const client = new ChimeraClient({ baseUrl: server.url });

    try {
      const { sessionId } = await client.createSession({
        cwd: workspace,
        model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
        sandboxMode: 'off',
      });

      const events: AgentEvent[] = [];
      for await (const ev of client.send(sessionId, 'hi')) {
        events.push(ev);
        if (ev.type === 'run_finished') break;
      }

      const started = events.find(
        (e): e is Extract<AgentEvent, { type: 'compaction_started' }> =>
          e.type === 'compaction_started',
      );
      const finished = events.find(
        (e): e is Extract<AgentEvent, { type: 'compaction_finished' }> =>
          e.type === 'compaction_finished',
      );

      expect(started).toBeDefined();
      expect(started!.reason).toBe('threshold');
      expect(finished).toBeDefined();
      expect(finished!.summary).toContain('## Goal');
      expect(finished!.summary).toContain('<files>');
      // fileOps stores absolute paths, so the summary contains the resolved cwd path.
      expect(finished!.summary).toContain(`<modified>${resolve(workspace, 'src/main.ts')}</modified>`);
      expect(finished!.messagesReplaced).toBeGreaterThan(0);

      const session = await client.getSession(sessionId);
      expect(session.messages.length).toBeLessThan(longMessages.length + 3);
    } finally {
      await server.close();
    }
  });

  it('manual /compact emits compaction_started { reason: "manual" } and compaction_finished', {
    timeout: 30000,
  }, async () => {
    const cannedSummary = [
      '## Goal',
      'test',
      '## Constraints',
      '',
      '## Progress',
      '### Done',
      '### In Progress',
      '### Blocked',
      '## Key Decisions',
      '',
      '## Next Steps',
      '',
      '## Critical Context',
      '',
      '<files>',
      '</files>',
    ].join('\n');

    const factory: AgentFactory = {
      build: async (init) => {
        const compactionConfig = resolveCompactionConfig({ config: {} });
        const resolvedWindow = 200_000;
        const compactor = new Compactor({
          config: { ...compactionConfig, reserveTokens: 50, keepRecentTokens: 100 },
          contextWindow: resolvedWindow,
          resolveModel: async () => summaryModel(cannedSummary),
          home,
        });

        const agent = new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: textOnlyModel('done.'),
          tools: {},
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: resolvedWindow,
          compaction: compactionConfig,
          compactor,
        });
        return { agent };
      },
    };

    const registry = new AgentRegistry({
      factory,
      instance: { pid: process.pid, cwd: workspace, version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const server = await startServer({ app });
    const client = new ChimeraClient({ baseUrl: server.url });

    try {
      const { sessionId } = await client.createSession({
        cwd: workspace,
        model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
        sandboxMode: 'off',
      });

      for await (const ev of client.send(sessionId, 'first message')) {
        if (ev.type === 'run_finished') break;
      }

      const compactEvents: AgentEvent[] = [];
      const subscribeController = new AbortController();

      const subscribePromise = (async () => {
        for await (const ev of client.subscribe(sessionId, { signal: subscribeController.signal })) {
          compactEvents.push(ev);
        }
      })();

      await client.compact(sessionId);

      await new Promise((r) => setTimeout(r, 3000));
      subscribeController.abort();
      await subscribePromise.catch(() => undefined);

      const started = compactEvents.find(
        (e): e is Extract<AgentEvent, { type: 'compaction_started' }> =>
          e.type === 'compaction_started',
      );
      const finished = compactEvents.find(
        (e): e is Extract<AgentEvent, { type: 'compaction_finished' }> =>
          e.type === 'compaction_finished',
      );

      expect(started).toBeDefined();
      expect(started!.reason).toBe('manual');
      expect(finished).toBeDefined();
      expect(finished!.summary).toContain('## Goal');
    } finally {
      await server.close();
    }
  });

  it('config invariant violation exits non-zero with stderr message', async () => {
    const { default: fs } = await import('node:fs/promises');
    await fs.mkdir(join(home, '.chimera'), { recursive: true });

    const result = checkCompactionInvariant(
      { reserveTokens: 80_000, keepRecentTokens: 80_000 },
      128_000,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Compaction invariant violated/);
    expect(result.error).toMatch(/128000/);
    expect(result.error).toMatch(/reserveTokens/);
    expect(result.error).toMatch(/keepRecentTokens/);
  });

  it('--no-compaction disables automatic compaction', {
    timeout: 30000,
  }, async () => {
    const longMessages = makeLongMessages(20, 2000);

    const factory: AgentFactory = {
      build: async (init) => {
        const compactionConfig = resolveCompactionConfig({
          cliOverride: false,
          config: { compaction: { enabled: true } },
        });
        expect(compactionConfig.enabled).toBe(false);

        const resolvedWindow = 500;
        const compactor = new Compactor({
          config: { ...compactionConfig, reserveTokens: 50, keepRecentTokens: 100 },
          contextWindow: resolvedWindow,
          resolveModel: async () => {
            throw new Error('should not be called');
          },
          home,
        });

        const agent = new Agent({
          cwd: init.cwd,
          model: init.model,
          languageModel: textOnlyModel('done.'),
          tools: {},
          sandboxMode: init.sandboxMode,
          home,
          contextWindow: resolvedWindow,
          compaction: compactionConfig,
          compactor,
        });
        agent.session.messages.push(...longMessages);
        return { agent };
      },
    };

    const registry = new AgentRegistry({
      factory,
      instance: { pid: process.pid, cwd: workspace, version: '0.1.0', sandboxMode: 'off' },
    });
    const app = buildApp({ registry, home });
    const server = await startServer({ app });
    const client = new ChimeraClient({ baseUrl: server.url });

    try {
      const { sessionId } = await client.createSession({
        cwd: workspace,
        model: { providerId: 'mock', modelId: 'm', maxSteps: 1 },
        sandboxMode: 'off',
      });

      const events: AgentEvent[] = [];
      for await (const ev of client.send(sessionId, 'hi')) {
        events.push(ev);
        if (ev.type === 'run_finished') break;
      }

      const started = events.find((e) => e.type === 'compaction_started');
      const finished = events.find((e) => e.type === 'compaction_finished');

      expect(started).toBeUndefined();
      expect(finished).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
