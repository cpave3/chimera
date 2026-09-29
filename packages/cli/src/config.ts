import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  CompactionConfig,
  ModelConfig,
  ModelSettings,
  SettingCapability,
} from '@chimera/core';
import type { AutoApproveLevel } from '@chimera/permissions';
import type { ProviderSpec, ProvidersConfig } from '@chimera/providers';
import type { DiagnosticsConfig } from '@chimera/tools';
import { z } from 'zod';

export interface ModelOptions {
  settings?: ModelSettings;
  capabilities?: Partial<Record<keyof ModelSettings, SettingCapability>>;
  requestProfile?: ProviderSpec['requestProfile'];
  providerExtensions?: Record<string, unknown>;
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * Tool-call compatibility mode for models with strong expectations about
   * tool names and argument schemas. Undefined uses Chimera's native surface.
   */
  toolCallShape?: 'chimera' | 'codex';
  /**
   * Overrides discovered image support, including explicit false. When
   * omitted, verified provider metadata or an SDK declaration can enable
   * vision. Other models route image turns to `defaultVisionModel`.
   */
  vision?: boolean;
  /**
   * Long edge, in pixels, this model's provider scales images down to before
   * charging for them. Sets how the context estimator prices an image:
   * roughly `(width * height) / 750` after scaling. Defaults to 1568; raise it
   * (2576) for high-resolution vision tiers.
   */
  imageLongEdge?: number;
  /**
   * When `true`, the factory forwards `{ parallelToolCalls: true }` to the
   * provider so the model emits multiple tool calls per step (which the AI
   * SDK runs concurrently via `Promise.all`). When unset, the provider's
   * default applies — which for some GPT models reached through proxies is
   * serial, causing subagent spawns to run one-at-a-time.
   */
  parallelToolCalls?: boolean;
}

export type WebSearchConfig =
  | { provider: 'tavily' | 'brave'; apiKey: string }
  | { provider: 'searxng'; baseUrl: string };

export interface HostBashPolicyConfig {
  enabled: boolean;
  mode: 'balanced' | 'strict';
  autoAllowThrough: 'none' | 'safe' | 'caution' | 'danger';
}

export type McpServerConfig =
  | {
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      trustedTools?: string[];
    }
  | { transport: 'http'; url: string; clientId?: string; trustedTools?: string[] };

export interface ChimeraConfig {
  mcpServers?: Record<string, McpServerConfig>;
  defaultModel?: string;
  /**
   * Model (`<providerId>/<modelId>`) that turns carrying images run on when
   * the active model is not vision-capable. The whole turn (tools included)
   * runs on this model, then the session reverts to the selected model.
   * Must have verified image support or an explicit `vision: true` declaration.
   */
  defaultVisionModel?: string;
  providers?: Record<string, ProviderSpec>;
  autoApprove?: AutoApproveLevel;
  commandPolicy?: {
    hostBash?: Partial<HostBashPolicyConfig>;
  };
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
   * Enables the web_search tool with exactly one configured provider.
   * Keyed providers accept `env:VAR_NAME`; SearXNG accepts its instance base URL.
   */
  webSearch?: WebSearchConfig;
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

const hostBashPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['balanced', 'strict']).optional(),
    autoAllowThrough: z.enum(['none', 'safe', 'caution', 'danger']).optional(),
  })
  .strict();

const serverNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const trustedToolsSchema = z.array(z.string().min(1)).optional();
const mcpServerSchema = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z
        .record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/),
        )
        .optional(),
      trustedTools: trustedToolsSchema,
    })
    .strict(),
  z
    .object({
      transport: z.literal('http'),
      url: z.url().refine((value) => {
        const url = new URL(value);
        return (
          url.username === '' &&
          url.password === '' &&
          url.hash === '' &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        );
      }, 'Must use HTTPS (HTTP is allowed only on loopback), without credentials or fragment'),
      clientId: z.string().min(1).optional(),
      trustedTools: trustedToolsSchema,
    })
    .strict(),
]);

export function validateMcpServers(value: unknown, path: string): Record<string, McpServerConfig> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid mcpServers in ${path}: expected an object`);
  }
  for (const [name, server] of Object.entries(value)) {
    const nameResult = serverNameSchema.safeParse(name);
    if (!nameResult.success || ['__proto__', 'constructor', 'prototype'].includes(name)) {
      throw new Error(`Invalid ${path}: mcpServers.${name}: invalid server name`);
    }
    const result = mcpServerSchema.safeParse(server);
    if (!result.success) {
      throw new Error(
        `Invalid ${path}: mcpServers.${name}: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
    }
  }
  return value as Record<string, McpServerConfig>;
}

export function loadConfig(home = homedir()): ChimeraConfig {
  const path = configPath(home);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let config: ChimeraConfig;
  try {
    config = JSON.parse(raw) as ChimeraConfig;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Invalid ${path}: expected an object`);
  }
  validateMcpServers(config.mcpServers, path);
  const result = hostBashPolicySchema.safeParse(config.commandPolicy?.hostBash ?? {});
  if (!result.success) {
    throw new Error(`Invalid commandPolicy.hostBash in ${path}: ${result.error.message}`);
  }
  return config;
}

export function resolveHostBashPolicy(config: ChimeraConfig): HostBashPolicyConfig {
  return {
    enabled: config.commandPolicy?.hostBash?.enabled ?? true,
    mode: config.commandPolicy?.hostBash?.mode ?? 'balanced',
    autoAllowThrough: config.commandPolicy?.hostBash?.autoAllowThrough ?? 'caution',
  };
}

export interface ResolvedModel {
  ref: string;
  model: ModelConfig;
  providersConfig: ProvidersConfig;
}

export interface ResolveModelOpts {
  cliSettings?: string;
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
      settings: opts.cliSettings === undefined ? undefined : parseModelSettings(opts.cliSettings),
      providerId,
      modelId,
      maxSteps: opts.maxSteps ?? 100,
      maxOutputTokens: modelOpts?.maxOutputTokens,
      vision: modelOpts?.vision,
      imageLongEdge: modelOpts?.imageLongEdge,
      toolCallShape: modelOpts?.toolCallShape,
      parallelToolCalls: modelOpts?.parallelToolCalls,
    },
    providersConfig: { providers, defaultModel: opts.config.defaultModel },
  };
}

export function parseModelSettings(value: string): ModelSettings {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('--model-settings must contain a JSON object');
  return parsed;
}
