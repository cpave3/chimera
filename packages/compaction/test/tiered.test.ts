import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { newSessionId, type Session } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Compactor, type MessagePruner } from '../src';

function makeSession(messages: ModelMessage[]): Session {
  return {
    id: newSessionId(),
    parentId: null,
    children: [],
    cwd: '/tmp',
    createdAt: Date.now(),
    messages: [...messages],
    toolCalls: [],
    status: 'idle',
    model: { providerId: 'p', modelId: 'm', maxSteps: 10 },
    sandboxMode: 'off',
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, stepCount: 0 },
    mode: 'build',
    userModelOverride: null,
    fileOps: { reads: new Set(), writes: new Set() },
    additionalReadPaths: [],
    additionalWritePaths: [],
    tasks: [],
  };
}

const SUMMARY_TEXT = [
  '## Goal',
  'g',
  '## Constraints',
  '## Progress',
  '### Done',
  '### In Progress',
  '### Blocked',
  '## Key Decisions',
  '## Next Steps',
  '## Critical Context',
].join('\n');

describe('Compactor tiered prune-then-summarize', () => {
  let home: string;
  let generateCalls: { prompt: string }[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-tiered-'));
    await mkdir(join(home, '.chimera', 'sessions'), { recursive: true });
    generateCalls = [];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function summaryModel(): LanguageModel {
    return new MockLanguageModelV3({
      doGenerate: async (options: { prompt: Array<{ content: unknown }> }) => {
        generateCalls.push({ prompt: JSON.stringify(options.prompt) });
        return {
          content: [{ type: 'text', text: SUMMARY_TEXT }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    }) as unknown as LanguageModel;
  }

  /** Pruner that shrinks every user message in range to a stub and reports savings. */
  function stubPruner(savedTokens: number): MessagePruner & { calls: number[] } {
    const pruner = {
      calls: [] as number[],
      async prune(messages: ModelMessage[], endIndex: number) {
        pruner.calls.push(endIndex);
        for (let i = 0; i < endIndex; i++) {
          const message = messages[i]!;
          if (message.role === 'user' && typeof message.content === 'string') {
            message.content = '[Result archived — retrieve with: recall({ id: "pr_aaaa1111" })]';
          }
        }
        return {
          archivedCount: 1,
          tokensSaved: savedTokens,
          archived: [{ id: 'pr_aaaa1111', toolName: 'bash', argsBrief: '{}' }],
        };
      },
    };
    return pruner;
  }

  function makeCompactor(pruner?: MessagePruner) {
    return new Compactor({
      config: { enabled: true, reserveTokens: 50, keepRecentTokens: 40 },
      contextWindow: 300,
      resolveModel: async () => summaryModel(),
      home,
      createPruner: pruner ? () => pruner : undefined,
    });
  }

  it('threshold compaction stops after pruning when pruning alone resolves the overflow', async () => {
    // Head holds one giant user message; tail is small. Pruning shrinks the
    // head far below the threshold, so no summary call should happen.
    const session = makeSession([
      { role: 'user', content: 'x'.repeat(4000) },
      { role: 'assistant', content: 'tail answer' },
    ]);
    const compactor = makeCompactor(stubPruner(900));
    const result = await compactor.compact(session, 'threshold');

    expect(result.strategy).toBe('prune');
    expect(result.prunedCount).toBe(1);
    expect(generateCalls).toHaveLength(0);
    // Conversation skeleton intact: both messages still present, head stubbed.
    expect(session.messages).toHaveLength(2);
    expect(String(session.messages[0]!.content)).toContain('pr_aaaa1111');
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it('summarizes after pruning when pruning is not enough', async () => {
    // Both head messages are large; pruning only shrinks user messages, the
    // remaining assistant bulk keeps the estimate above threshold.
    const session = makeSession([
      { role: 'user', content: 'u'.repeat(2000) },
      { role: 'assistant', content: 'a'.repeat(2000) },
      { role: 'user', content: 'recent question' },
    ]);
    const compactor = makeCompactor(stubPruner(400));
    const result = await compactor.compact(session, 'threshold');

    expect(result.strategy).toBe('prune+summarize');
    expect(generateCalls).toHaveLength(1);
    // The summarizer saw the stub, not the original user bulk.
    expect(generateCalls[0]!.prompt).toContain('pr_aaaa1111');
    expect(generateCalls[0]!.prompt).not.toContain('u'.repeat(2000));
    // Summary message carries the authoritative <archived> block.
    const summary = String(session.messages[0]!.content);
    expect(summary).toContain('<archived>');
    expect(summary).toContain('pr_aaaa1111');
    expect(summary).toContain('<files>');
  });

  it('manual compaction always summarizes even when pruning got under threshold', async () => {
    const session = makeSession([
      { role: 'user', content: 'x'.repeat(4000) },
      { role: 'assistant', content: 'tail answer' },
    ]);
    const compactor = makeCompactor(stubPruner(900));
    const result = await compactor.compact(session, 'manual');
    expect(result.strategy).toBe('prune+summarize');
    expect(generateCalls).toHaveLength(1);
  });

  it('reports strategy summarize when no pruner is configured', async () => {
    const session = makeSession([
      { role: 'user', content: 'x'.repeat(4000) },
      { role: 'assistant', content: 'tail answer' },
    ]);
    const compactor = makeCompactor(undefined);
    const result = await compactor.compact(session, 'threshold');
    expect(result.strategy).toBe('summarize');
    expect(result.prunedCount).toBe(0);
    expect(generateCalls).toHaveLength(1);
  });

  it('passes the keep-boundary to the pruner so the tail is off limits', async () => {
    const tail = { role: 'assistant' as const, content: 'short tail' };
    const session = makeSession([{ role: 'user', content: 'x'.repeat(4000) }, tail]);
    const pruner = stubPruner(900);
    const compactor = makeCompactor(pruner);
    await compactor.compact(session, 'threshold');
    expect(pruner.calls).toHaveLength(1);
    // endIndex must exclude the tail message.
    expect(pruner.calls[0]).toBeLessThanOrEqual(1);
  });
});
