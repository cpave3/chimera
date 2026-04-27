import { loadModes, type ModeRegistry } from '@chimera/modes';
import type { ChimeraConfig } from './config';

export interface LoadModesOpts {
  cwd: string;
  home?: string;
  config: ChimeraConfig;
  /** If set, overrides `config.modes.claudeCompat`. */
  claudeCompatOverride?: boolean;
  /** If true, skip discovery and return the empty registry (`--no-modes`). */
  modesDisabled?: boolean;
  onWarning?: (msg: string) => void;
}

const EMPTY_REGISTRY: ModeRegistry = {
  all: () => [],
  find: () => undefined,
  paths: () => new Set<string>(),
  collisions: () => [],
};

export function loadModesFromConfig(opts: LoadModesOpts): ModeRegistry {
  const configDisabled = opts.config.modes?.enabled === false;
  if (configDisabled || opts.modesDisabled) return EMPTY_REGISTRY;

  const claudeCompat = opts.claudeCompatOverride ?? opts.config.modes?.claudeCompat ?? true;

  return loadModes({
    cwd: opts.cwd,
    userHome: opts.home,
    includeClaudeCompat: claudeCompat,
    onWarning: opts.onWarning,
  });
}
