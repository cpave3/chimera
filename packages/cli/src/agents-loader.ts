import { type AgentRegistry, loadAgents, ReloadingAgentRegistry } from '@chimera/subagents';
import type { ChimeraConfig } from './config';

export interface LoadAgentsOpts {
  cwd: string;
  home?: string;
  config: ChimeraConfig;
  /** If set, overrides `config.agents.claudeCompat` (from `--no-claude-compat`). */
  claudeCompatOverride?: boolean;
  /** If true, skip discovery and return the empty registry (from `--no-agents`). */
  agentsDisabled?: boolean;
  onWarning?: (msg: string) => void;
}

const EMPTY_REGISTRY: AgentRegistry = {
  all: () => [],
  find: () => undefined,
  collisions: () => [],
  buildDescriptionIndex: () => '',
};

export function loadAgentsFromConfig(opts: LoadAgentsOpts): AgentRegistry {
  const configDisabled = opts.config.agents?.enabled === false;
  if (configDisabled || opts.agentsDisabled) return EMPTY_REGISTRY;

  const claudeCompat = opts.claudeCompatOverride ?? opts.config.agents?.claudeCompat ?? true;

  return loadAgents({
    cwd: opts.cwd,
    userHome: opts.home,
    includeClaudeCompat: claudeCompat,
    onWarning: opts.onWarning,
  });
}

/**
 * Interactive TUI variant: watches tier dirs and reloads on `*.md` changes.
 * Caller is responsible for `close()` when the TUI exits. When agents are
 * disabled via config, returns the empty registry (no watcher).
 */
export function loadReloadingAgentsFromConfig(opts: LoadAgentsOpts): AgentRegistry {
  const configDisabled = opts.config.agents?.enabled === false;
  if (configDisabled || opts.agentsDisabled) return EMPTY_REGISTRY;

  const claudeCompat = opts.claudeCompatOverride ?? opts.config.agents?.claudeCompat ?? true;

  return new ReloadingAgentRegistry({
    cwd: opts.cwd,
    userHome: opts.home,
    includeClaudeCompat: claudeCompat,
    onWarning: opts.onWarning,
  });
}
