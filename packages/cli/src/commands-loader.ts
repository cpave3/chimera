import { loadCommands, ReloadingCommandRegistry, type CommandRegistry } from '@chimera/commands';
import type { ChimeraConfig } from './config';

export interface LoadRegistryOpts {
  cwd: string;
  home?: string;
  config: ChimeraConfig;
  /** If set, overrides `config.commands.claudeCompat` (from `--no-claude-compat`). */
  claudeCompatOverride?: boolean;
  onWarning?: (msg: string) => void;
}

/**
 * Empty-registry stand-in for when `commands.enabled === false`. Avoids forcing
 * every consumer to branch on `undefined` vs. real registry.
 */
const EMPTY_REGISTRY: CommandRegistry = {
  list: () => [],
  find: () => undefined,
  expand: (name: string) => {
    throw new Error(`unknown command: ${name}`);
  },
  collisions: () => [],
};

export function loadCommandsFromConfig(opts: LoadRegistryOpts): CommandRegistry {
  const enabled = opts.config.commands?.enabled !== false;
  if (!enabled) return EMPTY_REGISTRY;

  const claudeCompat = opts.claudeCompatOverride ?? opts.config.commands?.claudeCompat ?? true;

  return loadCommands({
    cwd: opts.cwd,
    userHome: opts.home,
    includeClaudeCompat: claudeCompat,
    onWarning: opts.onWarning,
  });
}

/**
 * Interactive TUI variant: returns a registry that watches its tier
 * directories and reloads on change. The caller is responsible for calling
 * `close()` when the TUI exits. When commands are disabled via config, returns
 * the shared empty registry (no watcher installed).
 */
export function loadReloadingCommandsFromConfig(opts: LoadRegistryOpts): CommandRegistry {
  const enabled = opts.config.commands?.enabled !== false;
  if (!enabled) return EMPTY_REGISTRY;

  const claudeCompat = opts.claudeCompatOverride ?? opts.config.commands?.claudeCompat ?? true;

  return new ReloadingCommandRegistry({
    cwd: opts.cwd,
    userHome: opts.home,
    includeClaudeCompat: claudeCompat,
    onWarning: opts.onWarning,
  });
}
