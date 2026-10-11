import type { ModelCapabilities } from '@chimera/core';
import type { LanguageModel } from 'ai';

export type ProviderShape = 'openai' | 'anthropic';

export interface ProviderSpec {
  adapter?: 'native' | 'compatible';
  capabilitySource?: 'manticore';
  requestProfile?: 'openai-chat' | 'thinking' | 'template' | 'anthropic' | 'codex';
  shape: ProviderShape;
  baseUrl: string;
  apiKey: string;
  /** Only meaningful for 'openai' shape. Default: 'compatible'. */
  compatibility?: 'strict' | 'compatible';
  /**
   * Extra HTTP headers sent on every request to this provider. Values may
   * contain the literal token `{{session.id}}`; it is replaced with the
   * current session's id at getModel() time.
   */
  headers?: Record<string, string>;
  /**
   * Only meaningful for 'anthropic' shape. Default: true. Set false for a
   * proxy that rejects `cache_control` fields.
   */
  promptCaching?: boolean;
}

export interface ProvidersConfig {
  providers: Record<string, ProviderSpec>;
  defaultModel?: string;
}

export interface Provider {
  id: string;
  shape: ProviderShape;
  getModel(modelId: string, sessionId?: string): LanguageModel;
  getCapabilities(modelId: string, refresh?: boolean): Promise<ModelCapabilities>;
}

export interface ProviderRegistry {
  get(providerId: string): Provider;
  has(providerId: string): boolean;
  resolve(modelRef: string): { provider: Provider; modelId: string };
  ids(): string[];
}
