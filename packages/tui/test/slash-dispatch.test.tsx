import type { ChimeraClient } from '@chimera/client';
import { InMemoryCommandRegistry, type CommandRegistry } from '@chimera/commands';
import type { AgentEvent } from '@chimera/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

interface StubClientOpts {
  sendSpy?: (msg: string) => void;
  /**
   * When the TUI calls `send(id, content)`, the stub will emit these events
   * via its subscribe() stream — simulating the real server echoing a
   * user_message (and optionally more) after it processes the POST.
   */
  echoOnSend?: (content: string) => AgentEvent[];
}

function stubClient(opts: StubClientOpts = {}): ChimeraClient {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;

  return {
    subscribe: async function* () {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
    send: async function* (_id: string, msg: string) {
      opts.sendSpy?.(msg);
      for (const ev of opts.echoOnSend?.(msg) ?? []) {
        queue.push(ev);
      }
      wake?.();
      wake = null;
    },
    interrupt: async () => {},
    listRules: async () => [],
    addRule: async () => {},
    removeRule: async () => {},
    resolvePermission: async () => {},
  } as unknown as ChimeraClient;
}

function registry(
  cmds: { name: string; body: string; description?: string }[],
): CommandRegistry {
  return new InMemoryCommandRegistry(
    cmds.map((c) => ({
      name: c.name,
      body: c.body,
      description: c.description,
      path: `/tmp/${c.name}.md`,
      source: 'project' as const,
    })),
    [],
    '/tmp',
  );
}

async function type(stdin: NodeJS.WritableStream, text: string): Promise<void> {
  for (const ch of text) {
    (stdin as any).write(ch);
    await new Promise((r) => setTimeout(r, 1));
  }
  await new Promise((r) => setTimeout(r, 20));
}

describe('TUI slash dispatch', () => {
  it('/help lists user commands with descriptions', async () => {
    const reg = registry([
      { name: 'summarize', body: 'Summarize $ARGUMENTS', description: 'Summarize stuff' },
    ]);
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({})}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/help\r');
    const frame = lastFrame()!;
    expect(frame).toContain('/help');
    expect(frame).toContain('User commands');
    expect(frame).toContain('/summarize');
    expect(frame).toContain('Summarize stuff');
    unmount();
  });

  it('built-in wins over a user template with the same name', async () => {
    const reg = registry([{ name: 'help', body: 'Help template!' }]);
    const sent: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/help\r');
    const frame = lastFrame()!;
    // The built-in /help lists commands — shouldn't have fired an "unknown" error.
    expect(frame).not.toContain('unknown command');
    // Warning about shadowed user template should have been logged once.
    expect(frame).toContain('shadowed by the built-in');
    // The template body should NOT have been sent as a user message.
    expect(sent).toEqual([]);
    unmount();
  });

  it('user template dispatches and sends expanded message', async () => {
    const reg = registry([
      { name: 'summarize', body: 'Summarize: $ARGUMENTS' },
    ]);
    const sent: string[] = [];
    const { stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/summarize the current branch\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual(['Summarize: the current branch']);
    unmount();
  });

  it('shows the raw /<name> invocation in scrollback and suppresses the echoed expanded body', async () => {
    const reg = registry([
      { name: 'summarize', body: 'Summarize: $ARGUMENTS' },
    ]);
    const sent: string[] = [];
    // Simulate the server echoing a user_message event with the expanded text
    // (which is what the real server does after POST /messages).
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({
          sendSpy: (m) => sent.push(m),
          echoOnSend: (content) => [{ type: 'user_message', content }],
        })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/summarize the current branch\r');
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame()!;
    // The invocation the user typed appears.
    expect(frame).toContain('/summarize the current branch');
    // The expanded body is sent to the server...
    expect(sent).toEqual(['Summarize: the current branch']);
    // ...but is NOT shown in the scrollback (suppression consumed the echo).
    expect(frame).not.toContain('Summarize: the current branch');
    unmount();
  });

  it('/reload calls registry.reload() and logs on change', async () => {
    // Hand-built reloadable registry. `reload()` bumps an internal list and
    // notifies subscribers — simulating the real ReloadingCommandRegistry.
    let items: { name: string; body: string; description?: string }[] = [
      { name: 'before', body: 'b' },
    ];
    const listeners = new Set<() => void>();
    const reg: CommandRegistry = {
      list: () =>
        items.map((c) => ({
          name: c.name,
          body: c.body,
          description: c.description,
          path: `/tmp/${c.name}.md`,
          source: 'project' as const,
        })),
      find: (name) => {
        const c = items.find((x) => x.name === name);
        return c
          ? {
              name: c.name,
              body: c.body,
              description: c.description,
              path: `/tmp/${c.name}.md`,
              source: 'project' as const,
            }
          : undefined;
      },
      expand: () => '',
      collisions: () => [],
      reload: async () => {
        items = [...items, { name: 'after', body: 'a' }];
        for (const l of listeners) l();
      },
      onChange: (l) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
    };

    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({})}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/reload\r');
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame()!;
    expect(frame).toContain('commands reloaded (2 total)');
    unmount();
  });

  it('/help lists /reload as a built-in', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({})}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={registry([])}
      />,
    );
    await type(stdin, '/help\r');
    expect(lastFrame()!).toContain('/reload');
    unmount();
  });

  it('unknown /<name> shows a fuzzy hint and does not send a message', async () => {
    const reg = registry([{ name: 'summarize', body: 'S $ARGUMENTS' }]);
    const sent: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/summarze foo\r');
    const frame = lastFrame()!;
    expect(frame).toContain('unknown command');
    expect(frame).toContain('did you mean');
    expect(frame).toContain('/summarize');
    expect(sent).toEqual([]);
    unmount();
  });
});
