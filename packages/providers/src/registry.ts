import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelCapabilities } from '@chimera/core';
import type { LanguageModel } from 'ai';
import { wrapLanguageModel } from 'ai';
import { codexContinuationMiddleware, codexMetadataExtractor } from './codex-continuation';
import { buildKeyResolver } from './key';
import { assertModelCapabilities, localCapabilities } from './model-settings';
import type {
  Provider,
  ProviderRegistry,
  ProviderShape,
  ProviderSpec,
  ProvidersConfig,
} from './types';

export interface LoadProvidersOptions {
  warn?: (msg: string) => void;
}

function interpolateHeaders(
  headers: Record<string, string> | undefined,
  sessionId: string | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = sessionId ? value.replace(/\{\{session\.id\}\}/g, sessionId) : value;
  }
  return result;
}

function buildProvider(id: string, spec: ProviderSpec, opts: LoadProvidersOptions): Provider {
  if (spec.adapter !== undefined && !['native', 'compatible'].includes(spec.adapter))
    throw new Error(`${id}: invalid adapter`);
  if (spec.capabilitySource !== undefined && spec.capabilitySource !== 'manticore')
    throw new Error(`${id}: invalid capabilitySource`);
  if (
    spec.requestProfile !== undefined &&
    !['anthropic', 'openai-chat', 'thinking', 'template', 'codex'].includes(spec.requestProfile)
  )
    throw new Error(`${id}: invalid requestProfile`);
  if (
    spec.shape === 'anthropic' &&
    (spec.adapter === 'compatible' || spec.capabilitySource === 'manticore')
  )
    throw new Error(`${id}: Anthropic requires its native adapter`);
  const keyResolver = buildKeyResolver(spec.apiKey, { warn: opts.warn, providerId: id });

  const getModel = (modelId: string, sessionId?: string): LanguageModel => {
    const apiKey = keyResolver();
    const headers = interpolateHeaders(spec.headers, sessionId);
    if (spec.shape === 'anthropic') {
      const factory = (off = false) =>
        createAnthropic({
          baseURL: spec.baseUrl,
          apiKey,
          headers,
          ...(off
            ? {
                fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                  const body = JSON.parse(String(init?.body));
                  return fetch(input, {
                    ...init,
                    body: JSON.stringify({ ...body, thinking: { type: 'disabled' } }),
                  });
                },
              }
            : {}),
        })(modelId);
      return wrapLanguageModel({
        model: factory(),
        middleware: {
          specificationVersion: 'v3',
          async transformParams({ params }) {
            const thinking = params.providerOptions?.anthropic?.thinking as
              | { type?: string; budgetTokens?: number }
              | undefined;
            // The native SDK adds the budget. Our output limit includes thinking.
            return thinking?.type === 'enabled' &&
              typeof thinking.budgetTokens === 'number' &&
              params.maxOutputTokens !== undefined
              ? { ...params, maxOutputTokens: params.maxOutputTokens - thinking.budgetTokens }
              : params;
          },
          async wrapGenerate({ params, doGenerate }) {
            const thinking = params.providerOptions?.anthropic?.thinking as
              | { type?: string }
              | undefined;
            return thinking?.type === 'disabled' ? factory(true).doGenerate(params) : doGenerate();
          },
          async wrapStream({ params, doStream }) {
            const thinking = params.providerOptions?.anthropic?.thinking as
              | { type?: string }
              | undefined;
            return thinking?.type === 'disabled' ? factory(true).doStream(params) : doStream();
          },
        },
      });
    }
    if (spec.adapter === 'compatible' || spec.capabilitySource === 'manticore') {
      const model = createOpenAICompatible({
        name: 'chimera',
        baseURL: spec.baseUrl,
        apiKey,
        headers,
        ...(spec.capabilitySource === 'manticore'
          ? { metadataExtractor: codexMetadataExtractor }
          : {}),
      }).chatModel(modelId);
      return spec.capabilitySource === 'manticore'
        ? wrapLanguageModel({ model, middleware: codexContinuationMiddleware })
        : model;
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
      headers,
    });
    return factory.chat(modelId);
  };

  const cache = new Map<string, { expires: number; capabilities: ModelCapabilities }>();
  const getCapabilities = async (modelId: string, refresh = false): Promise<ModelCapabilities> => {
    const cached = cache.get(modelId);
    if (!refresh && cached && cached.expires > Date.now()) return cached.capabilities;
    if (spec.capabilitySource !== 'manticore') return localCapabilities(modelId, spec);
    try {
      const url = new URL(`${spec.baseUrl.replace(/\/$/, '')}/model-capabilities`);
      url.searchParams.set('model', modelId);
      const response = await fetch(url, {
        headers: {
          ...interpolateHeaders(spec.headers, undefined),
          Authorization: `Bearer ${keyResolver()}`,
        },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`Capability discovery returned ${response.status}`);
      const capabilities = (await response.json()) as ModelCapabilities;
      assertModelCapabilities(capabilities);
      if (
        capabilities.schemaVersion !== 1 ||
        !capabilities.settings ||
        typeof capabilities.profile !== 'string'
      )
        throw new Error('Invalid capability response');
      cache.set(modelId, { expires: Date.now() + 30_000, capabilities });
      return capabilities;
    } catch {
      const fallback = localCapabilities(modelId, {
        ...spec,
        requestProfile: undefined,
        baseUrl: '',
      });
      return { ...fallback, source: 'unavailable' };
    }
  };
  return { id, shape: spec.shape, getModel, getCapabilities };
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
      throw new Error(`Unknown provider '${providerId}'. Configured providers: ${known}.`);
    }
    validateShape(spec.shape, providerId);
    const provider = buildProvider(providerId, spec, opts);
    providerCache.set(providerId, provider);
    return provider;
  };

  const resolve = (modelRef: string): { provider: Provider; modelId: string } => {
    const slash = modelRef.indexOf('/');
    if (slash <= 0 || slash === modelRef.length - 1) {
      throw new Error(`Invalid model reference '${modelRef}'. Expected '<providerId>/<modelId>'.`);
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
