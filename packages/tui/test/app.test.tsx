import type { ChimeraClient } from '@chimera/client';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { PermissionModal } from '../src/PermissionModal';
import { buildTheme } from '../src/theme';

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
    ...overrides,
  } as unknown as ChimeraClient;
}

describe('App', () => {
  it('renders header with cwd and model', () => {
    const { lastFrame, unmount } = render(
      <App client={stubClient()} sessionId="01ABCDEFGH" modelRef="anthropic/claude-opus-4-7" cwd="/tmp/proj" />,
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
    expect(lastFrame()).toContain('Ctrl+C interrupt');
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
      <App client={client} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" sandboxMode={target === 'sandbox' ? 'bind' : 'off'} />,
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

    expect(sends).toEqual([
      'first follow-up',
      'second follow-up\n\nthird follow-up',
    ]);
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
});

describe('PermissionModal', () => {
  it('shows the command and choices', () => {
    const { lastFrame, unmount } = render(
      <PermissionModal
        command="pnpm test"
        target="host"
        theme={buildTheme()}
        onResolve={() => {}}
      />,
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
        theme={buildTheme()}
        onResolve={() => {}}
      />,
    );
    expect(lastFrame()).toContain('integration tests');
    unmount();
  });
});
