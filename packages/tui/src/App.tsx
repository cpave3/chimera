import { ChimeraClient, ChimeraHttpError } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type {
  AgentEvent,
  Checkpoint,
  ModelConfig,
  PermissionDecisionAction,
  SandboxMode,
  SessionId,
  SessionInfo,
  SessionStatus,
  Usage,
} from '@chimera/core';
import type { ModeRegistry } from '@chimera/modes';
import type { SkillRegistry } from '@chimera/skills';
import { useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { parseAttachTokens, readForAttach } from './attach-paths';
import { runBangCommand } from './bang';
import { isImageFile, readClipboardImage, saveImageToSession } from './clipboard';
import type { Peer } from './ContextPanel';
import { completionContext, listProjectFiles, rankFiles } from './file-completion';
import { FullscreenView } from './FullscreenView';
import { InlineView } from './InlineView';
import { insertText, type MultilineBuffer, replaceAll } from './input/buffer';
import { type OpenInEditorResult, openInEditor as openInEditorImpl } from './input/external-editor';
import { type OpenInPagerResult, openInPager as openInPagerImpl } from './input/pager';
import type { MouseBus } from './input/mouse';
import { PasteRegistry } from './input/paste';
import { handleKey } from './key-handler';
import type { NotificationReason } from './notify';
import type { OverlayDiffEntry } from './OverlayPicker';
import {
  mergePermissionQueue,
  type PendingPermission,
  requiresSudoAuthentication,
} from './permission-queue';
import { previewLine } from './prompt-view';
import type { SlashMenuItem } from './SlashMenu';
import { type Formatter, Scrollback, type ScrollbackEntry, type SubagentEntry } from './scrollback';
import {
  type ActiveSubagent,
  applySessionEvent,
  type SessionHydrationState,
} from './session-events';
import { BUILTIN_COMMANDS, isBuiltin, OVERLAY_COMMANDS } from './slash-commands';
import { dispatchSlash } from './slash-dispatch';
import { useThemeContext } from './theme/ThemeProvider';
import { formatTranscript } from './transcript-text';
import type { AppView, SudoAuthenticationState, TranscriptScroller } from './view';
import type { WorktreeStatus } from './worktree';

function sessionHasActiveRun(status: SessionStatus): boolean {
  return status === 'running' || status === 'waiting_for_permission';
}

function isActiveRunConflict(error: unknown): error is ChimeraHttpError {
  return (
    error instanceof ChimeraHttpError &&
    error.status === 409 &&
    typeof error.body === 'object' &&
    error.body !== null &&
    'error' in error.body &&
    error.body.error === 'run already in progress'
  );
}

export interface OverlayHandlers {
  diff(): Promise<{ modified: string[]; added: string[]; deleted: string[] }>;
  apply(paths?: string[]): Promise<void>;
  discard(): Promise<void>;
}

export interface AppProps {
  client: ChimeraClient;
  sessionId: SessionId;
  modelRef: string;
  /** Resolved model config; needed to drive `/new` and `/fork`. */
  model: ModelConfig;
  cwd: string;
  commands?: CommandRegistry;
  skills?: SkillRegistry;
  modes?: ModeRegistry;
  /** Mode names cycled by Shift+Tab. Default: ["build", "plan"]. */
  cycleModes?: string[];
  /** Initial active mode (overrides registry default). Default: "build". */
  initialMode?: string;
  sandboxMode?: SandboxMode;
  overlay?: OverlayHandlers;
  /**
   * When provided, called by `/reload` to re-compose the system prompt
   * (e.g., after AGENTS.md/AGENTS.local.md/CLAUDE.md changes). Returns the new prompt
   * to send to the server.
   */
  reloadSystemPrompt?: (ctx: { cwd: string }) => Promise<string> | string;
  /**
   * Per-tool scrollback formatters keyed by tool name. Passed to `Scrollback`
   * so it can render formatter summaries during session rehydration. Live
   * tool calls already carry `display` on their events.
   */
  formatters?: Record<string, Formatter>;
  /**
   * Injection point for the Ctrl+G editor handoff. Defaults to the real
   * implementation that uses `process.stdin`/`process.stdout` and treats the
   * mouse as inactive (the inline TUI does not enable mouse tracking).
   */
  openInEditor?: (args: { initialText: string }) => Promise<OpenInEditorResult>;
  /**
   * Lists the files offered after `@` and `#`. Defaults to git's file list
   * for the working directory, with a directory walk outside a repository.
   */
  listFiles?: (cwd: string) => Promise<string[]>;
  /**
   * Injection point for the Ctrl+T transcript view. Defaults to a pager on
   * the real terminal.
   */
  openInPager?: (args: { text: string }) => Promise<OpenInPagerResult>;
  /**
   * Initial message to submit when the TUI mounts (e.g. from `--prompt <text>`).
   * Goes through the same handling as if the user typed it and pressed Enter.
   */
  initialPrompt?: string;
  /** Owner-local authentication performed before resolving a sudo allow action. */
  checkSudo?: (request: { requestId: string; command: string; signal?: AbortSignal }) => Promise<{
    status: 'validated' | 'password_required' | 'unavailable';
    message?: string;
  }>;
  authenticateSudo?: (request: {
    requestId: string;
    command: string;
    password: Uint8Array;
    signal?: AbortSignal;
  }) => Promise<{
    status: 'validated' | 'failed' | 'cancelled' | 'unavailable';
    message?: string;
  }>;
  /** Pending large text pastes captured by the terminal input filter. */
  pasteRegistry?: PasteRegistry;
  /**
   * `inline` prints into the terminal's own scrollback; `fullscreen` owns
   * the alternate screen. Defaults to `inline`; `mountTui` picks the real one.
   */
  layout?: 'fullscreen' | 'inline';
  /** Injection point for tests: the size to lay out for, in place of the terminal's. */
  terminalSize?: { columns: number; rows: number };
  /**
   * Injection point for tests: finished entries the fullscreen transcript
   * mounts at a time. Defaults to 300.
   */
  transcriptWindow?: number;
  /**
   * Reads the working tree for the context panel. Defaults to git in the
   * working directory.
   */
  readWorktree?: (cwd: string) => Promise<WorktreeStatus | null>;
  /** The other live Chimera instances, for the context panel. */
  listPeers?: () => Promise<Peer[]>;
  /** Wheel events, which the terminal input filter takes out of the key stream. */
  mouse?: MouseBus;
  /**
   * Gives the terminal back before an editor or a pager runs, and takes it
   * again after: the alternate screen, and the reports the TUI asked the
   * terminal for.
   */
  screen?: { leave(): void; enter(): void };
  /** Lines to show at the top of the transcript when the TUI starts. */
  startupNotices?: string[];
  /** Called with the session on screen, at start and after every switch. */
  onActiveSessionChange?: (sessionId: SessionId) => void;
  /**
   * Asks for the user's attention: a run ended, a permission request opened,
   * or the agent needs input. `mountTui` turns this into a terminal
   * notification according to the `tui.notifications` setting.
   */
  notify?: (reason: NotificationReason, detail: { runMs: number }) => void;
}

const FILE_MENU_ROWS = 6;
const FILE_LIST_MAX_AGE_MS = 5_000;
const WHEEL_LINES = 3;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function App(props: AppProps): React.ReactElement | null {
  const themeCtx = useThemeContext();
  const fullscreen = props.layout === 'fullscreen';
  const app = useApp();
  const { stdout } = useStdout();
  const scrollback = useMemo(() => new Scrollback(props.formatters), [props.formatters]);
  const { entries, committedCount } = useSyncExternalStore(
    scrollback.subscribe.bind(scrollback),
    scrollback.splitSnapshot.bind(scrollback),
  );
  const [buffer, setBufferState] = useState<MultilineBuffer>({ text: '', cursor: 0 });
  const [permissionQueue, setPermissionQueue] = useState<PendingPermission[]>([]);
  const sessionHydrationRef = useRef<SessionHydrationState>({
    lifecycleEventObserved: false,
    resolvedPermissionIds: new Set(),
  });
  const [sudoAuthentication, setSudoAuthentication] = useState<SudoAuthenticationState | null>(
    null,
  );
  const pending = permissionQueue[0] ?? null;
  const sudoAuthenticationRef = useRef<AbortController | null>(null);
  useEffect(() => () => sudoAuthenticationRef.current?.abort(), []);
  // Active subagents indexed by subagentId. Updated from the parent's stream.
  const subagentsRef = useRef<Map<string, ActiveSubagent>>(new Map());
  // Active session/client. Swapped by `/attach <id>` so the TUI can drill
  // into a child session, then back to the parent.
  const [activeSession, setActiveSession] = useState<{
    client: ChimeraClient;
    sessionId: SessionId;
    label: string;
  }>({ client: props.client, sessionId: props.sessionId, label: 'parent' });
  const activeSessionRef = useRef(activeSession);
  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);
  const { onActiveSessionChange } = props;
  useEffect(() => {
    onActiveSessionChange?.(activeSession.sessionId);
  }, [activeSession.sessionId, onActiveSessionChange]);
  // Ink copies the last frame to the main screen when it leaves the
  // alternate screen. An empty last frame leaves the user's terminal as it
  // was before the session, so the fullscreen layout draws nothing first.
  const [exiting, setExiting] = useState(false);
  const cleanupAndExit = async () => {
    if (!fullscreen) {
      app.exit();
      return;
    }
    setExiting(true);
    setTimeout(() => app.exit(), 0);
  };
  const [overlayPicker, setOverlayPicker] = useState<OverlayDiffEntry[] | null>(null);
  const [sessionPicker, setSessionPicker] = useState<SessionInfo[] | null>(null);
  const [rewindPicker, setRewindPicker] = useState<Checkpoint[] | null>(null);
  // Tracks the active session's parentId for header display; refreshed via
  // `client.getSession()` after switches and forks.
  const [activeParentId, setActiveParentId] = useState<SessionId | null>(null);
  const [running, setRunning] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [bangRunning, setBangRunning] = useState(false);
  const busy = running || compacting || bangRunning;
  const [activeModeName, setActiveModeName] = useState<string>(props.initialMode ?? 'build');
  const [pendingModeName, setPendingModeName] = useState<string | null>(null);
  const [currentModelRef, setCurrentModelRef] = useState<string>(props.modelRef);
  /** Vision model the in-flight turn is routed to; null when not routed. */
  const [visionRouteRef, setVisionRouteRef] = useState<string | null>(null);
  const [terminalColumns, setColumns] = useState<number>(stdout?.columns ?? 80);
  const [terminalRows, setRows] = useState<number>(stdout?.rows ?? 24);
  const columns = props.terminalSize?.columns ?? terminalColumns;
  const rows = props.terminalSize?.rows ?? terminalRows;
  const [lastCtrlC, setLastCtrlC] = useState<number>(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const scrollerRef = useRef<TranscriptScroller | null>(null);
  const [retry, setRetry] = useState<{ attempt: number; maxAttempts: number } | null>(null);
  const [runSteps, setRunSteps] = useState(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [usageState, setUsageState] = useState<{
    usage: Usage;
    contextWindow: number;
    usedContextTokens: number;
    unknownWindow: boolean;
  } | null>(null);
  const [tasks, setTasks] = useState<{ content: string; status: string }[]>([]);
  const wasBusyRef = useRef(false);
  const [menuHighlight, setMenuHighlight] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // Bumped on /clear to remount <Static> so its internal append-cursor resets.
  const [staticEpoch, setStaticEpoch] = useState(0);
  // The welcome header is included in Static's items on the first mount and
  // omitted after /clear so it doesn't reappear mid-session.
  const [showHeader, setShowHeader] = useState(true);
  // Sync mirror of `buffer` so the useInput handler can see the latest value
  // even before React has flushed a render (happens when keys arrive in a
  // burst).
  const bufferRef = useRef<MultilineBuffer>({ text: '', cursor: 0 });
  function setBuffer(next: MultilineBuffer | ((old: MultilineBuffer) => MultilineBuffer)): void {
    setBufferState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      bufferRef.current = value;
      return value;
    });
  }
  // Tracks the user's "intended column" across vertical motions so going up
  // and then back down lands at the original column even on uneven lines.
  const stickyColRef = useRef<number | null>(null);
  // Set while the external editor is open so other input events don't try
  // to mutate the buffer concurrently.
  const editorOpenRef = useRef(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [registryVersion, setRegistryVersion] = useState(0);
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setColumns(stdout.columns ?? 80);
      setRows(stdout.rows ?? 24);
      // The fullscreen layout is laid out again by Ink at the new size.
      if (fullscreen) return;
      // Clear the terminal (screen + scrollback) and home the cursor, then
      // bump the Static epoch so Ink re-emits the historical entries at the
      // new width. Without this, full-width content from previous renders
      // wraps at the old width and leaves stranded rows in scrollback.
      stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setStaticEpoch((n) => n + 1);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, fullscreen]);

  // Surface startup notices and commands-registry warnings once on mount.
  useEffect(() => {
    for (const notice of props.startupNotices ?? []) scrollback.addInfo(notice);
    const reg = props.commands;
    if (!reg) return;
    for (const c of reg.collisions()) {
      scrollback.addInfo(
        `warning: command "${c.name}" at ${c.loserPath} is shadowed by ${c.winnerPath}`,
      );
    }
    for (const cmd of reg.list()) {
      if (isBuiltin(`/${cmd.name}`)) {
        scrollback.addInfo(
          `warning: user command /${cmd.name} is shadowed by the built-in of the same name`,
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to registry reloads so disk changes show up live.
  useEffect(() => {
    const reg = props.commands;
    if (!reg?.onChange) return;
    const unsub = reg.onChange(() => {
      scrollback.addInfo(`commands reloaded (${reg.list().length} total)`);
      setRegistryVersion((v) => v + 1);
    });
    return unsub;
  }, [props.commands, scrollback]);

  const sandboxMode = props.sandboxMode ?? 'off';
  const overlayMode = sandboxMode === 'overlay';

  // Filtered slash-menu items derived from buffer + registry. The menu only
  // appears for a single-line buffer beginning with `/`.
  const menuItems = useMemo<SlashMenuItem[]>(() => {
    const text = buffer.text;
    if (!text.startsWith('/') || text.includes(' ') || text.includes('\n') || menuDismissed)
      return [];
    const partial = text.slice(1).toLowerCase();
    const visibleBuiltins = overlayMode
      ? [...BUILTIN_COMMANDS, ...OVERLAY_COMMANDS]
      : BUILTIN_COMMANDS;
    const builtins: SlashMenuItem[] = visibleBuiltins
      .filter((c) => c.name.toLowerCase().slice(1).includes(partial))
      .map((c) => ({
        name: c.name.slice(1),
        description: c.description,
        kind: 'builtin' as const,
      }));
    const builtinNames = new Set(visibleBuiltins.map((c) => c.name));
    const users: SlashMenuItem[] = (props.commands?.list() ?? [])
      .filter((c) => !builtinNames.has(`/${c.name}`))
      .filter((c) => c.name.toLowerCase().includes(partial))
      .map((c) => ({
        name: c.name,
        description: c.description,
        kind: 'user' as const,
      }));
    // Skills are shadowed by built-ins and commands with the same name.
    const userCmdNames = new Set(users.map((u) => u.name));
    const skills: SlashMenuItem[] = (props.skills?.all() ?? [])
      .filter((s) => !builtinNames.has(`/${s.name}`) && !userCmdNames.has(s.name))
      .filter((s) => s.name.toLowerCase().includes(partial))
      .map((s) => ({
        name: s.name,
        description: s.description,
        kind: 'skill' as const,
      }));
    return [...builtins, ...users, ...skills];
  }, [buffer.text, props.commands, props.skills, menuDismissed, registryVersion, overlayMode]);

  const menuOpen = menuItems.length > 0;

  // File completion: the list under an `@` or `#` word in the prompt.
  const fileContext = useMemo(() => completionContext(buffer), [buffer]);
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const projectFilesLoadedAtRef = useRef(0);
  const [fileMenuHighlight, setFileMenuHighlight] = useState(0);
  const [fileMenuDismissedAt, setFileMenuDismissedAt] = useState<number | null>(null);
  const fileWordStart = fileContext?.start ?? null;
  const fileQuery = fileContext?.query ?? null;
  useEffect(() => {
    if (fileWordStart === null) return;
    if (Date.now() - projectFilesLoadedAtRef.current < FILE_LIST_MAX_AGE_MS) return;
    projectFilesLoadedAtRef.current = Date.now();
    void (props.listFiles ?? listProjectFiles)(props.cwd).then(setProjectFiles, () => {});
  }, [fileWordStart, props.cwd, props.listFiles]);
  useEffect(() => {
    setFileMenuHighlight(0);
  }, [fileQuery]);
  const fileMenuItems = useMemo(
    () =>
      fileContext && fileMenuDismissedAt !== fileContext.start
        ? rankFiles(projectFiles, fileContext.query, FILE_MENU_ROWS)
        : [],
    [fileContext, fileMenuDismissedAt, projectFiles],
  );

  useEffect(() => {
    setMenuHighlight(0);
  }, [buffer.text]);
  useEffect(() => {
    if (!buffer.text.startsWith('/')) setMenuDismissed(false);
  }, [buffer.text]);

  // When the current activity began and how many output tokens the session
  // had by then, so the activity line can show this run's time and tokens.
  const runStartedAtRef = useRef<number | null>(null);
  const runStartOutputTokensRef = useRef(0);
  // How long the run that just ended took, and whether the user ended it.
  const runElapsedRef = useRef(0);
  const interruptedRef = useRef(false);
  if (running && runStartedAtRef.current !== null) {
    runElapsedRef.current = Date.now() - runStartedAtRef.current;
  }
  if (running || compacting) {
    if (runStartedAtRef.current === null) {
      runStartedAtRef.current = Date.now();
      runStartOutputTokensRef.current = usageState?.usage.outputTokens ?? 0;
    }
  } else {
    runStartedAtRef.current = null;
  }

  // Tick the spinner while waiting for a response or compacting.
  useEffect(() => {
    if (!running && !compacting) return;
    const id = setInterval(() => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length), 200);
    return () => clearInterval(id);
  }, [running, compacting]);

  // Keep `activeParentId` in sync with whatever session the TUI is showing,
  // and rehydrate scrollback from the session's persisted messages so a
  // resumed/forked/switched session shows its prior conversation.
  useEffect(() => {
    let cancelled = false;
    const hydrationState: SessionHydrationState = {
      lifecycleEventObserved: false,
      resolvedPermissionIds: new Set(),
    };
    sessionHydrationRef.current = hydrationState;
    setRunning(false);
    setPermissionQueue([]);
    sudoAuthenticationRef.current?.abort();
    sudoAuthenticationRef.current = null;
    setSudoAuthentication(null);
    void (async () => {
      try {
        const s = await activeSession.client.getSession(activeSession.sessionId);
        if (cancelled) return;
        setActiveParentId(s.parentId ?? null);
        if (!hydrationState.lifecycleEventObserved) {
          setRunning(sessionHasActiveRun(s.status));
        }
        setPermissionQueue((queue) =>
          mergePermissionQueue(
            queue,
            (s.pendingPermissions ?? []).filter(
              (request) => !hydrationState.resolvedPermissionIds.has(request.requestId),
            ),
          ),
        );
        // Sync the TUI's UI state with the actual session mode and model.
        setActiveModeName(s.mode);
        setCurrentModelRef(`${s.model.providerId}/${s.model.modelId}`);
        const sessionTasks = (s as { tasks?: { content: string; status: string }[] }).tasks;
        setTasks(Array.isArray(sessionTasks) ? sessionTasks : []);
        // Only rehydrate if the session actually has prior messages — avoids
        // wiping a fresh "/new" session's empty scrollback unnecessarily.
        if (Array.isArray(s.messages) && s.messages.length > 0) {
          scrollback.rehydrateFromSession(s);
        }
      } catch {
        if (!cancelled) setActiveParentId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSession.client, activeSession.sessionId, scrollback]);

  // When a run ends with queued messages, concatenate and send as one turn.
  // When a run ends with queued messages, drain them. Consecutive regular
  // messages are merged into one turn; `!` commands run individually.
  useEffect(() => {
    if (wasBusyRef.current && !busy && queue.length > 0) {
      const items = queue;
      setQueue([]);
      (async () => {
        const regulars: string[] = [];
        for (const item of items) {
          if (item.startsWith('!')) {
            if (regulars.length > 0) {
              await sendUserMessage(regulars.join('\n\n'));
              regulars.length = 0;
            }
            await handleBang(item.slice(1).trim());
          } else {
            regulars.push(item);
          }
        }
        if (regulars.length > 0) {
          await sendUserMessage(regulars.join('\n\n'));
        }
      })();
    }
    wasBusyRef.current = busy;
    // handleSubmit is a stable closure for this purpose; intentional deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue]);

  // Subscribe to events on the active session — re-subscribes when /attach swaps it.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        for await (const ev of activeSession.client.subscribe(activeSession.sessionId, {
          signal: controller.signal,
        })) {
          if (!controller.signal.aborted) apply(ev);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          scrollback.addError(`event stream error: ${(err as Error).message}`);
        }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession.client, activeSession.sessionId]);

  // Auto-submit the initial prompt once on mount, if provided.
  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (props.initialPrompt && !initialPromptSentRef.current) {
      initialPromptSentRef.current = true;
      void handleSubmit(props.initialPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function apply(ev: AgentEvent | { type: 'permission_timeout'; requestId: string }): void {
    applySessionEvent(ev, {
      scrollback,
      sessionHydrationRef,
      subagentsRef,
      setRunning,
      setStreaming,
      setPermissionQueue,
      setVisionRouteRef,
      setUsageState,
      setActiveModeName,
      setPendingModeName,
      setCurrentModelRef,
      setCompacting,
      setTasks,
      setRetry,
      setRunSteps,
      onInputRequired: () => notify?.('input', { runMs: 0 }),
    });
  }

  const { notify } = props;
  const wasRunningRef = useRef(false);
  useEffect(() => {
    // The user who stopped a run is looking at the terminal.
    if (wasRunningRef.current && !running && !interruptedRef.current) {
      notify?.('run_finished', { runMs: runElapsedRef.current });
    }
    if (!running) interruptedRef.current = false;
    wasRunningRef.current = running;
  }, [running, notify]);
  const pendingRequestId = pending?.requestId ?? null;
  useEffect(() => {
    if (pendingRequestId !== null) notify?.('approval', { runMs: 0 });
  }, [pendingRequestId, notify]);

  function interruptRun(): void {
    interruptedRef.current = true;
    void activeSession.client.interrupt(activeSession.sessionId);
    scrollback.addInfo('interrupt sent');
  }

  function setBufferText(text: string): void {
    setBuffer({ text, cursor: text.length });
    stickyColRef.current = null;
  }

  /** Throw the transcript away, on screen and in the store. */
  function resetTranscript(): void {
    // \x1b[2J clears the visible screen, \x1b[3J clears the scrollback
    // buffer (xterm extension honored by most modern terminals), \x1b[H
    // parks the cursor at home so Ink's next frame draws from the top. The
    // fullscreen layout repaints every row itself.
    if (!fullscreen) stdout?.write('\x1b[2J\x1b[3J\x1b[H');
    scrollback.clear();
    setStaticEpoch((n) => n + 1);
    setShowHeader(false);
  }

  const { mouse } = props;
  useEffect(() => {
    if (!fullscreen || !mouse) return;
    return mouse.subscribe((event) => {
      scrollerRef.current?.scrollBy(event.kind === 'wheel-up' ? -WHEEL_LINES : WHEEL_LINES);
    });
  }, [fullscreen, mouse]);

  /** Run a program that takes over the terminal, then take the screen back. */
  async function withScreenHandoff<T>(operation: () => Promise<T>): Promise<T> {
    props.screen?.leave();
    try {
      return await operation();
    } finally {
      props.screen?.enter();
      // The program drew over the screen; nothing Ink remembers of it is true now.
      if (fullscreen) app.rerender();
    }
  }

  useInput((char, key) => {
    handleKey(char, key, {
      props,
      scrollback,
      running,
      pending,
      activeModeName,
      pendingModeName,
      overlayPicker,
      sessionPicker,
      rewindPicker,
      menuItems,
      menuOpen,
      menuHighlight,
      setMenuHighlight,
      setMenuDismissed,
      lastCtrlC,
      setLastCtrlC,
      helpOpen,
      setHelpOpen,
      bufferRef,
      setBuffer,
      setBufferText,
      stickyColRef,
      historyRef,
      historyIdxRef,
      editorOpenRef,
      interruptRun,
      cleanupAndExit,
      runEditorHandoff,
      runTranscriptView,
      handleSubmit,
      handleSlash,
      handlePasteImage,
      queue,
      setQueue,
      fileContext,
      fileMenuItems,
      fileMenuHighlight,
      setFileMenuHighlight,
      setFileMenuDismissedAt,
      fullscreen,
      scrollerRef,
      setPanelOpen,
    });
  });

  async function runEditorHandoff(): Promise<void> {
    if (editorOpenRef.current) return;
    editorOpenRef.current = true;
    setEditorOpen(true);
    try {
      const handler =
        props.openInEditor ??
        ((args: { initialText: string }) =>
          openInEditorImpl({
            initialText: args.initialText,
            mouseActive: false,
            stdout: process.stdout,
            stdin: process.stdin,
          }));
      const result = await withScreenHandoff(() =>
        handler({ initialText: bufferRef.current.text }),
      );
      if (result.ok) {
        setBuffer((b) => replaceAll(b, result.text));
        stickyColRef.current = null;
      } else {
        scrollback.addInfo(`editor: ${result.reason}`);
        setBuffer((b) => ({ ...b }));
      }
    } finally {
      editorOpenRef.current = false;
      setEditorOpen(false);
    }
  }

  async function runTranscriptView(): Promise<void> {
    if (editorOpenRef.current) return;
    editorOpenRef.current = true;
    setEditorOpen(true);
    try {
      const handler =
        props.openInPager ??
        ((args: { text: string }) =>
          openInPagerImpl({ text: args.text, stdout: process.stdout, stdin: process.stdin }));
      const text = formatTranscript(scrollback.all(), { color: props.openInPager === undefined });
      const result = await withScreenHandoff(() => handler({ text }));
      if (!result.ok) scrollback.addInfo(`transcript: ${result.reason}`);
    } finally {
      editorOpenRef.current = false;
      setEditorOpen(false);
    }
  }

  async function handleSubmit(text: string): Promise<void> {
    scrollerRef.current?.toEnd();
    const expandedText = props.pasteRegistry?.expand(text) ?? text;
    props.pasteRegistry?.clear();
    if (expandedText.startsWith('!')) {
      const command = expandedText.slice(1).trim();
      if (command.length === 0) return;
      if (busy) {
        setQueue((q) => [...q, expandedText]);
        return;
      }
      await handleBang(command);
      return;
    }
    if (expandedText.startsWith('/')) {
      handleSlash(expandedText.trim());
      return;
    }
    if (running) {
      void injectMidRun(expandedText);
      return;
    }
    if (busy) {
      // Compacting or a ! command is in flight (no active run to inject into);
      // queue so the message lands as the next turn once the run is idle.
      setQueue((q) => [...q, expandedText]);
      return;
    }
    await sendUserMessage(expandedText);
  }

  async function handleBang(command: string): Promise<void> {
    scrollback.addInfo(`running: ${previewLine(command)}`);
    setBangRunning(true);
    try {
      const result = await runBangCommand(command, props.cwd);
      const lines: string[] = [];
      if (result.stdout) lines.push(result.stdout);
      if (result.stderr) lines.push(result.stderr);
      if (!result.stdout && !result.stderr) lines.push('(no output)');
      const summary = `!${command} (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}${result.killedByBuffer ? ', truncated' : ''})`;
      const outputLines: string[] = [summary];
      if (lines.length > 0) outputLines.push(...lines);
      const output = outputLines.join('\n');
      await activeSession.client.appendMessage(activeSession.sessionId, output);
    } catch (err) {
      scrollback.addError(`! failed: ${(err as Error).message}`);
    } finally {
      setBangRunning(false);
    }
  }

  async function handlePasteImage(): Promise<void> {
    const image = await readClipboardImage();
    if (!image) {
      scrollback.addInfo('clipboard: no image found');
      return;
    }
    try {
      const path = await saveImageToSession(activeSession.sessionId, image);
      const label = `[Image #${pendingImages.length + 1}]`;
      setPendingImages((prev) => [...prev, path]);
      setBuffer((b) => insertText(b, ` ${label}`));
    } catch (err) {
      scrollback.addError(`clipboard paste failed: ${(err as Error).message}`);
    }
  }

  /**
   * Inject a regular user message into the active run so the agent sees it at
   * the next step boundary (usually after the current tool call), instead of
   * queueing it until the run ends. The run loop emits `user_message` at drain
   * time, which renders the "you: ..." scrollback row; we only surface an
   * "injected: ..." info line here for immediate feedback. Attach tokens and
   * images are not processed for mid-run injects — keep it to plain text so
   * the injection is fast and predictable.
   */
  async function injectMidRun(text: string): Promise<void> {
    try {
      await activeSession.client.appendMessage(activeSession.sessionId, text);
      scrollback.addInfo(`injected: ${previewLine(text)}`);
    } catch (err) {
      scrollback.addError(`inject failed: ${(err as Error).message}`);
    }
  }

  async function sendUserMessage(text: string): Promise<void> {
    const session = activeSession;
    const hydrationState = sessionHydrationRef.current;
    const tokens = parseAttachTokens(text, props.cwd);
    const imagePaths: string[] = [...pendingImages];

    for (const token of tokens) {
      if (isImageFile(token.absolute)) {
        imagePaths.push(token.absolute);
        continue;
      }
      try {
        await session.client.addPath(session.sessionId, token.kind, token.absolute);
      } catch (err) {
        const error = err as Error;
        if (error instanceof ChimeraHttpError && error.status === 400) {
          scrollback.addError(`attach ${token.raw}: ${error.message}`);
          continue;
        }
        scrollback.addError(`attach ${token.raw}: ${error.message}`);
        continue;
      }

      const info = await readForAttach(token.absolute);
      if (info.kind === 'missing' || info.kind === 'error') {
        scrollback.addError(`attach ${token.raw}: ${info.body}`);
        continue;
      }

      const prefix = token.kind === 'read' ? '@' : '#';
      try {
        await session.client.appendMessage(
          session.sessionId,
          `[auto-attached ${prefix}${token.raw}]\n${info.body}`,
        );
      } catch (err) {
        scrollback.addError(`attach ${token.raw}: ${(err as Error).message}`);
      }
    }

    setPendingImages([]);
    const cleanText = text.replace(/\[Image #\d+\]/g, '').trim();
    setRunning(true);
    setStreaming(false);
    try {
      for await (const _ev of session.client.send(session.sessionId, cleanText, {
        images: imagePaths.length > 0 ? imagePaths : undefined,
      })) {
        // events flow through subscribe(); send() drives the POST side.
      }
    } catch (err) {
      if (isActiveRunConflict(err)) {
        try {
          await session.client.appendMessage(
            session.sessionId,
            cleanText,
            imagePaths.length > 0 ? imagePaths : undefined,
          );
          const snapshot = await session.client.getSession(session.sessionId);
          if (sessionHydrationRef.current === hydrationState) {
            setRunning(sessionHasActiveRun(snapshot.status));
          }
          scrollback.addInfo(`injected: ${previewLine(cleanText)}`);
          return;
        } catch (appendError) {
          scrollback.addError(`inject failed: ${(appendError as Error).message}`);
          return;
        }
      }
      scrollback.addError(`send failed: ${(err as Error).message}`);
    }
  }

  function handleSlash(raw: string): void {
    dispatchSlash(raw, {
      props,
      scrollback,
      themeCtx,
      activeSession,
      setActiveSession,
      running,
      busy,
      setRunning,
      setStreaming,
      setCompacting,
      setQueue,
      activeModeName,
      pendingModeName,
      setPendingModeName,
      currentModelRef,
      overlayMode,
      setOverlayPicker,
      setSessionPicker,
      setRewindPicker,
      resetTranscript,
      sendUserMessage,
      injectMidRun,
      cleanupAndExit,
    });
  }

  function onResolve(action: PermissionDecisionAction): void {
    if (!pending) return;
    const item = pending;
    if (
      action.decision !== 'deny' &&
      !item.subagent &&
      requiresSudoAuthentication(item.policyAnalysis)
    ) {
      void beginSudoAuthentication(item, action);
      return;
    }
    void resolvePermission(item, action);
  }

  async function beginSudoAuthentication(
    item: PendingPermission,
    action: PermissionDecisionAction,
  ): Promise<void> {
    if (!props.checkSudo || !props.authenticateSudo) {
      scrollback.addError('sudo authentication is unavailable in this client.');
      return;
    }
    const controller = new AbortController();
    sudoAuthenticationRef.current?.abort();
    sudoAuthenticationRef.current = controller;
    setSudoAuthentication({ item, action, status: 'checking' });
    let result: Awaited<ReturnType<NonNullable<AppProps['checkSudo']>>>;
    try {
      result = await props.checkSudo({
        requestId: item.requestId,
        command: item.command,
        signal: controller.signal,
      });
    } catch (err) {
      if (sudoAuthenticationRef.current !== controller || controller.signal.aborted) return;
      sudoAuthenticationRef.current = null;
      setSudoAuthentication(null);
      scrollback.addError(`sudo authentication failed: ${(err as Error).message}`);
      return;
    }
    if (sudoAuthenticationRef.current !== controller) return;
    if (result.status === 'validated') {
      sudoAuthenticationRef.current = null;
      setSudoAuthentication(null);
      await resolvePermission(item, action);
    } else if (result.status === 'password_required') {
      setSudoAuthentication({ item, action, status: 'password' });
    } else {
      sudoAuthenticationRef.current = null;
      setSudoAuthentication(null);
      scrollback.addError(result.message ?? 'sudo authentication is unavailable.');
    }
  }

  async function submitSudoPassword(password: Uint8Array): Promise<void> {
    const authentication = sudoAuthentication;
    if (!authentication || !props.authenticateSudo) {
      password.fill(0);
      return;
    }
    setSudoAuthentication({ ...authentication, status: 'validating', error: undefined });
    const controller = sudoAuthenticationRef.current;
    let result: Awaited<ReturnType<NonNullable<AppProps['authenticateSudo']>>>;
    try {
      result = await props.authenticateSudo({
        requestId: authentication.item.requestId,
        command: authentication.item.command,
        password,
        signal: controller?.signal,
      });
    } catch (err) {
      password.fill(0);
      if (sudoAuthenticationRef.current !== controller || controller?.signal.aborted) return;
      setSudoAuthentication({
        ...authentication,
        status: 'password',
        error: (err as Error).message,
      });
      return;
    }
    password.fill(0);
    if (sudoAuthenticationRef.current !== controller) return;
    if (result.status === 'validated') {
      sudoAuthenticationRef.current = null;
      setSudoAuthentication(null);
      await resolvePermission(authentication.item, authentication.action);
    } else if (result.status === 'failed') {
      setSudoAuthentication({
        ...authentication,
        status: 'password',
        error: result.message,
      });
    } else {
      sudoAuthenticationRef.current = null;
      setSudoAuthentication(null);
      scrollback.addError(result.message ?? 'sudo authentication was cancelled.');
    }
  }

  function cancelSudoAuthentication(): void {
    sudoAuthenticationRef.current?.abort();
    sudoAuthenticationRef.current = null;
    setSudoAuthentication(null);
  }

  async function resolvePermission(
    item: PendingPermission,
    action: PermissionDecisionAction,
  ): Promise<void> {
    const hydrationState = sessionHydrationRef.current;
    const targetClient = item.subagent
      ? new ChimeraClient({ baseUrl: item.subagent.url })
      : activeSession.client;
    const targetSessionId = item.subagent ? item.subagent.sessionId : activeSession.sessionId;
    await targetClient.resolvePermissionAction(targetSessionId, item.requestId, action);
    if (sessionHydrationRef.current !== hydrationState) return;
    hydrationState.resolvedPermissionIds.add(item.requestId);
    setPermissionQueue((queue) => queue.filter((queued) => queued.requestId !== item.requestId));
  }

  // Split entries on the store's commit cursor. `<Static>` renders
  // positionally and append-only (it prints `items.slice(lastLength)`), so
  // the committed list must be a strictly growing prefix of the entry order
  // — per-entry classification here used to insert late-resolving entries
  // before already-printed ones, producing duplicate tool rows and dropped
  // text blocks. The Scrollback store owns finalization now: entries past
  // the cursor (streaming text, pending tools, blocked-but-final entries)
  // render in the dynamic region below until their whole prefix is final.
  //
  // Subagent rows whose `parentEntryId` references another entry are NOT
  // top-level — they're collected into `childrenByParent` and rendered
  // nested inside the parent's box, so the whole spawn_agent group commits
  // atomically when the parent's tool_call_result lands.
  const { committedEntries, inFlightEntries, childrenByParent } = useMemo<{
    committedEntries: ScrollbackEntry[];
    inFlightEntries: ScrollbackEntry[];
    childrenByParent: Map<string, SubagentEntry[]>;
  }>(() => {
    const childrenByParent = new Map<string, SubagentEntry[]>();
    for (const e of entries) {
      if (e.kind === 'subagent' && e.parentEntryId) {
        const arr = childrenByParent.get(e.parentEntryId) ?? [];
        arr.push(e);
        childrenByParent.set(e.parentEntryId, arr);
      }
    }
    const inFlight: ScrollbackEntry[] = [];
    const committed: ScrollbackEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.kind === 'subagent' && e.parentEntryId) continue; // nested child
      (i < committedCount ? committed : inFlight).push(e);
    }
    return { committedEntries: committed, inFlightEntries: inFlight, childrenByParent };
  }, [entries, committedCount]);

  const inFlightTool = useMemo(() => {
    for (let index = inFlightEntries.length - 1; index >= 0; index -= 1) {
      const entry = inFlightEntries[index]!;
      if (entry.kind === 'tool' && entry.toolResult === undefined && !entry.toolError) {
        return { name: entry.toolName, label: entry.displayName, summary: entry.text };
      }
    }
    return null;
  }, [inFlightEntries]);

  function applyOverlaySelection(selection: { paths: string[] } | null): void {
    const offered = overlayPicker ?? [];
    setOverlayPicker(null);
    if (!selection) {
      scrollback.addInfo('apply cancelled');
      return;
    }
    void (async () => {
      try {
        await props.overlay!.apply(selection.paths);
        scrollback.addInfo(`applied ${selection.paths.length}/${offered.length} overlay paths`);
      } catch (err) {
        scrollback.addError(`apply: ${(err as Error).message}`);
      }
    })();
  }

  function cancelSessionPicker(): void {
    setSessionPicker(null);
    scrollback.addInfo('/sessions cancelled');
  }

  function selectSession(selectedId: SessionId): void {
    setSessionPicker(null);
    if (selectedId === activeSession.sessionId) {
      scrollback.addInfo(`already on session ${selectedId.slice(-8)}`);
      return;
    }
    void (async () => {
      try {
        await props.client.resumeSession(selectedId);
        resetTranscript();
        setActiveSession({ client: props.client, sessionId: selectedId, label: 'session' });
        setRunning(false);
        setQueue([]);
        setStreaming(false);
        scrollback.addInfo(`switched to session ${selectedId.slice(-8)}`);
      } catch (err) {
        scrollback.addError(`/sessions: ${(err as Error).message}`);
      }
    })();
  }

  function cancelRewind(): void {
    setRewindPicker(null);
    scrollback.addInfo('/rewind cancelled');
  }

  function rewindTo(checkpoint: Checkpoint): void {
    setRewindPicker(null);
    setRunning(false);
    setQueue([]);
    setStreaming(false);
    void (async () => {
      try {
        const rewindResult = await activeSession.client.rewindSession(
          activeSession.sessionId,
          checkpoint.index,
        );
        resetTranscript();
        const session = await activeSession.client.getSession(activeSession.sessionId);
        if (Array.isArray(session.messages) && session.messages.length > 0) {
          scrollback.rehydrateFromSession(session);
        }
        setBufferText(checkpoint.userMessage);
        scrollback.addInfo(
          rewindResult.workspaceRestored
            ? `rewound to checkpoint ${checkpoint.index} (working tree restored)`
            : `rewound to checkpoint ${checkpoint.index} (conversation only; working tree unchanged)`,
        );
      } catch (err) {
        scrollback.addError(`/rewind: ${(err as Error).message}`);
      }
    })();
  }

  function forkFrom(checkpoint: Checkpoint): void {
    setRewindPicker(null);
    void (async () => {
      try {
        const { sessionId: childId } = await props.client.forkSession(
          activeSession.sessionId,
          undefined,
          checkpoint.index,
        );
        resetTranscript();
        setActiveSession({ client: props.client, sessionId: childId, label: 'forked' });
        setRunning(false);
        setQueue([]);
        setStreaming(false);
        const session = await activeSession.client.getSession(childId);
        if (Array.isArray(session.messages) && session.messages.length > 0) {
          scrollback.rehydrateFromSession(session);
        }
        setBufferText(checkpoint.userMessage);
        scrollback.addInfo(
          `forked from checkpoint ${checkpoint.index} into session ${childId.slice(-8)}`,
        );
      } catch (err) {
        scrollback.addError(`/rewind fork: ${(err as Error).message}`);
      }
    })();
  }

  const view: AppView = {
    props,
    columns,
    rows,
    sandboxMode,
    activeSession,
    activeParentId,
    committedEntries,
    inFlightEntries,
    childrenByParent,
    transcriptEpoch: staticEpoch,
    showHeader,
    running,
    compacting,
    streaming,
    retry,
    runSteps,
    spinner: SPINNER_FRAMES[spinnerFrame]!,
    inFlightTool,
    runStartedAt: runStartedAtRef.current,
    runOutputTokens: (usageState?.usage.outputTokens ?? 0) - runStartOutputTokensRef.current,
    tasks,
    queue,
    usageState,
    activeModeName,
    pendingModeName,
    currentModelRef,
    visionRouteRef,
    buffer,
    editorOpen,
    helpOpen,
    menuItems,
    menuHighlight,
    fileMenuItems,
    fileMenuHighlight,
    pending,
    sudoAuthentication,
    overlayPicker,
    sessionPicker,
    rewindPicker,
    onResolve,
    submitSudoPassword,
    cancelSudoAuthentication,
    applyOverlaySelection,
    cancelSessionPicker,
    selectSession,
    cancelRewind,
    rewindTo,
    forkFrom,
    panelOpen,
    scrollerRef,
  };

  if (exiting) return null;
  return fullscreen ? <FullscreenView view={view} /> : <InlineView view={view} />;
}

/**
 * Synthesize the user message sent when the user invokes a skill via
 * `/skillName [args]`. The message names the skill and its SKILL.md path so
 * the model reads it (firing `skill_activated`), and appends any args as the
 * user's request.
 */
