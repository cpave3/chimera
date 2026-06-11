import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { computeContextBreakdown } from '../src/context-breakdown';
import { estimateTokens } from '../src/context-tracker';

describe('computeContextBreakdown', () => {
  const messages: ModelMessage[] = [
    {
      role: 'assistant',
      content: '## Goal\nship it\n## Constraints\n<files>\n</files>',
    },
    { role: 'user', content: 'please do the thing' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'working on it' }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'bash',
          output: { type: 'text', value: 'normal output' },
        },
      ],
    } as ModelMessage,
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c2',
          toolName: 'read',
          output: {
            type: 'text',
            value: '[Result archived — retrieve with: recall({ id: "pr_abcd1234" })] — read output',
          },
        },
      ],
    } as ModelMessage,
  ];

  it('breaks the conversation down by kind with a summary row and stub count', () => {
    const breakdown = computeContextBreakdown({
      messages,
      systemPrompt: 'You are chimera.\n# Current tasks\n- [pending] x',
      lastPromptTokens: 12_345,
      contextWindow: 100_000,
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, thresholdPercent: 85 },
    });

    expect(breakdown.contextWindow).toBe(100_000);
    expect(breakdown.lastPromptTokens).toBe(12_345);
    expect(breakdown.systemPromptTokens).toBeGreaterThan(0);
    expect(breakdown.summaryTokens).toBe(estimateTokens([messages[0]!]));
    expect(breakdown.userTokens).toBe(estimateTokens([messages[1]!]));
    expect(breakdown.assistantTokens).toBe(estimateTokens([messages[2]!]));
    expect(breakdown.toolTokens).toBe(estimateTokens([messages[3]!, messages[4]!]));
    expect(breakdown.archivedStubCount).toBe(1);
    expect(breakdown.messageCount).toBe(5);
    expect(breakdown.estimatedTotalTokens).toBe(
      breakdown.systemPromptTokens +
        breakdown.summaryTokens +
        breakdown.userTokens +
        breakdown.assistantTokens +
        breakdown.toolTokens,
    );
    // Trigger for 100k @ 85% with 16384 reserve: min(85000, 83616) = 83616.
    expect(breakdown.triggerTokens).toBe(83_616);
  });

  it('reports a null trigger when compaction is disabled', () => {
    const breakdown = computeContextBreakdown({
      messages: [],
      systemPrompt: '',
      lastPromptTokens: null,
      contextWindow: 100_000,
      compaction: undefined,
    });
    expect(breakdown.triggerTokens).toBeNull();
    expect(breakdown.lastPromptTokens).toBeNull();
    expect(breakdown.estimatedTotalTokens).toBe(0);
  });
});
