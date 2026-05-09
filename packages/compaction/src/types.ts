export interface CompactionConfig {
  enabled: boolean;
  /** Tokens to reserve below contextWindow (default 16384). */
  reserveTokens: number;
  /** Tokens worth of trailing messages to keep verbatim (default 20000). */
  keepRecentTokens: number;
  /** Optional model override in providerId/modelId format. */
  model?: string;
}

export const DEFAULT_RESERVE_TOKENS = 16384;
export const DEFAULT_KEEP_RECENT_TOKENS = 20000;

export interface CompactionSummary {
  content: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesReplaced: number;
}

export interface CompactionLogEntry {
  ts: number;
  reason: 'threshold' | 'manual';
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  messagesReplaced: { count: number; firstIndex: number; lastIndex: number };
}
