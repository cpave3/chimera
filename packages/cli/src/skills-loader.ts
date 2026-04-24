import { loadSkills, type SkillRegistry } from '@chimera/skills';
import type { ChimeraConfig } from './config';

export interface LoadSkillsOpts {
  cwd: string;
  home?: string;
  config: ChimeraConfig;
  /** If set, overrides `config.skills.claudeCompat` (from `--no-claude-compat`). */
  claudeCompatOverride?: boolean;
  /** If true, skip discovery and return the empty registry (from `--no-skills`). */
  skillsDisabled?: boolean;
  onWarning?: (msg: string) => void;
}

const EMPTY_REGISTRY: SkillRegistry = {
  all: () => [],
  find: () => undefined,
  paths: () => new Set<string>(),
  collisions: () => [],
  buildIndex: () => '',
};

export function loadSkillsFromConfig(opts: LoadSkillsOpts): SkillRegistry {
  const configDisabled = opts.config.skills?.enabled === false;
  if (configDisabled || opts.skillsDisabled) return EMPTY_REGISTRY;

  const claudeCompat =
    opts.claudeCompatOverride ?? opts.config.skills?.claudeCompat ?? true;

  return loadSkills({
    cwd: opts.cwd,
    userHome: opts.home,
    includeClaudeCompat: claudeCompat,
    onWarning: opts.onWarning,
  });
}
