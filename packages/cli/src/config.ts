import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CompactionConfig, ModelConfig } from '@chimera/core';
import type { AutoApproveLevel } from '@chimera/permissions';
import type { ProviderSpec, ProvidersConfig } from '@chimera/providers';
import type { DiagnosticsConfig } from '@chimera/tools';

export interface ModelOptions {
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * Marks the model vision-capable. Only models with `vision: true` ever
   * receive image parts; image turns on other models route to
   * `defaultVisionModel`.
   */
  vision?: boolean;
}

export interface ChimeraConfig {
  defaultModel?: string;
  /**
   * Model (`<providerId>/<modelId>`) that turns carrying images run on when
   * the active model is not vision-capable. The whole turn (tools included)
   * runs on this model, then the session reverts to the selected model.
   * Must itself be marked `vision: true` under `models`.
   */
  defaultVisionModel?: string;
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
  agents?: {
    enabled?: boolean;
    claudeCompat?: boolean;
  };
  /**
   * Per-model overrides. Keyed by `<providerId>/<modelId>`.
   *
   * - `contextWindow` — honored by `resolveContextWindow`.
   * - `maxOutputTokens` — forwarded to the AI SDK's `maxOutputTokens` so the
   *   model is not capped by the provider's small default (synthetic.new
   *   defaults to 2048, which truncates long final syntheses).
   */
  models?: Record<string, ModelOptions>;
  modes?: {
    enabled?: boolean;
    claudeCompat?: boolean;
  };
  /** Mode active for new sessions when no `--mode` flag is given. Defaults to "build". */
  defaultMode?: string;
  /** Ordered list cycled by Shift+Tab in the TUI. Defaults to ["build", "plan"]. */
  cycleModes?: string[];
  /**
   * Per-step wall-clock timeout for LLM `streamText` calls (ms).
   * A value of `0` disables the timeout. Defaults to 120000.
   */
  responseTimeoutMs?: number;
  /**
   * Optional compaction settings for context-window management.
   * Defaults are `enabled: true`, `reserveTokens: 16384`, `keepRecentTokens: 20000`.
   */
  compaction?: Partial<
    Pick<CompactionConfig, 'enabled' | 'reserveTokens' | 'keepRecentTokens' | 'thresholdPercent'>
  > & {
    /** Model override for compaction summaries (providerId/modelId). */
    model?: string;
  };
  /**
   * Post-edit diagnostics feedback. Fast checks (biome, cerberus) are
   * auto-detected from project config files; `checks` adds or overrides
   * commands run after each edit/write, whose failures are fed back to the
   * model inside the tool result.
   */
  diagnostics?: DiagnosticsConfig;
  /**
   * Enables the web_search tool. `apiKey` follows the provider convention:
   * `env:VAR_NAME` resolves from the environment at call time.
   */
  webSearch?: {
    provider: 'tavily' | 'brave';
    apiKey: string;
  };
  /**
   * Shadow-git working-tree snapshots taken before each user message so
   * /rewind can restore file state. Default true; set false to make rewind
   * conversation-only.
   */
  workspaceCheckpoints?: boolean;
  /**
   * Archived-tool-output store backing the recall tool and compaction's
   * prune phase. Entries live under `~/.chimera/recall/<sessionId>/`.
   */
  recall?: {
    /** Default true. */
    enabled?: boolean;
    /** Tool results above this (estimated) size are archived at compaction. Default 500. */
    archiveThresholdTokens?: number;
    /** Entries older than this are garbage-collected. Default 30. */
    ttlDays?: number;
  };
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
  const modelOpts = opts.config.models?.[ref];
  return {
    ref,
    model: {
      providerId,
      modelId,
      maxSteps: opts.maxSteps ?? 100,
      maxOutputTokens: modelOpts?.maxOutputTokens,
      vision: modelOpts?.vision,
    },
    providersConfig: { providers, defaultModel: opts.config.defaultModel },
  };
}
