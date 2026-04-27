export type ModeSource =
  | 'project'
  | 'ancestor'
  | 'user'
  | 'claude-project'
  | 'claude-ancestor'
  | 'claude-user'
  | 'builtin';

export interface Mode {
  /** Filename stem (sans `.md`). Equals frontmatter `name` after validation. */
  name: string;
  /** One-sentence description from frontmatter. Required. */
  description: string;
  /** The markdown body after the frontmatter, used verbatim as a system-prompt fragment. */
  body: string;
  /**
   * Tool-name allowlist. `undefined` means "no allowlist" (all registered tools
   * are available). `[]` means "no tools at all" (pure-text mode).
   */
  tools?: string[];
  /** Optional `providerId/modelId` reference. Soft default for the mode. */
  model?: string;
  /** Raw `color:` from frontmatter, if any. May or may not be a valid hex. */
  rawColor?: string;
  /** Always-set resolved `#rrggbb` color (lowercase). Either parsed from `rawColor` or derived from `name`. */
  colorHex: string;
  /** Absolute path to the mode file. */
  path: string;
  /** Which discovery tier resolved this mode. */
  source: ModeSource;
}

export interface ModeCollision {
  name: string;
  winner: ModeSource;
  loser: ModeSource;
  winnerPath: string;
  loserPath: string;
}

export interface LoadModesOptions {
  cwd: string;
  /** Defaults to `os.homedir()`. */
  userHome?: string;
  /** Defaults to true. When false, the three `.claude/modes/` tiers are skipped. */
  includeClaudeCompat?: boolean;
  /** Invoked once per skipped file or tier collision. */
  onWarning?: (message: string) => void;
}

export interface ModeRegistry {
  /** Every resolved mode, stable-sorted by name. */
  all(): Mode[];
  find(name: string): Mode | undefined;
  /** Set of absolute mode-file paths. */
  paths(): Set<string>;
  collisions(): ModeCollision[];
}

export class ModeValidationError extends Error {
  constructor(
    message: string,
    public readonly modeName: string,
    public readonly tier: 'schema' | 'tools' | 'provider' | 'live',
  ) {
    super(message);
    this.name = 'ModeValidationError';
  }
}
