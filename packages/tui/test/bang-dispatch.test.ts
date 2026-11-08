import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeSession, type Mounted, mount, settle } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const compactionStarted: AgentEvent = { type: 'compaction_started', reason: 'threshold' };
const compactionFinished = {
  type: 'compaction_finished',
  summary: 'done',
  tokensBefore: 1000,
  tokensAfter: 200,
  messagesReplaced: 5,
} as AgentEvent;

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await settle(10);
  }
  await settle();
}

/** Mount in a directory that exists, on a session that echoes appended messages back. */
async function mountBang() {
  const session = fakeSession();
  Object.assign(session.client, {
    appendMessage: async (_sessionId: string, content: string) => {
      session.appended.push(content);
      session.push({ type: 'user_message', content });
    },
  });
  mounted = await mount({ client: session.client, cwd: '/tmp' });
  return { mounted, session };
}

describe('! commands', () => {
  it('runs the command here and appends its output to the session without a run', async () => {
    const { mounted, session } = await mountBang();
    await mounted.keys('!echo hello\r');
    await waitFor(() => session.appended.length === 1);

    expect(mounted.screen()).toContain('   note  running: echo hello');
    expect(session.appended[0]).toBe('!echo hello (exit 0)\nhello\n');
    expect(session.sent).toEqual([]);

    await mounted.keys('now ask\r');
    expect(session.sent).toEqual(['now ask']);
  });

  it('does nothing for a lone !', async () => {
    const { mounted, session } = await mountBang();
    await mounted.keys('!\r');

    expect(session.sent).toEqual([]);
    expect(session.appended).toEqual([]);
    expect(mounted.screen()).not.toContain('running:');
  });

  it('reports the exit code of a failing command', async () => {
    const { mounted, session } = await mountBang();
    await mounted.keys('!false\r');
    await waitFor(() => session.appended.length === 1);

    expect(session.appended[0]).toBe('!false (exit 1)\n(no output)');
    expect(mounted.screen()).toContain('!false (exit 1)');
    expect(session.sent).toEqual([]);

    await mounted.keys('ask\r');
    expect(session.sent).toEqual(['ask']);
  });

  it('marks the prompt as a shell command while it starts with !', async () => {
    mounted = await mount();
    expect(mounted.screen()).toMatch(/^│ › +│$/m);

    await mounted.keys('!echo hello');
    expect(mounted.screen()).toMatch(/^│ \$ !echo hello +│$/m);
  });

  it('queues a command typed while the session is busy and runs it after', async () => {
    const { mounted, session } = await mountBang();
    session.push(compactionStarted);
    await settle();
    await mounted.keys('!echo hello\r');

    expect(mounted.screen()).toContain(' queued  !echo hello');
    expect(session.appended).toEqual([]);

    session.push(compactionFinished);
    await waitFor(() => session.appended.length === 1);
    expect(session.appended[0]).toContain('!echo hello (exit 0)');
    expect(mounted.screen()).not.toContain(' queued ');
    expect(session.sent).toEqual([]);

    await mounted.keys('summarize\r');
    expect(session.sent).toEqual(['summarize']);
  });

  it('runs several queued commands in order', async () => {
    const { mounted, session } = await mountBang();
    session.push(compactionStarted);
    await settle();
    await mounted.keys('!echo a\r');
    await mounted.keys('!echo b\r');

    expect(mounted.screen()).toContain(' queued  !echo a');
    expect(mounted.screen()).toMatch(/^ {9}!echo b$/m);

    session.push(compactionFinished);
    await waitFor(() => session.appended.length === 2);
    expect(session.appended[0]).toContain('!echo a (exit 0)');
    expect(session.appended[1]).toContain('!echo b (exit 0)');
    expect(mounted.screen()).not.toContain(' queued ');
    expect(session.sent).toEqual([]);

    await mounted.keys('analysis\r');
    expect(session.sent).toEqual(['analysis']);
  });
});
