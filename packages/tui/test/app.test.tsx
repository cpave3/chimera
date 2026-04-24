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
