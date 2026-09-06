export interface ModelSettings {
  thinking?: 'on' | 'off' | 'adaptive';
  reasoningEffort?: string;
  thinkingBudgetTokens?: number;
  reasoningSummary?: string;
  verbosity?: string;
  serviceTier?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  parallelToolCalls?: boolean;
}

export type ModelSettingsPatch = { [Key in keyof ModelSettings]?: ModelSettings[Key] | null };

export interface SettingCapability {
  status: 'supported' | 'unsupported' | 'unknown';
  type: 'enum' | 'number' | 'boolean';
  values?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  default?: string | number | boolean;
  reason?: string;
}

export interface ModelCapabilities {
  /** Absent means unknown; a text-only array explicitly excludes image input. */
  inputModalities?: Array<'text' | 'image'>;
  schemaVersion: 1;
  modelId: string;
  profile: string;
  source: string;
  fingerprint: string;
  settings: Record<string, SettingCapability>;
}

export interface ModelSettingsState {
  model: string;
  overrides: ModelSettings;
  defaults: ModelSettings;
  effective: ModelSettings;
  capabilities: ModelCapabilities;
}

export const MODEL_SETTING_TYPES: Record<keyof ModelSettings, SettingCapability['type']> = {
  thinking: 'enum',
  reasoningEffort: 'enum',
  thinkingBudgetTokens: 'number',
  reasoningSummary: 'enum',
  verbosity: 'enum',
  serviceTier: 'enum',
  maxOutputTokens: 'number',
  temperature: 'number',
  topP: 'number',
  parallelToolCalls: 'boolean',
};

export function patchModelSettings(
  current: ModelSettings,
  patch: ModelSettingsPatch,
): ModelSettings {
  const result = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(MODEL_SETTING_TYPES, key)) throw new Error(`Unknown model setting: ${key}`);
    if (value === null) delete result[key as keyof ModelSettings];
    else if (value !== undefined) Object.assign(result, { [key]: value });
  }
  return result;
}

export function validateModelSettings(
  settings: ModelSettings,
  capabilities: ModelCapabilities,
): void {
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    const capability = capabilities.settings[key];
    if (!Object.hasOwn(MODEL_SETTING_TYPES, key)) throw new Error(`Unknown model setting: ${key}`);
    if (capability?.status !== 'supported')
      throw new Error(
        `${key}: ${capability?.reason ?? 'Supported values are unknown for this model.'}`,
      );
    if (
      capability.type === 'enum' &&
      (typeof value !== 'string' || !capability.values?.includes(value))
    ) {
      throw new Error(`${key} must be one of: ${capability.values?.join(', ')}`);
    }
    if (capability.type === 'boolean' && typeof value !== 'boolean')
      throw new Error(`${key} must be a boolean`);
    if (
      capability.type === 'number' &&
      (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (capability.integer && !Number.isInteger(value)) ||
        (capability.min !== undefined && value < capability.min) ||
        (capability.max !== undefined && value > capability.max))
    )
      throw new Error(`${key} is outside the supported range`);
  }
  if (
    settings.thinking === 'off' &&
    (settings.thinkingBudgetTokens !== undefined ||
      (settings.reasoningEffort !== undefined && settings.reasoningEffort !== 'none'))
  ) {
    throw new Error('Thinking Off conflicts with an explicit effort or budget');
  }
  if (settings.thinking === 'on' && settings.reasoningEffort === 'none')
    throw new Error('Thinking On conflicts with effort none');
  if (
    settings.thinkingBudgetTokens !== undefined &&
    settings.maxOutputTokens !== undefined &&
    settings.thinkingBudgetTokens >= settings.maxOutputTokens
  )
    throw new Error('Thinking budget must be smaller than the output limit');
}
