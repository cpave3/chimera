import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { MountOptions } from '../src/mount';
import { type Mounted, mount, runFinished, toolCall } from './harness';

const toolStart = toolCall('c1', 'bash', { command: 'pnpm test' }, 'pnpm test');

const permissionRequest = {
  type: 'permission_request',
  requestId: 'r1',
  tool: 'bash',
  target: 'host',
  command: 'rm -rf build',
} as AgentEvent;

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const desktopNotifications = (term: Mounted['term']) =>
  term.osc.filter((sequence) => sequence.startsWith('9;'));

function mountWith(notifications: MountOptions['notifications']): Promise<Mounted> {
  return mount({ notifications });
}

describe('attention requests', () => {
  it('rings once when a run ends', async () => {
    mounted = await mountWith('bell');
    await mounted.event(...toolStart);
    expect(mounted.term.bells).toBe(0);

    await mounted.event(runFinished);

    expect(mounted.term.bells).toBe(1);
  });

  it('does not ring when the user stopped the run', async () => {
    mounted = await mountWith('bell');
    await mounted.event(...toolStart);
    await mounted.keys('\x1b', 120);
    await mounted.event({ type: 'run_finished', reason: 'interrupted' } as AgentEvent);

    expect(mounted.session.interrupt).toHaveBeenCalled();
    expect(mounted.term.bells).toBe(0);
  });

  it('rings when a permission request opens', async () => {
    mounted = await mountWith('bell');
    await mounted.event(permissionRequest);

    expect(mounted.term.bells).toBe(1);
  });

  it('rings when the agent needs input', async () => {
    mounted = await mountWith('bell');
    await mounted.event(...toolStart, {
      type: 'user_input_required',
      request: 'Which database?',
    } as AgentEvent);

    expect(mounted.term.bells).toBe(1);
  });

  it('sends a desktop notification naming the project and the reason', async () => {
    mounted = await mountWith('auto');
    await mounted.event(permissionRequest);

    expect(desktopNotifications(mounted.term)).toEqual(['9;chimera · project: approval needed']);
  });

  it('stays quiet when notifications are off', async () => {
    mounted = await mountWith('off');
    await mounted.event(permissionRequest);
    await mounted.event(runFinished);

    expect(mounted.term.bells).toBe(0);
    expect(desktopNotifications(mounted.term)).toEqual([]);
  });
});
