import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSessionId } from '../src/ids';
import {
  forkSession,
  listSessionsOnDisk,
  loadSession,
  persistSession,
  readSessionMetadata,
  sessionEventsPath,
  sessionMetadataPath,
  sessionsDir,
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
    await writeFile(
      sessionMetadataPath(session.id, home),
      JSON.stringify(parsed),
      'utf8',
    );
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
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping malformed line'),
      );
      stderrSpy.mockRestore();
    });
  });
});
