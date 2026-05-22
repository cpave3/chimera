import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateText } from 'ai';
import type { FileOps, Session } from '@chimera/core';
import type { LanguageModel, ModelMessage } from 'ai';
import { estimateTokens } from './token-estimate';
import { buildCompactionPrompt, formatFilesBlock } from './prompt';
import type { CompactionConfig, CompactionLogEntry } from './types';

export interface CompactorOptions {
  config: CompactionConfig;
  contextWindow: number;
  /**
   * Resolve a model reference string like `'providerId/modelId'` into a
   * `LanguageModel`. Injected so tests can stub the LLM. An optional
   * `sessionId` is forwarded to the provider so request-scoped headers
   * (e.g. `x-session-id`) can be interpolated.
   */
  resolveModel(modelRef: string, sessionId?: string): Promise<LanguageModel>;
  /** Home directory for log writes. Defaults to `homedir()`. */
  home?: string;
}

export class Compactor {
  private opts: CompactorOptions;

  constructor(opts: CompactorOptions) {
    this.opts = opts;
  }

  /**
   * If compaction is enabled and the session's messages are estimated to exceed
   * `contextWindow - reserveTokens`, runs a compaction pass and mutates the
   * session in-place. Returns `{ ran: true, ... }` with the compaction result
   * when compaction ran, or `{ ran: false }` otherwise.
   */
  async maybeCompact(
    session: Session,
  ): Promise<
    | { ran: false }
    | { ran: true; summary: string; tokensBefore: number; tokensAfter: number; messagesReplaced: number }
  > {
    if (!this.opts.config.enabled) return { ran: false };
    const threshold = this.opts.contextWindow - this.opts.config.reserveTokens;
    const estimated = estimateTokens(session.messages);
    if (estimated > threshold) {
      const result = await this.compact(session, 'threshold');
      return { ran: true, ...result };
    }
    return { ran: false };
  }

  /**
   * Force a compaction regardless of token threshold. Mutates
   * `session.messages` in place.
   */
  async compact(
    session: Session,
    reason: 'threshold' | 'manual',
  ): Promise<{ summary: string; tokensBefore: number; tokensAfter: number; messagesReplaced: number }> {
    const tokensBefore = estimateTokens(session.messages);

    const adjusted = computeBoundary(session.messages, this.opts.config.keepRecentTokens);
    const keepStart = adjusted.keepStart;
    const toSummarize = keepStart === 0 ? [] : session.messages.slice(0, keepStart);
    const tailMessages = keepStart === session.messages.length ? [] : session.messages.slice(keepStart);

    let summaryText: string;
    if (toSummarize.length === 0) {
      // Nothing to replace; previous summary if any can be preserved.
      // Build a fresh summary with just the current file context.
      summaryText = buildFallbackSummary('', session.fileOps);
    } else {
      const modelRef = this.resolveModelRef(session);
      const model = await this.opts.resolveModel(modelRef, session.id);
      const previousSummary = this.extractPreviousSummary(session.messages);
      const prompt = buildCompactionPrompt({
        toSummarize,
        previousSummaryContent: previousSummary ?? undefined,
        fileOps: session.fileOps,
      });
      const result = await generateText({
        model,
        messages: [{ role: 'user', content: prompt }],
      });
      summaryText = this.ensureFilesBlock(result.text, session.fileOps);
    }

    const summaryMessage: ModelMessage = { role: 'assistant', content: summaryText };
    const newMessages =
      toSummarize.length === 0
        ? [...tailMessages]
        : [summaryMessage, ...tailMessages];

    const tokensAfter = estimateTokens(newMessages);
    const messagesReplaced = keepStart;

    // Mutate the session in place
    session.messages.splice(0, session.messages.length, ...newMessages);

    await this.appendLog(session.id, {
      ts: Date.now(),
      reason,
      tokensBefore,
      tokensAfter,
      summary: summaryText,
      messagesReplaced: {
        count: messagesReplaced,
        firstIndex: 0,
        lastIndex: messagesReplaced === 0 ? 0 : messagesReplaced - 1,
      },
    });

    return { summary: summaryText, tokensBefore, tokensAfter, messagesReplaced };
  }

  private resolveModelRef(session: Session): string {
    if (this.opts.config.model) {
      return this.opts.config.model;
    }
    return `${session.model.providerId}/${session.model.modelId}`;
  }

  /**
   * Look for an existing compaction summary message at the front of the
   * messages array; if one exists, return its text.
   */
  private extractPreviousSummary(messages: ModelMessage[]): string | undefined {
    if (messages.length === 0) return undefined;
    const first = messages[0];
    if (first.role === 'assistant' && typeof first.content === 'string') {
      // Heuristic: if the first message has our section headers, treat it as a
      // previous summary.
      if (first.content.includes('## Goal') && first.content.includes('<files>')) {
        return first.content;
      }
    }
    return undefined;
  }

  /**
   * Ensure the summary text ends with a correct `<files>` XML block derived
   * from the session's file ops. If the model already produced one, replace it
   * with the authoritative block.
   */
  private ensureFilesBlock(text: string, fileOps: FileOps): string {
    const idx = text.indexOf('<files>');
    if (idx >= 0) {
      // Strip everything from <files> onward and append our canonical block.
      return text.slice(0, idx).trimEnd() + '\n' + formatFilesBlock(fileOps);
    }
    return text.trimEnd() + '\n\n' + formatFilesBlock(fileOps);
  }

  private async appendLog(sessionId: string, entry: CompactionLogEntry): Promise<void> {
    const home = this.opts.home ?? homedir();
    const path = join(home, '.chimera', 'sessions', sessionId + '.compactions.jsonl');
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
  }
}

interface BoundaryResult {
  keepStart: number;
}

/** Compute the largest trailing slice that fits within keepRecentTokens,
 *  extending backward if necessary to preserve tool-call/tool-result pairs. */
export function computeBoundary(messages: ModelMessage[], keepRecentTokens: number): BoundaryResult {
  let tokenSum = 0;
  let keepCount = 0;

  // Walk from the end, accumulating token counts until we hit the budget.
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens([messages[i]]);
    if (tokenSum + tokens > keepRecentTokens) break;
    tokenSum += tokens;
    keepCount++;
  }

  const keepStart = messages.length - keepCount;
  const adjustedStart = adjustBoundaryForToolPairs(messages, keepStart);
  return { keepStart: adjustedStart };
}

/**
 * If the boundary at `keepStart` would split an assistant tool-call and its
 * matching tool-result(s), extend backward to include the full pair.
 * Returns the adjusted start index.
 */
function adjustBoundaryForToolPairs(messages: ModelMessage[], keepStart: number): number {
  // Map toolCallId -> index of its assistant message
  const callIdToAssistantIdx = new Map<string, number>();
  // Map toolCallId -> index of its tool-result message
  const callIdToResultIdx = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && typeof msg.content !== 'string') {
      for (const part of msg.content) {
        if (part.type === 'tool-call') {
          callIdToAssistantIdx.set(part.toolCallId, i);
        }
      }
    }
    if (msg.role === 'tool' && typeof msg.content !== 'string') {
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          callIdToResultIdx.set(part.toolCallId, i);
        }
      }
    }
  }

  let adjusted = keepStart;

  // For every tool-result in the tail, ensure its assistant is also in the tail.
  for (let i = keepStart; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && typeof msg.content !== 'string') {
      for (const part of msg.content) {
        if (part.type === 'tool-result') {
          const assistantIdx = callIdToAssistantIdx.get(part.toolCallId);
          if (assistantIdx !== undefined && assistantIdx < adjusted) {
            adjusted = assistantIdx;
          }
        }
      }
    }
  }

  return adjusted;
}

function buildFallbackSummary(_previousText: string, fileOps: FileOps): string {
  const lines: string[] = [
    '## Goal',
    '',
    '## Constraints',
    '',
    '## Progress',
    '### Done',
    '### In Progress',
    '### Blocked',
    '## Key Decisions',
    '',
    '## Next Steps',
    '',
    '## Critical Context',
    '',
  ];
  lines.push(formatFilesBlock(fileOps));
  return lines.join('\n');
}
