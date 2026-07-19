export type SkillSource =
  | 'project'
  | 'ancestor'
  | 'user'
  | 'claude-project'
  | 'claude-ancestor'
  | 'claude-user'
  | 'codex-project'
  | 'codex-ancestor'
  | 'codex-user'
  | 'agents-project'
  | 'agents-ancestor'
  | 'agents-user';

export interface Skill {
  /** Matches the directory name that contains the SKILL.md file. */
  name: string;
  /** One-sentence description from frontmatter (required). */
  description: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Which tier resolved this skill. */
  source: SkillSource;
  /** Raw frontmatter object, preserving any optional fields (version, license, …). */
  frontmatter: Record<string, string>;
}

export interface SkillCollision {
  name: string;
  winner: SkillSource;
  loser: SkillSource;
  winnerPath: string;
  loserPath: string;
}

export interface LoadSkillsOptions {
  cwd: string;
  /** Defaults to `os.homedir()`. */
  userHome?: string;
  /** Defaults to true. When false, the three `.claude/skills/` tiers are skipped. */
  includeClaudeCompat?: boolean;
  /** Defaults to true. When false, the three `.codex/skills/` tiers are skipped. */
  includeCodexCompat?: boolean;
  /**
   * Defaults to true. When true, the three `.agents/skills/` tiers (project /
   * ancestor / user-home) are searched after the `.codex/` tiers as a
   * cross-tool compatibility root. When false, they are skipped.
   */
  includeAgentsCompat?: boolean;
  /** Invoked once per skipped file or tier collision. */
  onWarning?: (message: string) => void;
}

export interface SkillRegistry {
  /** Every resolved skill, stable-sorted by name. */
  all(): Skill[];
  find(name: string): Skill | undefined;
  /** Set of absolute SKILL.md paths (for activation detection). */
  paths(): Set<string>;
  /**
   * Produces a system-prompt block listing resolved skills, or the empty
   * string when the registry is empty.
   */
  buildIndex(): string;
  collisions(): SkillCollision[];
}
