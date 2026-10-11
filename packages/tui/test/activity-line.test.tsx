import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent } from '@chimera/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

async function frameAfter(events: AgentEvent[]): Promise<string> {
  const buffer = [...events];
  const client = {
    subscribe: async function* () {
      while (true) {
        const next = buffer.shift();
        yield next ?? (await new Promise<AgentEvent>(() => {}));
      }
    },
    send: async function* () {},
    interrupt: async () => {},
    listRules: async () => [],
    listSubagents: async () => [],
    listSessions: async () => [],
  } as unknown as ChimeraClient;
  const { lastFrame, unmount } = render(
    <App client={client} sessionId="activity-sess" modelRef="m/m" cwd="/tmp" />,
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

const bashStart: AgentEvent = {
  type: 'tool_call_start',
  callId: 'c1' as never,
  name: 'bash',
  args: { command: 'pnpm test' },
  target: 'host',
  display: { summary: 'pnpm test' },
};

describe('activity line', () => {
  it('names the tool call in flight and how to interrupt', async () => {
    const frame = await frameAfter([bashStart]);

    expect(frame).toContain('running pnpm test');
    expect(frame).toContain('esc to interrupt');
    expect(frame).toMatch(/\b0s\b/);
  });

  it('says the run waits for approval while a permission request is open', async () => {
    const frame = await frameAfter([
      bashStart,
      {
        type: 'permission_request',
        requestId: 'r1',
        tool: 'bash',
        target: 'host',
        command: 'pnpm test',
      },
    ]);

    expect(frame).toContain('waiting for approval');
  });

  it('says the model is writing while text streams', async () => {
    const frame = await frameAfter([{ type: 'assistant_text_delta', id: 't1', delta: 'Hello' }]);

    expect(frame).toContain('writing');
  });

  it('shows a provider retry until the next step produces output', async () => {
    const retry: AgentEvent = {
      type: 'provider_retry',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 2000,
      error: 'Overloaded',
    };
    const waiting = await frameAfter([
      bashStart,
      { ...bashStart, type: 'tool_call_result', result: {}, durationMs: 1 } as never,
      retry,
    ]);
    const resumed = await frameAfter([
      retry,
      { type: 'assistant_text_delta', id: 't1', delta: 'ok' },
    ]);

    expect(waiting).toContain('provider error, retry 2/4 ·');
    expect(resumed).not.toContain('retry 2/4 ·');
  });
});
