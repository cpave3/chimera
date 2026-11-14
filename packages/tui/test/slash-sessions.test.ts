import type { AgentEvent, Checkpoint, SessionInfo } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeSession, type Mounted, mount, settle } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const PARENT_ID = '01ABCDEFGH8AWWBRGC';
const NEW_ID = '01HZNEWSESSION00000000000000';
const CHILD_ID = '01HZFORKEDCHILD0000000000000';

const compactionStarted: AgentEvent = { type: 'compaction_started', reason: 'threshold' };
const compactionFinished = {
  type: 'compaction_finished',
  summary: 'done',
  tokensBefore: 1000,
  tokensAfter: 200,
  messagesReplaced: 5,
} as AgentEvent;

/** Mount on a fake session whose client also has `methods`. */
async function mountWith(methods: Record<string, unknown>) {
  const session = fakeSession();
  Object.assign(session.client, methods);
  mounted = await mount({ client: session.client });
  return { mounted, session };
}

/** A client that records the sessions it creates, forks and rewinds. */
function sessionClient(checkpoints: Checkpoint[] = [], sessions: SessionInfo[] = []) {
  const calls = {
    created: [] as unknown[],
    forked: [] as Array<{
      id: string;
      purpose?: string;
      rewindIndex?: number;
      previousSessionId?: string;
    }>,
    rewound: [] as Array<{ id: string; index: number }>,
    listedCheckpoints: 0,
    compacted: [] as string[],
  };
  const methods = {
    createSession: async (options: unknown) => {
      calls.created.push(options);
      return { sessionId: NEW_ID };
    },
    forkSession: async (
      id: string,
      purpose?: string,
      rewindIndex?: number,
      previousSessionId?: string,
    ) => {
      calls.forked.push({ id, purpose, rewindIndex, previousSessionId });
      return { sessionId: CHILD_ID, parentId: id };
    },
    listSessions: async () => sessions,
    listCheckpoints: async () => {
      calls.listedCheckpoints += 1;
      return checkpoints;
    },
    rewindSession: async (id: string, index: number) => {
      calls.rewound.push({ id, index });
      return { sessionId: id };
    },
    compact: async (id: string) => {
      calls.compacted.push(id);
    },
    getSession: async () => ({
      parentId: null,
      status: 'idle',
      mode: 'build',
      model: { providerId: 'manticore', modelId: 'gpt' },
      messages: [],
    }),
  };
  return { calls, methods };
}

describe('/new', () => {
  it('passes the previous session to the server when switching to a new session', async () => {
    const { methods } = sessionClient();
    const session = fakeSession();
    const order: unknown[] = [];
    Object.assign(session.client, methods, {
      createSession: async (options: unknown) => {
        order.push(options);
        return { sessionId: NEW_ID };
      },
    });
    mounted = await mount({
      client: session.client,
    });
    order.length = 0;
    await mounted.keys('/new\r');
    expect(order).toEqual([
      {
        cwd: '/tmp/project',
        model: { providerId: 'manticore', modelId: 'gpt', maxSteps: 50 },
        sandboxMode: 'off',
        previousSessionId: PARENT_ID,
      },
    ]);
    expect(mounted.handle.activeSessionId()).toBe(NEW_ID);
  });

  it('creates a session with the model, cwd and sandbox of this one and switches to it', async () => {
    const { calls, methods } = sessionClient();
    const { mounted } = await mountWith(methods);
    await mounted.keys('/new\r');

    expect(calls.created).toEqual([
      {
        cwd: '/tmp/project',
        model: { providerId: 'manticore', modelId: 'gpt', maxSteps: 50 },
        sandboxMode: 'off',
        previousSessionId: PARENT_ID,
      },
    ]);
    expect(mounted.screen()).toContain('   note  new session 00000000');
  });
});

describe('/sessions', () => {
  const saved: SessionInfo = {
    id: '01HZAAAAAAAAAAAAAAAAAAAAAA',
    parentId: null,
    children: [],
    createdAt: 1700000000000,
    lastActivityAt: 1700000000000,
    cwd: '/tmp/project',
    model: { providerId: 'manticore', modelId: 'gpt', maxSteps: 50 },
    sandboxMode: 'off',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
    },
    messageCount: 2,
  };

  it('opens a picker of the sessions in this directory', async () => {
    const { methods } = sessionClient([], [saved]);
    const { mounted } = await mountWith(methods);
    await mounted.keys('/sessions\r');

    expect(mounted.screen()).toMatch(/┌─ sessions · 1 /);
    expect(mounted.screen()).toContain('AAAAAAAA');
  });

  it('passes the old session when selecting a saved session', async () => {
    const { methods } = sessionClient([], [saved]);
    const session = fakeSession();
    const calls: string[] = [];
    Object.assign(session.client, methods, {
      resumeSession: async (id: string, previousSessionId: string) => {
        calls.push(`${previousSessionId}->${id}`);
        return { sessionId: id };
      },
    });
    mounted = await mount({
      client: session.client,
    });
    await mounted.keys('/sessions\r');
    await mounted.keys('\r');
    expect(calls).toEqual([`${PARENT_ID}->${saved.id}`]);
    expect(mounted.handle.activeSessionId()).toBe(saved.id);
  });

  it('says when no session was saved in this directory', async () => {
    const { methods } = sessionClient([], [{ ...saved, cwd: '/elsewhere' }]);
    const { mounted } = await mountWith(methods);
    await mounted.keys('/sessions\r');

    expect(mounted.screen()).toContain('   note  no persisted sessions in /tmp/project');
    expect(mounted.screen()).not.toContain('┌─ sessions');
  });
});

describe('/fork', () => {
  it('forks the current session with a purpose and switches to the child', async () => {
    const { calls, methods } = sessionClient();
    const { mounted } = await mountWith(methods);
    await mounted.keys('/fork try alternative\r');

    expect(calls.forked).toEqual([
      {
        id: PARENT_ID,
        purpose: 'try alternative',
        rewindIndex: undefined,
        previousSessionId: PARENT_ID,
      },
    ]);
    expect(mounted.screen()).toContain(
      '   note  forked session 00000000 from 8AWWBRGC (try alternative)',
    );
  });

  it('forks without a purpose', async () => {
    const { calls, methods } = sessionClient();
    const { mounted } = await mountWith(methods);
    await mounted.keys('/fork\r');

    expect(calls.forked).toEqual([
      { id: PARENT_ID, purpose: undefined, rewindIndex: undefined, previousSessionId: PARENT_ID },
    ]);
  });
});

describe('/compact', () => {
  it('compacts the session', async () => {
    const { calls, methods } = sessionClient();
    const { mounted } = await mountWith(methods);
    await mounted.keys('/compact\r');

    expect(calls.compacted).toEqual([PARENT_ID]);
    expect(mounted.screen()).toContain('compact  compacting...');
  });

  it('queues a message typed while compacting and sends it after', async () => {
    mounted = await mount();
    await mounted.event(compactionStarted);
    expect(mounted.screen()).toMatch(/compacting ─╮$/m);

    await mounted.keys('hello while compacting\r');
    expect(mounted.screen()).toContain(' queued  hello while compacting');
    expect(mounted.session.sent).toEqual([]);

    await mounted.event(compactionFinished);
    expect(mounted.screen()).not.toContain(' queued ');
    expect(mounted.session.sent).toEqual(['hello while compacting']);
  });
});

describe('/rewind', () => {
  const checkpoints: Checkpoint[] = [
    { index: 0, userMessage: '', toolCallSummary: '', truncateByteOffset: 0 },
    {
      index: 3,
      userMessage: 'first prompt',
      toolCallSummary: '1 tool call',
      truncateByteOffset: 120,
    },
    { index: 7, userMessage: 'second prompt', toolCallSummary: '', truncateByteOffset: 240 },
  ];

  it('opens a picker of the checkpoints', async () => {
    const { methods } = sessionClient(checkpoints);
    const { mounted } = await mountWith(methods);
    await mounted.keys('/rewind\r');
    const screen = mounted.screen();

    expect(screen).toMatch(/┌─ rewind .*enter rewind · shift\+enter fork · esc ─┐/);
    expect(screen).toMatch(/ {2}3 {2}first prompt · 1 tool call/);
    expect(screen).toMatch(/ {2}7 {2}second prompt/);
  });

  it('says when there is no checkpoint to rewind to', async () => {
    const { methods } = sessionClient([checkpoints[0]!]);
    const { mounted } = await mountWith(methods);
    await mounted.keys('/rewind\r');

    expect(mounted.screen()).toContain('   note  no checkpoints to rewind to');
    expect(mounted.screen()).not.toContain('┌─ rewind');
  });

  it('rewinds to the checkpoint picked with Enter and puts its message back in the prompt', async () => {
    const { calls, methods } = sessionClient([
      checkpoints[0]!,
      { index: 1, userMessage: 'refactor the query', toolCallSummary: '', truncateByteOffset: 120 },
    ]);
    const { mounted } = await mountWith(methods);
    await mounted.keys('/rewind\r');
    await mounted.keys('\x1b[B');
    await mounted.keys('\r');

    expect(calls.rewound).toEqual([{ id: PARENT_ID, index: 1 }]);
    expect(mounted.screen()).toContain('rewound to checkpoint 1');
    expect(mounted.screen()).toMatch(/^│ › refactor the query +│$/m);
    expect(mounted.screen()).not.toContain('┌─ rewind');
  });

  it('forks from the checkpoint picked with Shift+Enter and puts its message in the prompt', async () => {
    const { calls, methods } = sessionClient(checkpoints);
    const { mounted } = await mountWith(methods);
    await mounted.keys('/rewind\r');
    await mounted.keys('\x1b[B');
    await mounted.keys('\x1b[B');
    await mounted.keys('\x1b[13;2u');

    expect(calls.forked).toEqual([
      { id: PARENT_ID, purpose: undefined, rewindIndex: 7, previousSessionId: PARENT_ID },
    ]);
    expect(calls.rewound).toEqual([]);
    expect(mounted.screen()).toContain('   note  forked from checkpoint 7 into session 00000000');
    expect(mounted.screen()).toMatch(/^│ › second prompt +│$/m);
  });

  it('closes the picker with Esc and neither rewinds nor forks', async () => {
    const { calls, methods } = sessionClient(checkpoints);
    const { mounted } = await mountWith(methods);
    await mounted.keys('/rewind\r');
    await mounted.keys('\x1b', 120);

    expect(mounted.screen()).not.toContain('┌─ rewind');
    expect(mounted.screen()).toContain('   note  /rewind cancelled');
    expect(calls.rewound).toEqual([]);
    expect(calls.forked).toEqual([]);
  });

  it('is queued while the session compacts', async () => {
    const { calls, methods } = sessionClient(checkpoints);
    const { mounted, session } = await mountWith(methods);
    session.push(compactionStarted);
    await settle();
    await mounted.keys('/rewind\r');

    expect(mounted.screen()).toContain(' queued  /rewind');
    expect(calls.listedCheckpoints).toBe(0);
  });
});
