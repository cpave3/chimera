import type { SessionId } from '@chimera/core';
import type { FirePayload, HookFireResult, HookRunner } from '@chimera/hooks';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/event-bus';
import { bridgeHooksToBus } from '../src/hook-bridge';

const sid = 's1' as unknown as SessionId;

interface Recorder extends HookRunner {
  fired: FirePayload[];
}

function recorder(): Recorder {
  const fired: FirePayload[] = [];
  return {
    fired,
    async fire(p): Promise<HookFireResult> {
      fired.push(p);
      return { blocked: false };
    },
  };
}

async function flush(): Promise<void> {
  // Hook firings are dispatched with `void runner.fire(...)`. Yield twice so
  // the microtask queue catches up before assertions.
  await Promise.resolve();
  await Promise.resolve();
}

describe('bridgeHooksToBus', () => {
  it('translates user_message → UserPromptSubmit', async () => {
    const bus = new EventBus(sid);
    const r = recorder();
    bridgeHooksToBus(bus, r);
    bus.publish({ type: 'user_message', content: 'hello' });
    await flush();
    expect(r.fired).toEqual([{ event: 'UserPromptSubmit', user_message: 'hello' }]);
  });

  it('enriches PostToolUse with name+args from tool_call_start', async () => {
    const bus = new EventBus(sid);
    const r = recorder();
    bridgeHooksToBus(bus, r);
    bus.publish({
      type: 'tool_call_start',
      callId: 'c1',
      name: 'bash',
      args: { command: 'echo hi' },
      target: 'host',
    });
    bus.publish({
      type: 'tool_call_result',
      callId: 'c1',
      result: { stdout: 'hi' },
      durationMs: 5,
    });
    await flush();
    expect(r.fired).toEqual([
      {
        event: 'PostToolUse',
        tool_name: 'bash',
        tool_input: { command: 'echo hi' },
        tool_result: { stdout: 'hi' },
      },
    ]);
  });

  it('emits PostToolUse error path on tool_call_error', async () => {
    const bus = new EventBus(sid);
    const r = recorder();
    bridgeHooksToBus(bus, r);
    bus.publish({
      type: 'tool_call_start',
      callId: 'c2',
      name: 'edit',
      args: { path: '/a' },
      target: 'host',
    });
    bus.publish({ type: 'tool_call_error', callId: 'c2', error: 'boom' });
    await flush();
    expect(r.fired).toEqual([
      {
        event: 'PostToolUse',
        tool_name: 'edit',
        tool_input: { path: '/a' },
        tool_error: 'boom',
      },
    ]);
  });

  it('translates run_finished → Stop', async () => {
    const bus = new EventBus(sid);
    const r = recorder();
    bridgeHooksToBus(bus, r);
    bus.publish({ type: 'run_finished', reason: 'stop' });
    await flush();
    expect(r.fired).toEqual([{ event: 'Stop', reason: 'stop' }]);
  });

  it('does not fire for events with no hook mapping', async () => {
    const bus = new EventBus(sid);
    const r = recorder();
    bridgeHooksToBus(bus, r);
    bus.publish({ type: 'session_started', sessionId: sid });
    bus.publish({ type: 'assistant_text_done', text: 'hi' });
    bus.publish({ type: 'step_finished', stepNumber: 1, finishReason: 'stop' });
    await flush();
    expect(r.fired).toEqual([]);
  });

  it('falls back to "unknown" tool_name when tool_call_start was missed', async () => {
    const bus = new EventBus(sid);
    const r = recorder();
    bridgeHooksToBus(bus, r);
    bus.publish({
      type: 'tool_call_result',
      callId: 'orphan',
      result: 'x',
      durationMs: 1,
    });
    await flush();
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0]).toMatchObject({ event: 'PostToolUse', tool_name: 'unknown' });
  });
});
