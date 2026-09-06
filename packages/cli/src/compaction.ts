import {
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  DEFAULT_THRESHOLD_PERCENT,
  type MessagePruner,
} from '@chimera/compaction';
import type { CompactionConfig, Session } from '@chimera/core';
import { validateModelSettings } from '@chimera/core';
import { localCapabilities, type ProviderRegistry, resolveModelSettings } from '@chimera/providers';
import { createRecallPruner, RecallStore } from '@chimera/recall';
import type { ChimeraConfig } from './config';

export function compactionCallOptions(config: ChimeraConfig, registry: ProviderRegistry) {
  return async (ref: string, session: Session) => {
    const { provider, modelId } = registry.resolve(ref);
    const spec = config.providers![provider.id];
    const options = config.models?.[ref];
    const base = options?.requestProfile
      ? localCapabilities(modelId, { ...spec, requestProfile: options.requestProfile })
      : await provider.getCapabilities(modelId);
    const capabilities = { ...base, settings: { ...base.settings, ...options?.capabilities } };
    validateModelSettings(options?.settings ?? {}, capabilities);
    const active = ref === `${session.model.providerId}/${session.model.modelId}`;
    const defaults = active
      ? (session.model.settings ?? {
          maxOutputTokens: session.model.maxOutputTokens,
          temperature: session.model.temperature,
        })
      : {
          maxOutputTokens: options?.maxOutputTokens,
          parallelToolCalls: options?.parallelToolCalls,
          ...options?.settings,
        };
    const resolved = resolveModelSettings(
      spec,
      capabilities,
      defaults,
      active ? (session.modelSettingsOverrides?.[ref] ?? {}) : {},
      options?.providerExtensions,
    );
    return {
      temperature: resolved.settings.temperature,
      topP: resolved.settings.topP,
      maxOutputTokens: resolved.settings.maxOutputTokens,
      providerOptions: resolved.providerOptions as Parameters<
        typeof import('ai').generateText
      >[0]['providerOptions'],
    };
  };
}

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
    thresholdPercent: cfg?.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT,
  };
}

export function checkCompactionInvariant(
  config: Pick<CompactionConfig, 'reserveTokens' | 'keepRecentTokens' | 'thresholdPercent'>,
  contextWindow: number,
): { ok: true } | { ok: false; error: string } {
  const thresholdPercent = config.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
  if (thresholdPercent < 50 || thresholdPercent > 95) {
    return {
      ok: false,
      error:
        `Compaction invariant violated: thresholdPercent (${thresholdPercent}) must be ` +
        `between 50 and 95. Fix compaction.thresholdPercent in ~/.chimera/config.json.`,
    };
  }
  if (config.reserveTokens + config.keepRecentTokens >= contextWindow) {
    return {
      ok: false,
      error:
        `Compaction invariant violated: reserveTokens (${config.reserveTokens}) + ` +
        `keepRecentTokens (${config.keepRecentTokens}) >= contextWindow (${contextWindow}). ` +
        `Reduce reserveTokens or keepRecentTokens in ~/.chimera/config.json.`,
    };
  }
  // The verbatim keep-tail plus the reserve must fit under the effective
  // trigger, otherwise every compaction immediately re-triggers.
  const effectiveTrigger = Math.min(
    (contextWindow * thresholdPercent) / 100,
    contextWindow - config.reserveTokens,
  );
  if (config.keepRecentTokens + config.reserveTokens >= effectiveTrigger) {
    return {
      ok: false,
      error:
        `Compaction invariant violated: keepRecentTokens (${config.keepRecentTokens}) + ` +
        `reserveTokens (${config.reserveTokens}) >= effective trigger ` +
        `(${Math.floor(effectiveTrigger)} = min(${thresholdPercent}% of ${contextWindow}, ` +
        `window - reserve)). Compaction would re-trigger immediately; lower ` +
        `keepRecentTokens or raise thresholdPercent in ~/.chimera/config.json.`,
    };
  }
  return { ok: true };
}
