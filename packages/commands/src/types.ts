export type CommandSource = 'project' | 'ancestor' | 'user' | 'claude-project' | 'claude-ancestor' | 'claude-user';

export interface Command {
  name: string;
  description?: string;
  body: string;
  path: string;
  source: CommandSource;
}

export interface LoadCommandsOptions {
  cwd: string;
  userHome?: string;
  includeClaudeCompat?: boolean;
  onWarning?: (msg: string) => void;
}

export interface CommandRegistry {
  list(): Command[];
  find(name: string): Command | undefined;
  expand(name: string, args: string, ctx?: ExpandContext): string;
  collisions(): CommandCollision[];
  /** Re-read the source tiers. Only implemented by reloading registries. */
  reload?(): Promise<void>;
  /**
   * Subscribe to change notifications. Returns an unsubscribe fn. Only
   * implemented by reloading registries.
   */
  onChange?(listener: () => void): () => void;
}

export interface ExpandContext {
  cwd?: string;
  date?: Date;
}

export interface CommandCollision {
  name: string;
  winner: CommandSource;
  loser: CommandSource;
  winnerPath: string;
  loserPath: string;
}
