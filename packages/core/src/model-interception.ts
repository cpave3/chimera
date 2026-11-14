import type { LanguageModel } from 'ai';
import type { ProviderOptions } from './agent';
import type { PromptSource } from './events';
import type { SessionId } from './ids';
import type { ModelConfig, UsageStep } from './types';

export interface ModelStepRequest {
  sessionId: SessionId;
  model: string;
  effort?: string;
  providerOptions?: ProviderOptions;
  systemPrompt: string;
  usage?: UsageStep;
}

export interface StepModelResolution {
  model: ModelConfig;
  languageModel: LanguageModel;
  providerOptions?: ProviderOptions;
}

export interface SubmittedPrompt {
  sessionId: SessionId;
  text: string;
  source: PromptSource;
}

export type PromptSubmissionResult = { decision: 'accept' } | { decision: 'drop'; reason: string };
