import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent } from '@chimera/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function* noEvents(): AsyncGenerator<AgentEvent> {
  yield* [];
}

/** A session whose event stream the test feeds, recording what the TUI sends. */
function session() {
  const waiters: Array<(event: AgentEvent) => void> = [];
  const buffer: AgentEvent[] = [];
  const steered: string[] = [];
  const sent: string[] = [];
  const push = (event: AgentEvent) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else buffer.push(event);
  };
  const client = {
    subscribe: async function* () {
      while (true) {
        const next = buffer.shift();
        yield next ?? (await new Promise<AgentEvent>((resolve) => waiters.push(resolve)));
      }
    },
    send: (_sessionId: string, text: string) => {
      sent.push(text);
      return noEvents();
    },
    appendMessage: async (_sessionId: string, text: string) => {
      steered.push(text);
    },
    interrupt: async () => {},
    listRules: async () => [],
    listSubagents: async () => [],
    listSessions: async () => [],
  } as unknown as ChimeraClient;
  return { client, push, steered, sent };
}

async function type(stdin: { write: (data: string) => void }, text: string) {
  for (const character of text) {
    stdin.write(character);
    await settle(2);
  }
  await settle(20);
}

const runStarted: AgentEvent = {
  type: 'tool_call_start',
  callId: 'c1' as never,
  name: 'bash',
  args: {},
  target: 'host',
  display: { summary: 'pnpm test' },
};

describe('message queue', () => {
  it('holds a message for the next turn on Tab during a run', async () => {
    const { client, push, steered, sent } = session();
    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="queue-sess" modelRef="m/m" cwd="/tmp" />,
    );
    push(runStarted);
    await settle();

    await type(stdin, 'also fix lint');
    stdin.write('\t');
    await settle();

    expect(lastFrame()).toContain('queued 1 · also fix lint');
    expect(lastFrame()).not.toContain('> also fix lint');
    expect(steered).toEqual([]);
    expect(sent).toEqual([]);

    push({ type: 'run_finished', reason: 'stop' });
    await settle(80);

    expect(sent).toEqual(['also fix lint']);
    expect(lastFrame()).not.toContain('queued 1');
    unmount();
  });

  it('still steers the current run on Enter', async () => {
    const { client, push, steered } = session();
    const { stdin, unmount } = render(
      <App client={client} sessionId="queue-sess" modelRef="m/m" cwd="/tmp" />,
    );
    push(runStarted);
    await settle();

    await type(stdin, 'use vitest');
    stdin.write('\r');
    await settle();

    expect(steered).toEqual(['use vitest']);
    unmount();
  });

  it('takes the newest queued message back on Up at an empty prompt', async () => {
    const { client, push } = session();
    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="queue-sess" modelRef="m/m" cwd="/tmp" />,
    );
    push(runStarted);
    await settle();
    await type(stdin, 'first');
    stdin.write('\t');
    await settle();
    await type(stdin, 'second');
    stdin.write('\t');
    await settle();
    expect(lastFrame()).toContain('queued 2 · second');

    stdin.write('\x1b[A');
    await settle();

    expect(lastFrame()).toContain('> second');
    expect(lastFrame()).toContain('queued 1 · first');
    expect(lastFrame()).not.toContain('queued 2');
    unmount();
  });

  it('lists at most three queued messages and counts the rest', async () => {
    const { client, push } = session();
    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="queue-sess" modelRef="m/m" cwd="/tmp" />,
    );
    push(runStarted);
    await settle();
    for (const text of ['one', 'two', 'three', 'four', 'five']) {
      await type(stdin, text);
      stdin.write('\t');
      await settle();
    }

    const frame = lastFrame() ?? '';
    expect(frame).toContain('queued 1 · one');
    expect(frame).toContain('queued 3 · three');
    expect(frame).not.toContain('queued 4');
    expect(frame).toContain('+2 more');
    unmount();
  });

  it('does not queue with Tab when no run is active', async () => {
    const { client } = session();
    const { lastFrame, stdin, unmount } = render(
      <App client={client} sessionId="queue-sess" modelRef="m/m" cwd="/tmp" />,
    );
    await settle();

    await type(stdin, 'hello');
    stdin.write('\t');
    await settle();

    expect(lastFrame()).not.toContain('queued');
    expect(lastFrame()).toContain('> hello');
    unmount();
  });
});
