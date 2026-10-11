import type {
  Checkpoint,
  PermissionDecisionAction,
  SandboxMode,
  SessionId,
  SessionInfo,
} from '@chimera/core';
import type { MutableRefObject } from 'react';
import type { AppProps } from './App';
import type { MultilineBuffer } from './input/buffer';
import type { OverlayDiffEntry } from './OverlayPicker';
import type { PendingPermission } from './permission-queue';
import type { SlashMenuItem } from './SlashMenu';
import type { ScrollbackEntry, SubagentEntry } from './scrollback';
import type { UsageState } from './session-events';
import type { ActiveSession } from './slash-dispatch';

export interface SudoAuthenticationState {
  item: PendingPermission;
  action: PermissionDecisionAction;
  status: 'checking' | 'password' | 'validating';
  error?: string;
}

/** What the transcript pane lets the key handler do. Fullscreen layout only. */
export interface TranscriptScroller {
  /** Negative scrolls toward earlier output. */
  scrollBy(lines: number): void;
  /** A page is the pane's height less one line of overlap. */
  scrollPages(pages: number): void;
  toEnd(): void;
}

/**
 * Everything a layout draws, built once by the App controller. A layout
 * reads it and calls its handlers; it keeps no session state of its own.
 */
export interface AppView {
  props: AppProps;
  columns: number;
  rows: number;
  sandboxMode: SandboxMode;
  activeSession: ActiveSession;
  /** Set when the session shown is a fork or a subagent of another. */
  activeParentId: SessionId | null;

  /** Entries before the commit cursor never change again. */
  committedEntries: ScrollbackEntry[];
  inFlightEntries: ScrollbackEntry[];
  childrenByParent: Map<string, SubagentEntry[]>;
  /** Bumped when the transcript is thrown away, so a layout redraws from nothing. */
  transcriptEpoch: number;
  showHeader: boolean;

  running: boolean;
  compacting: boolean;
  streaming: boolean;
  retry: { attempt: number; maxAttempts: number } | null;
  runSteps: number;
  spinner: string;
  inFlightTool: { name: string; label?: string; summary: string } | null;
  /** When the activity in progress began; null when idle. */
  runStartedAt: number | null;
  /** Output tokens produced since the activity began. */
  runOutputTokens: number;

  tasks: { content: string; status: string }[];
  queue: string[];
  usageState: UsageState | null;
  activeModeName: string;
  pendingModeName: string | null;
  currentModelRef: string;
  visionRouteRef: string | null;

  buffer: MultilineBuffer;
  editorOpen: boolean;
  helpOpen: boolean;
  menuItems: SlashMenuItem[];
  menuHighlight: number;
  fileMenuItems: string[];
  fileMenuHighlight: number;

  pending: PendingPermission | null;
  sudoAuthentication: SudoAuthenticationState | null;
  overlayPicker: OverlayDiffEntry[] | null;
  sessionPicker: SessionInfo[] | null;
  rewindPicker: Checkpoint[] | null;
  onResolve: (action: PermissionDecisionAction) => void;
  submitSudoPassword: (password: Uint8Array) => Promise<void>;
  cancelSudoAuthentication: () => void;
  applyOverlaySelection: (selection: { paths: string[] } | null) => void;
  cancelSessionPicker: () => void;
  selectSession: (sessionId: SessionId) => void;
  cancelRewind: () => void;
  rewindTo: (checkpoint: Checkpoint) => void;
  forkFrom: (checkpoint: Checkpoint) => void;

  panelOpen: boolean;
  scrollerRef: MutableRefObject<TranscriptScroller | null>;
}

/** A permission prompt, a password prompt or a picker has the keyboard. */
export function dialogOpen(view: AppView): boolean {
  return (
    view.pending !== null ||
    view.sudoAuthentication !== null ||
    view.overlayPicker !== null ||
    view.sessionPicker !== null ||
    view.rewindPicker !== null
  );
}
