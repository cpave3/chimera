import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { buildKeyResolver } from './key';
import type {
  Provider,
  ProviderRegistry,
  ProvidersConfig,
  ProviderShape,
  ProviderSpec,
} from './types';

export interface LoadProvidersOptions {
  warn?: (msg: string) => void;
}

function buildProvider(
  id: string,
  spec: ProviderSpec,
  opts: LoadProvidersOptions,
): Provider {
  const keyResolver = buildKeyResolver(spec.apiKey, { warn: opts.warn, providerId: id });

  const getModel = (modelId: string): LanguageModel => {
    const apiKey = keyResolver();
    if (spec.shape === 'anthropic') {
      const factory = createAnthropic({ baseURL: spec.baseUrl, apiKey });
      return factory(modelId);
    }
    // @ai-sdk/openai v3 removed the top-level `compatibility` option; the
    // provider spec still carries it for forward compatibility but it is not
    // forwarded to createOpenAI.
    //
    // Default the selector to Chat Completions (`.chat()`) rather than the
    // newer Responses API (`factory(modelId)`). Most OpenAI-compatible
    // endpoints (OpenRouter, vLLM, Ollama, synthetic.new, etc.) only implement
    // Chat Completions; sending them `/v1/responses` returns a 404.
    const factory = createOpenAI({
      baseURL: spec.baseUrl,
      apiKey,
    });
    return factory.chat(modelId);
  };

  return { id, shape: spec.shape, getModel };
}

export function loadProviders(
  config: ProvidersConfig,
  opts: LoadProvidersOptions = {},
): ProviderRegistry {
  const providerCache = new Map<string, Provider>();

  const get = (providerId: string): Provider => {
    const cached = providerCache.get(providerId);
    if (cached) return cached;
    const spec = config.providers[providerId];
    if (!spec) {
      const known = Object.keys(config.providers).join(', ') || '<none configured>';
      throw new Error(
        `Unknown provider '${providerId}'. Configured providers: ${known}.`,
      );
    }
    validateShape(spec.shape, providerId);
    const provider = buildProvider(providerId, spec, opts);
    providerCache.set(providerId, provider);
    return provider;
  };

  const resolve = (modelRef: string): { provider: Provider; modelId: string } => {
    const slash = modelRef.indexOf('/');
    if (slash <= 0 || slash === modelRef.length - 1) {
      throw new Error(
        `Invalid model reference '${modelRef}'. Expected '<providerId>/<modelId>'.`,
      );
    }
    const providerId = modelRef.slice(0, slash);
    const modelId = modelRef.slice(slash + 1);
    return { provider: get(providerId), modelId };
  };

  return {
    get,
    has: (id: string) => Object.hasOwn(config.providers, id),
    resolve,
    ids: () => Object.keys(config.providers),
  };
}

function validateShape(shape: string, providerId: string): asserts shape is ProviderShape {
  if (shape !== 'openai' && shape !== 'anthropic') {
    throw new Error(
      `Provider '${providerId}' has unsupported shape '${shape}'. Use 'openai' or 'anthropic'.`,
    );
  }
}
