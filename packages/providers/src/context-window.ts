import type { DiscoveredLimit, ModelCapabilities } from '@chimera/core';
import type { ProviderShape } from './types';

/**
 * Conservative fallback window used when neither config override nor the
 * built-in table resolves a value. Intentionally on the small side so the
 * "remaining budget" UI errs toward warning earlier rather than later.
 */
export const CONTEXT_WINDOW_FALLBACK = 128_000;

/**
 * Built-in context-window table. Keyed by model id within a provider shape.
 * Match is exact on `modelId` first, then by longest-prefix so dated
 * variants (e.g. `claude-sonnet-4-5-20250929`) inherit the family default.
 */
const TABLE: Record<ProviderShape, Record<string, number>> = {
  anthropic: {
    // Claude 3.5 family
    'claude-3-5-sonnet': 200_000,
    'claude-3-5-haiku': 200_000,
    // Claude 3.7 family
    'claude-3-7-sonnet': 200_000,
    // Claude 4.x family
    'claude-sonnet-4': 200_000,
    'claude-sonnet-4-5': 200_000,
    'claude-sonnet-4-6': 200_000,
    'claude-opus-4': 200_000,
    'claude-opus-4-5': 200_000,
    'claude-opus-4-6': 200_000,
    'claude-opus-4-7': 200_000,
    'claude-haiku-4-5': 200_000,
  },
  openai: {
    // GPT-4.1 family — 1M-token context.
    'gpt-4.1': 1_047_576,
    'gpt-4.1-mini': 1_047_576,
    'gpt-4.1-nano': 1_047_576,
    // GPT-4o family
    'gpt-4o': 128_000,
    'gpt-4o-mini': 128_000,
    // o-series reasoning
    o1: 200_000,
    'o1-mini': 128_000,
    o3: 200_000,
    'o3-mini': 200_000,
    'o4-mini': 200_000,
  },
};

const warnedRefs = new Set<string>();

/** Test-only: reset the once-per-process warning de-dup set. */
export function __resetContextWindowWarnings(): void {
  warnedRefs.clear();
}

export interface ResolveContextWindowOptions {
  providerShape: ProviderShape;
  providerId: string;
  modelId: string;
  /** Optional override from `~/.chimera/config.json`'s `models.<ref>.contextWindow`. */
  override?: number;
  /**
   * Deployment context limit discovered through capability metadata. Ignored
   * unless a positive safe integer, so a corrupt descriptor can never widen
   * the budget.
   */
  discovered?: number;
  /** Sink for the "unknown model" warning. Defaults to `process.stderr`. */
  warn?: (msg: string) => void;
}

export type ContextWindowSource = 'override' | 'discovered' | 'table' | 'fallback';

export interface ResolvedContextWindow {
  value: number;
  source: ContextWindowSource;
}

/** A discovered limit is only trusted as a positive safe integer. */
function usableLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : undefined;
}

export function discoveredLimitValue(descriptor: DiscoveredLimit | undefined): number | undefined {
  return descriptor?.status === 'discovered' ? usableLimit(descriptor.value) : undefined;
}

export function resolveContextWindow(opts: ResolveContextWindowOptions): ResolvedContextWindow {
  if (typeof opts.override === 'number' && opts.override > 0) {
    return { value: opts.override, source: 'override' };
  }
  const discovered = usableLimit(opts.discovered);
  if (discovered !== undefined) return { value: discovered, source: 'discovered' };
  const shapeTable = TABLE[opts.providerShape];
  const exact = shapeTable[opts.modelId];
  if (typeof exact === 'number') return { value: exact, source: 'table' };
  const prefixHit = longestPrefixMatch(shapeTable, opts.modelId);
  if (prefixHit !== undefined) return { value: prefixHit, source: 'table' };

  const ref = `${opts.providerId}/${opts.modelId}`;
  if (!warnedRefs.has(ref)) {
    warnedRefs.add(ref);
    const msg = `chimera: unknown context window for ${ref}; falling back to ${CONTEXT_WINDOW_FALLBACK} tokens. Set \`models["${ref}"].contextWindow\` in ~/.chimera/config.json to override.`;
    if (opts.warn) {
      opts.warn(msg);
    } else if (typeof process !== 'undefined' && process.stderr) {
      process.stderr.write(`${msg}\n`);
    }
  }
  return { value: CONTEXT_WINDOW_FALLBACK, source: 'fallback' };
}

export interface ResolveModelWindowsOptions {
  providerShape: ProviderShape;
  providerId: string;
  modelId: string;
  /** Optional override from `~/.chimera/config.json`'s `models.<ref>.contextWindow`. */
  override?: number;
  /** Capability metadata carrying discovered limits, when a discovery ran. */
  capabilities?: Pick<ModelCapabilities, 'limits'> | undefined;
  /** Sink for the "unknown model" warning. Defaults to `process.stderr`. */
  warn?: (msg: string) => void;
}

export interface ResolvedModelWindows {
  context: ResolvedContextWindow;
  /** Discovered input limit when usable; undefined otherwise. */
  inputLimit?: number;
  /** Discovered output limit when usable; undefined otherwise. */
  outputLimit?: number;
  /**
   * The basis for prompt budgets (compaction triggers and targets):
   * `min(discovered input limit, total context)`, or the total context when no
   * input limit was discovered. Output room is NOT subtracted here — the
   * compaction reserve subtracts it exactly once.
   */
  promptBasis: number;
}

/**
 * The window set a session uses for one model: the resolved total context
 * (explicit override > discovered > built-in table > fallback) plus the
 * separately discovered input and output caps.
 */
export function resolveModelWindows(opts: ResolveModelWindowsOptions): ResolvedModelWindows {
  const limits = opts.capabilities?.limits;
  const context = resolveContextWindow({
    providerShape: opts.providerShape,
    providerId: opts.providerId,
    modelId: opts.modelId,
    override: opts.override,
    discovered: discoveredLimitValue(limits?.context),
    warn: opts.warn,
  });
  const inputLimit = discoveredLimitValue(limits?.input);
  const outputLimit = discoveredLimitValue(limits?.output);
  const promptBasis =
    inputLimit === undefined ? context.value : Math.min(inputLimit, context.value);
  return {
    context,
    ...(inputLimit !== undefined ? { inputLimit } : {}),
    ...(outputLimit !== undefined ? { outputLimit } : {}),
    promptBasis,
  };
}

function longestPrefixMatch(table: Record<string, number>, modelId: string): number | undefined {
  let best: { key: string; value: number } | undefined;
  for (const key of Object.keys(table)) {
    if (modelId.startsWith(key) && (best === undefined || key.length > best.key.length)) {
      best = { key, value: table[key]! };
    }
  }
  return best?.value;
}
