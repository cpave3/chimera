import {
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  type MessagePruner,
} from '@chimera/compaction';
import { createRecallPruner, RecallStore } from '@chimera/recall';
import type { CompactionConfig } from '@chimera/core';
import type { ChimeraConfig } from './config';

/**
 * Per-session prune-phase factory for the Compactor, backed by the recall
 * store. Returns undefined when recall is disabled — the Compactor then
 * behaves exactly as before tiering (summarize only).
 */
export function recallPrunerFactory(
  config: ChimeraConfig,
  home?: string,
): ((sessionId: string) => MessagePruner) | undefined {
  if (config.recall?.enabled === false) return undefined;
  return (sessionId) =>
    createRecallPruner(new RecallStore({ sessionId, home, ttlDays: config.recall?.ttlDays }), {
      archiveThresholdTokens: config.recall?.archiveThresholdTokens,
    });
}

export function resolveCompactionConfig(opts: {
  cliOverride?: boolean;
  config: ChimeraConfig;
}): CompactionConfig {
  const cfg = opts.config.compaction;
  const enabled = opts.cliOverride !== false && (cfg?.enabled ?? true);
  return {
    enabled,
    reserveTokens: cfg?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    keepRecentTokens: cfg?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
    model: cfg?.model,
  };
}

export function checkCompactionInvariant(
  config: Pick<CompactionConfig, 'reserveTokens' | 'keepRecentTokens'>,
  contextWindow: number,
): { ok: true } | { ok: false; error: string } {
  if (config.reserveTokens + config.keepRecentTokens >= contextWindow) {
    return {
      ok: false,
      error:
        `Compaction invariant violated: reserveTokens (${config.reserveTokens}) + ` +
        `keepRecentTokens (${config.keepRecentTokens}) >= contextWindow (${contextWindow}). ` +
        `Reduce reserveTokens or keepRecentTokens in ~/.chimera/config.json.`,
    };
  }
  return { ok: true };
}
