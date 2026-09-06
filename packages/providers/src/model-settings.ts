import type { ProviderOptions } from '@chimera/core';
import {
  MODEL_SETTING_TYPES,
  type ModelCapabilities,
  type ModelSettings,
  type SettingCapability,
  validateModelSettings,
} from '@chimera/core';
import type { ProviderSpec } from './types';

const choice = (values: string[], defaultValue?: string): SettingCapability => ({
  status: 'supported',
  type: 'enum',
  values,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});

export function assertModelCapabilities(value: unknown): asserts value is ModelCapabilities {
  const capability = value as ModelCapabilities | null;
  if (
    !capability ||
    capability.schemaVersion !== 1 ||
    typeof capability.modelId !== 'string' ||
    typeof capability.profile !== 'string' ||
    typeof capability.source !== 'string' ||
    typeof capability.fingerprint !== 'string' ||
    !capability.settings ||
    typeof capability.settings !== 'object' ||
    Array.isArray(capability.settings)
  )
    throw new Error('Invalid model capability descriptor');
  for (const [key, setting] of Object.entries(capability.settings)) {
    if (
      !setting ||
      !['supported', 'unsupported', 'unknown'].includes(setting.status) ||
      !['enum', 'number', 'boolean'].includes(setting.type) ||
      (Object.hasOwn(MODEL_SETTING_TYPES, key) &&
        setting.type !== MODEL_SETTING_TYPES[key as keyof ModelSettings]) ||
      (setting.status === 'supported' &&
        setting.type === 'enum' &&
        (!Array.isArray(setting.values) ||
          !setting.values.length ||
          setting.values.some((item) => typeof item !== 'string'))) ||
      (setting.min !== undefined && !Number.isFinite(setting.min)) ||
      (setting.max !== undefined && !Number.isFinite(setting.max))
    )
      throw new Error(`Invalid model capability: ${key}`);
  }
}

export function localCapabilities(modelId: string, spec: ProviderSpec): ModelCapabilities {
  const compatible = spec.adapter === 'compatible' || spec.capabilitySource === 'manticore';
  const settings = Object.fromEntries(
    Object.entries(MODEL_SETTING_TYPES).map(([key, type]) => [
      key,
      {
        status: 'unknown',
        type,
        reason: 'No verified settings profile. Configure capabilities for this model.',
      },
    ]),
  ) as Record<string, SettingCapability>;
  let host = '';
  try {
    host = new URL(spec.baseUrl).hostname;
  } catch {
    /* Unknown hosts require explicit profiles. */
  }
  const profile =
    spec.requestProfile ??
    (spec.shape === 'anthropic'
      ? 'anthropic'
      : host === 'api.openai.com'
        ? 'openai-chat'
        : ['api.synthetic.new', 'api.z.ai', 'api.moonshot.ai', 'api.moonshot.cn'].includes(host) &&
            /(?:^|\/)(?:GLM-(?:4\.[567](?:-(?:flashx?|airx?|x))?|5(?:\.[123])?(?:-flash)?)|kimi-k2\.(?:[56]|7-code(?:-highspeed)?))$/i.test(
              modelId,
            )
          ? 'thinking'
          : 'unknown');
  if (profile !== 'unknown' && profile !== 'codex') {
    settings.maxOutputTokens = { status: 'supported', type: 'number', min: 1, integer: true };
  }
  if (profile === 'openai-chat') {
    settings.parallelToolCalls = { status: 'supported', type: 'boolean' };
    settings.temperature = { status: 'supported', type: 'number', min: 0, max: 2 };
    settings.topP = { status: 'supported', type: 'number', min: 0, max: 1 };
    const modern = /^gpt-(?:5\.[456]|6)/.test(modelId);
    if (/^(?:gpt-5|gpt-6|o[134])/.test(modelId)) {
      const canDisable = /^gpt-5\.[12456]/.test(modelId) && !modelId.includes('codex');
      settings.thinking = choice(canDisable ? ['on', 'off'] : ['on']);
      settings.reasoningEffort = choice([
        ...(canDisable ? ['none'] : []),
        'low',
        'medium',
        'high',
        ...(modern ? ['xhigh'] : []),
        ...(compatible && /^gpt-(?:5\.6|6)/.test(modelId) ? ['max'] : []),
      ]);
      settings.verbosity = choice(['low', 'medium', 'high']);
      settings.serviceTier = choice(['auto', 'default', 'flex', 'priority']);
    }
  } else if (profile === 'anthropic') {
    settings.parallelToolCalls = { status: 'supported', type: 'boolean', default: true };
    const outputMax = /claude-(?:opus-4-[67]|sonnet-4-6)/.test(modelId)
      ? 128000
      : /claude-(?:sonnet-4-|(?:opus|haiku)-4-5)/.test(modelId)
        ? 64000
        : /claude-opus-4-/.test(modelId)
          ? 32000
          : undefined;
    if (outputMax) settings.maxOutputTokens.max = outputMax;
    settings.temperature = { status: 'supported', type: 'number', min: 0, max: 1 };
    settings.topP = { status: 'supported', type: 'number', min: 0, max: 1 };
    if (modelId.includes('claude-opus-4-7')) {
      settings.temperature = {
        status: 'unsupported',
        type: 'number',
        reason: 'This model does not accept sampling parameters.',
      };
      settings.topP = {
        status: 'unsupported',
        type: 'number',
        reason: 'This model does not accept sampling parameters.',
      };
    }
    if (/claude-(?:opus|sonnet)-4-[67]/.test(modelId)) {
      settings.thinking = choice(['off', 'adaptive'], 'off');
      settings.reasoningEffort = choice([
        'low',
        'medium',
        'high',
        ...(modelId.includes('opus-4-7') ? ['xhigh'] : []),
        ...(modelId.includes('opus') ? ['max'] : []),
      ]);
    } else if (
      /claude-(?:3-7-sonnet|(?:opus|sonnet)-4(?:-[015])?|haiku-4-5)(?:-\d{8})?$/.test(modelId)
    ) {
      settings.thinking = choice(['on', 'off']);
      settings.thinkingBudgetTokens = {
        status: 'supported',
        type: 'number',
        min: 1024,
        integer: true,
      };
    }
  } else if (profile === 'thinking' || profile === 'template') {
    settings.thinking = compatible
      ? choice(/(?:glm-5\.3|kimi-k2\.7-code)/i.test(modelId) ? ['on'] : ['on', 'off'])
      : {
          status: 'unsupported',
          type: 'enum',
          reason: 'Select adapter: compatible to use this thinking profile.',
        };
    if (profile === 'thinking' && /(?:^|\/)glm-/i.test(modelId)) {
      settings.temperature = { status: 'supported', type: 'number', min: 0, max: 1 };
      settings.topP = { status: 'supported', type: 'number', min: 0.01, max: 1 };
      if (compatible && /glm-5\.[23]/i.test(modelId))
        settings.reasoningEffort = choice(
          /glm-5\.3/i.test(modelId) ? ['low', 'high', 'max'] : ['high', 'max'],
          'max',
        );
    }
    if (profile === 'thinking' && /kimi-k2\./i.test(modelId)) {
      settings.temperature = {
        status: 'unsupported',
        type: 'number',
        reason: 'Kimi fixes sampling values for each thinking mode.',
      };
      settings.topP = {
        status: 'unsupported',
        type: 'number',
        reason: 'Kimi fixes top-p at 0.95.',
      };
    }
  }
  return {
    schemaVersion: 1,
    modelId,
    profile,
    source: spec.requestProfile ? 'configuration' : 'built-in',
    fingerprint: JSON.stringify({ modelId, profile, settings }),
    settings,
  };
}

export function resolveModelSettings(
  spec: ProviderSpec,
  capabilities: ModelCapabilities,
  defaults: ModelSettings = {},
  overrides: ModelSettings = {},
  extensions: Record<string, unknown> = {},
): { settings: ModelSettings; providerOptions?: ProviderOptions } {
  assertModelCapabilities(capabilities);
  validateModelSettings(overrides, capabilities);
  const settings = { ...defaults, ...overrides };
  if (settings.thinking === 'off') {
    delete settings.thinkingBudgetTokens;
    delete settings.reasoningEffort;
  }
  // Legacy output/tool defaults predate capability metadata. Do not present an
  // unenforced Codex output cap as an effective setting or reject old sessions.
  for (const key of Object.keys(settings) as (keyof ModelSettings)[]) {
    if (capabilities.settings[key]?.status === 'unsupported' && overrides[key] === undefined)
      delete settings[key];
  }
  const known = Object.fromEntries(
    Object.entries(settings).filter(([key]) => capabilities.settings[key]?.status === 'supported'),
  );
  validateModelSettings(known, capabilities);
  if (
    capabilities.profile === 'anthropic' &&
    settings.thinking !== 'off' &&
    (settings.thinking !== undefined || settings.reasoningEffort !== undefined)
  ) {
    if (settings.temperature !== undefined || settings.topP !== undefined)
      throw new Error('Sampling settings cannot be combined with Anthropic thinking');
    if (settings.thinking === 'on' && settings.thinkingBudgetTokens === undefined)
      throw new Error('Thinking On requires a thinking budget');
  }
  if (
    capabilities.profile === 'anthropic' &&
    settings.temperature !== undefined &&
    settings.topP !== undefined
  )
    throw new Error('Anthropic accepts either temperature or topP, not both');
  if (
    capabilities.profile === 'openai-chat' &&
    capabilities.settings.reasoningEffort.status === 'supported' &&
    settings.thinking !== 'off' &&
    settings.reasoningEffort !== 'none' &&
    (settings.temperature !== undefined || settings.topP !== undefined)
  )
    throw new Error('Sampling settings require reasoning to be off for this model');
  const forbidden = new Set([
    'model',
    'messages',
    'tools',
    'tool_choice',
    'stream',
    'headers',
    'authorization',
    'apiKey',
    'reasoning_effort',
    'reasoning',
    'text_verbosity',
    'effort',
    'reasoningEffort',
    'thinking',
    'reasoning_summary',
    'verbosity',
    'textVerbosity',
    'service_tier',
    'temperature',
    'top_p',
    'max_tokens',
    'max_completion_tokens',
    'parallel_tool_calls',
    'chat_template_kwargs',
    ...Object.keys(MODEL_SETTING_TYPES),
  ]);
  for (const key of Object.keys(extensions))
    if (forbidden.has(key))
      throw new Error(`Provider extension conflicts with a managed field: ${key}`);
  const options: Record<string, unknown> = { ...extensions };
  const compatible = spec.adapter === 'compatible' || spec.capabilitySource === 'manticore';
  if (!compatible && Object.keys(extensions).length)
    throw new Error('Provider extensions require adapter: compatible so fields are not discarded');
  if (spec.shape === 'anthropic') {
    if (settings.parallelToolCalls !== undefined)
      options.disableParallelToolUse = !settings.parallelToolCalls;
    if (settings.thinking !== undefined)
      options.thinking =
        settings.thinking === 'off'
          ? { type: 'disabled' }
          : settings.thinking === 'adaptive'
            ? { type: 'adaptive' }
            : { type: 'enabled', budgetTokens: settings.thinkingBudgetTokens };
    if (settings.reasoningEffort !== undefined) options.effort = settings.reasoningEffort;
  } else {
    if (settings.reasoningEffort !== undefined) options.reasoningEffort = settings.reasoningEffort;
    if (settings.verbosity !== undefined) options.textVerbosity = settings.verbosity;
    if (settings.parallelToolCalls !== undefined)
      options[compatible ? 'parallel_tool_calls' : 'parallelToolCalls'] =
        settings.parallelToolCalls;
    if (settings.serviceTier !== undefined)
      options[compatible ? 'service_tier' : 'serviceTier'] = settings.serviceTier;
    if (settings.reasoningSummary !== undefined) {
      if (!compatible) throw new Error('Reasoning summaries require a compatible request profile');
      options.reasoning_summary = settings.reasoningSummary;
    }
    if (settings.thinking !== undefined) {
      if (capabilities.profile === 'thinking')
        options.thinking = { type: settings.thinking === 'off' ? 'disabled' : 'enabled' };
      else if (capabilities.profile === 'template')
        options.chat_template_kwargs = { enable_thinking: settings.thinking !== 'off' };
      else if (settings.thinking === 'off') options.reasoningEffort = 'none';
      else options.reasoningEffort ??= capabilities.settings.reasoningEffort.default ?? 'medium';
    }
    if (
      !compatible &&
      (settings.reasoningEffort === 'max' ||
        settings.reasoningEffort === 'ultra' ||
        (settings.thinking !== undefined &&
          (capabilities.profile === 'thinking' || capabilities.profile === 'template')))
    ) {
      throw new Error('This setting requires adapter: compatible in the provider configuration');
    }
  }
  return {
    settings,
    providerOptions: Object.keys(options).length
      ? ({
          [spec.shape === 'anthropic' ? 'anthropic' : compatible ? 'chimera' : 'openai']: options,
        } as ProviderOptions)
      : undefined,
  };
}
