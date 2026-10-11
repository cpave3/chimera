import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent } from '@chimera/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const FILES = [
  'packages/core/src/agent.ts',
  'packages/core/test/agent.test.ts',
  'packages/server/src/agent-registry.ts',
  'README.md',
];

async function* noEvents(): AsyncGenerator<AgentEvent> {
  yield* [];
}

function mount(events: AgentEvent[] = []) {
  const sent: string[] = [];
  let interrupts = 0;
  const client = {
    subscribe: async function* () {
      for (const event of events) yield event;
      await new Promise(() => undefined);
    },
    send: (_sessionId: string, text: string) => {
      sent.push(text);
      return noEvents();
    },
    appendMessage: async () => {},
    interrupt: async () => {
      interrupts += 1;
    },
    listRules: async () => [],
    listSubagents: async () => [],
    listSessions: async () => [],
    listPaths: async () => ({ read: [], write: [] }),
    addPath: async () => {},
  } as unknown as ChimeraClient;
  const view = render(
    <App
      client={client}
      sessionId="files-sess"
      modelRef="m/m"
      cwd="/tmp"
      listFiles={async () => FILES}
    />,
  );
  return { ...view, sent, interrupts: () => interrupts };
}

async function type(stdin: { write: (data: string) => void }, text: string) {
  for (const character of text) {
    stdin.write(character);
    await settle(2);
  }
  await settle(30);
}

describe('file completion menu', () => {
  it('lists matching files and completes the word on Tab', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await settle();

    await type(stdin, 'fix @agent');

    const open = lastFrame() ?? '';
    expect(open).toContain('packages/core/src/agent.ts');
    expect(open).toContain('packages/server/src/agent-registry.ts');
    expect(open).not.toContain('README.md');

    stdin.write('\t');
    await settle();

    expect(lastFrame()).toContain('> fix @packages/core/src/agent.ts');
    expect(lastFrame()).not.toContain('agent-registry.ts');
    unmount();
  });

  it('accepts the selected file on Enter without sending the message', async () => {
    const { lastFrame, stdin, sent, unmount } = mount();
    await settle();
    await type(stdin, 'see @agent');

    stdin.write('\x1b[B');
    await settle();
    stdin.write('\r');
    await settle();

    expect(lastFrame()).toContain('> see @packages/core/test/agent.test.ts');
    expect(sent).toEqual([]);
    unmount();
  });

  it('shows no list when nothing matches, so Enter sends the message', async () => {
    const { lastFrame, stdin, sent, unmount } = mount();
    await settle();

    await type(stdin, 'ping @nobody');
    expect(lastFrame()).not.toContain('packages/');
    stdin.write('\r');
    await settle(80);

    expect(sent).toHaveLength(1);
    unmount();
  });

  it('closes on Escape without interrupting the run', async () => {
    const { lastFrame, stdin, interrupts, unmount } = mount([
      { type: 'tool_call_start', callId: 'c1' as never, name: 'bash', args: {}, target: 'host' },
    ]);
    await settle();
    await type(stdin, 'see @agent');
    expect(lastFrame()).toContain('packages/core/src/agent.ts');

    stdin.write('\x1b');
    await settle();

    expect(lastFrame()).not.toContain('packages/core/src/agent.ts');
    expect(lastFrame()).toContain('> see @agent');
    expect(interrupts()).toBe(0);
    unmount();
  });
});
