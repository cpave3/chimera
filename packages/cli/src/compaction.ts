import {
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  DEFAULT_THRESHOLD_PERCENT,
  type MessagePruner,
} from '@chimera/compaction';
import type { CompactionConfig, Session } from '@chimera/core';
import { validateModelSettings } from '@chimera/core';
import {
  derivedOutputDefault,
  localCapabilities,
  type ProviderRegistry,
  type ResolvedModelWindows,
  resolveContextWindow,
  resolveModelSettings,
  resolveModelWindows,
} from '@chimera/providers';
import { createRecallPruner, RecallStore } from '@chimera/recall';
import type { ChimeraConfig } from './config';

/**
 * The startup model's resolved windows, discovery included: commands run the
 * compaction invariant check against these AFTER discovery so a configuration
 * that only fits a discovered window is not rejected on the table/fallback
 * value, and a discovered window that breaks the configuration is. Uses the
 * caller's registry so the factory shares the same capability cache.
 */
export async function startupSessionWindows(
  config: Pick<ChimeraConfig, 'providers' | 'models'>,
  registry: ProviderRegistry,
  ref: string,
): Promise<ResolvedModelWindows> {
  const { provider, modelId } = registry.resolve(ref);
  const providerSpec = config.providers?.[provider.id];
  const providerShape = providerSpec?.shape ?? provider.shape;
  const override = config.models?.[ref]?.contextWindow;
  try {
    const capabilities = await provider.getCapabilities(modelId);
    return resolveModelWindows({
      providerShape,
      providerId: provider.id,
      modelId,
      override,
      capabilities,
    });
  } catch {
    return resolveModelWindows({ providerShape, providerId: provider.id, modelId, override });
  }
}

export function compactionModelOptions(config: ChimeraConfig, registry: ProviderRegistry) {
  return {
    fallbackModel: config.utilityModel,
    // The Compactor awaits this hook, so the summary model's window resolves
    // through the provider's cached capability discovery: a Manticore alias
    // carries its own limits into the summary budget, and a separately
    // discovered input cap bounds the summary call's prompt like any other.
    // A resolution failure degrades to the sync table/fallback path.
    resolveContextWindow: async (ref: string) => {
      const { provider, modelId } = registry.resolve(ref);
      const providerShape = config.providers![provider.id].shape;
      const override = config.models?.[ref]?.contextWindow;
      try {
        const capabilities = await provider.getCapabilities(modelId);
        return resolveModelWindows({
          providerShape,
          providerId: provider.id,
          modelId,
          override,
          capabilities,
        }).promptBasis;
      } catch {
        return resolveContextWindow({
          providerShape,
          providerId: provider.id,
          modelId,
          override,
        }).value;
      }
    },
  };
}

export function compactionCallOptions(config: ChimeraConfig, registry: ProviderRegistry) {
  return async (ref: string, session: Session) => {
    const { provider, modelId } = registry.resolve(ref);
    const spec = config.providers![provider.id];
    const options = config.models?.[ref];
    // A pinned requestProfile fixes the settings profile, but token limits
    // are independently useful: fetch them through the provider's cache.
    const fetchedLimits =
      options?.requestProfile && spec.capabilitySource === 'manticore'
        ? await provider.getCapabilities(modelId).catch(() => undefined)
        : undefined;
    const base = options?.requestProfile
      ? {
          ...localCapabilities(modelId, { ...spec, requestProfile: options.requestProfile }),
          ...(fetchedLimits?.limits ? { limits: fetchedLimits.limits } : {}),
        }
      : await provider.getCapabilities(modelId);
    const capabilities = { ...base, settings: { ...base.settings, ...options?.capabilities } };
    validateModelSettings(options?.settings ?? {}, capabilities);
    const active = ref === `${session.model.providerId}/${session.model.modelId}`;
    // A separate summary model gets its own discovered output bound; the
    // active model's session settings already carry the factory's derivation.
    const derivedOutput = active
      ? undefined
      : derivedOutputDefault(
          capabilities,
          resolveModelWindows({
            providerShape: spec.shape,
            providerId: provider.id,
            modelId,
            override: options?.contextWindow,
            capabilities,
          }).context.value,
        );
    const defaults = active
      ? (session.model.settings ?? {
          maxOutputTokens: session.model.maxOutputTokens,
          temperature: session.model.temperature,
        })
      : {
          maxOutputTokens: options?.maxOutputTokens ?? derivedOutput,
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
    model: cfg?.model ?? opts.config.utilityModel,
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
