import { ChimeraClient } from '@chimera/client';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { PermissionModal } from '../src/PermissionModal';

function stubClient(overrides: Partial<ChimeraClient> = {}): ChimeraClient {
  return {
    subscribe: async function* () {
      // no events
    },
    send: async function* () {},
    interrupt: async () => {},
    listRules: async () => [],
    addRule: async () => {},
    removeRule: async () => {},
    resolvePermission: async () => {},
    listSubagents: async () => [],
    createSession: async () => ({ sessionId: '01HZNEWSESS00000000000000000' }),
    listSessions: async () => [],
    compact: async () => {},
    ...overrides,
  } as unknown as ChimeraClient;
}

describe('App', () => {
  it('renders header with cwd and model', () => {
    const { lastFrame, unmount } = render(
      <App
        client={stubClient()}
        sessionId="01ABCDEFGH"
        modelRef="anthropic/claude-opus-4-7"
        cwd="/tmp/proj"
      />,
    );
    expect(lastFrame()).toContain('Chimera');
    expect(lastFrame()).toContain('/tmp/proj');
    expect(lastFrame()).toContain('anthropic/claude-opus-4-7');
    unmount();
  });

  it('renders the input prompt', () => {
    const { lastFrame, unmount } = render(
      <App client={stubClient()} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" />,
    );
    expect(lastFrame()).toContain('>');
    unmount();
  });

  it('renders the footer hints', () => {
    const { lastFrame, unmount } = render(
      <App client={stubClient()} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" />,
    );
    expect(lastFrame()).toContain('Ctrl+Z');
    expect(lastFrame()).toContain('/ commands');
    unmount();
  });

  it.each([
    ['sandbox', '[sandbox]'],
    ['host', '[host]'],
  ] as const)('renders %s tool calls with the %s badge', async (target, badge) => {
    const events = [
      {
        type: 'tool_call_start' as const,
        callId: 'c1',
        name: 'bash',
        args: { command: 'echo hi' },
        target,
      },
    ];
    const client = stubClient({
      subscribe: async function* () {
        for (const ev of events) yield ev;
        // Stay open so the App can keep rendering.
        await new Promise(() => undefined);
      } as unknown as ChimeraClient['subscribe'],
    });

    const { lastFrame, unmount } = render(
      <App
        client={client}
        sessionId="01ABCDEFGH"
        modelRef="m/m"
        cwd="/tmp"
        sandboxMode={target === 'sandbox' ? 'bind' : 'off'}
      />,
    );
    // Wait one tick so the subscribe generator yields and React flushes.
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()).toContain(badge);
    unmount();
  });

  it('Enter while running queues the message instead of sending it', async () => {
    const sends: string[] = [];
    let firstSendResolve: (() => void) | null = null;
    const client = stubClient({
      // Each send() call pushes its text and (for the first call) stays pending
      // so `running` is still true when the second Enter fires.
      send: async function* (id: string, text: string) {
        void id;
        sends.push(text);
        if (sends.length === 1) {
          await new Promise<void>((r) => {
            firstSendResolve = r;
          });
        }
      } as unknown as ChimeraClient['send'],
    });

    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" />,
    );

    const write = (s: string): void => {
      (stdin as unknown as { write: (s: string) => void }).write(s);
    };

    for (const ch of 'first\r') {
      write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 20));

    for (const ch of 'second\r') {
      write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 20));

    expect(sends).toEqual(['first']);
    expect(lastFrame()).toContain('queued (1)');
    expect(lastFrame()).toContain('second');

    firstSendResolve?.();
    unmount();
  });

  it('after run ends, queued messages are concatenated and sent as one user turn', async () => {
    const sends: string[] = [];
    const sendResolvers: Array<() => void> = [];
    let pushEvent: ((ev: unknown) => void) | null = null;

    const client = stubClient({
      send: async function* (id: string, text: string) {
        void id;
        sends.push(text);
        // Stay pending until the test releases this send.
        await new Promise<void>((r) => {
          sendResolvers.push(r);
        });
      } as unknown as ChimeraClient['send'],
      subscribe: async function* () {
        const buffer: unknown[] = [];
        const waiters: Array<(ev: unknown) => void> = [];
        pushEvent = (ev: unknown) => {
          const w = waiters.shift();
          if (w) w(ev);
          else buffer.push(ev);
        };
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as never;
            continue;
          }
          yield await new Promise<never>((r) => {
            waiters.push(r as (ev: unknown) => void);
          });
        }
      } as unknown as ChimeraClient['subscribe'],
    });

    const { stdin, lastFrame, unmount } = render(
      <App client={client} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" />,
    );
    const write = (s: string): void => {
      (stdin as unknown as { write: (s: string) => void }).write(s);
    };

    for (const ch of 'first follow-up\r') {
      write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 20));

    for (const ch of 'second follow-up\r') {
      write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 20));

    for (const ch of 'third follow-up\r') {
      write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 20));

    // End the first run by emitting run_finished into the subscribe stream.
    sendResolvers[0]?.();
    pushEvent?.({ type: 'run_finished', reason: 'interrupted' });
    await new Promise((r) => setTimeout(r, 30));

    expect(sends).toEqual(['first follow-up', 'second follow-up\n\nthird follow-up']);
    expect(lastFrame()).not.toContain('queued (');

    sendResolvers[1]?.();
    unmount();
  });

  it('Esc during a run calls interrupt(sessionId)', async () => {
    let sendResolve: (() => void) | null = null;
    const interrupts: string[] = [];
    const client = stubClient({
      send: async function* (id: string) {
        void id;
        await new Promise<void>((r) => {
          sendResolve = r;
        });
      } as unknown as ChimeraClient['send'],
      interrupt: (async (id: string) => {
        interrupts.push(id);
      }) as ChimeraClient['interrupt'],
    });

    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" />,
    );

    for (const ch of 'hello\r') {
      (stdin as unknown as { write: (s: string) => void }).write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 20));

    (stdin as unknown as { write: (s: string) => void }).write('\x1b');
    await new Promise((r) => setTimeout(r, 20));

    expect(interrupts).toEqual(['01ABCDEFGH']);
    expect(lastFrame()).toContain('interrupt sent');

    sendResolve?.();
    unmount();
  });

  it('Ctrl+C during a run calls interrupt(sessionId) instead of exiting', async () => {
    let sendResolve: (() => void) | null = null;
    const interrupts: string[] = [];
    const client = stubClient({
      // send() stays pending so `running` remains true while Ctrl+C fires.
      send: async function* (id: string) {
        void id;
        await new Promise<void>((r) => {
          sendResolve = r;
        });
      } as unknown as ChimeraClient['send'],
      interrupt: (async (id: string) => {
        interrupts.push(id);
      }) as ChimeraClient['interrupt'],
    });

    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" />,
    );

    // Submit a normal message so `running` flips to true.
    for (const ch of 'hello\r') {
      (stdin as unknown as { write: (s: string) => void }).write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 20));

    // Ctrl+C while running.
    (stdin as unknown as { write: (s: string) => void }).write('\x03');
    await new Promise((r) => setTimeout(r, 20));

    expect(interrupts).toEqual(['01ABCDEFGH']);
    expect(lastFrame()).toContain('interrupt sent');

    // Release the pending send promise so the render loop can unmount.
    sendResolve?.();
    unmount();
  });

  it('routes a subagent_event permission_request to the child via a fresh client', async () => {
    // Spy on ChimeraClient.prototype.resolvePermission so calls made by the
    // child client (constructed inside App.tsx from `pending.subagent.url`)
    // are intercepted. The parent's stub has its own resolvePermission and
    // is not a real ChimeraClient instance, so the spy isolates the child path.
    const childResolveSpy = vi
      .spyOn(ChimeraClient.prototype, 'resolvePermission')
      .mockImplementation(async () => {});
    const parentResolveSpy = vi.fn(async () => {});

    let pushEvent: ((ev: unknown) => void) | null = null;
    const client = stubClient({
      resolvePermission: parentResolveSpy as unknown as ChimeraClient['resolvePermission'],
      subscribe: async function* () {
        const buffer: unknown[] = [];
        const waiters: Array<(ev: unknown) => void> = [];
        pushEvent = (ev: unknown) => {
          const w = waiters.shift();
          if (w) w(ev);
          else buffer.push(ev);
        };
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as never;
            continue;
          }
          yield await new Promise<never>((r) => {
            waiters.push(r as (ev: unknown) => void);
          });
        }
      } as unknown as ChimeraClient['subscribe'],
    });

    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="parent-sess" modelRef="m/m" cwd="/tmp" />,
    );

    pushEvent!({
      type: 'subagent_spawned',
      subagentId: 'sub-9999999999',
      parentCallId: 'pc1',
      childSessionId: 'child-sess-A',
      url: 'http://127.0.0.1:1',
      purpose: 'investigate',
    });
    pushEvent!({
      type: 'subagent_event',
      subagentId: 'sub-9999999999',
      event: {
        type: 'permission_request',
        requestId: 'req-1',
        tool: 'bash',
        target: 'host',
        command: 'rm -rf /tmp/x',
        reason: 'cleanup',
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    const frame = lastFrame()!;
    expect(frame).toContain('rm -rf /tmp/x');
    // Header includes both the subagent id (last 8 chars) and purpose.
    expect(frame).toMatch(/\[subagent .*: investigate\]/);

    // Resolve with 'a' (allow once).
    (stdin as unknown as { write: (s: string) => void }).write('a');
    await new Promise((r) => setTimeout(r, 30));

    expect(parentResolveSpy).not.toHaveBeenCalled();
    expect(childResolveSpy).toHaveBeenCalledTimes(1);
    expect(childResolveSpy.mock.calls[0]?.[0]).toBe('child-sess-A');
    expect(childResolveSpy.mock.calls[0]?.[1]).toBe('req-1');
    expect(childResolveSpy.mock.calls[0]?.[2]).toBe('allow');

    childResolveSpy.mockRestore();
    unmount();
  });
  it('preserves all subagent child tool rows when the parent spawn_agent commits to <Static>', async () => {
    // When the parent spawn_agent's tool_call_result lands, the parent entry
    // transitions from inFlight (re-rendered every tick) into <Static>
    // (rendered once and never re-emitted). The children list MUST be
    // captured at commit time and rendered alongside the parent — otherwise
    // the user sees the parent line with only the final assistant_text_done
    // child, with all the subagent's tool rows missing.
    let pushEvent: ((ev: unknown) => void) | null = null;
    const client = stubClient({
      subscribe: async function* () {
        const buffer: unknown[] = [];
        const waiters: Array<(ev: unknown) => void> = [];
        pushEvent = (ev: unknown) => {
          const w = waiters.shift();
          if (w) w(ev);
          else buffer.push(ev);
        };
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as never;
            continue;
          }
          yield await new Promise<never>((resolve) => {
            waiters.push(resolve as (ev: unknown) => void);
          });
        }
      } as unknown as ChimeraClient['subscribe'],
    });

    const { lastFrame, unmount } = render(
      <App client={client} sessionId="parent-sess" modelRef="m/m" cwd="/tmp" />,
    );

    pushEvent!({
      type: 'tool_call_start',
      callId: 'pc1',
      name: 'spawn_agent',
      args: { prompt: 'investigate', purpose: 'investigate' },
      target: 'host',
      display: { summary: 'investigate' },
    });
    pushEvent!({
      type: 'subagent_spawned',
      subagentId: 'sa1',
      parentCallId: 'pc1',
      childSessionId: 'cs',
      url: '',
      purpose: 'investigate',
    });
    pushEvent!({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_start',
        callId: 'cc1',
        name: 'read',
        args: { path: 'a.ts' },
        target: 'sandbox',
        display: { summary: 'a.ts' },
      },
    });
    pushEvent!({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_result',
        callId: 'cc1',
        result: { content: 'x', total_lines: 1, truncated: false },
        durationMs: 1,
        display: { summary: 'a.ts (1 lines)' },
      },
    });
    pushEvent!({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_start',
        callId: 'cc2',
        name: 'grep',
        args: { pattern: 'foo' },
        target: 'sandbox',
        display: { summary: 'pattern foo' },
      },
    });
    pushEvent!({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: {
        type: 'tool_call_result',
        callId: 'cc2',
        result: { matches: [] },
        durationMs: 1,
        display: { summary: '0 matches' },
      },
    });
    pushEvent!({
      type: 'subagent_event',
      subagentId: 'sa1',
      event: { type: 'assistant_text_done', text: 'final summary text' },
    });
    pushEvent!({
      type: 'subagent_finished',
      subagentId: 'sa1',
      parentCallId: 'pc1',
      result: 'final summary text',
      reason: 'stop',
    });
    // Parent's tool_call_result — this transitions the parent into <Static>.
    pushEvent!({
      type: 'tool_call_result',
      callId: 'pc1',
      result: { result: 'final summary text', reason: 'stop' },
      durationMs: 5,
      display: { summary: 'investigate (done)' },
    });

    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame()!;
    // Parent badge + summary always shows.
    expect(frame).toContain('spawn_agent');
    expect(frame).toContain('(done)');
    // The final assistant text shows.
    expect(frame).toContain('final summary text');
    // BUG hypothesis: child tool rows should still be visible after commit.
    expect(frame).toMatch(/read:.*a\.ts/);
    expect(frame).toMatch(/grep:.*0 matches/);
    unmount();
  });

  it('preserves children of two parallel spawn_agents when one commits before the other has finished', async () => {
    // Reproduces the reported bug: with multiple parallel spawn_agent calls
    // (e.g. /review fans out to several reviewers), one subagent finishes
    // first and its parent commits to <Static>, while the other subagent is
    // still running and emitting child events. Those late-arriving events
    // must still nest under the slower parent, and the slower parent must
    // commit with all of them — none should be silently dropped.
    let pushEvent: ((ev: unknown) => void) | null = null;
    const client = stubClient({
      subscribe: async function* () {
        const buffer: unknown[] = [];
        const waiters: Array<(ev: unknown) => void> = [];
        pushEvent = (ev: unknown) => {
          const w = waiters.shift();
          if (w) w(ev);
          else buffer.push(ev);
        };
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as never;
            continue;
          }
          yield await new Promise<never>((resolve) => {
            waiters.push(resolve as (ev: unknown) => void);
          });
        }
      } as unknown as ChimeraClient['subscribe'],
    });

    const { lastFrame, unmount } = render(
      <App client={client} sessionId="parent-sess" modelRef="m/m" cwd="/tmp" />,
    );

    // Both spawn_agents fire in the same assistant message.
    pushEvent!({
      type: 'tool_call_start',
      callId: 'pcA',
      name: 'spawn_agent',
      args: { purpose: 'reviewA' },
      target: 'host',
      display: { summary: 'reviewA' },
    });
    pushEvent!({
      type: 'tool_call_start',
      callId: 'pcB',
      name: 'spawn_agent',
      args: { purpose: 'reviewB' },
      target: 'host',
      display: { summary: 'reviewB' },
    });
    pushEvent!({
      type: 'subagent_spawned',
      subagentId: 'saA',
      parentCallId: 'pcA',
      childSessionId: 'csA',
      url: '',
      purpose: 'reviewA',
    });
    pushEvent!({
      type: 'subagent_spawned',
      subagentId: 'saB',
      parentCallId: 'pcB',
      childSessionId: 'csB',
      url: '',
      purpose: 'reviewB',
    });
    // Both subagents emit some child tool calls (interleaved).
    for (const sub of ['saA', 'saB']) {
      for (let i = 0; i < 3; i++) {
        pushEvent!({
          type: 'subagent_event',
          subagentId: sub,
          event: {
            type: 'tool_call_start',
            callId: `${sub}-cc${i}`,
            name: 'read',
            args: { path: `${sub}/${i}.ts` },
            target: 'sandbox',
            display: { summary: `${sub}/${i}.ts` },
          },
        });
        pushEvent!({
          type: 'subagent_event',
          subagentId: sub,
          event: {
            type: 'tool_call_result',
            callId: `${sub}-cc${i}`,
            result: { content: 'x', total_lines: 1, truncated: false },
            durationMs: 1,
            display: { summary: `${sub}/${i}.ts (read)` },
          },
        });
      }
    }
    // A finishes first.
    pushEvent!({
      type: 'subagent_event',
      subagentId: 'saA',
      event: { type: 'assistant_text_done', text: 'A summary' },
    });
    pushEvent!({
      type: 'subagent_finished',
      subagentId: 'saA',
      parentCallId: 'pcA',
      result: 'A summary',
      reason: 'stop',
    });
    pushEvent!({
      type: 'tool_call_result',
      callId: 'pcA',
      result: { result: 'A summary', reason: 'stop' },
      durationMs: 5,
      display: { summary: 'reviewA (done)' },
    });
    // B emits MORE child tool calls AFTER A's parent has committed.
    for (let i = 3; i < 6; i++) {
      pushEvent!({
        type: 'subagent_event',
        subagentId: 'saB',
        event: {
          type: 'tool_call_start',
          callId: `saB-cc${i}`,
          name: 'grep',
          args: { pattern: `late${i}` },
          target: 'sandbox',
          display: { summary: `late${i}` },
        },
      });
      pushEvent!({
        type: 'subagent_event',
        subagentId: 'saB',
        event: {
          type: 'tool_call_result',
          callId: `saB-cc${i}`,
          result: { matches: [] },
          durationMs: 1,
          display: { summary: `late${i} done` },
        },
      });
    }
    pushEvent!({
      type: 'subagent_event',
      subagentId: 'saB',
      event: { type: 'assistant_text_done', text: 'B summary' },
    });
    pushEvent!({
      type: 'subagent_finished',
      subagentId: 'saB',
      parentCallId: 'pcB',
      result: 'B summary',
      reason: 'stop',
    });
    pushEvent!({
      type: 'tool_call_result',
      callId: 'pcB',
      result: { result: 'B summary', reason: 'stop' },
      durationMs: 5,
      display: { summary: 'reviewB (done)' },
    });

    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame()!;
    // A's children should all be present (they were all in entries when A committed).
    expect(frame).toMatch(/saA\/0\.ts/);
    expect(frame).toMatch(/saA\/1\.ts/);
    expect(frame).toMatch(/saA\/2\.ts/);
    expect(frame).toContain('A summary');
    // B's children should all be present too.
    expect(frame).toMatch(/saB\/0\.ts/);
    expect(frame).toMatch(/saB\/1\.ts/);
    expect(frame).toMatch(/saB\/2\.ts/);
    expect(frame).toContain('late3');
    expect(frame).toContain('late4');
    expect(frame).toContain('late5');
    expect(frame).toContain('B summary');
    unmount();
  });

  it('submits initialPrompt automatically on mount', async () => {
    const sends: string[] = [];
    const client = stubClient({
      send: async function* (id: string, text: string) {
        void id;
        sends.push(text);
        // Stay pending so running remains true for the assertion window.
        await new Promise(() => undefined);
      } as unknown as ChimeraClient['send'],
    });

    const { lastFrame, unmount } = render(
      <App
        client={client}
        sessionId="01ABCDEFGH"
        modelRef="m/m"
        cwd="/tmp"
        initialPrompt="bootstrap task"
      />,
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(sends).toEqual(['bootstrap task']);
    // Frame shows spinner because the run is pending with no events yet.
    expect(lastFrame()).toContain('waiting');
    unmount();
  });

  it('/new invokes createSession and switches to the new session', async () => {
    let createCalled = false;
    const client = stubClient({
      createSession: async () => {
        createCalled = true;
        return { sessionId: '01HZNEWSESS00000000000000000' };
      },
    });

    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" />,
    );

    const write = (s: string): void => {
      (stdin as unknown as { write: (s: string) => void }).write(s);
    };

    for (const ch of '/new\r') {
      write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 50));

    expect(createCalled).toBe(true);
    expect(lastFrame()).toContain('new session');
    unmount();
  });

  it('/sessions opens the interactive picker when sessions exist', async () => {
    const sessions = [
      {
        id: '01HZAAAAAAAAAAAAAAAAAAAAAA',
        parentId: null,
        children: [],
        createdAt: 1700000000000,
        lastActivityAt: 1700000000000,
        cwd: '/tmp',
        model: { providerId: 'mock', modelId: 'mock', maxSteps: 10 },
        sandboxMode: 'off' as const,
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

    const client = stubClient({
      listSessions: async () => sessions,
    });

    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" />,
    );

    const write = (s: string): void => {
      (stdin as unknown as { write: (s: string) => void }).write(s);
    };

    for (const ch of '/sessions\r') {
      write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain('Sessions (1)');
    expect(lastFrame()).toContain('navigate');
    expect(lastFrame()).toContain('AAAAAAAA');
    unmount();
  });

  it('renders a compaction spinner on compaction_started and clears on compaction_finished', async () => {
    let pushEvent: ((ev: unknown) => void) | null = null;
    const client = stubClient({
      subscribe: async function* () {
        const buffer: unknown[] = [];
        const waiters: Array<(ev: unknown) => void> = [];
        pushEvent = (ev: unknown) => {
          const w = waiters.shift();
          if (w) w(ev);
          else buffer.push(ev);
        };
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as never;
            continue;
          }
          yield await new Promise<never>((resolve) => {
            waiters.push(resolve as (ev: unknown) => void);
          });
        }
      } as unknown as ChimeraClient['subscribe'],
    });

    const { lastFrame, unmount } = render(
      <App client={client} sessionId="parent-sess" modelRef="m/m" cwd="/tmp" />,
    );

    pushEvent!({ type: 'compaction_started', reason: 'manual' });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()!).toContain('compacting');

    pushEvent!({
      type: 'compaction_finished',
      summary: 'synthetic',
      tokensBefore: 1000,
      tokensAfter: 200,
      messagesReplaced: 5,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()!).not.toContain('compacting');
    expect(lastFrame()!).toContain('compaction done: -800 tokens');
    expect(lastFrame()!).toContain('5 messages replaced');

    unmount();
  });

  it('renders an info line when a background process exits', async () => {
    let pushEvent: ((ev: unknown) => void) | null = null;
    const client = stubClient({
      subscribe: async function* () {
        const buffer: unknown[] = [];
        const waiters: Array<(ev: unknown) => void> = [];
        pushEvent = (ev: unknown) => {
          const w = waiters.shift();
          if (w) w(ev);
          else buffer.push(ev);
        };
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as never;
            continue;
          }
          yield await new Promise<never>((resolve) => {
            waiters.push(resolve as (ev: unknown) => void);
          });
        }
      } as unknown as ChimeraClient['subscribe'],
    });

    const { lastFrame, unmount } = render(
      <App client={client} sessionId="parent-sess" modelRef="m/m" cwd="/tmp" />,
    );
    await new Promise((r) => setTimeout(r, 20));

    pushEvent!({
      type: 'background_process_exited',
      shellId: 'shell_1',
      command: 'pnpm dev',
      status: 'exited',
      exitCode: 1,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()!).toContain('background process shell_1 exited (exit 1): pnpm dev');

    unmount();
  });

  it('renders each tool call exactly once when results arrive out of order', async () => {
    let pushEvent: ((ev: unknown) => void) | null = null;
    const client = stubClient({
      subscribe: async function* () {
        const buffer: unknown[] = [];
        const waiters: Array<(ev: unknown) => void> = [];
        pushEvent = (ev: unknown) => {
          const w = waiters.shift();
          if (w) w(ev);
          else buffer.push(ev);
        };
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as never;
            continue;
          }
          yield await new Promise<never>((resolve) => {
            waiters.push(resolve as (ev: unknown) => void);
          });
        }
      } as unknown as ChimeraClient['subscribe'],
    });

    const { lastFrame, unmount } = render(
      <App client={client} sessionId="parent-sess" modelRef="m/m" cwd="/tmp" />,
    );
    await new Promise((r) => setTimeout(r, 20));

    const emit = (ev: unknown) => pushEvent!(ev);
    emit({ type: 'assistant_text_delta', id: 't1', delta: 'running two tools' });
    emit({ type: 'assistant_text_done', id: 't1', text: 'running two tools' });
    emit({
      type: 'tool_call_start',
      callId: 'a',
      name: 'bash',
      args: {},
      target: 'host',
      display: { summary: 'TOOL_ALPHA_SUMMARY' },
    });
    emit({
      type: 'tool_call_start',
      callId: 'b',
      name: 'read',
      args: {},
      target: 'host',
      display: { summary: 'TOOL_BETA_SUMMARY' },
    });
    await new Promise((r) => setTimeout(r, 30));
    // B resolves before A — the sequence that used to displace <Static>'s
    // positional cursor and print B twice while dropping A entirely.
    emit({
      type: 'tool_call_result',
      callId: 'b',
      result: {},
      durationMs: 1,
      display: { summary: 'TOOL_BETA_SUMMARY' },
    });
    await new Promise((r) => setTimeout(r, 30));
    emit({
      type: 'tool_call_result',
      callId: 'a',
      result: {},
      durationMs: 1,
      display: { summary: 'TOOL_ALPHA_SUMMARY' },
    });
    emit({ type: 'run_finished', reason: 'stop' });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame()!;
    const count = (needle: string) => frame.split(needle).length - 1;
    expect(count('TOOL_ALPHA_SUMMARY')).toBe(1);
    expect(count('TOOL_BETA_SUMMARY')).toBe(1);
    expect(count('running two tools')).toBe(1);

    unmount();
  });

  it('renders a task progress widget on task_list_updated', async () => {
    let pushEvent: ((ev: unknown) => void) | null = null;
    const client = stubClient({
      subscribe: async function* () {
        const buffer: unknown[] = [];
        const waiters: Array<(ev: unknown) => void> = [];
        pushEvent = (ev: unknown) => {
          const w = waiters.shift();
          if (w) w(ev);
          else buffer.push(ev);
        };
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as never;
            continue;
          }
          yield await new Promise<never>((resolve) => {
            waiters.push(resolve as (ev: unknown) => void);
          });
        }
      } as unknown as ChimeraClient['subscribe'],
    });

    const { lastFrame, unmount } = render(
      <App client={client} sessionId="parent-sess" modelRef="m/m" cwd="/tmp" />,
    );
    await new Promise((r) => setTimeout(r, 20));

    pushEvent!({
      type: 'task_list_updated',
      tasks: [
        { content: 'write failing test', status: 'completed' },
        { content: 'implement feature', status: 'in_progress' },
        { content: 'refactor', status: 'pending' },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()!).toContain('[tasks 1/3: implement feature]');

    pushEvent!({
      type: 'task_list_updated',
      tasks: [
        { content: 'write failing test', status: 'completed' },
        { content: 'implement feature', status: 'completed' },
        { content: 'refactor', status: 'completed' },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()!).toContain('[tasks 3/3 done]');

    unmount();
  });

  it('/compact handler sets compacting immediately, and queued messages auto-send after compaction_finished', async () => {
    const sends: string[] = [];
    let pushEvent: ((ev: unknown) => void) | null = null;
    const client = stubClient({
      // biome-ignore lint/correctness/useYield: stub records the call and yields nothing
      send: async function* (id: string, text: string) {
        void id;
        sends.push(text);
      } as unknown as ChimeraClient['send'],
      subscribe: async function* () {
        const buffer: unknown[] = [];
        const waiters: Array<(ev: unknown) => void> = [];
        pushEvent = (ev: unknown) => {
          const w = waiters.shift();
          if (w) w(ev);
          else buffer.push(ev);
        };
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as never;
            continue;
          }
          yield await new Promise<never>((resolve) => {
            waiters.push(resolve as (ev: unknown) => void);
          });
        }
      } as unknown as ChimeraClient['subscribe'],
    });

    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="parent-sess" modelRef="m/m" cwd="/tmp" />,
    );

    // Start compacting.
    pushEvent!({ type: 'compaction_started', reason: 'manual' });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()!).toContain('compacting');

    // Queue a message while compacting.
    const write = (s: string): void => {
      (stdin as unknown as { write: (s: string) => void }).write(s);
    };
    for (const ch of 'hello during compact\r') {
      write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()!).toContain('queued (1)');
    expect(sends).toEqual([]);

    // End compaction.
    pushEvent!({
      type: 'compaction_finished',
      summary: 'synthetic',
      tokensBefore: 1000,
      tokensAfter: 200,
      messagesReplaced: 5,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()!).not.toContain('queued (');
    expect(lastFrame()!).not.toContain('compacting');
    expect(lastFrame()!).toContain('compaction done');
    expect(sends).toEqual(['hello during compact']);

    unmount();
  });

  it('renders a compaction error line on compaction_failed', async () => {
    let pushEvent: ((ev: unknown) => void) | null = null;
    const client = stubClient({
      subscribe: async function* () {
        const buffer: unknown[] = [];
        const waiters: Array<(ev: unknown) => void> = [];
        pushEvent = (ev: unknown) => {
          const w = waiters.shift();
          if (w) w(ev);
          else buffer.push(ev);
        };
        while (true) {
          if (buffer.length > 0) {
            yield buffer.shift() as never;
            continue;
          }
          yield await new Promise<never>((resolve) => {
            waiters.push(resolve as (ev: unknown) => void);
          });
        }
      } as unknown as ChimeraClient['subscribe'],
    });

    const { lastFrame, unmount } = render(
      <App client={client} sessionId="parent-sess" modelRef="m/m" cwd="/tmp" />,
    );

    pushEvent!({ type: 'compaction_started', reason: 'threshold' });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()!).toContain('compacting');

    pushEvent!({ type: 'compaction_failed', error: 'model refused' });
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()!).not.toContain('compacting');
    expect(lastFrame()!).toContain('compaction failed: model refused');

    unmount();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PermissionModal', () => {
  it('shows the command and choices', () => {
    const { lastFrame, unmount } = render(
      <PermissionModal command="pnpm test" target="host" onResolve={() => {}} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('pnpm test');
    expect(frame).toContain('Allow once');
    expect(frame).toContain('Allow & remember');
    expect(frame).toContain('Deny once');
    unmount();
  });

  it('shows the reason line when provided', () => {
    const { lastFrame, unmount } = render(
      <PermissionModal
        command="echo x"
        reason="integration tests"
        target="host"
        onResolve={() => {}}
      />,
    );
    expect(lastFrame()).toContain('integration tests');
    unmount();
  });

  it('choose → scope: allow + session remembers with session scope only', async () => {
    const calls: Array<{ decision: 'allow' | 'deny'; remember?: Record<string, unknown> }> = [];
    const { stdin, lastFrame, unmount } = render(
      <PermissionModal
        command="rm -rf /tmp"
        target="host"
        onResolve={(decision, remember) => calls.push({ decision, remember: remember as Record<string, unknown> })}
      />,
    );

    (stdin as unknown as { write: (s: string) => void }).write('A');
    await new Promise((r) => setTimeout(r, 5));
    expect(lastFrame()).toContain('Remember for [s]ession');

    (stdin as unknown as { write: (s: string) => void }).write('s');
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([{ decision: 'allow', remember: { scope: 'session' } }]);

    unmount();
  });

  it('choose → scope: allow + project remembers with exact pattern', async () => {
    const calls: Array<{ decision: 'allow' | 'deny'; remember?: Record<string, unknown> }> = [];
    const { stdin, lastFrame, unmount } = render(
      <PermissionModal
        command="rm -rf /tmp"
        target="host"
        onResolve={(decision, remember) => calls.push({ decision, remember: remember as Record<string, unknown> })}
      />,
    );

    (stdin as unknown as { write: (s: string) => void }).write('A');
    await new Promise((r) => setTimeout(r, 5));
    expect(lastFrame()).toContain('Remember for [s]ession');

    (stdin as unknown as { write: (s: string) => void }).write('p');
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([
      {
        decision: 'allow',
        remember: { scope: 'project', pattern: 'rm -rf /tmp', patternKind: 'exact' },
      },
    ]);

    unmount();
  });

  it('choose → pattern → scope: allow uses pattern from editing mode', async () => {
    const calls: Array<{ decision: 'allow' | 'deny'; remember?: Record<string, unknown> }> = [];
    const { stdin, lastFrame, unmount } = render(
      <PermissionModal
        command="rm -rf /tmp"
        target="host"
        onResolve={(decision, remember) => calls.push({ decision, remember: remember as Record<string, unknown> })}
      />,
    );

    // Transition from choose to pattern editing.
    (stdin as unknown as { write: (s: string) => void }).write('g');
    await new Promise((r) => setTimeout(r, 5));
    expect(lastFrame()).toContain('Edit pattern');

    // Confirm default pattern with Enter (tests that pattern mode carries the
    // command forward into scope mode even though no edits were made).
    (stdin as unknown as { write: (s: string) => void }).write('\r');
    await new Promise((r) => setTimeout(r, 10));

    expect(lastFrame()).toContain('Remember for [s]ession');

    // Press 'p' for project scope; default command becomes exact pattern.
    (stdin as unknown as { write: (s: string) => void }).write('p');
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([
      {
        decision: 'allow',
        remember: { scope: 'project', pattern: 'rm -rf /tmp', patternKind: 'exact' },
      },
    ]);

    unmount();
  });

  it('choose → scope: deny + session remembers with session scope only', async () => {
    const calls: Array<{ decision: 'allow' | 'deny'; remember?: Record<string, unknown> }> = [];
    const { stdin, lastFrame, unmount } = render(
      <PermissionModal
        command="rm -rf /tmp"
        target="host"
        onResolve={(decision, remember) => calls.push({ decision, remember: remember as Record<string, unknown> })}
      />,
    );

    (stdin as unknown as { write: (s: string) => void }).write('D');
    await new Promise((r) => setTimeout(r, 5));
    expect(lastFrame()).toContain('Remember for [s]ession');

    (stdin as unknown as { write: (s: string) => void }).write('s');
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([{ decision: 'deny', remember: { scope: 'session' } }]);

    unmount();
  });

  it('resolve emits plain allow (no remember) on [a]', () => {
    const calls: Array<{ decision: 'allow' | 'deny'; remember?: Record<string, unknown> }> = [];
    const { stdin, unmount } = render(
      <PermissionModal
        command="clear"
        target="host"
        onResolve={(decision, remember) => calls.push({ decision, remember: remember as Record<string, unknown> })}
      />,
    );

    (stdin as unknown as { write: (s: string) => void }).write('a');
    expect(calls).toEqual([{ decision: 'allow' }]);

    unmount();
  });
});
