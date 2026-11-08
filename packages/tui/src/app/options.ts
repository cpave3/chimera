import type { ChimeraClient } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type {
  HostAuthenticationCheckResult,
  HostAuthenticationResult,
  ModelConfig,
  SandboxMode,
  SessionId,
} from '@chimera/core';
import type { ModeRegistry } from '@chimera/modes';
import type { SkillRegistry } from '@chimera/skills';
import type { OpenFileInEditorResult, OpenInEditorResult } from '../input/external-editor';
import type { OpenInPagerResult } from '../input/pager';
import type { StatusLineConfig } from '../ledger/status-line';
import type { NotificationSetting } from '../notify';
import type { Formatter } from '../scrollback';
import type { TuiLayout } from '../theme/loader';
import type { WorktreeStatus } from '../worktree';

export interface OverlayHandlers {
  diff(): Promise<{ modified: string[]; added: string[]; deleted: string[] }>;
  apply(paths?: string[]): Promise<void>;
  discard(): Promise<void>;
}

/** What the TUI is mounted with: the session, its registries, and the hooks it calls. */
export interface TuiOptions {
  client: ChimeraClient;
  sessionId: SessionId;
  modelRef: string;
  /** Resolved model config; `/new` and `/fork` create sessions with it. */
  model: ModelConfig;
  cwd: string;
  commands?: CommandRegistry;
  skills?: SkillRegistry;
  modes?: ModeRegistry;
  /** Mode names cycled by Shift+Tab; default every mode that cycles. */
  cycleModes?: string[];
  /** The mode to start in. Default `build`. */
  initialMode?: string;
  sandboxMode?: SandboxMode;
  /** Host commands run in the operating system's sandbox. */
  osSandbox?: boolean;
  overlay?: OverlayHandlers;
  /** Called by `/reload` to compose the system prompt again. */
  reloadSystemPrompt?: (ctx: { cwd: string; sessionId: SessionId }) => Promise<string> | string;
  /** Scrollback formatters by tool name, for sessions restored from disk. */
  formatters?: Record<string, Formatter>;
  /** A message to send when the TUI starts, as if typed. */
  initialPrompt?: string;
  checkSudo?: (request: {
    requestId: string;
    command: string;
    signal?: AbortSignal;
  }) => Promise<HostAuthenticationCheckResult>;
  authenticateSudo?: (request: {
    requestId: string;
    command: string;
    password: Uint8Array;
    signal?: AbortSignal;
  }) => Promise<HostAuthenticationResult>;
  /** `fullscreen` (the default) or `inline`; a terminal that cannot show fullscreen gets inline. */
  layout?: TuiLayout;
  /** False leaves the mouse to the terminal. */
  mouse?: boolean;
  /** Lines to show at the top of the transcript when the TUI starts. */
  startupNotices?: string[];
  /** The project's `MEMORY.md`, which `/memory` opens. */
  memoryIndexPath?: string;
  /** How to ask for attention: `auto`, `bell` or `off`. */
  notifications?: NotificationSetting;
  /** The status line: rows of built-in items, or a command. */
  statusLine?: StatusLineConfig;
  /** Shown in the banner and given to a status line command. */
  version?: string;

  /** Injection point for Ctrl+G. Defaults to `$VISUAL`/`$EDITOR` on the real terminal. */
  openInEditor?: (args: { initialText: string }) => Promise<OpenInEditorResult>;
  /** Injection point for Ctrl+T. Defaults to a pager on the real terminal. */
  openInPager?: (args: { text: string }) => Promise<OpenInPagerResult>;
  /** Injection point for `/memory`. */
  openFileInEditor?: (args: { path: string }) => Promise<OpenFileInEditorResult>;
  /** The files offered after `@` and `#`. Defaults to git's file list. */
  listFiles?: (cwd: string) => Promise<string[]>;
  /** The git branch and its ahead/behind counts, for the status line. Defaults to git. */
  readWorktree?: (cwd: string) => Promise<WorktreeStatus | null>;
}
