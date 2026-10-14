import type { AgentEvent } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { summarizeRun } from '../src/metrics';

function toolCall(callId: string, name: string, args: unknown): AgentEvent {
  return { type: 'tool_call_start', callId, name, args, target: 'host' } as AgentEvent;
}

function usage(inputTokens: number, outputTokens: number, lastStepInput: number): AgentEvent {
  return {
    type: 'usage_updated',
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      totalTokens: inputTokens + outputTokens,
      stepCount: 1,
      lastStep: {
        inputTokens: lastStepInput,
        outputTokens,
        cachedInputTokens: 0,
        totalTokens: lastStepInput + outputTokens,
      },
    },
    contextWindow: 32_768,
    usedContextTokens: lastStepInput,
    unknownWindow: false,
  };
}

describe('summarizeRun', () => {
  it('reports how a clean run went', () => {
    const metrics = summarizeRun([
      toolCall('call-1', 'read', { path: 'a.js' }),
      { type: 'tool_call_result', callId: 'call-1' as never, result: {}, durationMs: 3 },
      usage(9_000, 40, 9_000),
      { type: 'step_finished', stepNumber: 1, finishReason: 'tool-calls' },
      toolCall('call-2', 'edit', { path: 'a.js' }),
      { type: 'tool_call_result', callId: 'call-2' as never, result: {}, durationMs: 4 },
      usage(18_400, 90, 9_400),
      { type: 'step_finished', stepNumber: 2, finishReason: 'tool-calls' },
      { type: 'assistant_text_done', text: 'Changed the greeting.' },
      usage(28_000, 110, 9_600),
      { type: 'step_finished', stepNumber: 3, finishReason: 'stop' },
      { type: 'run_finished', reason: 'stop' },
    ]);

    expect(metrics).toMatchObject({
      finishReason: 'stop',
      steps: 3,
      toolCalls: 2,
      toolCallsByName: { read: 1, edit: 1 },
      toolErrors: 0,
      repeatedCalls: 0,
      textToolCalls: 0,
      inputTokens: 28_000,
      outputTokens: 110,
      promptFloorTokens: 9_000,
      peakContextTokens: 9_600,
      finalText: 'Changed the greeting.',
    });
  });

  it('counts failed tool calls and the calls that repeat the one before', () => {
    const metrics = summarizeRun([
      toolCall('call-1', 'edit', { path: 'a.js', old_string: 'x' }),
      { type: 'tool_call_error', callId: 'call-1' as never, error: 'old_string not found' },
      toolCall('call-2', 'edit', { path: 'a.js', old_string: 'x' }),
      { type: 'tool_call_error', callId: 'call-2' as never, error: 'old_string not found' },
      toolCall('call-3', 'read', { path: 'a.js' }),
      toolCall('call-4', 'edit', { path: 'a.js', old_string: 'x' }),
      { type: 'run_finished', reason: 'max_steps' },
    ]);

    expect(metrics.toolErrors).toBe(2);
    expect(metrics.repeatedCalls).toBe(1);
    expect(metrics.finishReason).toBe('max_steps');
  });

  it('notices a tool call that the model printed as text', () => {
    const metrics = summarizeRun([
      {
        type: 'assistant_text_done',
        text: '<tool_call>\n{"name": "read", "arguments": {"path": "a.js"}}\n</tool_call>',
      },
      { type: 'assistant_text_done', text: 'I will read the file next.' },
      { type: 'run_finished', reason: 'stop' },
    ]);

    expect(metrics.textToolCalls).toBe(1);
  });

  it('has no finish reason when the run never reported one', () => {
    expect(summarizeRun([]).finishReason).toBe('none');
  });

  it('keeps the error of a failed run', () => {
    const metrics = summarizeRun([{ type: 'run_finished', reason: 'error', error: 'HTTP 400' }]);

    expect(metrics.error).toBe('HTTP 400');
  });
});
