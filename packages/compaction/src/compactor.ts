import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CompactionRequest, FileOps, Session } from '@chimera/core';
import type { LanguageModel, ModelMessage } from 'ai';
import { generateText } from 'ai';
import {
  boundText,
  buildCompactionPrompt,
  formatArchivedBlock,
  formatFilesBlock,
  formatTasksBlock,
} from './prompt';
import { type EstimateOptions, estimateTokens } from './token-estimate';
import type {
  ArchivedRef,
  CompactionConfig,
  CompactionLogEntry,
  CompactionStrategy,
  MessagePruner,
} from './types';

export interface CompactorOptions {
  config: CompactionConfig;
  contextWindow: number;
  /**
   * Default image scale for direct callers. Agent compactions pass the active
   * model's scale and window in the request, including after model switches.
   */
  imageLongEdge?: number;
  /**
   * Resolve a model reference string like `'providerId/modelId'` into a
   * `LanguageModel`. Injected so tests can stub the LLM. An optional
   * `sessionId` is forwarded to the provider so request-scoped headers
   * (e.g. `x-session-id`) can be interpolated.
   */
  resolveModel(modelRef: string, sessionId?: string): Promise<LanguageModel>;
  resolveCallOptions?(
    modelRef: string,
    session: Session,
  ): Promise<
    Pick<
      Parameters<typeof generateText>[0],
      'providerOptions' | 'temperature' | 'topP' | 'maxOutputTokens'
    >
  >;
  /** Home directory for log writes. Defaults to `homedir()`. */
  home?: string;
  requestTimeoutMs?: number;
  fallbackModel?: string;
  resolveContextWindow?(modelRef: string): number | Promise<number>;
  /**
   * Optional phase-1 pruner factory (recall archival), invoked per compaction
   * with the session id since archive stores are per-session. When
   * threshold-triggered pruning alone brings the estimate back under the
   * window budget, the LLM summarization phase is skipped entirely.
   */
  createPruner?(sessionId: string): MessagePruner;
}

export interface CompactResult {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesReplaced: number;
  strategy: CompactionStrategy;
  prunedCount: number;
  prunedTokensSaved: number;
  warnings?: string[];
}

export class Compactor {
  private opts: CompactorOptions;

  constructor(opts: CompactorOptions) {
    this.opts = opts;
  }

  private estimateOptions(): EstimateOptions {
    return { imageLongEdge: this.opts.imageLongEdge };
  }

  /**
   * If compaction is enabled and the session's messages are estimated to exceed
   * `contextWindow - reserveTokens`, runs a compaction pass and mutates the
   * session in-place. Returns `{ ran: true, ... }` with the compaction result
   * when compaction ran, or `{ ran: false }` otherwise.
   */
  async maybeCompact(session: Session): Promise<{ ran: false } | ({ ran: true } & CompactResult)> {
    if (!this.opts.config.enabled) return { ran: false };
    const threshold = this.opts.contextWindow - this.opts.config.reserveTokens;
    const estimated = estimateTokens(session.messages, this.estimateOptions());
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
    request?: CompactionRequest,
  ): Promise<CompactResult> {
    const messages = session.messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((part) => ({ ...part }))
        : message.content,
    })) as ModelMessage[];
    const estimateOptions = { imageLongEdge: request?.imageLongEdge ?? this.opts.imageLongEdge };
    const contextWindow = request?.contextWindow ?? this.opts.contextWindow;
    const budget =
      request?.targetTokens ??
      contextWindow - Math.min(this.opts.config.reserveTokens, contextWindow / 2);
    const tokensBefore = estimateTokens(messages, estimateOptions);
    const warnings: string[] = [];

    const adjusted = computeBoundary(messages, this.opts.config.keepRecentTokens, estimateOptions);
    const keepStart = adjusted.keepStart;

    // Phase 1: prune. Rewrites head messages in place (large tool outputs →
    // recall stubs); cheap, lossless via the recall store, and preserves the
    // conversation skeleton. For threshold compactions that get back under
    // budget this is the whole job — no LLM call, no summary message.
    let prunedCount = 0;
    let prunedTokensSaved = 0;
    let freshArchivedRefs: ArchivedRef[] = [];
    if (keepStart > 0 && this.opts.createPruner) {
      try {
        const pruner = this.opts.createPruner(session.id);
        const prunedMessages = messages.map((message) => ({
          ...message,
          content: Array.isArray(message.content)
            ? message.content.map((part) => ({ ...part }))
            : message.content,
        })) as ModelMessage[];
        const pruneResult = await withDeadline(
          () => pruner.prune(prunedMessages, keepStart),
          this.opts.requestTimeoutMs ?? 30_000,
          request?.abortSignal,
        );
        request?.abortSignal?.throwIfAborted();
        messages.splice(0, messages.length, ...prunedMessages);
        prunedCount = pruneResult.archivedCount;
        prunedTokensSaved = pruneResult.tokensSaved;
        freshArchivedRefs = pruneResult.archived;
      } catch (error) {
        request?.abortSignal?.throwIfAborted();
        warnings.push(
          `Recall archival failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (reason === 'threshold' && prunedCount > 0) {
      const afterPrune = estimateTokens(messages, estimateOptions);
      if (afterPrune <= budget) {
        const result: CompactResult = {
          summary: '',
          tokensBefore,
          tokensAfter: afterPrune,
          messagesReplaced: 0,
          strategy: 'prune',
          prunedCount,
          prunedTokensSaved,
          warnings,
        };
        await this.appendLog(session.id, {
          ts: Date.now(),
          reason,
          tokensBefore,
          tokensAfter: afterPrune,
          summary: '',
          messagesReplaced: { count: 0, firstIndex: 0, lastIndex: 0 },
          strategy: 'prune',
          prunedCount,
          prunedTokensSaved,
          warnings,
        });
        request?.abortSignal?.throwIfAborted();
        session.messages.splice(0, session.messages.length, ...messages);
        return result;
      }
    }

    // Phase 2: summarize the (post-prune) head. Stubs in the head would lose
    // their pr_ ids inside prose, so an authoritative <archived> block is
    // appended to the summary alongside <files>.
    const strategy: CompactionStrategy = prunedCount > 0 ? 'prune+summarize' : 'summarize';
    const toSummarize = keepStart === 0 ? [] : messages.slice(0, keepStart);
    const tailMessages = keepStart === messages.length ? [] : messages.slice(keepStart);
    // Carried-forward refs (stubs from earlier passes, previous summary's
    // <archived> block) plus the refs archived by this pass's prune.
    const archivedById = new Map(collectArchivedRefs(toSummarize).map((ref) => [ref.id, ref]));
    for (const ref of freshArchivedRefs) archivedById.set(ref.id, ref);
    const archivedRefs = [...archivedById.values()].slice(-MAX_ARCHIVED_REFS);

    let summaryText: string;
    if (toSummarize.length === 0) {
      // Nothing to replace; previous summary if any can be preserved.
      // Build a fresh summary with just the current file context.
      summaryText = buildFallbackSummary('', session.fileOps);
    } else {
      const modelRef = this.resolveModelRef(session);
      const previousSummary = this.extractPreviousSummary(messages);
      const prompt = buildCompactionPrompt({
        toSummarize,
        previousSummaryContent: previousSummary ?? undefined,
        fileOps: session.fileOps,
      });
      let text: string | undefined;
      const modelRefs = [
        ...new Set([modelRef, this.opts.fallbackModel].filter((ref): ref is string => !!ref)),
      ];
      for (const ref of modelRefs) {
        try {
          let attempt = 0;
          const generate = () =>
            withDeadline(
              async (abortSignal) => {
                attempt++;
                const model = await this.opts.resolveModel(ref, session.id);
                const callOptions = await this.opts.resolveCallOptions?.(ref, session);
                const summaryWindow =
                  (await this.opts.resolveContextWindow?.(ref)) ?? contextWindow;
                const maxOutputTokens = Math.max(
                  1,
                  Math.min(
                    callOptions?.maxOutputTokens ?? 2_048,
                    2_048,
                    Math.floor(summaryWindow / 4),
                  ),
                );
                const fits =
                  estimateTokens([{ role: 'user', content: prompt }]) + maxOutputTokens + 256 <=
                  summaryWindow;
                const boundedPrompt =
                  attempt === 1 && fits ? prompt : boundText(prompt, Math.floor(summaryWindow / 2));
                const truncationWarning =
                  'Summary input was truncated for context recovery; original history is in the compaction log';
                if (boundedPrompt !== prompt && !warnings.includes(truncationWarning))
                  warnings.push(truncationWarning);
                const result = await generateText({
                  ...callOptions,
                  model,
                  messages: [{ role: 'user', content: boundedPrompt }],
                  maxOutputTokens,
                  maxRetries: 0,
                  abortSignal,
                });
                if (!result.text.trim()) throw new Error('Model returned an empty summary');
                return result;
              },
              this.opts.requestTimeoutMs ?? 30_000,
              request?.abortSignal,
            );
          const result = await generate().catch(async (error) => {
            request?.abortSignal?.throwIfAborted();
            warnings.push(
              `Retrying compaction model ${ref} after 250ms: ${error instanceof Error ? error.message : String(error)}`,
            );
            await delay(250, undefined, { signal: request?.abortSignal });
            return generate();
          });
          text = result.text;
          if (ref !== modelRef) warnings.push(`Used fallback compaction model ${ref}`);
          break;
        } catch (error) {
          request?.abortSignal?.throwIfAborted();
          warnings.push(
            `Summary unavailable (${ref}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (text === undefined) {
        warnings.push('Used lossy context recovery because no summary model succeeded');
        text = `## Goal\nRecovery excerpt (not a model summary):\n${boundText(
          JSON.stringify(toSummarize),
          Math.floor(contextWindow / 4),
        )}`;
      }
      summaryText = this.ensureFilesBlock(text.replace(STALE_TASKS_BLOCK, ''), session.fileOps);
      if (archivedRefs.length > 0) {
        summaryText = `${summaryText}\n${formatArchivedBlock(archivedRefs)}`;
      }
      // A task_list call still in the tail is newer context than this summary
      // sits at; restating the list ahead of it would read as an older state.
      if (session.tasks.length > 0 && !hasTaskListCall(tailMessages)) {
        summaryText = `${summaryText}\n${formatTasksBlock(session.tasks)}`;
      }
    }

    const summaryMessage: ModelMessage = { role: 'assistant', content: summaryText };
    let newMessages =
      toSummarize.length === 0 ? [...tailMessages] : [summaryMessage, ...tailMessages];
    const latestUser = messages
      .slice()
      .reverse()
      .find((message) => message.role === 'user');
    if (latestUser && toSummarize.includes(latestUser)) {
      warnings.push('Latest user input was truncated for context recovery');
      newMessages.push({
        role: 'user',
        content: boundText(
          typeof latestUser.content === 'string'
            ? latestUser.content
            : JSON.stringify(latestUser.content),
          Math.floor(budget / 4),
        ),
      });
    }

    let tokensAfter = estimateTokens(newMessages, estimateOptions);
    let messagesReplaced = keepStart;
    if (tokensAfter > budget) {
      warnings.push(
        'Used lossy context recovery because the summary or kept tail exceeded the budget',
      );
      summaryText = `## Goal\nRecovery excerpt (not a model summary):\n${boundText(
        JSON.stringify(messages),
        Math.floor(budget),
      )}`;
      newMessages = [{ role: 'assistant', content: summaryText }];
      if (latestUser) {
        newMessages.push({
          role: 'user',
          content: boundText(
            typeof latestUser.content === 'string'
              ? latestUser.content
              : JSON.stringify(latestUser.content),
            Math.floor(budget / 4),
          ),
        });
      }
      tokensAfter = estimateTokens(newMessages, estimateOptions);
      messagesReplaced = messages.length;
    }

    // Mutate the session in place
    request?.abortSignal?.throwIfAborted();
    const recoveryMessages = warnings.length > 0 ? [...session.messages] : undefined;
    session.messages.splice(0, session.messages.length, ...newMessages);

    await this.appendLog(session.id, {
      ts: Date.now(),
      reason,
      tokensBefore,
      tokensAfter,
      summary: summaryText,
      recoveryMessages,
      messagesReplaced: {
        count: messagesReplaced,
        firstIndex: 0,
        lastIndex: messagesReplaced === 0 ? 0 : messagesReplaced - 1,
      },
      strategy,
      prunedCount,
      prunedTokensSaved,
      warnings,
    });

    return {
      summary: summaryText,
      tokensBefore,
      tokensAfter,
      messagesReplaced,
      strategy,
      prunedCount,
      prunedTokensSaved,
      warnings,
    };
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
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
    } catch (error) {
      entry.warnings.push(
        `Could not write compaction log ${path}: ${error instanceof Error ? error.message : String(error)}. Check disk space and permissions.`,
      );
    }
  }
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  signal.throwIfAborted();
  let timer!: ReturnType<typeof setTimeout>;
  let onAbort!: () => void;
  const expired = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort(new Error(`Compaction request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(signal), expired]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

const STUB_PATTERN =
  /\[Result archived — retrieve with: recall\(\{ id: "(pr_[0-9a-f]{8,12})" \}\)\](?: — (\S+) output)?/;
const ARCHIVED_ENTRY_PATTERN = /<entry id="(pr_[0-9a-f]{8,12})" tool="([^"]*)">([^<]*)<\/entry>/g;
const MAX_ARCHIVED_REFS = 20;
// A previous summary's <tasks> block that the model copied into its output.
const STALE_TASKS_BLOCK = /<tasks>[\s\S]*?<\/tasks>\n?/g;

function hasTaskListCall(messages: ModelMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      typeof message.content !== 'string' &&
      message.content.some((part) => part.type === 'tool-call' && part.toolName === 'task_list'),
  );
}

/**
 * Gather every recall id referenced by the messages about to be summarized:
 * stubs inside tool results (from this or earlier prune passes) and entries
 * carried in a previous summary's <archived> block. Without this, the ids
 * would dissolve into prose and the archived outputs become unreachable.
 * Deduped by id; capped to the most recent MAX_ARCHIVED_REFS.
 */
function collectArchivedRefs(messages: ModelMessage[]): ArchivedRef[] {
  const refs = new Map<string, ArchivedRef>();
  for (const message of messages) {
    if (message.role === 'assistant' && typeof message.content === 'string') {
      for (const match of message.content.matchAll(ARCHIVED_ENTRY_PATTERN)) {
        refs.set(match[1]!, { id: match[1]!, toolName: match[2]!, argsBrief: match[3]! });
      }
      continue;
    }
    if (message.role !== 'tool' || typeof message.content === 'string') continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type !== 'tool-result') continue;
      const output = part.output;
      const text =
        typeof output === 'string'
          ? output
          : output && typeof output === 'object' && 'value' in output
            ? String((output as { value: unknown }).value)
            : '';
      const match = STUB_PATTERN.exec(text);
      if (match) {
        const toolName = match[2] ?? (typeof part.toolName === 'string' ? part.toolName : 'tool');
        refs.set(match[1]!, { id: match[1]!, toolName, argsBrief: '' });
      }
    }
  }
  return [...refs.values()].slice(-MAX_ARCHIVED_REFS);
}

interface BoundaryResult {
  keepStart: number;
}

/** Compute the largest trailing slice that fits within keepRecentTokens,
 *  extending backward if necessary to preserve tool-call/tool-result pairs. */
export function computeBoundary(
  messages: ModelMessage[],
  keepRecentTokens: number,
  estimateOptions?: EstimateOptions,
): BoundaryResult {
  let tokenSum = 0;
  let keepCount = 0;

  // Walk from the end, accumulating token counts until we hit the budget.
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens([messages[i]], estimateOptions);
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
