import type { AgentEvent, Usage } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scrollback } from '../src/scrollback';

function usage(inputTokens: number, outputTokens: number, cachedInputTokens: number): Usage {
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens: inputTokens + outputTokens,
    stepCount: 0,
  };
}

function usageEvent(value: Usage): AgentEvent {
  return {
    type: 'usage_updated',
    usage: value,
    contextWindow: 200_000,
    usedContextTokens: value.inputTokens,
    unknownWindow: false,
  };
}

function toolCall(callId: string, durationMs: number): AgentEvent[] {
  return [
    { type: 'tool_call_start', callId: callId as never, name: 'bash', args: {}, target: 'host' },
    { type: 'tool_call_result', callId: callId as never, result: { exit_code: 0 }, durationMs },
  ];
}

describe('turn summary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a run with its duration, steps, tool calls and tokens', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'user_message', content: 'fix it' });
    for (const event of [...toolCall('a', 10), ...toolCall('b', 10)]) scrollback.apply(event);
    scrollback.apply({ type: 'step_finished', stepNumber: 1, finishReason: 'tool-calls' });
    scrollback.apply({ type: 'step_finished', stepNumber: 2, finishReason: 'stop' });
    scrollback.apply(usageEvent(usage(210_000, 4_200, 168_000)));
    vi.advanceTimersByTime(72_000);
    scrollback.apply({ type: 'run_finished', reason: 'stop' });

    const last = scrollback.all().at(-1)!;
    expect(last.kind).toBe('turn');
    expect(last.text).toBe('1m 12s · 2 steps · 2 tool calls · ↑ 210k ↓ 4.2k tokens · cache 80%');
  });

  it('counts only the tokens of this run', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'user_message', content: 'first' });
    scrollback.apply({ type: 'step_finished', stepNumber: 1, finishReason: 'stop' });
    scrollback.apply(usageEvent(usage(10_000, 500, 0)));
    scrollback.apply({ type: 'run_finished', reason: 'stop' });

    scrollback.apply({ type: 'user_message', content: 'second' });
    scrollback.apply({ type: 'step_finished', stepNumber: 1, finishReason: 'stop' });
    scrollback.apply(usageEvent(usage(25_000, 800, 12_000)));
    vi.advanceTimersByTime(3_000);
    scrollback.apply({ type: 'run_finished', reason: 'stop' });

    expect(scrollback.all().at(-1)!.text).toBe('3s · 1 step · ↑ 15k ↓ 300 tokens · cache 80%');
  });

  it('adds no summary for a run that never reached the model', () => {
    const scrollback = new Scrollback();
    scrollback.apply({ type: 'user_message', content: 'hi' });
    scrollback.apply({ type: 'run_finished', reason: 'error', error: 'invalid api key' });

    expect(scrollback.all().some((entry) => entry.kind === 'turn')).toBe(false);
  });

  it('records how long a tool call took', () => {
    const scrollback = new Scrollback();
    for (const event of toolCall('slow', 8_200)) scrollback.apply(event);

    expect(scrollback.all()[0]).toMatchObject({ kind: 'tool', durationMs: 8_200 });
  });
});
