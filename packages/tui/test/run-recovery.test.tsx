import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent } from '@chimera/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

/** A client whose event stream the test feeds one event at a time. */
function pushableClient(): { client: ChimeraClient; push: (event: AgentEvent) => void } {
  const buffer: AgentEvent[] = [];
  const waiters: Array<(event: AgentEvent) => void> = [];
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
    send: async function* () {},
    interrupt: async () => {},
    listRules: async () => [],
    listSubagents: async () => [],
    listSessions: async () => [],
  } as unknown as ChimeraClient;
  return { client, push };
}

async function frameAfter(events: AgentEvent[]): Promise<string> {
  const { client, push } = pushableClient();
  const { lastFrame, unmount } = render(
    <App client={client} sessionId="recovery-sess" modelRef="m/m" cwd="/tmp" />,
  );
  for (const event of events) push(event);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

describe('run recovery messages', () => {
  it('tells the user a failed step is being retried', async () => {
    const frame = await frameAfter([
      { type: 'provider_retry', attempt: 2, maxAttempts: 4, delayMs: 2000, error: 'Overloaded' },
    ]);
    expect(frame).toContain('provider error: Overloaded');
    expect(frame).toContain('retry 2/4 in 2s');
  });

  it('names the fallback model when a run moves to it', async () => {
    const frame = await frameAfter([
      { type: 'model_fallback', from: 'a/primary', to: 'a/backup', error: 'Overloaded' },
    ]);
    expect(frame).toContain('a/primary is unavailable');
    expect(frame).toContain('a/backup');
  });

  it('reports an output cutoff and the continuation', async () => {
    const frame = await frameAfter([{ type: 'output_continued', attempt: 1, maxAttempts: 2 }]);
    expect(frame).toContain('output limit reached');
    expect(frame).toContain('1/2');
  });

  it('explains a run that ended on the output limit', async () => {
    const frame = await frameAfter([{ type: 'run_finished', reason: 'output_limit' }]);
    expect(frame).toContain('output limit');
    expect(frame).toContain("'continue'");
  });
});
