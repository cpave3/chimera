import { ChimeraClient } from '@chimera/client';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

function stubClient(): ChimeraClient {
  return {
    subscribe: async function* () {},
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
}

describe('cursor wrapping regression', () => {
  it('renders the active cursor via embedded ANSI inverse escapes', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={stubClient()} sessionId="01ABCDEFGH" modelRef="m/m" cwd="/tmp" />,
    );

    const write = (s: string): void => {
      (stdin as unknown as { write: (s: string) => void }).write(s);
    };

    for (const ch of 'typing test') {
      write(ch);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame()!;

    // Must use embedded SGR inverse escapes rather than a separate
    // <Text inverse> node. Three sibling <Text> nodes (pre / inverse / post)
    // detach the cursor from the wrapping text flow and leave it visually
    // stuck at the end of the first wrapped line.
    expect(frame).toContain('\x1b[7m');
    expect(frame).toContain('\x1b[27m');

    // The typed text should still be present after stripping ANSI.
    const stripped = frame.replace(/\x1b\[[0-9;]*m/g, '').replace(/\n/g, '');
    expect(stripped).toContain('typing test');

    unmount();
  });
});
