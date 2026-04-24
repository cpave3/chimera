import type { ChimeraClient } from '@chimera/client';
import { InMemoryCommandRegistry, type CommandRegistry } from '@chimera/commands';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

function stub(): ChimeraClient {
  return {
    subscribe: async function* () {
      await new Promise(() => {});
    },
    send: async function* () {},
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

describe('slash menu', () => {
  it('opens when you type "/s" and lists matching built-ins + user commands', async () => {
    const reg = registry([{ name: 'summarize', body: 'S $ARGUMENTS', description: 'sum' }]);
    const { lastFrame, stdin, unmount } = render(
      <App client={stub()} sessionId="s" modelRef="m/m" cwd="/tmp" commands={reg} />,
    );
    await type(stdin, '/s');
    const frame = lastFrame()!;
    expect(frame).toContain('/sessions');
    expect(frame).toContain('/summarize');
    expect(frame).toContain('built-in');
    expect(frame).toContain('user');
    unmount();
  });

  it('filters by case-insensitive prefix as the user types', async () => {
    const reg = registry([
      { name: 'summarize', body: 'x' },
      { name: 'refactor', body: 'y' },
    ]);
    const { lastFrame, stdin, unmount } = render(
      <App client={stub()} sessionId="s" modelRef="m/m" cwd="/tmp" commands={reg} />,
    );
    await type(stdin, '/Sum');
    const frame = lastFrame()!;
    expect(frame).toContain('/summarize');
    expect(frame).not.toContain('/refactor');
    expect(frame).not.toContain('/help');
    unmount();
  });

  it('closes once the input contains a space (args phase)', async () => {
    const reg = registry([{ name: 'summarize', body: 'x' }]);
    const { lastFrame, stdin, unmount } = render(
      <App client={stub()} sessionId="s" modelRef="m/m" cwd="/tmp" commands={reg} />,
    );
    await type(stdin, '/summarize ');
    const frame = lastFrame()!;
    // The bordered menu box uses box-drawing characters; look for the header
    // instead.
    expect(frame).not.toContain('built-in');
    // But the input line still shows the typed text.
    expect(frame).toContain('/summarize');
    unmount();
  });

  it('Tab completes the highlighted item with a trailing space (closes menu)', async () => {
    const reg = registry([{ name: 'summarize', body: 'x' }]);
    const { lastFrame, stdin, unmount } = render(
      <App client={stub()} sessionId="s" modelRef="m/m" cwd="/tmp" commands={reg} />,
    );
    await type(stdin, '/sum');
    // Press Tab
    (stdin as any).write('\t');
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame()!;
    expect(frame).toContain('/summarize');
    // Menu should now be closed because input has a trailing space.
    expect(frame).not.toContain('built-in');
    unmount();
  });

  it('Down arrow moves the highlight; Tab then completes the new selection', async () => {
    const reg = registry([
      { name: 'summarize', body: 'x' },
      { name: 'sumthing', body: 'y' },
    ]);
    const { lastFrame, stdin, unmount } = render(
      <App client={stub()} sessionId="s" modelRef="m/m" cwd="/tmp" commands={reg} />,
    );
    await type(stdin, '/sum');
    // Down, then Tab.
    (stdin as any).write('\x1b[B'); // down arrow
    await new Promise((r) => setTimeout(r, 10));
    (stdin as any).write('\t');
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame()!;
    // Second item alphabetical is "sumthing".
    expect(frame).toContain('/sumthing');
    unmount();
  });

  it('Esc dismisses the menu until the user starts over', async () => {
    const reg = registry([{ name: 'summarize', body: 'x' }]);
    const { lastFrame, stdin, unmount } = render(
      <App client={stub()} sessionId="s" modelRef="m/m" cwd="/tmp" commands={reg} />,
    );
    await type(stdin, '/sum');
    expect(lastFrame()).toContain('/summarize');
    (stdin as any).write('\x1b'); // Esc
    await new Promise((r) => setTimeout(r, 20));
    // Menu gone — no more "built-in" badge, and the input is unchanged.
    const frame = lastFrame()!;
    expect(frame).not.toContain('built-in');
    expect(frame).toContain('/sum');
    unmount();
  });
});
