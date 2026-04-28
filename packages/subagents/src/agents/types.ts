export type AgentSource =
  | 'project'
  | 'ancestor'
  | 'user'
  | 'claude-project'
  | 'claude-ancestor'
  | 'claude-user';

export interface AgentDefinition {
  /** Matches the basename of the source `.md` file. */
  name: string;
  /** One-sentence description from frontmatter (required). */
  description: string;
  /** Body of the markdown file — used as the subagent's system prompt verbatim. */
  body: string;
  /** Absolute path to the agent definition file. */
  path: string;
  /** Which tier resolved this agent. */
  source: AgentSource;
  /** Raw frontmatter object, preserving any optional fields. */
  frontmatter: Record<string, string>;
}

export interface AgentCollision {
  name: string;
  winner: AgentSource;
  loser: AgentSource;
  winnerPath: string;
  loserPath: string;
}

export interface LoadAgentsOptions {
  cwd: string;
  /** Defaults to `os.homedir()`. */
  userHome?: string;
  /** Defaults to true. When false, the three `.claude/agents/` tiers are skipped. */
  includeClaudeCompat?: boolean;
  /** Invoked once per skipped file or tier collision. */
  onWarning?: (message: string) => void;
}

export interface AgentRegistry {
  /** Every resolved agent, stable-sorted by name. */
  all(): AgentDefinition[];
  find(name: string): AgentDefinition | undefined;
  /**
   * Markdown listing of `<name> — <description>` lines suitable for
   * appending to the spawn-tool's tool description. Empty string when no
   * agents are defined.
   */
  buildDescriptionIndex(): string;
  collisions(): AgentCollision[];
}
