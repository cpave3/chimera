import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent } from '@chimera/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

function clientWith(events: AgentEvent[]): ChimeraClient {
  return {
    subscribe: async function* () {
      for (const event of events) yield event;
      await new Promise(() => undefined);
    },
    send: async function* () {},
    interrupt: async () => {},
    listRules: async () => [],
    listSubagents: async () => [],
    listSessions: async () => [],
  } as unknown as ChimeraClient;
}

function read(index: number): AgentEvent[] {
  const callId = `read-${index}` as never;
  const display = { summary: `src/file-${index}.ts` };
  return [
    { type: 'tool_call_start', callId, name: 'read', args: {}, target: 'host', display },
    {
      type: 'tool_call_result',
      callId,
      result: { content: `body ${index}` },
      durationMs: 1,
      display,
    },
  ];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

describe('transcript view', () => {
  it('opens the whole session in a pager on Ctrl+T, with grouped calls listed one by one', async () => {
    const shown: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={clientWith([
          { type: 'user_message', content: 'look around' },
          ...read(1),
          ...read(2),
          ...read(3),
          { type: 'run_finished', reason: 'stop' },
        ])}
        sessionId="transcript-sess"
        modelRef="m/m"
        cwd="/tmp"
        openInPager={async ({ text }) => {
          shown.push(text);
          return { ok: true };
        }}
      />,
    );
    await settle();
    expect(lastFrame()).toContain('explored: read 3 files');

    stdin.write('\x14');
    await settle();

    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('› look around');
    for (const index of [1, 2, 3]) {
      expect(shown[0]).toContain(`• read: src/file-${index}.ts`);
      expect(shown[0]).toContain(`body ${index}`);
    }
    unmount();
  });

  it('says why when the pager cannot be started', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App
        client={clientWith([{ type: 'user_message', content: 'hi' }])}
        sessionId="transcript-sess"
        modelRef="m/m"
        cwd="/tmp"
        openInPager={async () => ({ ok: false, reason: 'spawn less ENOENT' })}
      />,
    );
    await settle();

    stdin.write('\x14');
    await settle();

    expect(lastFrame()).toContain('transcript: spawn less ENOENT');
    unmount();
  });
});
