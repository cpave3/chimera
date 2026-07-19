import type { ModelMessage } from 'ai';
import { estimateTokens } from './context-tracker';
import type { CompactionConfig } from './types';

const STUB_MARKER = '[Result archived — retrieve with: recall(';
const SUMMARY_MARKERS = ['## Goal', '<files>'] as const;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const GROWTH_MARGIN_TOKENS = 4_096;

export interface ContextBreakdown {
  contextWindow: number;
  /** Provider-reported input tokens of the last prompt; null before any step. */
  lastPromptTokens: number | null;
  /** char/4 estimate of system prompt + all messages. */
  estimatedTotalTokens: number;
  /** Effective compaction trigger in tokens, or null when compaction is off. */
  triggerTokens: number | null;
  systemPromptTokens: number;
  messageCount: number;
  /** Estimate of the leading compaction-summary message, when present. */
  summaryTokens: number;
  userTokens: number;
  assistantTokens: number;
  toolTokens: number;
  /** Tool results already replaced by recall stubs. */
  archivedStubCount: number;
}

export interface ContextBreakdownInput {
  messages: ModelMessage[];
  systemPrompt: string;
  lastPromptTokens: number | null;
  contextWindow: number;
  compaction?: CompactionConfig;
  maxOutputTokens?: number;
  /** Long edge images are scaled to before pricing; see EstimateOptions. */
  imageLongEdge?: number;
}

/**
 * Per-category char/4 accounting of the session context, surfaced via the
 * `/context` TUI command. Estimates are labeled as such next to the
 * provider's actual last-prompt figure — tool schemas and provider framing
 * are not estimated, which is the bulk of any estimate-vs-actual gap.
 */
export function computeContextBreakdown(input: ContextBreakdownInput): ContextBreakdown {
  const systemPromptTokens =
    input.systemPrompt.length === 0 ? 0 : Math.ceil(input.systemPrompt.length / 4);

  let summaryTokens = 0;
  let userTokens = 0;
  let assistantTokens = 0;
  let toolTokens = 0;
  let archivedStubCount = 0;

  for (let i = 0; i < input.messages.length; i++) {
    const message = input.messages[i]!;
    const tokens = estimateTokens([message], { imageLongEdge: input.imageLongEdge });
    if (i === 0 && isCompactionSummary(message)) {
      summaryTokens += tokens;
      continue;
    }
    if (message.role === 'user') {
      userTokens += tokens;
    } else if (message.role === 'assistant') {
      assistantTokens += tokens;
    } else if (message.role === 'tool') {
      toolTokens += tokens;
      archivedStubCount += countStubs(message);
    }
  }

  let triggerTokens: number | null = null;
  if (input.compaction?.enabled) {
    const reserve = Math.min(
      Math.max(
        input.compaction.reserveTokens,
        (input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) + GROWTH_MARGIN_TOKENS,
      ),
      input.contextWindow / 2,
    );
    triggerTokens = Math.floor(
      Math.min(
        (input.contextWindow * (input.compaction.thresholdPercent ?? 85)) / 100,
        input.contextWindow - reserve,
      ),
    );
  }

  return {
    contextWindow: input.contextWindow,
    lastPromptTokens: input.lastPromptTokens,
    estimatedTotalTokens:
      systemPromptTokens + summaryTokens + userTokens + assistantTokens + toolTokens,
    triggerTokens,
    systemPromptTokens,
    messageCount: input.messages.length,
    summaryTokens,
    userTokens,
    assistantTokens,
    toolTokens,
    archivedStubCount,
  };
}

function isCompactionSummary(message: ModelMessage): boolean {
  return (
    message.role === 'assistant' &&
    typeof message.content === 'string' &&
    SUMMARY_MARKERS.every((marker) => (message.content as string).includes(marker))
  );
}

function countStubs(message: ModelMessage): number {
  if (typeof message.content === 'string') return 0;
  let count = 0;
  for (const part of message.content as Array<Record<string, unknown>>) {
    if (part.type !== 'tool-result') continue;
    const output = part.output;
    const text =
      typeof output === 'string'
        ? output
        : output && typeof output === 'object' && 'value' in output
          ? String((output as { value: unknown }).value)
          : '';
    if (text.startsWith(STUB_MARKER)) count += 1;
  }
  return count;
}
