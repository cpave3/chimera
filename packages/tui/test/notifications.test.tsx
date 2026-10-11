import type { AgentEvent } from '@chimera/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import type { NotificationReason } from '../src/notify';
import { fakeSession, settle } from './fullscreen-helpers';

const toolStart: AgentEvent = {
  type: 'tool_call_start',
  callId: 'c1' as never,
  name: 'bash',
  args: {},
  target: 'host',
  display: { summary: 'pnpm test' },
};

function mount() {
  const session = fakeSession();
  const asked: NotificationReason[] = [];
  const rendered = render(
    <App
      client={session.client}
      sessionId="notify-sess"
      modelRef="m/m"
      model={{ providerId: 'm', modelId: 'm', maxSteps: 50 }}
      cwd="/tmp"
      notify={(reason) => asked.push(reason)}
    />,
  );
  return { ...rendered, session, asked };
}

describe('attention requests', () => {
  it('asks once when a run ends', async () => {
    const { session, asked, unmount } = mount();
    session.push(toolStart);
    await settle();
    expect(asked).toEqual([]);
    session.push({ type: 'run_finished', reason: 'stop' } as AgentEvent);
    await settle();
    unmount();

    expect(asked).toEqual(['run_finished']);
  });

  it('does not ask when the user stopped the run', async () => {
    const { session, asked, stdin, unmount } = mount();
    session.push(toolStart);
    await settle();
    stdin.write('\x1b');
    await settle();
    session.push({ type: 'run_finished', reason: 'interrupted' } as AgentEvent);
    await settle();
    unmount();

    expect(asked).toEqual([]);
  });

  it('asks when a permission request opens', async () => {
    const { session, asked, unmount } = mount();
    session.push({
      type: 'permission_request',
      requestId: 'r1',
      tool: 'bash',
      target: 'host',
      command: 'rm -rf build',
    } as AgentEvent);
    await settle();
    unmount();

    expect(asked).toEqual(['approval']);
  });

  it('asks when the agent needs input', async () => {
    const { session, asked, unmount } = mount();
    session.push(toolStart);
    session.push({ type: 'user_input_required', request: 'Which database?' } as AgentEvent);
    await settle();
    unmount();

    expect(asked).toContain('input');
  });
});
