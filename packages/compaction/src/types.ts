export interface CompactionConfig {
  enabled: boolean;
  /** Tokens to reserve below contextWindow (default 16384). */
  reserveTokens: number;
  /** Tokens worth of trailing messages to keep verbatim (default 20000). */
  keepRecentTokens: number;
  /** Optional model override in providerId/modelId format. */
  model?: string;
  /**
   * Compact when the projected prompt crosses this percentage of the
   * context window (effective trigger = min(window * pct, window - reserve)).
   * Default 85.
   */
  thresholdPercent?: number;
}

export const DEFAULT_THRESHOLD_PERCENT = 85;

export const DEFAULT_RESERVE_TOKENS = 16384;
export const DEFAULT_KEEP_RECENT_TOKENS = 20000;

export interface CompactionSummary {
  content: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesReplaced: number;
}

export type CompactionStrategy = 'prune' | 'prune+summarize' | 'summarize';

export interface ArchivedRef {
  id: string;
  toolName: string;
  argsBrief: string;
}

export interface PruneResult {
  archivedCount: number;
  tokensSaved: number;
  archived: ArchivedRef[];
}

/**
 * Compaction phase 1: rewrite messages[0..endIndex) in place (typically
 * swapping large tool outputs for recall stubs) without removing or
 * reordering messages. Implemented by `createRecallPruner` in
 * `@chimera/recall` (structurally compatible — no package dependency
 * in either direction).
 */
export interface MessagePruner {
  prune(messages: import('ai').ModelMessage[], endIndex: number): Promise<PruneResult>;
}

export interface CompactionLogEntry {
  ts: number;
  reason: 'threshold' | 'manual';
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  messagesReplaced: { count: number; firstIndex: number; lastIndex: number };
  strategy?: CompactionStrategy;
  prunedCount?: number;
  prunedTokensSaved?: number;
}
