import type { ModelMessage } from 'ai';

/** Fixed per-message overhead constant to account for role/formatting tokens. */
export const PER_MESSAGE_OVERHEAD = 16;

/**
 * Conservative char/4 heuristic for token estimation.
 * Each message contributes JSON-stringified length / 4 rounded up,
 * plus a small overhead constant.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    total += Math.ceil(text.length / 4) + PER_MESSAGE_OVERHEAD;
  }
  return total;
}
