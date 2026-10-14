import type { AgentEvent, RunFinishedReason } from '@chimera/core';

export interface RunMetrics {
  /** `none`: the run ended (or was killed) before it reported a reason. */
  finishReason: RunFinishedReason | 'none';
  error?: string;
  steps: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  toolErrors: number;
  /** Tool calls with the same name and arguments as the call before them. */
  repeatedCalls: number;
  /** Assistant messages that hold a tool call printed as text. */
  textToolCalls: number;
  subagents: number;
  compactions: number;
  inputTokens: number;
  outputTokens: number;
  /** Input tokens of the first step: the system prompt, the tool schemas and the user message. */
  promptFloorTokens: number;
  peakContextTokens: number;
  finalText: string;
}

// The shapes small models fall back to when they miss the tool-calling
// channel: Hermes/Qwen tags, Llama function tags, and a bare JSON call.
const TEXT_TOOL_CALL =
  /<tool_call>|<\|tool_call|<function=|\{\s*"name"\s*:\s*"\w+"\s*,\s*"(arguments|parameters)"\s*:/;

export function summarizeRun(events: AgentEvent[]): RunMetrics {
  const metrics: RunMetrics = {
    finishReason: 'none',
    steps: 0,
    toolCalls: 0,
    toolCallsByName: {},
    toolErrors: 0,
    repeatedCalls: 0,
    textToolCalls: 0,
    subagents: 0,
    compactions: 0,
    inputTokens: 0,
    outputTokens: 0,
    promptFloorTokens: 0,
    peakContextTokens: 0,
    finalText: '',
  };
  let previousCall: string | undefined;
  let sawUsage = false;

  for (const event of events) {
    switch (event.type) {
      case 'tool_call_start': {
        metrics.toolCalls += 1;
        metrics.toolCallsByName[event.name] = (metrics.toolCallsByName[event.name] ?? 0) + 1;
        const call = `${event.name} ${JSON.stringify(event.args)}`;
        if (call === previousCall) metrics.repeatedCalls += 1;
        previousCall = call;
        break;
      }
      case 'tool_call_error':
        metrics.toolErrors += 1;
        break;
      case 'assistant_text_done':
        if (TEXT_TOOL_CALL.test(event.text)) metrics.textToolCalls += 1;
        metrics.finalText = event.text;
        break;
      case 'step_finished':
        metrics.steps += 1;
        break;
      case 'subagent_spawned':
        metrics.subagents += 1;
        break;
      case 'compaction_finished':
        metrics.compactions += 1;
        break;
      case 'usage_updated':
        metrics.inputTokens = event.usage.inputTokens;
        metrics.outputTokens = event.usage.outputTokens;
        if (!sawUsage) {
          metrics.promptFloorTokens = event.usage.lastStep?.inputTokens ?? event.usage.inputTokens;
          sawUsage = true;
        }
        metrics.peakContextTokens = Math.max(metrics.peakContextTokens, event.usedContextTokens);
        break;
      case 'run_finished':
        metrics.finishReason = event.reason;
        if (event.error !== undefined) metrics.error = event.error;
        break;
    }
  }
  return metrics;
}
