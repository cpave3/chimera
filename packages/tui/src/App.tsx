import { resolve as resolvePath } from 'node:path';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChimeraClient, ChimeraHttpError } from '@chimera/client';
import { parseAttachTokens, readForAttach } from './attach-paths';
import { runBangCommand } from './bang';
import type { CommandRegistry } from '@chimera/commands';
import type {
  AgentEvent,
  Checkpoint,
  ModelConfig,
  SandboxMode,
  SessionId,
  SessionInfo,
  Usage,
} from '@chimera/core';
import type { ModeRegistry } from '@chimera/modes';
import type { SkillRegistry } from '@chimera/skills';
import { Header } from './Header';
import {
  backspace,
  cursorLineCol,
  endsWithUnescapedBackslashAtCursor,
  insertChar,
  insertNewline,
  type MultilineBuffer,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
  replaceAll,
} from './input/buffer';
import { openInEditor as openInEditorImpl, type OpenInEditorResult } from './input/external-editor';
import { renderMarkdown } from './markdown';
import { OverlayPicker, type OverlayDiffEntry } from './OverlayPicker';
import { PermissionModal } from './PermissionModal';
import {
  type Formatter,
  Scrollback,
  type ScrollbackEntry,
  type SubagentEntry,
} from './scrollback';
import { RewindPicker } from './RewindPicker';
import { SessionPicker, buildSessionTreeRows, formatRelativeTime } from './SessionPicker';
import { SlashMenu, type SlashMenuItem } from './SlashMenu';
import {
  BUILTIN_COMMANDS,
  findClosestCommand,
  isBuiltin,
  OVERLAY_COMMANDS,
} from './slash-commands';
import { type StatusBarWidget } from './StatusBar';
import { renderToolBody } from './ToolBody';
import { UsageWidget } from './UsageWidget';
import { ChromeBar } from './ChromeBar';
import { applyThemeByName, listThemes } from './theme/loader';
import { useTheme, useThemeContext } from './theme/ThemeProvider';
import type { Theme } from './theme/types';

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
   * (e.g., after AGENTS.md/CLAUDE.md changes). Returns the new prompt
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
   * Initial message to submit when the TUI mounts (e.g. from `--prompt <text>`).
   * Goes through the same handling as if the user typed it and pressed Enter.
   */
  initialPrompt?: string;
}

interface PendingPermission {
  requestId: string;
  command: string;
  reason?: string;
  /**
   * When set, the request was raised inside a subagent and resolution must
   * be sent to the child's server (via a freshly built ChimeraClient).
   */
  subagent?: {
    id: string;
    purpose: string;
    sessionId: string;
    url: string;
  };
}

interface ActiveSubagent {
  subagentId: string;
  childSessionId: string;
  url: string;
  purpose: string;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CHIMERA_VERSION = '0.1.0';

type StaticItem =
  | { kind: 'header'; id: '__header__' }
  | {
      kind: 'entry';
      id: string;
      entry: ScrollbackEntry;
      children: SubagentEntry[];
    };

export function App(props: AppProps): React.ReactElement {
  const theme = useTheme();
  const themeCtx = useThemeContext();
  const app = useApp();
  const { stdout } = useStdout();
  const scrollback = useMemo(() => new Scrollback(props.formatters), [props.formatters]);
  const { entries, committedCount } = useSyncExternalStore(
    scrollback.subscribe.bind(scrollback),
    scrollback.splitSnapshot.bind(scrollback),
  );
  const [buffer, setBufferState] = useState<MultilineBuffer>({ text: '', cursor: 0 });
  const [pending, setPending] = useState<PendingPermission | null>(null);
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
  const cleanupAndExit = async () => {
    app.exit();
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
  const [columns, setColumns] = useState<number>(stdout?.columns ?? 80);
  const [lastCtrlC, setLastCtrlC] = useState<number>(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
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
  }, [stdout]);

  // Surface commands-registry warnings once on mount.
  useEffect(() => {
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

  useEffect(() => {
    setMenuHighlight(0);
  }, [buffer.text]);
  useEffect(() => {
    if (!buffer.text.startsWith('/')) setMenuDismissed(false);
  }, [buffer.text]);

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
    void (async () => {
      try {
        const s = await activeSession.client.getSession(activeSession.sessionId);
        if (cancelled) return;
        setActiveParentId(s.parentId ?? null);
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
          apply(ev);
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
    if (process.env.CHIMERA_DEBUG_SUBAGENTS) {
      const compact: Record<string, unknown> = { type: ev.type };
      if ('callId' in ev) compact.callId = ev.callId;
      if ('subagentId' in ev) compact.subagentId = ev.subagentId;
      if ('parentCallId' in ev) compact.parentCallId = ev.parentCallId;
      if (ev.type === 'subagent_event') {
        compact.inner = (ev as { event: { type: string } }).event.type;
        const inner = (ev as { event: Record<string, unknown> }).event;
        if ('callId' in inner) compact.innerCallId = inner.callId;
        if ('name' in inner) compact.innerName = inner.name;
      }
      if (ev.type === 'tool_call_start') compact.name = (ev as { name: string }).name;
      process.stderr.write(`[chimera-tui-apply] ${JSON.stringify(compact)}\n`);
    }
    scrollback.apply(ev as AgentEvent);
    const all = scrollback.all();
    if (process.env.CHIMERA_DEBUG_SUBAGENTS && ev.type === 'tool_call_result') {
      const childCount = all.filter(
        (e) => e.kind === 'subagent' && e.parentEntryId !== undefined,
      ).length;
      process.stderr.write(
        `[chimera-tui-apply]   after tool_call_result: total entries=${all.length}, subagent-children=${childCount}\n`,
      );
    }
    if (ev.type === 'assistant_text_delta' || ev.type === 'reasoning_text_delta') {
      setStreaming(true);
    } else if (ev.type === 'permission_request') {
      setPending({ requestId: ev.requestId, command: ev.command, reason: ev.reason });
    } else if (ev.type === 'permission_resolved' || ev.type === 'permission_timeout') {
      setPending(null);
    } else if (ev.type === 'subagent_spawned') {
      subagentsRef.current.set(ev.subagentId, {
        subagentId: ev.subagentId,
        childSessionId: ev.childSessionId,
        url: ev.url,
        purpose: ev.purpose,
      });
    } else if (ev.type === 'subagent_finished') {
      subagentsRef.current.delete(ev.subagentId);
    } else if (ev.type === 'subagent_event') {
      const inner = ev.event;
      const sa = subagentsRef.current.get(ev.subagentId);
      if (inner.type === 'permission_request' && sa && sa.url) {
        setPending({
          requestId: inner.requestId,
          command: inner.command,
          reason: inner.reason,
          subagent: {
            id: ev.subagentId,
            purpose: sa.purpose,
            sessionId: sa.childSessionId,
            url: sa.url,
          },
        });
      } else if (inner.type === 'permission_resolved' || inner.type === 'permission_timeout') {
        setPending((p) => (p && p.requestId === inner.requestId ? null : p));
      }
    } else if (ev.type === 'run_finished') {
      setRunning(false);
      setStreaming(false);
      if (ev.reason !== 'stop') {
        const statusMsg =
          ev.reason === 'max_steps'
            ? "run ended: max steps reached; type 'continue' to resume"
            : ev.reason === 'interrupted'
              ? 'run interrupted'
              : ev.reason === 'timeout'
                ? 'run timed out'
                : `run error: ${ev.error ?? 'unknown'}`;
        scrollback.addInfo(statusMsg);
      }
    } else if (ev.type === 'usage_updated') {
      setUsageState({
        usage: ev.usage,
        contextWindow: ev.contextWindow,
        usedContextTokens: ev.usedContextTokens,
        unknownWindow: ev.unknownWindow,
      });
    } else if (ev.type === 'mode_changed') {
      setActiveModeName(ev.to);
      setPendingModeName(null);
      scrollback.addModeChange(ev.from, ev.to);
    } else if (ev.type === 'model_changed') {
      setCurrentModelRef(ev.to);
      scrollback.addInfo(`model changed: ${ev.from} → ${ev.to}`);
    } else if (ev.type === 'compaction_started') {
      setCompacting(true);
    } else if (ev.type === 'compaction_finished') {
      setCompacting(false);
      const delta = ev.tokensBefore - ev.tokensAfter;
      scrollback.addInfo(
        `compaction done: ${delta > 0 ? `-` : ''}${delta} tokens (${ev.messagesReplaced} messages replaced)`
      );
    } else if (ev.type === 'compaction_failed') {
      setCompacting(false);
      scrollback.addError(`compaction failed: ${ev.error}`);
    } else if (ev.type === 'task_list_updated') {
      setTasks(ev.tasks);
    } else if (ev.type === 'background_process_exited') {
      const outcome =
        ev.status === 'killed'
          ? 'killed'
          : `exited (exit ${ev.exitCode ?? 'unknown'})`;
      scrollback.addInfo(`background process ${ev.shellId} ${outcome}: ${ev.command}`);
    }
  }

  function interruptRun(): void {
    void activeSession.client.interrupt(activeSession.sessionId);
    scrollback.addInfo('interrupt sent');
  }

  function setBufferText(text: string): void {
    setBuffer({ text, cursor: text.length });
    stickyColRef.current = null;
  }

  useInput((char, key) => {
    if (pending) return; // handled by modal
    if (overlayPicker) return; // handled by picker
    if (sessionPicker) return; // handled by SessionPicker
    if (rewindPicker) return; // handled by RewindPicker
    if (editorOpenRef.current) return; // editor is mid-handoff

    if (key.ctrl && char === 'c') {
      if (running) {
        interruptRun();
        return;
      }
      const now = Date.now();
      if (now - lastCtrlC < 2000) {
        void cleanupAndExit();
        return;
      }
      setLastCtrlC(now);
      scrollback.addInfo('press Ctrl+C again to exit');
      return;
    }
    if (key.escape && running && !menuOpen) {
      interruptRun();
      return;
    }
    if (key.ctrl && char === 'd') {
      void cleanupAndExit();
      return;
    }
    if (key.ctrl && char === 'z') {
      if (process.platform === 'win32') {
        // Windows doesn't support SIGTSTP; ignore the key.
        return;
      }
      process.kill(process.pid, 'SIGTSTP');
      return;
    }

    if (key.shift && key.tab) {
      // When `cycleModes` isn't supplied, default to every discovered
      // mode so user-authored files (e.g. ~/.chimera/modes/question.md)
      // are picked up automatically — see add-modes design D9.
      const all = props.modes?.all() ?? [];
      const cycle = props.cycleModes ?? all.map((mode) => mode.name);
      // Modes with cycle: false are excluded from Shift+Tab but remain
      // selectable via /mode <name>.
      const validCycle = cycle.filter((name) => {
        const mode = all.find((m) => m.name === name);
        return mode != null && mode.cycle !== false;
      });
      if (validCycle.length === 0) return;
      const here = pendingModeName ?? activeModeName;
      const idx = validCycle.indexOf(here);
      const nextName = validCycle[(idx + 1) % validCycle.length] ?? validCycle[0]!;
      void handleSlash(`/mode ${nextName}`);
      return;
    }

    const latestBuffer = bufferRef.current;
    const latestText = latestBuffer.text;

    if (menuOpen) {
      if (key.escape) {
        setMenuDismissed(true);
        return;
      }
      if (key.upArrow) {
        setMenuHighlight((h) => Math.max(0, h - 1));
        return;
      }
      if (key.downArrow) {
        setMenuHighlight((h) => Math.min(menuItems.length - 1, h + 1));
        return;
      }
      if (key.tab) {
        const sel = menuItems[menuHighlight];
        if (sel) setBufferText(`/${sel.name} `);
        return;
      }
      if (key.return) {
        const sel = menuItems[menuHighlight];
        if (!sel || latestText === `/${sel.name}`) {
          // fall through to submit below
        } else {
          setBufferText(`/${sel.name} `);
          return;
        }
      }
    }

    if (key.ctrl && char === 'g') {
      void runEditorHandoff();
      return;
    }

    if (key.return) {
      const insertNewlineKey =
        key.shift || key.meta || endsWithUnescapedBackslashAtCursor(latestBuffer);
      if (insertNewlineKey) {
        setBuffer((b) => insertNewline(b));
        stickyColRef.current = null;
        return;
      }
      if (latestText.trim().length === 0) return;
      const text = latestText;
      setBufferText('');
      historyRef.current.push(text);
      historyIdxRef.current = historyRef.current.length;
      void handleSubmit(text);
      return;
    }
    if (key.upArrow) {
      if (latestText.length === 0) {
        if (historyRef.current.length === 0) return;
        historyIdxRef.current = Math.max(0, historyIdxRef.current - 1);
        setBufferText(historyRef.current[historyIdxRef.current] ?? '');
        return;
      }
      const { buf, col } = moveUp(latestBuffer, stickyColRef.current);
      stickyColRef.current = col;
      setBuffer(buf);
      return;
    }
    if (key.downArrow) {
      if (latestText.length === 0) {
        historyIdxRef.current = Math.min(historyRef.current.length, historyIdxRef.current + 1);
        setBufferText(historyRef.current[historyIdxRef.current] ?? '');
        return;
      }
      const { buf, col } = moveDown(latestBuffer, stickyColRef.current);
      stickyColRef.current = col;
      setBuffer(buf);
      return;
    }
    if (key.leftArrow) {
      stickyColRef.current = null;
      setBuffer((b) => moveLeft(b));
      return;
    }
    if (key.rightArrow) {
      stickyColRef.current = null;
      setBuffer((b) => moveRight(b));
      return;
    }
    if (key.ctrl && char === 'a') {
      stickyColRef.current = null;
      setBuffer((b) => moveLineStart(b));
      return;
    }
    if (key.ctrl && char === 'e') {
      stickyColRef.current = null;
      setBuffer((b) => moveLineEnd(b));
      return;
    }
    if (key.tab && latestText.startsWith('/') && !latestText.includes('\n')) {
      const match = BUILTIN_COMMANDS.find((c) => c.name.startsWith(latestText));
      if (match) {
        setBufferText(match.name);
        return;
      }
      const userMatch = props.commands?.list().find((c) => `/${c.name}`.startsWith(latestText));
      if (userMatch) {
        setBufferText(`/${userMatch.name}`);
        return;
      }
      const skillMatch = props.skills?.all().find((s) => `/${s.name}`.startsWith(latestText));
      if (skillMatch) setBufferText(`/${skillMatch.name}`);
      return;
    }
    if (key.backspace || key.delete) {
      // Ink's keypress parser maps `\x7f` (the modern Backspace key) to
      // `key.delete` and `\x08` (legacy / Ctrl+H) to `key.backspace`. The
      // physical Delete key (`[3~`) also lands on `key.delete`, so we can't
      // reliably distinguish it from Backspace — both behave as
      // "delete the char before the cursor", matching the convention used
      // elsewhere in the TUI (e.g. `PermissionModal`).
      stickyColRef.current = null;
      setBuffer((b) => backspace(b));
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      stickyColRef.current = null;
      setBuffer((b) => insertChar(b, char));
    }
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
      const result = await handler({ initialText: bufferRef.current.text });
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

  async function handleSubmit(text: string): Promise<void> {
    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      if (command.length === 0) return;
      if (busy) {
        setQueue((q) => [...q, text]);
        scrollback.addInfo(`queued: ${previewLine(text)}`);
        return;
      }
      await handleBang(command);
      return;
    }
    if (text.startsWith('/')) {
      handleSlash(text.trim());
      return;
    }
    if (busy) {
      setQueue((q) => [...q, text]);
      scrollback.addInfo(`queued: ${previewLine(text)}`);
      return;
    }
    await sendUserMessage(text);
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

  async function sendUserMessage(text: string): Promise<void> {
    const tokens = parseAttachTokens(text, props.cwd);
    for (const token of tokens) {
      try {
        await activeSession.client.addPath(activeSession.sessionId, token.kind, token.absolute);
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
      await activeSession.client.appendMessage(
        activeSession.sessionId,
        `[auto-attached ${prefix}${token.raw}]\n${info.body}`,
      );
    }

    setRunning(true);
    setStreaming(false);
    try {
      for await (const _ev of activeSession.client.send(activeSession.sessionId, text)) {
        // events flow through subscribe(); send() drives the POST side.
      }
    } catch (err) {
      scrollback.addError(`send failed: ${(err as Error).message}`);
    }
  }

  function handleSlash(raw: string): void {
    const [name, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ');
    switch (name) {
      case '/help': {
        const builtinLines = BUILTIN_COMMANDS.map((c) => `${c.name} — ${c.description}`);
        const userLines = (props.commands?.list() ?? []).map(
          (c) => `/${c.name} — ${c.description ?? '(user command)'}`,
        );
        const all =
          userLines.length > 0
            ? [...builtinLines, '', 'User commands:', ...userLines]
            : builtinLines;
        scrollback.addInfo(all.join('\n'));
        return;
      }
      case '/clear':
        // \x1b[2J clears the visible screen, \x1b[3J clears the scrollback
        // buffer (xterm extension honored by most modern terminals), \x1b[H
        // parks the cursor at home so Ink's next frame draws from the top.
        stdout?.write('\x1b[2J\x1b[3J\x1b[H');
        scrollback.clear();
        setShowHeader(false);
        setStaticEpoch((n) => n + 1);
        return;
      case '/exit':
        void cleanupAndExit();
        return;
      case '/model': {
        if (arg) {
          const target = arg === 'default' || arg === 'reset' ? null : arg;
          void (async () => {
            try {
              await activeSession.client.setModel(activeSession.sessionId, target);
              scrollback.addInfo(
                target ? `model set to ${target}` : 'model override cleared',
              );
            } catch (error) {
              scrollback.addError(`/model: ${(error as Error).message}`);
            }
          })();
        } else {
          scrollback.addInfo(`current model: ${currentModelRef}`);
        }
        return;
      }
      case '/add-read-path':
      case '/add-write-path': {
        const kind = name === '/add-read-path' ? 'read' : 'write';
        if (!arg) {
          scrollback.addError(`usage: ${name} <path>`);
          return;
        }
        void (async () => {
          try {
            await activeSession.client.addPath(activeSession.sessionId, kind, arg);
            scrollback.addInfo(`${name}: granted ${kind} access to ${arg}`);
          } catch (err) {
            scrollback.addError(`${name}: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/rules': {
        void (async () => {
          try {
            if (arg.startsWith('rm ')) {
              const idx = Number.parseInt(arg.slice(3).trim(), 10);
              if (!Number.isInteger(idx)) {
                scrollback.addError('usage: /rules rm <index>');
              } else {
                await activeSession.client.removeRule(activeSession.sessionId, idx);
                scrollback.addInfo(`removed rule ${idx}`);
              }
            } else {
              const rules = await activeSession.client.listRules(activeSession.sessionId);
              if (rules.length === 0) scrollback.addInfo('no rules');
              else {
                rules.forEach((r, i) => {
                  scrollback.addInfo(
                    `[${i}] ${r.decision} ${r.tool} ${r.patternKind} ${r.pattern}`,
                  );
                });
              }
            }
          } catch (err) {
            scrollback.addError(`/rules: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/new': {
        void (async () => {
          try {
            const { sessionId: newId } = await props.client.createSession({
              cwd: props.cwd,
              model: props.model,
              sandboxMode: props.sandboxMode ?? 'off',
            });
            stdout?.write('\x1b[2J\x1b[3J\x1b[H');
            scrollback.clear();
            setStaticEpoch((n) => n + 1);
            setShowHeader(false);
            setPendingModeName(null); // Reset pending mode on new session
            setActiveSession({
              client: props.client,
              sessionId: newId,
              label: 'session',
            });
            setRunning(false);
            setQueue([]);
            setStreaming(false);
            scrollback.addInfo(`new session ${newId.slice(-8)}`);
          } catch (err) {
            scrollback.addError(`/new: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/sessions': {
        void (async () => {
          try {
            const allSessions = await props.client.listSessions();
            const sub = rest.join(' ').trim();
            // /sessions all → bypass cwd-scoping for the picker
            const showAll = sub === 'all';
            const targetCwd = resolvePath(props.cwd);
            const scoped = showAll
              ? allSessions
              : allSessions.filter((s) => resolvePath(s.cwd) === targetCwd);
            const scopeLabel = showAll ? '(all directories)' : `in ${props.cwd}`;
            if (sub === 'tree') {
              if (scoped.length === 0) {
                scrollback.addInfo(`no persisted sessions ${scopeLabel}`);
              } else {
                const rows = buildSessionTreeRows(scoped);
                const lines = rows.map((r) => {
                  const truncId = r.info.id.slice(-8);
                  const childMark =
                    r.info.children.length > 0 ? ` (${r.info.children.length})` : '';
                  const marker = r.info.id === activeSession.sessionId ? '  ←' : '';
                  return `${r.prefix}${truncId}${childMark}  ${r.info.messageCount} msg${marker}`;
                });
                scrollback.addInfo(`session tree ${scopeLabel}:\n${lines.join('\n')}`);
              }
              return;
            }
            if (sub.length > 0 && sub !== 'all') {
              // /sessions <id> — always look up against the full set
              const target = allSessions.find((s) => s.id === sub || s.id.endsWith(sub));
              if (!target) {
                scrollback.addError(`/sessions: no session matching ${sub}`);
                return;
              }
              const ancestry: string[] = [];
              {
                const renderedAt = Date.now();
                let cur: SessionInfo | undefined = target;
                while (cur) {
                  ancestry.unshift(
                    `${cur.id.slice(-8)} (${formatRelativeTime(renderedAt, cur.createdAt)})`,
                  );
                  if (!cur.parentId) break;
                  cur = allSessions.find((s) => s.id === cur!.parentId);
                }
              }
              const lines = [
                `id:        ${target.id}`,
                `cwd:       ${target.cwd}`,
                `model:     ${target.model.providerId}/${target.model.modelId}`,
                `parent:    ${target.parentId ?? '(root)'}`,
                `children:  ${target.children.length}`,
                `messages:  ${target.messageCount}`,
                `ancestry:  ${ancestry.join(' → ')}`,
              ];
              scrollback.addInfo(lines.join('\n'));
              return;
            }
            // No sub-arg (or `all`): open interactive picker
            if (scoped.length === 0) {
              scrollback.addInfo(
                `no persisted sessions ${scopeLabel}` +
                  (showAll ? '' : ' — use `/sessions all` to see every session'),
              );
              return;
            }
            setSessionPicker(scoped);
          } catch (err) {
            scrollback.addError(`/sessions: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/fork': {
        const purpose = rest.join(' ').trim();
        void (async () => {
          try {
            const { sessionId: childId, parentId } = await props.client.forkSession(
              activeSession.sessionId,
              purpose.length > 0 ? purpose : undefined,
            );
            stdout?.write('\x1b[2J\x1b[3J\x1b[H');
            scrollback.clear();
            setStaticEpoch((n) => n + 1);
            setShowHeader(false);
            setActiveSession({
              client: props.client,
              sessionId: childId,
              label: 'forked',
            });
            setRunning(false);
            setQueue([]);
            setStreaming(false);
            scrollback.addInfo(
              `forked session ${childId.slice(-8)} from ${parentId.slice(-8)}${
                purpose.length > 0 ? ` (${purpose})` : ''
              }`,
            );
          } catch (err) {
            scrollback.addError(`/fork: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/rewind': {
        if (busy) {
          setQueue((q) => [...q, raw]);
          scrollback.addInfo(`queued: ${previewLine(raw)}`);
          return;
        }
        void (async () => {
          try {
            const checkpoints = await activeSession.client.listCheckpoints(activeSession.sessionId);
            if (checkpoints.length <= 1) {
              scrollback.addInfo('no checkpoints to rewind to');
              return;
            }
            setRewindPicker(checkpoints);
          } catch (err) {
            scrollback.addError(`/rewind: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/subagents': {
        void (async () => {
          try {
            const list = await activeSession.client.listSubagents(activeSession.sessionId);
            if (list.length === 0) {
              scrollback.addInfo('no active subagents');
            } else {
              const lines = list.map(
                (s) => `${s.subagentId}  ${s.purpose}  ${s.status}  ${s.url || '(in-process)'}`,
              );
              const hint =
                '\n\nTo inspect: copy a subagentId, then run `chimera attach <id>` in another terminal,\n' +
                'or use /attach <id> here to drill the TUI into the child.';
              scrollback.addInfo(`subagents:\n${lines.join('\n')}${hint}`);
            }
          } catch (err) {
            scrollback.addError(`/subagents: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/attach': {
        const target = arg.trim();
        if (!target) {
          scrollback.addInfo('usage: /attach <subagentId>');
          return;
        }
        void (async () => {
          try {
            const list = await activeSession.client.listSubagents(activeSession.sessionId);
            const match = list.find(
              (s) => s.subagentId === target || s.subagentId.endsWith(target),
            );
            if (!match) {
              scrollback.addError(`/attach: no subagent matching "${target}"`);
              return;
            }
            if (!match.url) {
              scrollback.addError(
                `/attach: subagent ${match.subagentId} is in-process and not attachable`,
              );
              return;
            }
            const childClient = new ChimeraClient({ baseUrl: match.url });
            scrollback.addInfo(
              `attaching to subagent ${match.subagentId} (${match.purpose}) at ${match.url}`,
            );
            setPendingModeName(null); // Reset pending mode on attach
            setActiveSession({
              client: childClient,
              sessionId: match.sessionId,
              label: `subagent ${match.subagentId.slice(-8)}`,
            });
            // Drop parent-session UI state — its run/queue belong to the
            // parent's stream, which we are no longer subscribed to.
            setRunning(false);
            setQueue([]);
            setStreaming(false);
          } catch (err) {
            scrollback.addError(`/attach: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/detach': {
        if (activeSession.client === props.client && activeSession.sessionId === props.sessionId) {
          scrollback.addInfo('already attached to the parent session');
          return;
        }
        scrollback.addInfo('detaching back to parent session');
        setActiveSession({
          client: props.client,
          sessionId: props.sessionId,
          label: 'parent',
        });
        setRunning(false);
        setQueue([]);
        setStreaming(false);
        return;
      }
      case '/compact': {
        if (busy) {
          setQueue((q) => [...q, raw]);
          scrollback.addInfo(`queued: ${previewLine(raw)}`);
          return;
        }
        setCompacting(true);
        scrollback.addInfo('compacting...');
        void (async () => {
          try {
            await activeSession.client.compact(activeSession.sessionId);
          } catch (err) {
            setCompacting(false);
            scrollback.addError(`/compact: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/reload': {
        const reg = props.commands;
        const reloadFn = reg?.reload;
        if (!reloadFn) {
          scrollback.addInfo('commands: reload not supported in this session.');
          return;
        }
        void (async () => {
          try {
            // Reload user commands.
            await reloadFn.call(reg);
            // Reload AGENTS.md/CLAUDE.md if the hook is provided.
            if (props.reloadSystemPrompt) {
              const newPrompt = await props.reloadSystemPrompt({ cwd: props.cwd });
              await props.client.reloadSession(props.sessionId, newPrompt);
              scrollback.addInfo('system prompt reloaded.');
            } else {
              scrollback.addInfo('commands reloaded.');
            }
          } catch (err) {
            scrollback.addError(`reload failed: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/mode': {
        const target = arg.trim();
        if (!target) {
          const list = props.modes?.all() ?? [];
          if (list.length === 0) {
            scrollback.addInfo('no modes available (mode discovery is disabled).');
          } else {
            const lines = list.map((mode) => {
              const marker = mode.name === activeModeName ? '* ' : '  ';
              const tail = mode.name === activeModeName ? ' (active)' : '';
              return `${marker}${mode.name} — ${mode.description}${tail}`;
            });
            scrollback.addInfo(`Modes:\n${lines.join('\n')}`);
          }
          return;
        }
        const next = props.modes?.find(target);
        if (!next) {
          scrollback.addError(`unknown mode "${target}"`);
          return;
        }
        const effectiveCurrent = pendingModeName ?? activeModeName;
        if (next.name === effectiveCurrent) return;
        setPendingModeName(next.name);
        void (async () => {
          try {
            await activeSession.client.setMode(activeSession.sessionId, next.name);
            if (running) {
              // Mid-run switch: interrupt so the new mode applies as soon as
              // the run terminates rather than after the model finishes its
              // multi-step plan. Any text already streaming is past saving;
              // anything not yet sent will be in the new mode.
              await activeSession.client.interrupt(activeSession.sessionId);
            }
          } catch (err) {
            setPendingModeName(null);
            scrollback.addError(`mode switch failed: ${(err as Error).message}`);
          }
        })();
        return;
      }
      case '/theme': {
        const target = arg.trim();
        if (!target) {
          try {
            const themes = listThemes();
            if (themes.length === 0) {
              scrollback.addInfo('no themes available');
            } else {
              const lines = themes.map((t) => {
                const marker = t.active ? '* ' : '  ';
                const tag = t.source === 'user' ? ' (user)' : '';
                return `${marker}${t.name}${tag}`;
              });
              const hint = '\n\nUse /theme <name> to apply.';
              scrollback.addInfo(`themes:\n${lines.join('\n')}${hint}`);
            }
          } catch (err) {
            scrollback.addError(`/theme: ${(err as Error).message}`);
          }
          return;
        }
        try {
          const applyResult = applyThemeByName(target);
          themeCtx.reload();
          scrollback.addInfo(
            `theme: applied '${target}' (${applyResult.origin === 'user' ? 'user' : 'builtin'}).`,
          );
        } catch (err) {
          scrollback.addError(`/theme: ${(err as Error).message}`);
        }
        return;
      }
      case '/overlay':
      case '/apply':
      case '/discard': {
        if (!overlayMode || !props.overlay) {
          scrollback.addError(`${name} requires --sandbox-mode overlay`);
          return;
        }
        if (name === '/overlay') {
          void (async () => {
            try {
              const diff = await props.overlay!.diff();
              const total = diff.added.length + diff.modified.length + diff.deleted.length;
              if (total === 0) {
                scrollback.addInfo('overlay: no pending changes');
              } else {
                const lines: string[] = [];
                for (const p of diff.added) lines.push(`  + ${p}`);
                for (const p of diff.modified) lines.push(`  ~ ${p}`);
                for (const p of diff.deleted) lines.push(`  - ${p}`);
                scrollback.addInfo(`overlay diff (${total}):\n${lines.join('\n')}`);
              }
            } catch (err) {
              scrollback.addError(`overlay: ${(err as Error).message}`);
            }
          })();
          return;
        }
        if (name === '/apply') {
          void (async () => {
            try {
              const diff = await props.overlay!.diff();
              const entries: OverlayDiffEntry[] = [
                ...diff.added.map<OverlayDiffEntry>((path) => ({ kind: 'added', path })),
                ...diff.modified.map<OverlayDiffEntry>((path) => ({
                  kind: 'modified',
                  path,
                })),
                ...diff.deleted.map<OverlayDiffEntry>((path) => ({
                  kind: 'deleted',
                  path,
                })),
              ];
              if (entries.length === 0) {
                scrollback.addInfo('overlay: no pending changes');
                return;
              }
              setOverlayPicker(entries);
            } catch (err) {
              scrollback.addError(`overlay: ${(err as Error).message}`);
            }
          })();
          return;
        }
        // /discard
        void (async () => {
          try {
            await props.overlay!.discard();
            scrollback.addInfo('overlay discarded');
          } catch (err) {
            scrollback.addError(`discard: ${(err as Error).message}`);
          }
        })();
        return;
      }
      default: {
        const templateName = name!.startsWith('/') ? name!.slice(1) : name!;
        const template = props.commands?.find(templateName);
        if (template) {
          let expanded: string;
          try {
            expanded = props.commands!.expand(templateName, arg, { cwd: props.cwd });
          } catch (err) {
            scrollback.addError(`/${templateName}: ${(err as Error).message}`);
            return;
          }
          scrollback.addUserMessage(raw);
          scrollback.suppressUserMessageMatching(expanded);
          if (running) {
            setQueue((q) => [...q, expanded]);
            scrollback.addInfo(`queued: ${previewLine(raw)}`);
            return;
          }
          void sendUserMessage(expanded);
          return;
        }
        const skill = props.skills?.find(templateName);
        if (skill) {
          const body = expandSkillInvocation(skill.name, skill.path, arg);
          scrollback.addUserMessage(raw);
          scrollback.suppressUserMessageMatching(body);
          if (running) {
            setQueue((q) => [...q, body]);
            scrollback.addInfo(`queued: ${previewLine(raw)}`);
            return;
          }
          void sendUserMessage(body);
          return;
        }
        const suggestion = findClosestCommand(name!, props.commands, props.skills);
        scrollback.addError(
          suggestion
            ? `unknown command: ${name} — did you mean ${suggestion}?`
            : `unknown command: ${name}`,
        );
      }
    }
  }

  function onResolve(
    decision: 'allow' | 'deny',
    remember?:
      | { scope: 'session' }
      | { scope: 'project'; pattern: string; patternKind: 'exact' | 'glob' },
  ): void {
    if (!pending) return;
    const requestId = pending.requestId;
    const subagent = pending.subagent;
    setPending(null);
    const targetClient = subagent
      ? new ChimeraClient({ baseUrl: subagent.url })
      : activeSession.client;
    const targetSessionId = subagent ? subagent.sessionId : activeSession.sessionId;
    void targetClient
      .resolvePermission(targetSessionId, requestId, decision, remember)
      .catch((err) => {
        scrollback.addError(`resolvePermission: ${(err as Error).message}`);
      });
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

  const staticItems = useMemo<StaticItem[]>(() => {
    const entryItems: StaticItem[] = committedEntries.map((e) => ({
      kind: 'entry',
      id: e.id,
      entry: e,
      children: childrenByParent.get(e.id) ?? [],
    }));
    return showHeader ? [{ kind: 'header', id: '__header__' }, ...entryItems] : entryItems;
  }, [committedEntries, childrenByParent, showHeader]);

  const cwdLeft = useMemo<StatusBarWidget[]>(
    () => [
      <Text key="cwd" color={theme.accent.primary}>
        {props.cwd}
      </Text>,
    ],
    [props.cwd, theme.accent.primary],
  );
  const cwdRight = useMemo<StatusBarWidget[]>(
    () => [
      <Text key="sandbox" color={theme.text.muted}>
        {`[sandbox:${sandboxMode}]`}
      </Text>,
    ],
    [sandboxMode, theme.text.muted],
  );
  const activeModeObj = props.modes?.find(activeModeName);
  const pendingModeObj = pendingModeName ? props.modes?.find(pendingModeName) : undefined;
  const modeWidget = useMemo<StatusBarWidget>(() => {
    if (pendingModeObj && pendingModeObj.name !== activeModeName) {
      return (
        <Text>
          <Text color={theme.text.muted}>[mode:</Text>
          <Text color={activeModeObj?.colorHex ?? theme.text.muted}>{activeModeName}</Text>
          <Text color={theme.text.muted}>{' → '}</Text>
          <Text color={pendingModeObj.colorHex}>{pendingModeObj.name}</Text>
          <Text color={theme.text.muted}>]</Text>
        </Text>
      );
    }
    return (
      <Text>
        <Text color={theme.text.muted}>[mode:</Text>
        <Text color={activeModeObj?.colorHex ?? theme.text.muted}>{activeModeName}</Text>
        <Text color={theme.text.muted}>]</Text>
      </Text>
    );
  }, [activeModeName, activeModeObj, pendingModeName, pendingModeObj, theme.text.muted]);
  const modelLeft = useMemo<StatusBarWidget[]>(
    () => [
      modeWidget,
      <Text key="model" color={theme.accent.primary}>
        {currentModelRef}
      </Text>,
      <Text key="session" color={theme.text.muted}>
        {`session ${activeSession.sessionId.slice(-8)}`}
      </Text>,
      activeParentId ? (
        <Text key="forked" color={theme.accent.secondary}>
          (forked)
        </Text>
      ) : null,
    ],
    [modeWidget, currentModelRef, activeSession.sessionId, activeParentId, theme.accent.primary, theme.text.muted, theme.accent.secondary],
  );
  const tasksWidget = useMemo<StatusBarWidget>(() => {
    if (tasks.length === 0) return null;
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const active = tasks.find((task) => task.status === 'in_progress');
    const label = active
      ? `[tasks ${completed}/${tasks.length}: ${active.content.length > 40 ? `${active.content.slice(0, 40)}…` : active.content}]`
      : `[tasks ${completed}/${tasks.length}${completed === tasks.length ? ' done' : ''}]`;
    return (
      <Text key="tasks" color={theme.accent.secondary}>
        {label}
      </Text>
    );
  }, [tasks, theme.accent.secondary]);
  const modelRight = useMemo<StatusBarWidget[]>(
    () => [
      tasksWidget,
      usageState && (
        <UsageWidget
          key="usage"
          usage={usageState.usage}
          contextWindow={usageState.contextWindow}
          usedContextTokens={usageState.usedContextTokens}
          unknownWindow={usageState.unknownWindow}
        />
      ),
    ],
    [tasksWidget, usageState],
  );


  // Steady-state during a run: the buffer is empty and the spinner /
  // streaming deltas re-render App many times per second. Keep the prompt
  // subtree referentially stable across those renders, and collapse the
  // outer layout to a single row when the buffer is single-line so the
  // dynamic frame's height stays exactly 1 — matching the pre-multiline
  // structure that did not flicker.
  const isMultilineBuffer = buffer.text.includes('\n');
  const isBangBuffer = buffer.text.startsWith('!');
  const promptBody = useMemo(
    () => renderPromptLines(buffer, theme.accent.primary, theme.accent.secondary, editorOpen, isBangBuffer),
    [buffer, editorOpen, theme.accent.primary, theme.accent.secondary, isBangBuffer],
  );

  return (
    <>
      <Static key={`static-${staticEpoch}`} items={staticItems}>
        {(item) => {
          if (item.kind === 'header') {
            return (
              <Box key={item.id}>
                <Header
                  version={CHIMERA_VERSION}
                  modelRef={props.modelRef}
                  cwd={props.cwd}
                  sessionId={props.sessionId}
                />
              </Box>
            );
          }
          return (
            <Box key={item.id} flexDirection="column" marginTop={1}>
              {renderEntryLines(item.entry, columns, theme, item.children)}
            </Box>
          );
        }}
      </Static>
      <Box flexDirection="column" width={columns}>
        {inFlightEntries.map((e) => (
          <Box key={e.id} flexDirection="column" marginTop={1}>
            {renderEntryLines(e, columns, theme, childrenByParent.get(e.id) ?? [])}
          </Box>
        ))}
        {running && (
          <Box>
            <Text color={theme.ui.accent}>
              {SPINNER_FRAMES[spinnerFrame]} {streaming ? 'streaming…' : 'waiting…'}
            </Text>
          </Box>
        )}
        {compacting && (
          <Box>
            <Text color={theme.ui.accent}>{SPINNER_FRAMES[spinnerFrame]} compacting…</Text>
          </Box>
        )}
        {queue.length > 0 && (
          <Box>
            <Text color={theme.text.muted}>
              {`queued (${queue.length}): ${previewLine(queue[0]!)}${queue.length > 1 ? ` (+${queue.length - 1} more)` : ''}`}
            </Text>
          </Box>
        )}
        {pending && (
          <PermissionModal
            command={pending.command}
            reason={pending.reason}
            target="host"
            header={
              pending.subagent
                ? `[subagent ${pending.subagent.id.slice(-8)}: ${pending.subagent.purpose}]`
                : undefined
            }
            onResolve={onResolve}
          />
        )}
        {overlayPicker && (
          <OverlayPicker
            entries={overlayPicker}
            onResolve={(selection) => {
              const entries = overlayPicker;
              setOverlayPicker(null);
              if (!selection) {
                scrollback.addInfo('apply cancelled');
                return;
              }
              void (async () => {
                try {
                  await props.overlay!.apply(selection.paths);
                  scrollback.addInfo(
                    `applied ${selection.paths.length}/${entries.length} overlay paths`,
                  );
                } catch (err) {
                  scrollback.addError(`apply: ${(err as Error).message}`);
                }
              })();
            }}
          />
        )}
        {sessionPicker && (
          <SessionPicker
            sessions={sessionPicker}
            currentSessionId={activeSession.sessionId}
            onCancel={() => {
              setSessionPicker(null);
              scrollback.addInfo('/sessions cancelled');
            }}
            onSelect={(selectedId) => {
              setSessionPicker(null);
              if (selectedId === activeSession.sessionId) {
                scrollback.addInfo(`already on session ${selectedId.slice(-8)}`);
                return;
              }
              void (async () => {
                try {
                  await props.client.resumeSession(selectedId);
                  stdout?.write('\x1b[2J\x1b[3J\x1b[H');
                  scrollback.clear();
                  setStaticEpoch((n) => n + 1);
                  setShowHeader(false);
                  setActiveSession({
                    client: props.client,
                    sessionId: selectedId,
                    label: 'session',
                  });
                  setRunning(false);
                  setQueue([]);
                  setStreaming(false);
                  scrollback.addInfo(`switched to session ${selectedId.slice(-8)}`);
                } catch (err) {
                  scrollback.addError(`/sessions: ${(err as Error).message}`);
                }
              })();
            }}
          />
        )}
        {rewindPicker && (
          <RewindPicker
            checkpoints={rewindPicker}
            onCancel={() => {
              setRewindPicker(null);
              scrollback.addInfo('/rewind cancelled');
            }}
            onRewind={(checkpoint) => {
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
                  stdout?.write('\x1b[2J\x1b[3J\x1b[H');
                  scrollback.clear();
                  setStaticEpoch((n) => n + 1);
                  setShowHeader(false);
                  const s = await activeSession.client.getSession(activeSession.sessionId);
                  if (Array.isArray(s.messages) && s.messages.length > 0) {
                    scrollback.rehydrateFromSession(s);
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
            }}
            onFork={(checkpoint) => {
              setRewindPicker(null);
              void (async () => {
                try {
                  const { sessionId: childId } = await props.client.forkSession(
                    activeSession.sessionId,
                    undefined,
                    checkpoint.index,
                  );
                  stdout?.write('\x1b[2J\x1b[3J\x1b[H');
                  scrollback.clear();
                  setStaticEpoch((n) => n + 1);
                  setShowHeader(false);
                  setActiveSession({
                    client: props.client,
                    sessionId: childId,
                    label: 'forked',
                  });
                  setRunning(false);
                  setQueue([]);
                  setStreaming(false);
                  const s = await activeSession.client.getSession(childId);
                  if (Array.isArray(s.messages) && s.messages.length > 0) {
                    scrollback.rehydrateFromSession(s);
                  }
                  setBufferText(checkpoint.userMessage);
                  scrollback.addInfo(
                    `forked from checkpoint ${checkpoint.index} into session ${childId.slice(-8)}`,
                  );
                } catch (err) {
                  scrollback.addError(`/rewind fork: ${(err as Error).message}`);
                }
              })();
            }}
          />
        )}
        {menuOpen && <SlashMenu items={menuItems} highlightIdx={menuHighlight} />}
        <Box
          borderStyle="single"
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.text.muted}
          {...(isMultilineBuffer ? { flexDirection: 'column' as const } : {})}
        >
          {promptBody}
        </Box>
      </Box>
      <ChromeBar
        cwdLeft={cwdLeft}
        cwdRight={cwdRight}
        modelLeft={modelLeft}
        modelRight={modelRight}
        separatorColor={theme.text.muted}
        mutedColor={theme.text.muted}
      />
    </>
  );
}

/**
 * Synthesize the user message sent when the user invokes a skill via
 * `/skillName [args]`. The message names the skill and its SKILL.md path so
 * the model reads it (firing `skill_activated`), and appends any args as the
 * user's request.
 */
function previewLine(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

function renderPromptLines(
  buffer: MultilineBuffer,
  accentColor: string,
  bangColor: string,
  editorOpen: boolean,
  isBang: boolean,
): React.ReactElement[] {
  const allLines = buffer.text.split('\n');
  const { line: cursorLine, col: cursorCol } = cursorLineCol(buffer);
  return allLines.map((lineText, idx) => {
    const isFirst = idx === 0;
    const prefix = isFirst ? (isBang ? 'bash > ' : '> ') : '  ';
    const color = isBang ? bangColor : accentColor;
    const showCursor = idx === cursorLine && !editorOpen;
    if (!showCursor) {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
        <Box key={idx}>
          <Text color={isFirst ? color : undefined}>{prefix}</Text>
          <Text>{lineText}</Text>
        </Box>
      );
    }
    const pre = lineText.slice(0, cursorCol);
    const atChar = cursorCol < lineText.length ? lineText[cursorCol]! : ' ';
    const post = cursorCol < lineText.length ? lineText.slice(cursorCol + 1) : '';
    // Render the cursor line as a single <Text> with embedded SGR inverse
    // escapes so the terminal wraps continuously. Three sibling <Text>
    // nodes (pre / inverse / post) detach the cursor from the text flow
    // because Ink treats each as a separate flex item.
    const lineWithCursor = `${pre}\x1b[7m${atChar}\x1b[27m${post}`;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
      <Box key={idx}>
        <Text color={isFirst ? color : undefined}>{prefix}</Text>
        <Text>{lineWithCursor}</Text>
      </Box>
    );
  });
}

function expandSkillInvocation(name: string, path: string, args: string): string {
  const trimmed = args.trim();
  const head = `Use the "${name}" skill from ${path}.`;
  return trimmed.length > 0 ? `${head}\n\n${trimmed}` : head;
}

/**
 * Hard-wrap `text` into one string per visual line. Splits on explicit `\n`
 * first, then breaks each segment at `width` characters. The first segment's
 * available width is reduced by `firstOffset` to leave room for a prefix
 * like `you: ` or `[host] `.
 */
function wrapToLines(text: string, width: number, firstOffset: number): string[] {
  if (text.length === 0) return [''];
  const available = Math.max(1, width);
  const segments = text.split('\n');
  const out: string[] = [];
  segments.forEach((seg, segIdx) => {
    let remaining = seg;
    let budget = available - (segIdx === 0 ? firstOffset : 0);
    if (budget < 1) budget = 1;
    if (remaining.length === 0) {
      out.push('');
      return;
    }
    while (remaining.length > budget) {
      out.push(remaining.slice(0, budget));
      remaining = remaining.slice(budget);
      budget = available;
    }
    out.push(remaining);
  });
  return out;
}

function renderEntryLines(
  entry: ScrollbackEntry,
  columns: number,
  theme: Theme,
  children: SubagentEntry[] = [],
): React.ReactElement[] {
  const width = Math.max(10, columns);

  if (entry.kind === 'user') {
    const prefix = 'you: ';
    const lines = wrapToLines(entry.text, width, prefix.length);
    return [
      <Box key={`${entry.id}:u`} flexDirection="column">
        <Text>
          <Text color={theme.ui.accent} bold>
            you
          </Text>
          {`: ${lines[0] ?? ''}`}
        </Text>
        {lines.slice(1).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
          <Box key={i} paddingLeft={prefix.length}>
            <Text>{line}</Text>
          </Box>
        ))}
      </Box>,
    ];
  }
  if (entry.kind === 'assistant') {
    return [
      <Box key={`${entry.id}:a`} flexDirection="column" paddingLeft={2}>
        {renderMarkdown(entry.text, theme)}
      </Box>,
    ];
  }
  if (entry.kind === 'thinking') {
    const lines = entry.text.split('\n');
    return [
      <Box key={`${entry.id}:th`} flexDirection="column" paddingLeft={2}>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for split output
          <Text key={i} color={theme.text.muted}>
            {line}
          </Text>
        ))}
      </Box>,
    ];
  }
  if (entry.kind === 'tool') {
    const badge = entry.toolTarget === 'host' ? '[host]' : '[sandbox]';
    const namePrefix = entry.toolName ? `${entry.toolName}: ` : '';
    const prefixLen = badge.length + 1;
    const textLines = wrapToLines(`${namePrefix}${entry.text}`, width, prefixLen);
    const out: React.ReactElement[] = [
      <Box key={`${entry.id}:t`} flexDirection="column">
        <Text>
          <Text color={theme.ui.badge}>{badge}</Text>{' '}
          <Text color={theme.accent.secondary}>{textLines[0] ?? ''}</Text>
        </Text>
        {textLines.slice(1).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
          <Box key={i} paddingLeft={prefixLen}>
            <Text color={theme.accent.secondary}>{line}</Text>
          </Box>
        ))}
        {entry.detail !== undefined &&
          wrapToLines(entry.detail, width, prefixLen).map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
            <Box key={`d${i}`} paddingLeft={prefixLen}>
              <Text color={theme.text.muted}>{line}</Text>
            </Box>
          ))}
        {renderToolBody(entry, { width, prefixLen, theme })}
        {entry.skillName && (
          <Box paddingLeft={prefixLen}>
            <Text color={theme.ui.accent}>📚 skill: {entry.skillName}</Text>
          </Box>
        )}
        {children.map((child, idx) => {
          const isLast = idx === children.length - 1;
          const connector = isLast ? '└ ' : '├ ';
          const childLines = wrapToLines(child.text, width, prefixLen + connector.length);
          return (
            <Box key={`${entry.id}:c:${child.id}`} flexDirection="column" paddingLeft={prefixLen}>
              <Text>
                <Text color={theme.text.muted}>{connector}</Text>
                <Text color={theme.text.muted}>{childLines[0] ?? ''}</Text>
              </Text>
              {childLines.slice(1).map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
                <Box key={i} paddingLeft={connector.length}>
                  <Text color={theme.text.muted}>{line}</Text>
                </Box>
              ))}
              {child.detail !== undefined &&
                wrapToLines(child.detail, width, prefixLen + connector.length).map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
                  <Box key={`cd${i}`} paddingLeft={connector.length}>
                    <Text color={theme.text.muted}>{line}</Text>
                  </Box>
                ))}
            </Box>
          );
        })}
      </Box>,
    ];
    if (entry.toolError) {
      const errLines = wrapToLines(`error: ${entry.toolError}`, width, prefixLen);
      out.push(
        <Box key={`${entry.id}:e`} flexDirection="column" paddingLeft={prefixLen}>
          {errLines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
            <Text key={i} color={theme.status.error}>
              {line}
            </Text>
          ))}
        </Box>,
      );
    }
    return out;
  }
  if (entry.kind === 'subagent') {
    const idShort = entry.subagentId ? entry.subagentId.slice(-4) : '?';
    const labelParts = [`[subagent ${idShort}`];
    if (entry.subagentPurpose) labelParts.push(`: ${entry.subagentPurpose}`);
    labelParts.push(']');
    const label = labelParts.join('');
    const prefix = `${label} `;
    const lines = wrapToLines(entry.text, width, prefix.length + 2);
    return [
      <Box key={`${entry.id}:s`} flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={theme.ui.accent}>{label}</Text>{' '}
          <Text color={theme.text.muted}>{lines[0] ?? ''}</Text>
        </Text>
        {lines.slice(1).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
          <Box key={i} paddingLeft={prefix.length}>
            <Text color={theme.text.muted}>{line}</Text>
          </Box>
        ))}
      </Box>,
    ];
  }
  if (entry.kind === 'info' || entry.kind === 'mode_change') {
    const lines = wrapToLines(entry.text, width, 0);
    return lines.map((line, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
      <Text key={`${entry.id}:${i}`} color={theme.text.muted}>
        {line}
      </Text>
    ));
  }
  const lines = wrapToLines(entry.text, width, 0);
  return lines.map((line, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
    <Text key={`${entry.id}:${i}`} color={theme.status.error}>
      {line}
    </Text>
  ));
}
