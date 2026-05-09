import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import type { AgentEvent, Session } from '@chimera/core';
import { Compactor, computeBoundary, estimateTokens } from '../src';
import { newSessionId } from '@chimera/core';

describe('estimateTokens', () => {
  it('estimates user messages as ceil(len/4) + overhead', () => {
    const msgs: ModelMessage[] = [{ role: 'user', content: 'hello' }];
    const expected = Math.ceil(5 / 4) + 16;
    expect(estimateTokens(msgs)).toBe(expected);
  });

  it('estimates assistant objects with JSON overhead', () => {
    const msgs: ModelMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' } as { type: 'text'; text: string }],
      },
    ];
    const json = JSON.stringify(msgs[0]!.content);
    const expected = Math.ceil(json.length / 4) + 16;
    expect(estimateTokens(msgs)).toBe(expected);
  });

  it('sums multiple messages', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' }, // ceil(2/4)+16 = 17
      { role: 'assistant', content: 'hello there' }, // ceil(11/4)+16 = 19
    ];
    expect(estimateTokens(msgs)).toBe(17 + 19);
  });
});

describe('computeBoundary', () => {
  const user = (text: string): ModelMessage => ({ role: 'user', content: text });
  const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

  it('keeps all messages when they fit within budget', () => {
    const messages: ModelMessage[] = [user('a'), assistant('b')];
    const result = computeBoundary(messages, 100000);
    expect(result.keepStart).toBe(0);
  });

  it('splits when only the last message fits', () => {
    const messages: ModelMessage[] = [
      user('first message long enough to overflow'),
      assistant('ok'),
    ];
    // keepRecentTokens small enough that only last message fits
    const result = computeBoundary(messages, estimateTokens([messages[1]!]));
    expect(result.keepStart).toBe(1);
  });

  it('preserves an assistant tool-call and its tool-result pair', () => {
    const messages: ModelMessage[] = [
      user('step 1'),
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: '/x' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'read', output: 'data' },
        ],
      },
      assistant('final'),
    ];

    // Budget exactly 2 trailing messages (tool-result + final).
    // The tool-result requires its preceding assistant, so keepStart should
    // extend back to include the assistant tool-call (index 1).
    const budget = estimateTokens(messages.slice(2));
    const result = computeBoundary(messages, budget);
    expect(result.keepStart).toBe(1);
  });

  it('does not extend when boundary is on a clean message boundary', () => {
    const messages: ModelMessage[] = [
      user('a'),
      assistant('b'),
      user('c'),
    ];
    const budget = estimateTokens([messages[2]!]);
    const result = computeBoundary(messages, budget);
    expect(result.keepStart).toBe(2);
  });
});

describe('Compactor', () => {
  let home: string;
  let emittedEvents: AgentEvent[];
  let resolveModelCalls: { ref: string; count: number };

  beforeEach(async () => {
    home = await (await import('node:fs/promises')).mkdtemp(join(tmpdir(), 'chimera-compaction-'));
    await mkdir(join(home, '.chimera', 'sessions'), { recursive: true });
    emittedEvents = [];
    resolveModelCalls = { ref: '', count: 0 };
  });

  afterEach(async () => {
    try {
      await rm(home, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function makeSession(messages: ModelMessage[] = []): Session {
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
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
        stepCount: 0,
      },
      mode: 'build',
      userModelOverride: null,
      fileOps: { reads: new Set(), writes: new Set() },
    };
  }

  function makeCompactor(enabled = true, overrides: Partial<Parameters<typeof Compactor.prototype.compact>[0]> = {}) {
    return new Compactor({
      config: {
        enabled,
        reserveTokens: 10,
        keepRecentTokens: 30,
      },
      contextWindow: 100,
      emit: async (event: AgentEvent) => {
        emittedEvents.push(event);
      },
      resolveModel: async (ref: string) => {
        resolveModelCalls.ref = ref;
        resolveModelCalls.count += 1;
        // Return a NOOP language model — tests that need generateText mock
        // will avoid it by making toSummarize empty.
        return null as unknown as import('ai').LanguageModel;
      },
      home,
    });
  }

  it('maybeCompact is a no-op when disabled', async () => {
    const session = makeSession([{ role: 'user', content: 'x'.repeat(200) }]);
    const compactor = makeCompactor(false);
    const ran = await compactor.maybeCompact(session);
    expect(ran).toBe(false);
    expect(session.messages).toHaveLength(1);
    expect(emittedEvents).toHaveLength(0);
  });

  it('maybeCompact is a no-op when below threshold', async () => {
    const session = makeSession([{ role: 'user', content: 'short' }]);
    const compactor = makeCompactor(true);
    const ran = await compactor.maybeCompact(session);
    expect(ran).toBe(false);
    expect(session.messages).toHaveLength(1);
  });

  it('maybeCompact runs when overflow passes threshold', async () => {
    // ceil(500/4) + 16 = 141 tokens. threshold = 100 - 10 = 90. 141 > 90.
    const session = makeSession([{ role: 'user', content: 'x'.repeat(500) }]);
    const compactor = makeCompactor(true);
    // Because toSummarize will be calculated and since our stub resolveModel
    // returns null, generateText will throw. We therefore expect
    // compaction_failed.
    try {
      await compactor.maybeCompact(session);
    } catch {
      // ignore
    }
    expect(emittedEvents.some((e) => e.type === 'compaction_started')).toBe(true);
    expect(emittedEvents.some((e) => e.type === 'compaction_failed')).toBe(true);
  });

  it('manual compact with no messages produces empty summary but emits finished', async () => {
    const session = makeSession([]);
    const compactor = makeCompactor(true);
    await compactor.compact(session, 'manual');

    const started = emittedEvents[0];
    expect(started!.type).toBe('compaction_started');
    expect((started as Extract<AgentEvent, { type: 'compaction_started' }>).reason).toBe('manual');

    expect(emittedEvents.some((e) => e.type === 'compaction_finished')).toBe(true);
    expect(session.messages).toHaveLength(0);
  });

  it('manual compact with one message produces summary and keeps tail', async () => {
    const session = makeSession([{ role: 'user', content: 'hello world' }]);
    const compactor = makeCompactor(true);
    await compactor.compact(session, 'manual');

    const finished = emittedEvents.find((e) => e.type === 'compaction_finished') as
      | Extract<AgentEvent, { type: 'compaction_finished' }>
      | undefined;
    expect(finished).toBeDefined();
    // messages replaced = keepStart index (all fit in keepRecentTokens)
    expect(finished!.messagesReplaced).toBe(0);
  });

  it('emits events in order: started -> finished', async () => {
    const session = makeSession([]);
    const compactor = makeCompactor(true);
    await compactor.compact(session, 'manual');
    expect(emittedEvents[0]!.type).toBe('compaction_started');
    expect(emittedEvents[1]!.type).toBe('compaction_finished');
  });

  describe('structured summary headers', () => {
    it('includes all required headers in fallback summary', async () => {
      const session = makeSession([]);
      const compactor = makeCompactor(true);
      await compactor.compact(session, 'manual');

      const finished = emittedEvents.find((e) => e.type === 'compaction_finished') as
        | Extract<AgentEvent, { type: 'compaction_finished' }>
        | undefined;
      expect(finished).toBeDefined();
      const text = finished!.summary;
      expect(text).toContain('## Goal');
      expect(text).toContain('## Constraints');
      expect(text).toContain('## Progress');
      expect(text).toContain('### Done');
      expect(text).toContain('### In Progress');
      expect(text).toContain('### Blocked');
      expect(text).toContain('## Key Decisions');
      expect(text).toContain('## Next Steps');
      expect(text).toContain('## Critical Context');
      expect(text).toContain('<files>');
    });
  });

  describe('file ops dedup', () => {
    it('lists a path as <modified> only when it was also read', async () => {
      const session = makeSession([]);
      session.fileOps.reads.add('/src/foo.ts');
      session.fileOps.writes.add('/src/foo.ts');
      session.fileOps.reads.add('/src/bar.ts');

      const compactor = makeCompactor(true);
      await compactor.compact(session, 'manual');

      const finished = emittedEvents.find((e) => e.type === 'compaction_finished') as
        | Extract<AgentEvent, { type: 'compaction_finished' }>
        | undefined;
      const summary = finished!.summary;
      // modified should appear
      expect(summary).toContain('<modified>/src/foo.ts</modified>');
      // read-only should appear
      expect(summary).toContain('<read>/src/bar.ts</read>');
      // should NOT list as read
      expect(summary).not.toContain('<read>/src/foo.ts</read>');
    });
  });

  describe('log appending', () => {
    it('appends one JSON line per successful compaction', async () => {
      const session = makeSession([]);
      const compactor = makeCompactor(true);
      await compactor.compact(session, 'manual');

      const logPath = join(home, '.chimera', 'sessions', `${session.id}.compactions.jsonl`);
      const raw = await readFile(logPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!);
      expect(entry.reason).toBe('manual');
      expect(typeof entry.ts).toBe('number');
      expect(typeof entry.tokensBefore).toBe('number');
      expect(typeof entry.tokensAfter).toBe('number');
      expect(entry.summary).toContain('## Goal');
      expect(entry.messagesReplaced).toEqual({ count: expect.any(Number), firstIndex: expect.any(Number), lastIndex: expect.any(Number) });
    });

    it('appends multiple lines in chronological order', async () => {
      const session = makeSession([]);
      const compactor = makeCompactor(true);
      await compactor.compact(session, 'manual');
      await new Promise((r) => setTimeout(r, 5));
      await compactor.compact(session, 'manual');

      const logPath = join(home, '.chimera', 'sessions', `${session.id}.compactions.jsonl`);
      const raw = await readFile(logPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!);
      const second = JSON.parse(lines[1]!);
      expect(second.ts).toBeGreaterThanOrEqual(first.ts);
    });
  });
});
