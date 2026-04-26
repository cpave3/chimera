import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newSessionId } from '../src/ids';
import {
  forkSession,
  listSessionsOnDisk,
  loadSession,
  persistSession,
  sessionEventsPath,
  sessionMetadataPath,
  sessionsDir,
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
      ...overrides,
    };
  }

  it('writes session.json without messages or toolCalls and appends event line', async () => {
    const s = makeSession();
    await persistSession(
      s,
      {
        type: 'step_finished',
        stepNumber: 1,
        finishReason: 'stop',
        messages: s.messages,
        toolCalls: s.toolCalls,
        usage: s.usage,
      },
      home,
    );
    const meta = JSON.parse(
      await readFile(sessionMetadataPath(s.id, home), 'utf8'),
    );
    expect(meta.id).toEqual(s.id);
    expect(meta).not.toHaveProperty('messages');
    expect(meta).not.toHaveProperty('toolCalls');
    expect(meta.parentId).toBeNull();
    expect(meta.children).toEqual([]);

    const events = (await readFile(sessionEventsPath(s.id, home), 'utf8'))
      .split('\n')
      .filter(Boolean);
    expect(events).toHaveLength(1);
    const ev = JSON.parse(events[0]);
    expect(ev.type).toBe('step_finished');
    expect(ev.messages).toEqual(s.messages);
  });

  it('round-trips messages and toolCalls via the latest step_finished', async () => {
    const s = makeSession();
    s.messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    await persistSession(
      s,
      {
        type: 'step_finished',
        stepNumber: 1,
        finishReason: 'stop',
        messages: s.messages,
        toolCalls: s.toolCalls,
        usage: s.usage,
      },
      home,
    );
    const loaded = await loadSession(s.id, home);
    expect(loaded.id).toEqual(s.id);
    expect(loaded.messages).toEqual(s.messages);
    expect(loaded.status).toEqual('idle');
  });

  it('uses the most recent step_finished for messages on resume', async () => {
    const s = makeSession();
    await persistSession(
      s,
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
      s,
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
    const loaded = await loadSession(s.id, home);
    expect(loaded.messages).toHaveLength(2);
  });

  it('skips a malformed trailing line on resume', async () => {
    const s = makeSession();
    await persistSession(
      s,
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
    const eventsPath = sessionEventsPath(s.id, home);
    const existing = await readFile(eventsPath, 'utf8');
    await writeFile(eventsPath, existing + '{ this is not json', 'utf8');

    const loaded = await loadSession(s.id, home);
    expect(loaded.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('resets status to idle on load', async () => {
    const s = makeSession({ status: 'error' });
    await persistSession(
      s,
      {
        type: 'step_finished',
        stepNumber: 1,
        finishReason: 'stop',
        messages: s.messages,
        toolCalls: s.toolCalls,
        usage: s.usage,
      },
      home,
    );
    const loaded = await loadSession(s.id, home);
    expect(loaded.status).toEqual('idle');
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

      const childEvents = (
        await readFile(sessionEventsPath(childId, home), 'utf8')
      )
        .split('\n')
        .filter(Boolean);
      // copied step_finished + appended forked_from
      expect(childEvents).toHaveLength(2);
      const last = JSON.parse(childEvents[childEvents.length - 1]);
      expect(last.type).toBe('forked_from');
      expect(last.parentId).toEqual(parent.id);
      expect(last.purpose).toEqual('try it');

      const parentMeta = JSON.parse(
        await readFile(sessionMetadataPath(parent.id, home), 'utf8'),
      );
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
      const parentBefore = await readFile(
        sessionEventsPath(parent.id, home),
        'utf8',
      );

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

      const parentAfter = await readFile(
        sessionEventsPath(parent.id, home),
        'utf8',
      );
      expect(parentAfter).toEqual(parentBefore);
    });
  });

  describe('concurrent writers', () => {
    it('interleaved appends to events.jsonl yield valid lines', async () => {
      const s = makeSession();
      // Two concurrent appendSessionEvent calls; each writes one line.
      // POSIX append semantics guarantee atomicity for typical line sizes.
      await Promise.all([
        persistSession(
          s,
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
          s,
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
      const loaded = await loadSession(s.id, home);
      expect(loaded.messages).toHaveLength(1);
      expect(['a', 'b']).toContain(loaded.messages[0]!.content);
    });
  });

  describe('listSessionsOnDisk', () => {
    it('returns persisted sessions with metadata', async () => {
      const a = makeSession();
      const b = makeSession();
      await persistSession(
        a,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [{ role: 'user', content: 'a1' }],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );
      await persistSession(
        b,
        {
          type: 'step_finished',
          stepNumber: 1,
          finishReason: 'stop',
          messages: [
            { role: 'user', content: 'b1' },
            { role: 'assistant', content: 'b2' },
          ],
          toolCalls: [],
          usage: emptyUsage(),
        },
        home,
      );

      const list = await listSessionsOnDisk(home);
      const ids = list.map((s) => s.id).sort();
      expect(ids).toEqual([a.id, b.id].sort());
      const bInfo = list.find((s) => s.id === b.id)!;
      expect(bInfo.messageCount).toEqual(2);
    });

    it('ignores pre-change flat <id>.json files', async () => {
      const a = makeSession();
      await persistSession(
        a,
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
      expect(list.map((s) => s.id)).toEqual([a.id]);
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
      const firstActivity = firstScan.find((entry) => entry.id === session.id)!
        .lastActivityAt;
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
      const secondActivity = secondScan.find(
        (entry) => entry.id === session.id,
      )!.lastActivityAt;
      expect(secondActivity).toBeGreaterThanOrEqual(firstActivity);
    });
  });
});
