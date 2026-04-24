import type { LanguageModel } from 'ai';

export type ProviderShape = 'openai' | 'anthropic';

export interface ProviderSpec {
  shape: ProviderShape;
  baseUrl: string;
  apiKey: string;
  /** Only meaningful for 'openai' shape. Default: 'compatible'. */
  compatibility?: 'strict' | 'compatible';
}

export interface ProvidersConfig {
  providers: Record<string, ProviderSpec>;
  defaultModel?: string;
}

export interface Provider {
  id: string;
  shape: ProviderShape;
  getModel(modelId: string): LanguageModel;
}

export interface ProviderRegistry {
  get(providerId: string): Provider;
  has(providerId: string): boolean;
  resolve(modelRef: string): { provider: Provider; modelId: string };
  ids(): string[];
}
