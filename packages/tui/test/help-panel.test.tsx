import type { ChimeraClient } from '@chimera/client';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

function idleClient(): ChimeraClient {
  return {
    subscribe: async function* () {},
    send: async function* () {},
    interrupt: async () => {},
    listRules: async () => [],
    listSubagents: async () => [],
    listSessions: async () => [],
  } as unknown as ChimeraClient;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe('help panel', () => {
  it('opens on ? at an empty prompt and closes on Escape', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={idleClient()} sessionId="help-sess" modelRef="m/m" cwd="/tmp" />,
    );
    await settle();
    expect(lastFrame()).not.toContain('Shift+Tab');

    stdin.write('?');
    await settle();
    expect(lastFrame()).toContain('Shift+Tab');
    expect(lastFrame()).toContain('Ctrl+G');
    expect(lastFrame()).toContain('Ctrl+C');

    stdin.write('\x1b');
    await settle();
    expect(lastFrame()).not.toContain('Shift+Tab');
    unmount();
  });

  it('closes when the user starts typing and keeps the typed character', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={idleClient()} sessionId="help-sess" modelRef="m/m" cwd="/tmp" />,
    );
    await settle();
    stdin.write('?');
    await settle();

    stdin.write('h');
    await settle();

    expect(lastFrame()).not.toContain('Shift+Tab');
    expect(lastFrame()).toContain('> h');
    unmount();
  });

  it('types a question mark when the prompt already has text', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={idleClient()} sessionId="help-sess" modelRef="m/m" cwd="/tmp" />,
    );
    await settle();
    stdin.write('w');
    await settle();
    stdin.write('?');
    await settle();

    expect(lastFrame()).toContain('> w?');
    expect(lastFrame()).not.toContain('Shift+Tab');
    unmount();
  });
});
