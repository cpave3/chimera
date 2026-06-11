import { EventEmitter } from 'node:events';
import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent } from '@chimera/core';
import { Box, Static, Text, render } from 'ink';
import { useSyncExternalStore } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { Scrollback, type ScrollbackEntry } from '../src/scrollback';

/**
 * Regression test for streaming flicker: when the in-flight dynamic region
 * grows to the terminal height, Ink abandons diff rendering and rewrites
 * `clearTerminal + full static history + output` on every frame — visible as
 * flicker/jumping scrollback. Paragraph spilling keeps the dynamic region
 * bounded, so the overflow path must never engage while streaming.
 *
 * Note: under a CI env var Ink routes to its append-only CI renderer and this
 * test passes vacuously; it is only meaningful where `is-in-ci` is false.
 */

const CLEAR_TERMINAL = '[2J[3J[H';

class FakeStdout extends EventEmitter {
  frames: string[] = [];
  isTTY = true;
  rows = 10;
  columns = 60;
  write = (chunk: string): boolean => {
    this.frames.push(chunk);
    return true;
  };
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() {
    return null;
  }
}

/** Minimal App-shaped consumer: committed prefix in <Static>, rest below. */
function makeHarness(scrollback: Scrollback) {
  return function Harness() {
    const { entries, committedCount } = useSyncExternalStore(
      scrollback.subscribe.bind(scrollback),
      scrollback.splitSnapshot.bind(scrollback),
      scrollback.splitSnapshot.bind(scrollback),
    );
    const committed: ScrollbackEntry[] = [];
    const inFlight: ScrollbackEntry[] = [];
    entries.forEach((entry, i) => {
      (i < committedCount ? committed : inFlight).push(entry);
    });
    return (
      <>
        <Static items={committed}>
          {(item) => (
            <Box key={item.id} flexDirection="column" marginTop={1}>
              <Text>{item.text}</Text>
            </Box>
          )}
        </Static>
        <Box flexDirection="column">
          {inFlight.map((entry) => (
            <Box key={entry.id} flexDirection="column" marginTop={1}>
              <Text>{entry.text}</Text>
            </Box>
          ))}
          <Box>
            <Text>spinner streaming…</Text>
          </Box>
        </Box>
      </>
    );
  };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('streaming on a short terminal', () => {
  it('never triggers the clearTerminal full-rewrite path', async () => {
    const scrollback = new Scrollback({}, { streamSpillLines: 3 });
    const stdout = new FakeStdout();
    const Harness = makeHarness(scrollback);
    const instance = render(<Harness />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    scrollback.apply({ type: 'user_message', content: 'hello' });
    await tick();

    const paragraphs = Array.from(
      { length: 12 },
      (_, i) => `paragraph ${i} line one\nparagraph ${i} line two`,
    );
    const fullText = paragraphs.join('\n\n');
    for (const delta of fullText.match(/.{1,20}/gs) ?? []) {
      scrollback.apply({ type: 'assistant_text_delta', id: 't1', delta });
      await tick();
    }
    scrollback.apply({ type: 'assistant_text_done', id: 't1', text: fullText });
    await tick(30);

    const clears = stdout.frames.filter((frame) => frame.includes(CLEAR_TERMINAL));
    expect(clears).toHaveLength(0);

    // The whole message ended up committed, nothing dropped or duplicated.
    const { entries, committedCount } = scrollback.splitSnapshot();
    expect(committedCount).toBe(entries.length);
    expect(
      entries
        .filter((entry) => entry.kind === 'assistant')
        .map((entry) => entry.text)
        .join('\n\n'),
    ).toBe(fullText);

    instance.unmount();
  });
});

describe('subagent run on a short terminal', () => {
  it('keeps the in-flight spawn_agent group from triggering clearTerminal rewrites', async () => {
    const stdout = new FakeStdout();
    stdout.rows = 20;
    const events: AgentEvent[] = [
      {
        type: 'tool_call_start',
        callId: 'spawn1',
        name: 'spawn_agent',
        args: { purpose: 'explore' },
        target: 'host',
      },
      {
        type: 'subagent_spawned',
        subagentId: 'sa1',
        parentCallId: 'spawn1',
        purpose: 'explore',
        url: '',
      },
      ...Array.from(
        { length: 30 },
        (_, i): AgentEvent => ({
          type: 'subagent_event',
          subagentId: 'sa1',
          event: {
            type: 'tool_call_start',
            callId: `inner${i}`,
            name: 'read',
            args: { path: `/tmp/file-${i}.txt` },
            target: 'sandbox',
          },
        }),
      ),
    ];
    const client = {
      subscribe: async function* () {
        for (const event of events) {
          yield event;
          await tick();
        }
        await new Promise(() => undefined);
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
    } as unknown as ChimeraClient;

    const instance = render(
      <App client={client} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    // Let all 30 child rows stream in while the parent tool is still pending.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const clears = stdout.frames.filter((frame) => frame.includes(CLEAR_TERMINAL));
    expect(clears).toHaveLength(0);

    // The dynamic region shows only the tail of the run, with an elision row.
    const lastFrame = stdout.frames.join('');
    expect(lastFrame).toContain('earlier steps');

    instance.unmount();
  });
});
