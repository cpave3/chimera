import { tmpdir } from 'node:os';
import { ChimeraHttpError } from '@chimera/client';
import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MountOptions } from '../src/mount';
import {
  type FakeSession,
  fakeSession,
  type Mounted,
  mount,
  settle,
  text,
  userMessage,
} from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const event = (value: unknown) => value as AgentEvent;

const snapshot = (status: string) => ({
  parentId: null,
  mode: 'build',
  model: { providerId: 'manticore', modelId: 'gpt' },
  messages: [],
  status,
  pendingPermissions: [],
});

/** Mount on a fake session whose client has `extra` methods; feed it through `session`. */
async function mountSession(
  extra: Record<string, unknown> = {},
  overrides: Partial<MountOptions> = {},
): Promise<{
  mounted: Mounted;
  session: FakeSession;
  feed(...events: AgentEvent[]): Promise<void>;
}> {
  const session = fakeSession();
  Object.assign(session.client, extra);
  mounted = await mount({ client: session.client, ...overrides });
  return {
    mounted,
    session,
    async feed(...events) {
      for (const item of events) session.push(item);
      await settle();
    },
  };
}

describe('sending a message', () => {
  it('shows a long paste as a placeholder but sends its text and attaches its paths', async () => {
    const attached: string[] = [];
    const { mounted, session } = await mountSession({
      addPath: async (_sessionId: string, _kind: string, path: string) => {
        attached.push(path);
      },
    });
    const pasted = 'first\nsecond\n@source.ts\nfourth\nfifth';
    await mounted.keys(`\x1b[200~${pasted}\x1b[201~`);
    expect(mounted.screen()).toContain('│ › [Pasted text #1, 5 lines]');

    await mounted.keys('\r');

    expect(session.sent).toEqual([pasted]);
    expect(attached).toEqual(['/tmp/project/source.ts']);
  });

  it('sends the initial prompt on start', async () => {
    mounted = await mount({ initialPrompt: 'bootstrap task' });

    expect(mounted.session.sent).toEqual(['bootstrap task']);
    expect(mounted.term.screen().at(-4)).toContain('esc interrupt');
  });

  it('reports a failed send', async () => {
    const { mounted, session } = await mountSession({
      // biome-ignore lint/correctness/useYield: the request fails before any event
      send: async function* () {
        throw new ChimeraHttpError(409, { error: 'different conflict' });
      },
    });
    await mounted.keys('fail\r');

    expect(session.appended).toEqual([]);
    expect(mounted.screen()).toContain('✗ error  send failed:');
  });

  it('adds the message to the run once when the server says a run is already going', async () => {
    const sent: string[] = [];
    const appended: Array<{ text: string; images?: string[] }> = [];
    const { mounted } = await mountSession({
      // biome-ignore lint/correctness/useYield: the request fails before any event
      send: async function* (_sessionId: string, message: string) {
        sent.push(message);
        throw new ChimeraHttpError(409, { error: 'run already in progress' });
      },
      appendMessage: async (_sessionId: string, message: string, images?: string[]) => {
        appended.push({ text: message, images });
      },
      getSession: async () => snapshot('idle'),
    });
    await mounted.keys('keep this\r');

    expect(sent).toEqual(['keep this']);
    expect(appended).toEqual([{ text: 'keep this', images: undefined }]);
    expect(mounted.screen()).toContain('   note  injected: keep this');
    expect(mounted.screen()).not.toContain('send failed');
    expect(mounted.term.screen().at(-4)).toContain('? help');
  });
});

describe('a message during a run', () => {
  it('goes into the run in progress on Enter', async () => {
    mounted = await mount();
    await mounted.keys('first\r');
    await mounted.event(userMessage('first'), text('working'));
    await mounted.keys('second\r');

    expect(mounted.session.sent).toEqual(['first']);
    expect(mounted.session.appended).toEqual(['second']);
    expect(mounted.screen()).toContain('   note  injected: second');
    expect(mounted.screen()).not.toContain('queued');
  });

  it.each([
    'running',
    'waiting_for_permission',
  ])('goes into the run of a resumed session that is %s', async (status) => {
    const { mounted, session } = await mountSession({ getSession: async () => snapshot(status) });
    await mounted.keys('continue\r');

    expect(session.sent).toEqual([]);
    expect(session.appended).toEqual(['continue']);
  });

  it('goes into the run when a tool event came before a late idle snapshot', async () => {
    let releaseSnapshot = () => {};
    const { mounted, session, feed } = await mountSession({
      getSession: async () => {
        await new Promise<void>((resolve) => {
          releaseSnapshot = resolve;
        });
        return snapshot('idle');
      },
    });
    await feed(
      event({
        type: 'tool_call_start',
        callId: 'active-tool',
        name: 'bash',
        args: { command: 'sleep 1' },
        target: 'host',
      }),
    );
    releaseSnapshot();
    await settle();
    await mounted.keys('follow up\r');

    expect(session.appended).toEqual(['follow up']);
    expect(session.sent).toEqual([]);
  });

  it('holds a ! command until the run ends, then runs it', async () => {
    mounted = await mount({ cwd: tmpdir() });
    await mounted.keys('first follow-up\r');
    await mounted.keys('second follow-up\r');
    await mounted.keys('!echo hi\r');
    expect(mounted.screen()).toContain(' queued  !echo hi');

    await mounted.event(event({ type: 'run_finished', reason: 'interrupted' }));
    await vi.waitFor(() => expect(mounted!.session.appended).toHaveLength(2));

    expect(mounted.session.sent).toEqual(['first follow-up']);
    expect(mounted.session.appended[0]).toBe('second follow-up');
    expect(mounted.session.appended[1]).toMatch(/^!echo hi \(exit 0\)\nhi/);
    expect(mounted.screen()).not.toContain('queued');
  });
});

describe('interrupting a run', () => {
  it.each([
    ['Esc', '\x1b'],
    ['Ctrl+C', '\x03'],
  ])('%s sends an interrupt for the session instead of exiting', async (_name, key) => {
    mounted = await mount();
    const exit = vi.fn();
    void mounted.handle.waitUntilExit().then(exit);
    await mounted.keys('hello\r');
    await mounted.keys(key, 120);

    expect(mounted.session.interrupt).toHaveBeenCalledExactlyOnceWith('01ABCDEFGH8AWWBRGC');
    expect(mounted.screen()).toContain('   note  interrupt sent');
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('compaction and the queue', () => {
  it('holds a message typed while compacting and sends it once compaction ends', async () => {
    mounted = await mount();
    await mounted.event(event({ type: 'compaction_started', reason: 'manual' }));
    await mounted.keys('hello during compact\r');
    expect(mounted.screen()).toContain(' queued  hello during compact');
    expect(mounted.session.sent).toEqual([]);

    await mounted.event(
      event({
        type: 'compaction_finished',
        summary: 'synthetic',
        tokensBefore: 1000,
        tokensAfter: 200,
        messagesReplaced: 5,
      }),
    );

    expect(mounted.session.sent).toEqual(['hello during compact']);
    expect(mounted.screen()).not.toContain('queued');
    expect(mounted.term.screen().at(-4)).not.toContain('compacting');
    expect(mounted.screen()).toContain('compaction done');
  });

  it('/compact asks the server to compact and shows it at once', async () => {
    const compact = vi.fn(async () => {});
    const { mounted } = await mountSession({ compact });
    await mounted.keys('/compact\r');

    expect(compact).toHaveBeenCalledWith('01ABCDEFGH8AWWBRGC');
    expect(mounted.term.screen().at(-4)).toContain('compacting');
  });
});

describe('session commands', () => {
  it('/new creates a session and switches to it', async () => {
    const createSession = vi.fn(async () => ({ sessionId: '01HZNEWSESS00000000000000000' }));
    const { mounted } = await mountSession({ createSession });
    await mounted.keys('/new\r');

    expect(createSession).toHaveBeenCalledOnce();
    expect(mounted.screen()).toContain('   note  new session 00000000');
    expect(mounted.term.screen().at(-1)).toBe('   00000000');
  });

  it('/sessions opens the picker on the sessions of this directory', async () => {
    const sessions = [
      {
        id: '01HZAAAAAAAAAAAAAAAAAAAAAA',
        parentId: null,
        children: [],
        createdAt: 1700000000000,
        lastActivityAt: 1700000000000,
        cwd: '/tmp/project',
        model: { providerId: 'manticore', modelId: 'gpt', maxSteps: 10 },
        sandboxMode: 'off',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 0,
          stepCount: 0,
        },
        messageCount: 2,
      },
    ];
    const { mounted } = await mountSession({ listSessions: async () => sessions });
    await mounted.keys('/sessions\r');
    const screen = mounted.screen();

    expect(screen).toContain('sessions · 1');
    expect(screen).toContain('↑↓ enter switch · esc');
    expect(screen).toContain('AAAAAAAA  project');
    expect(screen).toContain('2 msgs');
  });

  it('/context shows the token breakdown from the server', async () => {
    const { mounted } = await mountSession({
      getContextBreakdown: async () => ({
        contextWindow: 200_000,
        lastPromptTokens: 54_321,
        estimatedTotalTokens: 60_000,
        triggerTokens: 170_000,
        systemPromptTokens: 2_000,
        messageCount: 12,
        summaryTokens: 1_500,
        userTokens: 5_000,
        assistantTokens: 20_000,
        toolTokens: 31_500,
        archivedStubCount: 3,
      }),
    });
    await mounted.keys('/context\r');
    const screen = mounted.screen();

    expect(screen).toContain('   note  context window: 200,000 tokens');
    expect(screen).toContain('   note  last prompt (actual): 54,321 (27%)');
    expect(screen).toContain('   note  auto-compact trigger: 170,000 (85%)');
    expect(screen).toContain('   note    tool results: ~31,500 (3 archived stubs)');
  });
});
