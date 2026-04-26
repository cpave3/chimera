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
  /** Sink for the "unknown model" warning. Defaults to `process.stderr`. */
  warn?: (msg: string) => void;
}

export type ContextWindowSource = 'override' | 'table' | 'fallback';

export interface ResolvedContextWindow {
  value: number;
  source: ContextWindowSource;
}

export function resolveContextWindow(opts: ResolveContextWindowOptions): ResolvedContextWindow {
  if (typeof opts.override === 'number' && opts.override > 0) {
    return { value: opts.override, source: 'override' };
  }
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

function longestPrefixMatch(table: Record<string, number>, modelId: string): number | undefined {
  let best: { key: string; value: number } | undefined;
  for (const key of Object.keys(table)) {
    if (modelId.startsWith(key) && (best === undefined || key.length > best.key.length)) {
      best = { key, value: table[key]! };
    }
  }
  return best?.value;
}
