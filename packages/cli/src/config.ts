import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelConfig } from '@chimera/core';
import type { AutoApproveLevel } from '@chimera/permissions';
import type { ProvidersConfig, ProviderSpec } from '@chimera/providers';

export interface ChimeraConfig {
  defaultModel?: string;
  providers?: Record<string, ProviderSpec>;
  autoApprove?: AutoApproveLevel;
  commands?: {
    enabled?: boolean;
    claudeCompat?: boolean;
  };
  skills?: {
    enabled?: boolean;
    claudeCompat?: boolean;
  };
  /**
   * Per-model overrides. Keyed by `<providerId>/<modelId>`. Currently only
   * `contextWindow` is honored — see `resolveContextWindow`.
   */
  models?: Record<string, { contextWindow?: number }>;
  modes?: {
    enabled?: boolean;
    claudeCompat?: boolean;
  };
  /** Mode active for new sessions when no `--mode` flag is given. Defaults to "build". */
  defaultMode?: string;
  /** Ordered list cycled by Shift+Tab in the TUI. Defaults to ["build", "plan"]. */
  cycleModes?: string[];
}

export function configPath(home = homedir()): string {
  return join(home, '.chimera', 'config.json');
}

export function loadConfig(home = homedir()): ChimeraConfig {
  try {
    const raw = readFileSync(configPath(home), 'utf8');
    return JSON.parse(raw) as ChimeraConfig;
  } catch {
    return {};
  }
}

export interface ResolvedModel {
  ref: string;
  model: ModelConfig;
  providersConfig: ProvidersConfig;
}

export interface ResolveModelOpts {
  cliModel?: string;
  maxSteps?: number;
  config: ChimeraConfig;
}

export function resolveModel(opts: ResolveModelOpts): ResolvedModel {
  const ref = opts.cliModel ?? opts.config.defaultModel;
  if (!ref) {
    throw new Error(
      'No model configured. Set "defaultModel" in ~/.chimera/config.json or pass -m <providerId/modelId>.',
    );
  }
  const slash = ref.indexOf('/');
  if (slash <= 0) {
    throw new Error(`Invalid model reference '${ref}'. Expected '<providerId>/<modelId>'.`);
  }
  const providerId = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const providers = opts.config.providers ?? {};
  if (!providers[providerId]) {
    throw new Error(
      `Model references provider '${providerId}' but no such provider is configured in ~/.chimera/config.json.`,
    );
  }
  return {
    ref,
    model: { providerId, modelId, maxSteps: opts.maxSteps ?? 100 },
    providersConfig: { providers, defaultModel: opts.config.defaultModel },
  };
}
