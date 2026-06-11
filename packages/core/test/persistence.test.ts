import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSessionId } from '../src/ids';
import {
  appendSessionEvent,
  forkSession,
  listSessionsOnDisk,
  loadSession,
  persistSession,
  readCheckpoints,
  readSessionMetadata,
  sessionEventsPath,
  sessionMetadataPath,
  sessionsDir,
  truncateEventsAtIndex,
  writeSessionMetadata,
} from '../src/persistence';
import { emptyUsage, type Session } from '../src/types';

describe('persistence', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-test-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      id: newSessionId(),
      parentId: null,
      children: [],
      cwd: '/tmp',
      createdAt: Date.now(),
      messages: [{ role: 'user', content: 'hi' }],
      toolCalls: [],
      status: 'running',
      model: { providerId: 'p', modelId: 'm', maxSteps: 100 },
      sandboxMode: 'off',
      usage: emptyUsage(),
      fileOps: { reads: new Set(), writes: new Set() },
      additionalReadPaths: [],
      additionalWritePaths: [],
      ...overrides,
    };
  }

  it('writes session.json without messages or toolCalls and appends event line', async () => {
    const session = makeSession();
    await persistSession(
      session,
      {
        type: 'step_finished',
        stepNumber: 1,
        finishReason: 'stop',
        messages: session.messages,
        toolCalls: session.toolCalls,
        usage: session.usage,
      },
      home,
    );
    const meta = JSON.parse(await readFile(sessionMetadataPath(session.id, home), 'utf8'));
    expect(meta.id).toEqual(session.id);
    expect(meta).not.toHaveProperty('messages');
    expect(meta).not.toHaveProperty('toolCalls');
    expect(meta.parentId).toBeNull();
    expect(meta.children).toEqual([]);

    const events = (await readFile(sessionEventsPath(session.id, home), 'utf8'))
      .split('\n')
      .filter(Boolean);
    expect(events).toHaveLength(1);
    const eventEntry = JSON.parse(events[0]);
    expect(eventEntry.type).toBe('step_finished');
    expect(eventEntry.messages).toEqual(session.messages);
  });

  it('round-trips messages and toolCalls via the latest step_finished', async () => {
    const session = makeSession();
    session.messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    await persistSession(
      session,
      {
        type: 'step_finished',
        stepNumber: 1,
        finishReason: 'stop',
        messages: session.messages,
        toolCalls: session.toolCalls,
        usage: session.usage,
      },
      home,
    );
    const loaded = await loadSession(session.id, home);
    expect(loaded.id).toEqual(session.id);
    expect(loaded.messages).toEqual(session.messages);
    expect(loaded.status).toEqual('idle');
  });

  it('uses the most recent step_finished for messages on resume', async () => {
    const session = makeSession();
    await persistSession(
      session,
      {
        type: 'step_finished',
        stepNumber: 1,
        finishReason: 'stop',
        messages: [{ role: 'user', content: 'first' }],
        toolCalls: [],
        usage: emptyUsage(),
      },
      home,
    );
    await persistSession(
      session,
      {
        type: 'step_finished',
        stepNumber: 2,
        finishReason: 'stop',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
        ],
        toolCalls: [],
        usage: emptyUsage(),
      },
      home,
    );
    const loaded = await loadSession(session.id, home);
    expect(loaded.messages).toHaveLength(2);
  });

  it('skips a malformed trailing line on resume', async () => {
    const session = makeSession();
    await persistSession(
      session,
      {
        type: 'step_finished',
        stepNumber: 1,
        finishReason: 'stop',
        messages: [{ role: 'user', content: 'hi' }],
        toolCalls: [],
        usage: emptyUsage(),
      },
      home,
    );
    const eventsPath = sessionEventsPath(session.id, home);
    const existing = await readFile(eventsPath, 'utf8');
    await writeFile(eventsPath, `${existing}{ this is not json`, 'utf8');

    const loaded = await loadSession(session.id, home);
    expect(loaded.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('resets status to idle on load', async () => {
    const session = makeSession({ status: 'error' });
    await persistSession(
      session,
      {
        type: 'step_finished',
        stepNumber: 1,
        finishReason: 'stop',
        messages: session.messages,
        toolCalls: session.toolCalls,
        usage: session.usage,
      },
      home,
    );
    const loaded = await loadSession(session.id, home);
    expect(loaded.status).toEqual('idle');
  });

  it('round-trips additionalReadPaths and additionalWritePaths', async () => {
    const session = makeSession({
      additionalReadPaths: ['/opt/data', '/etc/config'],
      additionalWritePaths: ['/tmp', '/var/log'],
    });
    await writeSessionMetadata(session, home);
    const loaded = await loadSession(session.id, home);
    expect(loaded.additionalReadPaths).toEqual(['/opt/data', '/etc/config']);
    expect(loaded.additionalWritePaths).toEqual(['/tmp', '/var/log']);
  });

  it('defaults additionalReadPaths/additionalWritePaths to [] when missing', async () => {
    const session = makeSession();
    await writeSessionMetadata(session, home);
    // Manually strip the new fields to simulate pre-change metadata.
    const raw = await readFile(sessionMetadataPath(session.id, home), 'utf8');
    const parsed = JSON.parse(raw);
    delete parsed.additionalReadPaths;
    delete parsed.additionalWritePaths;
    await writeFile(sessionMetadataPath(session.id, home), JSON.stringify(parsed), 'utf8');
    const loaded = await loadSession(session.id, home);
    expect(loaded.additionalReadPaths).toEqual([]);
    expect(loaded.additionalWritePaths).toEqual([]);
    // readSessionMetadata also copes with missing fields.
    const meta = await readSessionMetadata(session.id, home);
    expect(meta.additionalReadPaths).toEqual([]);
    expect(meta.additionalWritePaths).toEqual([]);
  });

  describe('forkSession', () => {
    it('copies events, appends forked_from, links parent and child', async () => {
      const parent = makeSession();
      await persistSession(
        parent,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'hi' }],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );

      const { session: child, childId } = await forkSession({
        parentId: parent.id,
        purpose: 'try it',
        home,
      });

      expect(child.parentId).toEqual(parent.id);
      expect(child.id).toEqual(childId);
      expect(child.children).toEqual([]);

      const childEvents = (await readFile(sessionEventsPath(childId, home), 'utf8'))
        .split('\n')
        .filter(Boolean);
      // copied step_finished + appended forked_from
      expect(childEvents).toHaveLength(2);
      const last = JSON.parse(childEvents[childEvents.length - 1]);
      expect(last.type).toBe('forked_from');
      expect(last.parentId).toEqual(parent.id);
      expect(last.purpose).toEqual('try it');

      const parentMeta = JSON.parse(await readFile(sessionMetadataPath(parent.id, home), 'utf8'));
      expect(parentMeta.children).toContain(childId);
    });

    it("child writes do not affect parent's events.jsonl", async () => {
      const parent = makeSession();
      await persistSession(
        parent,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'hi' }],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );
      const parentBefore = await readFile(sessionEventsPath(parent.id, home), 'utf8');

      const { childId } = await forkSession({ parentId: parent.id, home });
      // Now write a new event to the child
      const child = await loadSession(childId, home);
      await persistSession(
        child,
        {
          type: 'step_finished',
          stepNumber: 2,
          finishReason: 'stop',
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'reply' },
          ],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );

      const parentAfter = await readFile(sessionEventsPath(parent.id, home), 'utf8');
      expect(parentAfter).toEqual(parentBefore);
    });

    it('inherits parent additionalReadPaths and additionalWritePaths', async () => {
      const parent = makeSession({
        additionalReadPaths: ['/opt/data'],
        additionalWritePaths: ['/tmp'],
      });
      await persistSession(
        parent,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'hi' }],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );
      const { session: child } = await forkSession({ parentId: parent.id, home });
      expect(child.additionalReadPaths).toEqual(['/opt/data']);
      expect(child.additionalWritePaths).toEqual(['/tmp']);
      // Verify they survive into persisted metadata.
      const childMeta = JSON.parse(await readFile(sessionMetadataPath(child.id, home), 'utf8'));
      expect(childMeta.additionalReadPaths).toEqual(['/opt/data']);
      expect(childMeta.additionalWritePaths).toEqual(['/tmp']);
    });
  });

  describe('concurrent writers', () => {
    it('interleaved appends to events.jsonl yield valid lines', async () => {
      const session = makeSession();
      // Two concurrent appendSessionEvent calls; each writes one line.
      // POSIX append semantics guarantee atomicity for typical line sizes.
      await Promise.all([
        persistSession(
          session,
          {
            type: 'step_finished',
            stepNumber: 1,
            finishReason: 'stop',
            messages: [{ role: 'user', content: 'a' }],
            toolCalls: [],
            usage: emptyUsage(),
          },
          home,
        ),
        persistSession(
          session,
          {
            type: 'step_finished',
            stepNumber: 2,
            finishReason: 'stop',
            messages: [{ role: 'user', content: 'b' }],
            toolCalls: [],
            usage: emptyUsage(),
          },
          home,
        ),
      ]);
      // Resume must succeed and pick *some* well-formed step_finished snapshot.
      const loaded = await loadSession(session.id, home);
      expect(loaded.messages).toHaveLength(1);
      expect(['a', 'b']).toContain(loaded.messages[0]!.content);
    });
  });

  describe('listSessionsOnDisk', () => {
    it('returns persisted sessions with metadata', async () => {
      const firstSession = makeSession();
      firstSession.messages = [{ role: 'user', content: 'a1' }];
      await persistSession(
        firstSession,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: firstSession.messages,
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );
      const secondSession = makeSession();
      secondSession.messages = [
        { role: 'user', content: 'b1' },
        { role: 'assistant', content: 'b2' },
      ];
      await persistSession(
        secondSession,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: secondSession.messages,
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );

      const list = await listSessionsOnDisk(home);
      const ids = list.map((s) => s.id).sort();
      expect(ids).toEqual([firstSession.id, secondSession.id].sort());
      const secondInfo = list.find((s) => s.id === secondSession.id)!;
      expect(secondInfo.messageCount).toEqual(2);
    });

    it('ignores pre-change flat <id>.json files', async () => {
      const persistedSession = makeSession();
      await persistSession(
        persistedSession,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'hi' }],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );
      // Drop a legacy flat file in the same parent dir
      const legacyId = newSessionId();
      await mkdir(sessionsDir(home), { recursive: true });
      await writeFile(
        join(sessionsDir(home), `${legacyId}.json`),
        JSON.stringify({ id: legacyId }),
        'utf8',
      );

      const list = await listSessionsOnDisk(home);
      expect(list.map((s) => s.id)).toEqual([persistedSession.id]);
    });

    it('reports lastActivityAt that advances when new events are appended', async () => {
      const session = makeSession();
      await persistSession(
        session,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'first' }],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );
      const firstScan = await listSessionsOnDisk(home);
      const firstActivity = firstScan.find((entry) => entry.id === session.id)!.lastActivityAt;
      expect(firstActivity).toBeGreaterThanOrEqual(session.createdAt);

      // Force a measurable mtime change before the second persist; some
      // filesystems have ms-resolution mtimes and back-to-back writes can
      // land on the same tick.
      await new Promise((resolveTick) => setTimeout(resolveTick, 12));

      await persistSession(
        session,
        {
          type: 'step_finished',
          stepNumber: 2,
          finishReason: 'stop',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
          ],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );
      const secondScan = await listSessionsOnDisk(home);
      const secondActivity = secondScan.find((entry) => entry.id === session.id)!.lastActivityAt;
      expect(secondActivity).toBeGreaterThanOrEqual(firstActivity);
    });

    it('falls back to events.jsonl when messageCount is absent in metadata', async () => {
      const session = makeSession();
      session.messages = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ];
      await persistSession(
        session,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: session.messages,
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );
      // Strip messageCount to simulate pre-change metadata.
      const metaPath = sessionMetadataPath(session.id, home);
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      delete meta.messageCount;
      await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

      const list = await listSessionsOnDisk(home);
      const info = list.find((s) => s.id === session.id)!;
      expect(info.messageCount).toEqual(3);
    });
  });

  describe('readSessionMetadata', () => {
    it('round-trips metadata for a persisted session', async () => {
      const session = makeSession();
      session.messages = [{ role: 'user', content: 'hi' }];
      await persistSession(
        session,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: session.messages,
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );
      const meta = await readSessionMetadata(session.id, home);
      expect(meta.id).toEqual(session.id);
      expect(meta.cwd).toEqual(session.cwd);
      expect(meta.messageCount).toEqual(1);
      expect(meta.children).toEqual([]);
      expect(meta.parentId).toBeNull();
    });

    it('throws for an unknown session id', async () => {
      await expect(readSessionMetadata('01HZZZZZZZZZZZZZZZZZZZZZZZ', home)).rejects.toThrow();
    });

    it('falls back to events.jsonl when messageCount is absent', async () => {
      const session = makeSession();
      session.messages = [{ role: 'user', content: 'one' }];
      await persistSession(
        session,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: session.messages,
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );
      const metaPath = sessionMetadataPath(session.id, home);
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      delete meta.messageCount;
      await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

      const result = await readSessionMetadata(session.id, home);
      expect(result.messageCount).toEqual(1);
    });
  });

  describe('loadSession backward read', () => {
    it('finds snapshot in large events.jsonl quickly', async () => {
      const session = makeSession();
      const lines: string[] = [];
      for (let i = 0; i < 9999; i++) {
        lines.push(JSON.stringify({ type: 'user_message', content: String(i) }));
      }
      lines.push(
        JSON.stringify({
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
          ],
          toolCalls: [],
          usage: emptyUsage(),
        }),
      );
      await writeSessionMetadata(session, home);
      await writeFile(sessionEventsPath(session.id, home), `${lines.join('\n')}\n`, 'utf8');

      const start = performance.now();
      const loaded = await loadSession(session.id, home);
      const elapsed = performance.now() - start;

      expect(loaded.messages).toHaveLength(2);
      expect(loaded.messages[1]!.content).toBe('b');
      expect(elapsed).toBeLessThan(50);
      console.log(`  loadSession on ${lines.length} events: ${elapsed.toFixed(1)}ms`);
    });

    it('returns empty messages when events.jsonl has no snapshot', async () => {
      const session = makeSession();
      const lines = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ type: 'user_message', content: String(i) }),
      );
      await writeSessionMetadata(session, home);
      await writeFile(sessionEventsPath(session.id, home), `${lines.join('\n')}\n`, 'utf8');

      const loaded = await loadSession(session.id, home);
      expect(loaded.messages).toHaveLength(0);
    });

    it('reads whole file when it fits in one chunk', async () => {
      const session = makeSession();
      const lines = [
        JSON.stringify({ type: 'user_message', content: 'noise' }),
        JSON.stringify({
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'small' }],
          toolCalls: [],
          usage: emptyUsage(),
        }),
      ];
      await writeSessionMetadata(session, home);
      await writeFile(sessionEventsPath(session.id, home), `${lines.join('\n')}\n`, 'utf8');

      const loaded = await loadSession(session.id, home);
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0]!.content).toBe('small');
    });

    it('doubles chunk size when snapshot spans chunk boundary', async () => {
      const session = makeSession();
      // Write events so the snapshot line starts before the first chunk boundary.
      const bigPrefix = 'x'.repeat(50_000);
      const noise = JSON.stringify({ type: 'user_message', content: bigPrefix });
      const snapshot = JSON.stringify({
        type: 'step_finished',
        stepNumber: 1,
        finishReason: 'stop',
        messages: [{ role: 'user', content: 'spans-chunk' }],
        toolCalls: [],
        usage: emptyUsage(),
      });
      await writeSessionMetadata(session, home);
      await writeFile(sessionEventsPath(session.id, home), `${noise}\n${snapshot}\n`, 'utf8');

      const loaded = await loadSession(session.id, home);
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0]!.content).toBe('spans-chunk');
    });

    it('warns on malformed line in the last chunk', async () => {
      const session = makeSession();
      const lines = [
        JSON.stringify({
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'ok' }],
          toolCalls: [],
          usage: emptyUsage(),
        }),
        '{ this is not json',
      ];
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      await writeSessionMetadata(session, home);
      // No trailing newline so the malformed line IS the last line.
      await writeFile(sessionEventsPath(session.id, home), lines.join('\n'), 'utf8');

      const loaded = await loadSession(session.id, home);
      expect(loaded.messages).toHaveLength(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('skipping malformed line'));
      stderrSpy.mockRestore();
    });
  });

  describe('readCheckpoints', () => {
    it('returns single checkpoint for empty session', async () => {
      const session = makeSession();
      await writeSessionMetadata(session, home);
      const checkpoints = await readCheckpoints(session.id, home);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]).toEqual({
        index: 0,
        userMessage: '',
        toolCallSummary: '',
        truncateByteOffset: 0,
      });
    });

    it('returns checkpoints for a single user turn', async () => {
      const session = makeSession();
      await writeSessionMetadata(session, home);
      const event1 = {
        type: 'step_finished' as const,
        stepNumber: 1,
        finishReason: 'stop',
        messages: [{ role: 'user' as const, content: 'hello' }],
        toolCalls: [],
        usage: emptyUsage(),
      };
      await appendSessionEvent(session.id, event1, home);

      const checkpoints = await readCheckpoints(session.id, home);
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0]).toEqual({
        index: 0,
        userMessage: '',
        toolCallSummary: '',
        truncateByteOffset: 0,
      });
      expect(checkpoints[1]).toMatchObject({
        index: 0, // user message at index 0
        userMessage: 'hello',
        toolCallSummary: '',
      });
      // For the first checkpoint, truncateByteOffset matches index-0 checkpoint
      // because there is no prior snapshot before the first user message.
      expect(checkpoints[1]!.truncateByteOffset).toBe(0);
    });

    it('reads checkpoints with correct byte offsets when no trailing newline', async () => {
      const session = makeSession();
      await writeSessionMetadata(session, home);

      const event = {
        type: 'step_finished' as const,
        stepNumber: 1,
        finishReason: 'stop',
        messages: [{ role: 'user' as const, content: 'hello' }],
        toolCalls: [],
        usage: emptyUsage(),
      };

      // Write without trailing newline (manually, not via appendSessionEvent).
      const eventsPath = sessionEventsPath(session.id, home);
      await mkdir(dirname(eventsPath), { recursive: true });
      await writeFile(eventsPath, JSON.stringify(event), 'utf8');

      const checkpoints = await readCheckpoints(session.id, home);
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0]).toEqual({
        index: 0,
        userMessage: '',
        toolCallSummary: '',
        truncateByteOffset: 0,
      });
      expect(checkpoints[1]).toMatchObject({
        index: 0,
        userMessage: 'hello',
        toolCallSummary: '',
      });

      // Truncating at the reported offset should leave a valid file.
      const result = await truncateEventsAtIndex(session.id, 0, home);
      expect(result.messages).toEqual([]);

      const loaded = await loadSession(session.id, home);
      expect(loaded.messages).toEqual([]);
    });

    it('handles compacted session with warning and only addressable checkpoints', async () => {
      const session = makeSession();
      await writeSessionMetadata(session, home);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Pre-compaction snapshot: contains two user messages.
      const preCompaction = {
        type: 'step_finished' as const,
        stepNumber: 1,
        finishReason: 'stop',
        messages: [
          { role: 'user' as const, content: 'first' },
          { role: 'assistant' as const, content: 'reply1' },
          { role: 'user' as const, content: 'second' },
          { role: 'assistant' as const, content: 'reply2' },
        ],
        toolCalls: [],
        usage: emptyUsage(),
      };

      // Post-compaction snapshot: fewer messages (summary + recent).
      const postCompaction = {
        type: 'step_finished' as const,
        stepNumber: 2,
        finishReason: 'stop',
        messages: [
          { role: 'system' as const, content: 'Summary of previous conversation' },
          { role: 'user' as const, content: 'second' },
          { role: 'assistant' as const, content: 'reply2' },
        ],
        toolCalls: [],
        usage: emptyUsage(),
      };

      await appendSessionEvent(session.id, preCompaction, home);
      await appendSessionEvent(session.id, postCompaction, home);

      const checkpoints = await readCheckpoints(session.id, home);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('compaction detected'));

      // Only addressable checkpoints: index 0 + the user message still in latest snapshot.
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[0]).toEqual({
        index: 0,
        userMessage: '',
        toolCallSummary: '',
        truncateByteOffset: 0,
      });
      expect(checkpoints[1]).toMatchObject({
        index: 1,
        userMessage: 'second',
        toolCallSummary: '',
      });

      warnSpy.mockRestore();
    });

    it('returns checkpoints for multiple user turns with tool call summaries', async () => {
      const session = makeSession();
      await writeSessionMetadata(session, home);

      // Turn 1: user + assistant(tool-calls) + tool_results
      const event1 = {
        type: 'step_finished' as const,
        stepNumber: 1,
        finishReason: 'stop',
        messages: [
          { role: 'user' as const, content: 'first message' },
          {
            role: 'assistant' as const,
            content: [
              { type: 'text', text: 'Here is the analysis' },
              { type: 'tool-call', toolCallId: 'tc1', toolName: 'read', input: { path: '/tmp/a' } },
            ],
          },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', output: 'data' }] },
        ],
        toolCalls: [],
        usage: emptyUsage(),
      };
      // Turn 2: user + assistant(tool-calls)
      const event2 = {
        type: 'step_finished' as const,
        stepNumber: 2,
        finishReason: 'stop',
        messages: [
          { role: 'user' as const, content: 'first message' },
          {
            role: 'assistant' as const,
            content: [
              { type: 'text', text: 'Here is the analysis' },
              { type: 'tool-call', toolCallId: 'tc1', toolName: 'read', input: { path: '/tmp/a' } },
            ],
          },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', output: 'data' }] },
          { role: 'user' as const, content: 'second message' },
          {
            role: 'assistant' as const,
            content: [
              {
                type: 'tool-call',
                toolCallId: 'tc2',
                toolName: 'write',
                input: { path: '/tmp/b' },
              },
              {
                type: 'tool-call',
                toolCallId: 'tc3',
                toolName: 'write',
                input: { path: '/tmp/b' },
              },
            ],
          },
        ],
        toolCalls: [],
        usage: emptyUsage(),
      };

      await appendSessionEvent(session.id, event1, home);
      await appendSessionEvent(session.id, event2, home);

      const checkpoints = await readCheckpoints(session.id, home);
      expect(checkpoints).toHaveLength(3);
      expect(checkpoints[0]).toEqual({
        index: 0,
        userMessage: '',
        toolCallSummary: '',
        truncateByteOffset: 0,
      });
      expect(checkpoints[1]).toMatchObject({
        index: 0,
        userMessage: 'first message',
        toolCallSummary: 'read(/tmp/a)',
      });
      expect(checkpoints[2]).toMatchObject({
        index: 3,
        userMessage: 'second message',
        toolCallSummary: 'write(/tmp/b) x2',
      });

      // Verify byte offsets: checkpoint 1 should be length of event1 line + newline
      const eventsRaw = await readFile(sessionEventsPath(session.id, home), 'utf8');
      const event1Line = JSON.stringify(event1);
      const expectedOffset = Buffer.byteLength(event1Line, 'utf8') + 1; // +1 for \n
      expect(checkpoints[1]!.truncateByteOffset).toBe(0); // event1 starts at 0
      expect(checkpoints[2]!.truncateByteOffset).toBe(expectedOffset); // event2 starts after event1
      // Verify truncation point by slicing the file
      const truncatedBytes = eventsRaw
        .slice(0, checkpoints[2]!.truncateByteOffset)
        .split('\n')
        .filter(Boolean);
      expect(truncatedBytes).toHaveLength(1);
      const truncated = JSON.parse(truncatedBytes[0]!);
      expect(truncated.messages).toEqual(event1.messages);
    });

    it('updates checkpoint on message_appended snapshots', async () => {
      const session = makeSession();
      await writeSessionMetadata(session, home);

      await persistSession(
        session,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'hi' }],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );

      // Append another user message
      await persistSession(
        session,
        {
          type: 'message_appended',
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'user', content: 'extra' },
          ],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );

      const checkpoints = await readCheckpoints(session.id, home);
      expect(checkpoints).toHaveLength(3);
      expect(checkpoints[1]!.userMessage).toBe('hi');
      expect(checkpoints[2]!.userMessage).toBe('extra');
    });
  });

  describe('truncateEventsAtIndex', () => {
    it('truncates to middle of multi-turn session', async () => {
      const session = makeSession();
      await writeSessionMetadata(session, home);

      // In real sessions the first persisted snapshot after a turn
      // already includes the assistant reply.
      const afterAssistantReply = {
        type: 'step_finished' as const,
        stepNumber: 1,
        finishReason: 'stop',
        messages: [
          { role: 'user' as const, content: 'hello' },
          { role: 'assistant' as const, content: 'hi there' },
        ],
        toolCalls: [],
        usage: emptyUsage(),
      };
      const afterSecondUser = {
        type: 'step_finished' as const,
        stepNumber: 2,
        finishReason: 'stop',
        messages: [
          { role: 'user' as const, content: 'hello' },
          { role: 'assistant' as const, content: 'hi there' },
          { role: 'user' as const, content: 'how are you?' },
          { role: 'assistant' as const, content: 'doing great' },
        ],
        toolCalls: [],
        usage: emptyUsage(),
      };

      await appendSessionEvent(session.id, afterAssistantReply, home);
      await appendSessionEvent(session.id, afterSecondUser, home);

      // In a session with messages [user0, assistant1, user2, assistant3]
      // the user messages are at positions 0 and 2.
      const checkpointsBefore = await readCheckpoints(session.id, home);
      expect(checkpointsBefore).toHaveLength(3);

      // Truncate before the second user message (index 2).
      // The latest snapshot with messages.length <= 2 is afterAssistantReply.
      const result = await truncateEventsAtIndex(session.id, 2, home);
      expect(result.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]);
      expect(result.toolCalls).toEqual([]);
      expect(result.usage).toEqual(emptyUsage());

      // File should contain exactly the surviving snapshot.
      const eventsRaw = await readFile(sessionEventsPath(session.id, home), 'utf8');
      const remainingLines = eventsRaw.split('\n').filter(Boolean);
      expect(remainingLines).toHaveLength(1);
      const remaining = JSON.parse(remainingLines[0]!);
      expect(remaining.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]);

      // Verify loadSession reflects truncated state
      const loaded = await loadSession(session.id, home);
      expect(loaded.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]);
    });

    it('truncates to index 0 and clears file', async () => {
      const session = makeSession();
      await writeSessionMetadata(session, home);

      await persistSession(
        session,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'hi' }],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );

      const result = await truncateEventsAtIndex(session.id, 0, home);
      expect(result.messages).toEqual([]);
      expect(result.toolCalls).toEqual([]);
      expect(result.usage).toEqual(emptyUsage());

      // File should be empty
      const eventsRaw = await readFile(sessionEventsPath(session.id, home), 'utf8');
      expect(eventsRaw).toBe('');

      const loaded = await loadSession(session.id, home);
      expect(loaded.messages).toEqual([]);
    });
  });

  describe('forkSession with rewindIndex', () => {
    it('creates child with truncated history when rewindIndex is set', async () => {
      const parent = makeSession();
      await writeSessionMetadata(parent, home);

      // Snapshot after first turn completes (user+assistant):
      const afterTurn1 = {
        type: 'step_finished' as const,
        stepNumber: 1,
        finishReason: 'stop',
        messages: [
          { role: 'user' as const, content: 'hello' },
          { role: 'assistant' as const, content: 'hi' },
        ],
        toolCalls: [],
        usage: emptyUsage(),
      };
      // Snapshot after second turn completes (user2+assistant2):
      const afterTurn2 = {
        type: 'step_finished' as const,
        stepNumber: 2,
        finishReason: 'stop',
        messages: [
          { role: 'user' as const, content: 'hello' },
          { role: 'assistant' as const, content: 'hi' },
          { role: 'user' as const, content: 'how are you?' },
          { role: 'assistant' as const, content: 'fine' },
        ],
        toolCalls: [],
        usage: emptyUsage(),
      };

      await appendSessionEvent(parent.id, afterTurn1, home);
      await appendSessionEvent(parent.id, afterTurn2, home);

      // Fork with rewindIndex=2 — before the second user message.
      const { session: child, childId } = await forkSession({
        parentId: parent.id,
        purpose: 'test-rewind',
        home,
        rewindIndex: 2,
      });

      // Child messages should reflect the truncation (only turn 1).
      expect(child.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);

      // Child events: one surviving snapshot + forked_from appended.
      const childEventsRaw = await readFile(sessionEventsPath(childId, home), 'utf8');
      const childLines = childEventsRaw.split('\n').filter(Boolean);
      expect(childLines).toHaveLength(2);
      const lastChild = JSON.parse(childLines[1]!);
      expect(lastChild.type).toBe('forked_from');
      expect(lastChild.purpose).toBe('test-rewind');

      // Parent should be untouched.
      const parentRaw = await readFile(sessionEventsPath(parent.id, home), 'utf8');
      const parentLines = parentRaw.split('\n').filter(Boolean);
      expect(parentLines).toHaveLength(2);
      expect(parentLines[0]).toContain('"stepNumber":1');
      expect(parentLines[1]).toContain('"stepNumber":2');

      // Loading child from disk should give truncated state.
      const loadedChild = await loadSession(childId, home);
      expect(loadedChild.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]);
      expect(loadedChild.toolCalls).toEqual([]);
    });

    it('fork with rewindIndex=0 creates empty child', async () => {
      const parent = makeSession();
      await persistSession(
        parent,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'only message' }],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );

      const { session: child, childId } = await forkSession({
        parentId: parent.id,
        home,
        rewindIndex: 0,
      });

      expect(child.messages).toEqual([]);
      expect(child.toolCalls).toEqual([]);

      const childEventsRaw = await readFile(sessionEventsPath(childId, home), 'utf8');
      const childLines = childEventsRaw.split('\n').filter(Boolean);
      expect(childLines).toHaveLength(1); // only forked_from
      expect(JSON.parse(childLines[0]!).type).toBe('forked_from');
    });
  });
});
