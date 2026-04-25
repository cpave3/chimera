import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChimeraClient } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type { AgentEvent, SandboxMode, SessionId, Usage } from '@chimera/core';
import type { SkillRegistry } from '@chimera/skills';
import { Header } from './Header';
import { renderMarkdown } from './markdown';
import { OverlayPicker, type OverlayDiffEntry } from './OverlayPicker';
import { PermissionModal } from './PermissionModal';
import { Scrollback, type ScrollbackEntry } from './scrollback';
import { SlashMenu, type SlashMenuItem } from './SlashMenu';
import {
  BUILTIN_COMMANDS,
  findClosestCommand,
  isBuiltin,
  OVERLAY_COMMANDS,
} from './slash-commands';
import { StatusBar, type StatusBarWidget } from './StatusBar';
import { renderToolBody } from './ToolBody';
import { UsageWidget } from './UsageWidget';
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
  cwd: string;
  commands?: CommandRegistry;
  skills?: SkillRegistry;
  sandboxMode?: SandboxMode;
  overlay?: OverlayHandlers;
  /**
   * When provided, called by `/reload` to re-compose the system prompt
   * (e.g., after AGENTS.md/CLAUDE.md changes). Returns the new prompt
   * to send to the server.
   */
  reloadSystemPrompt?: (ctx: { cwd: string }) => Promise<string> | string;
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
      children: ScrollbackEntry[];
    };

export function App(props: AppProps): React.ReactElement {
  const theme = useTheme();
  const themeCtx = useThemeContext();
  const app = useApp();
  const { stdout } = useStdout();
  const scrollback = useMemo(() => new Scrollback(), []);
  const [entries, setEntries] = useState<ScrollbackEntry[]>([]);
  const [input, setInputState] = useState('');
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
  const [overlayPicker, setOverlayPicker] = useState<OverlayDiffEntry[] | null>(null);
  const [running, setRunning] = useState(false);
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
  const wasRunningRef = useRef(false);
  // Id of the assistant entry currently receiving text deltas. Held out of
  // <Static> so its text can keep updating; committed once text_done fires.
  const [streamingEntryId, setStreamingEntryId] = useState<string | null>(null);
  const [menuHighlight, setMenuHighlight] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  // Bumped on /clear to remount <Static> so its internal append-cursor resets.
  const [staticEpoch, setStaticEpoch] = useState(0);
  // The welcome header is included in Static's items on the first mount and
  // omitted after /clear so it doesn't reappear mid-session.
  const [showHeader, setShowHeader] = useState(true);
  // Sync mirror of `input` so the useInput handler can see the latest value
  // even before React has flushed a render (happens when keys arrive in a
  // burst).
  const inputRef = useRef('');
  function setInput(next: string | ((old: string) => string)): void {
    setInputState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      inputRef.current = value;
      return value;
    });
  }
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
    setEntries(scrollback.all());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to registry reloads so disk changes show up live.
  useEffect(() => {
    const reg = props.commands;
    if (!reg?.onChange) return;
    const unsub = reg.onChange(() => {
      scrollback.addInfo(`commands reloaded (${reg.list().length} total)`);
      setEntries(scrollback.all());
      setRegistryVersion((v) => v + 1);
    });
    return unsub;
  }, [props.commands, scrollback]);

  const sandboxMode = props.sandboxMode ?? 'off';
  const overlayMode = sandboxMode === 'overlay';

  // Filtered slash-menu items derived from input + registry.
  const menuItems = useMemo<SlashMenuItem[]>(() => {
    if (!input.startsWith('/') || input.includes(' ') || menuDismissed) return [];
    const partial = input.slice(1).toLowerCase();
    const visibleBuiltins = overlayMode
      ? [...BUILTIN_COMMANDS, ...OVERLAY_COMMANDS]
      : BUILTIN_COMMANDS;
    const builtins: SlashMenuItem[] = visibleBuiltins
      .filter((c) => c.name.toLowerCase().slice(1).startsWith(partial))
      .map((c) => ({
        name: c.name.slice(1),
        description: c.description,
        kind: 'builtin' as const,
      }));
    const builtinNames = new Set(visibleBuiltins.map((c) => c.name));
    const users: SlashMenuItem[] = (props.commands?.list() ?? [])
      .filter((c) => !builtinNames.has(`/${c.name}`))
      .filter((c) => c.name.toLowerCase().startsWith(partial))
      .map((c) => ({
        name: c.name,
        description: c.description,
        kind: 'user' as const,
      }));
    // Skills are shadowed by built-ins and commands with the same name.
    const userCmdNames = new Set(users.map((u) => u.name));
    const skills: SlashMenuItem[] = (props.skills?.all() ?? [])
      .filter((s) => !builtinNames.has(`/${s.name}`) && !userCmdNames.has(s.name))
      .filter((s) => s.name.toLowerCase().startsWith(partial))
      .map((s) => ({
        name: s.name,
        description: s.description,
        kind: 'skill' as const,
      }));
    return [...builtins, ...users, ...skills];
  }, [input, props.commands, props.skills, menuDismissed, registryVersion, overlayMode]);

  const menuOpen = menuItems.length > 0;

  useEffect(() => {
    setMenuHighlight(0);
  }, [input]);
  useEffect(() => {
    if (!input.startsWith('/')) setMenuDismissed(false);
  }, [input]);

  // Tick the spinner while waiting for a response.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [running]);

  // When a run ends with queued messages, concatenate and send as one turn.
  useEffect(() => {
    if (wasRunningRef.current && !running && queue.length > 0) {
      const combined = queue.join('\n\n');
      setQueue([]);
      void sendUserMessage(combined);
    }
    wasRunningRef.current = running;
    // sendUserMessage is a stable closure for this purpose; intentional deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, queue]);

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
          setEntries(scrollback.all());
        }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession.client, activeSession.sessionId]);

  function apply(ev: AgentEvent | { type: 'permission_timeout'; requestId: string }): void {
    scrollback.apply(ev as AgentEvent);
    const all = scrollback.all();
    setEntries(all);
    if (ev.type === 'assistant_text_delta') {
      setStreaming(true);
      const last = all[all.length - 1];
      if (last?.kind === 'assistant') {
        setStreamingEntryId((prev) => (prev === last.id ? prev : last.id));
      }
    } else if (ev.type === 'assistant_text_done') {
      setStreamingEntryId(null);
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
      } else if (
        inner.type === 'permission_resolved' ||
        inner.type === 'permission_timeout'
      ) {
        setPending((p) => (p && p.requestId === inner.requestId ? null : p));
      }
    } else if (ev.type === 'run_finished') {
      setRunning(false);
      setStreaming(false);
      setStreamingEntryId(null);
    } else if (ev.type === 'usage_updated') {
      setUsageState({
        usage: ev.usage,
        contextWindow: ev.contextWindow,
        usedContextTokens: ev.usedContextTokens,
        unknownWindow: ev.unknownWindow,
      });
    }
  }

  function interruptRun(): void {
    void activeSession.client.interrupt(activeSession.sessionId);
    scrollback.addInfo('interrupt sent');
    setEntries(scrollback.all());
  }

  useInput((char, key) => {
    if (pending) return; // handled by modal
    if (overlayPicker) return; // handled by picker

    if (key.ctrl && char === 'c') {
      if (running) {
        interruptRun();
        return;
      }
      const now = Date.now();
      if (now - lastCtrlC < 2000) {
        app.exit();
        return;
      }
      setLastCtrlC(now);
      scrollback.addInfo('press Ctrl+C again to exit');
      setEntries(scrollback.all());
      return;
    }
    if (key.escape && running && !menuOpen) {
      interruptRun();
      return;
    }
    if (key.ctrl && char === 'd') {
      app.exit();
      return;
    }

    const latestInput = inputRef.current;

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
        if (sel) setInput(`/${sel.name} `);
        return;
      }
      if (key.return) {
        const sel = menuItems[menuHighlight];
        if (!sel || latestInput === `/${sel.name}`) {
          // fall through to submit below
        } else {
          setInput(`/${sel.name} `);
          return;
        }
      }
    }

    if (key.return) {
      if (latestInput.trim().length === 0) return;
      const text = latestInput;
      setInput('');
      historyRef.current.push(text);
      historyIdxRef.current = historyRef.current.length;
      void handleSubmit(text);
      return;
    }
    if (key.upArrow && latestInput.length === 0) {
      if (historyRef.current.length === 0) return;
      historyIdxRef.current = Math.max(0, historyIdxRef.current - 1);
      setInput(historyRef.current[historyIdxRef.current] ?? '');
      return;
    }
    if (key.downArrow && latestInput.length === 0) {
      historyIdxRef.current = Math.min(
        historyRef.current.length,
        historyIdxRef.current + 1,
      );
      setInput(historyRef.current[historyIdxRef.current] ?? '');
      return;
    }
    if (key.tab && latestInput.startsWith('/')) {
      const match = BUILTIN_COMMANDS.find((c) => c.name.startsWith(latestInput));
      if (match) {
        setInput(match.name);
        return;
      }
      const userMatch = props.commands
        ?.list()
        .find((c) => `/${c.name}`.startsWith(latestInput));
      if (userMatch) {
        setInput(`/${userMatch.name}`);
        return;
      }
      const skillMatch = props.skills
        ?.all()
        .find((s) => `/${s.name}`.startsWith(latestInput));
      if (skillMatch) setInput(`/${skillMatch.name}`);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((i) => i.slice(0, -1));
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      setInput((i) => i + char);
    }
  });

  async function handleSubmit(text: string): Promise<void> {
    if (text.startsWith('/')) {
      handleSlash(text.trim());
      return;
    }
    if (running) {
      setQueue((q) => [...q, text]);
      scrollback.addInfo(`queued: ${previewLine(text)}`);
      setEntries(scrollback.all());
      return;
    }
    await sendUserMessage(text);
  }

  async function sendUserMessage(text: string): Promise<void> {
    setRunning(true);
    setStreaming(false);
    try {
      for await (const _ev of activeSession.client.send(activeSession.sessionId, text)) {
        // events flow through subscribe(); send() drives the POST side.
      }
    } catch (err) {
      scrollback.addError(`send failed: ${(err as Error).message}`);
      setEntries(scrollback.all());
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
        setEntries(scrollback.all());
        return;
      }
      case '/clear':
        // \x1b[2J clears the visible screen, \x1b[3J clears the scrollback
        // buffer (xterm extension honored by most modern terminals), \x1b[H
        // parks the cursor at home so Ink's next frame draws from the top.
        stdout?.write('\x1b[2J\x1b[3J\x1b[H');
        scrollback.clear();
        setEntries([]);
        setStreamingEntryId(null);
        setShowHeader(false);
        setStaticEpoch((n) => n + 1);
        return;
      case '/exit':
        app.exit();
        return;
      case '/model': {
        if (arg) {
          scrollback.addInfo(
            `changing model at runtime is not yet implemented; start a new session with -m ${arg}.`,
          );
        } else {
          scrollback.addInfo(`current model: ${props.modelRef}`);
        }
        setEntries(scrollback.all());
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
          setEntries(scrollback.all());
        })();
        return;
      }
      case '/new':
      case '/sessions': {
        scrollback.addInfo(`${name} is not yet wired to the server in MVP.`);
        setEntries(scrollback.all());
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
                (s) =>
                  `${s.subagentId}  ${s.purpose}  ${s.status}  ${s.url || '(in-process)'}`,
              );
              const hint =
                '\n\nTo inspect: copy a subagentId, then run `chimera attach <id>` in another terminal,\n' +
                'or use /attach <id> here to drill the TUI into the child.';
              scrollback.addInfo(`subagents:\n${lines.join('\n')}${hint}`);
            }
          } catch (err) {
            scrollback.addError(`/subagents: ${(err as Error).message}`);
          }
          setEntries(scrollback.all());
        })();
        return;
      }
      case '/attach': {
        const target = arg.trim();
        if (!target) {
          scrollback.addInfo('usage: /attach <subagentId>');
          setEntries(scrollback.all());
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
              setEntries(scrollback.all());
              return;
            }
            if (!match.url) {
              scrollback.addError(
                `/attach: subagent ${match.subagentId} is in-process and not attachable`,
              );
              setEntries(scrollback.all());
              return;
            }
            const childClient = new ChimeraClient({ baseUrl: match.url });
            scrollback.addInfo(
              `attaching to subagent ${match.subagentId} (${match.purpose}) at ${match.url}`,
            );
            setEntries(scrollback.all());
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
            setStreamingEntryId(null);
          } catch (err) {
            scrollback.addError(`/attach: ${(err as Error).message}`);
            setEntries(scrollback.all());
          }
        })();
        return;
      }
      case '/detach': {
        if (
          activeSession.client === props.client &&
          activeSession.sessionId === props.sessionId
        ) {
          scrollback.addInfo('already attached to the parent session');
          setEntries(scrollback.all());
          return;
        }
        scrollback.addInfo('detaching back to parent session');
        setEntries(scrollback.all());
        setActiveSession({
          client: props.client,
          sessionId: props.sessionId,
          label: 'parent',
        });
        setRunning(false);
        setQueue([]);
        setStreaming(false);
        setStreamingEntryId(null);
        return;
      }
      case '/reload': {
        const reg = props.commands;
        const reloadFn = reg?.reload;
        if (!reloadFn) {
          scrollback.addInfo('commands: reload not supported in this session.');
          setEntries(scrollback.all());
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
              setEntries(scrollback.all());
            } else {
              scrollback.addInfo('commands reloaded.');
              setEntries(scrollback.all());
            }
          } catch (err) {
            scrollback.addError(`reload failed: ${(err as Error).message}`);
            setEntries(scrollback.all());
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
          setEntries(scrollback.all());
          return;
        }
        try {
          const r = applyThemeByName(target);
          themeCtx.reload();
          scrollback.addInfo(
            `theme: applied '${target}' (${r.origin === 'user' ? 'user' : 'builtin'}).`,
          );
        } catch (err) {
          scrollback.addError(`/theme: ${(err as Error).message}`);
        }
        setEntries(scrollback.all());
        return;
      }
      case '/overlay':
      case '/apply':
      case '/discard': {
        if (!overlayMode || !props.overlay) {
          scrollback.addError(`${name} requires --sandbox-mode overlay`);
          setEntries(scrollback.all());
          return;
        }
        if (name === '/overlay') {
          void (async () => {
            try {
              const diff = await props.overlay!.diff();
              const total =
                diff.added.length + diff.modified.length + diff.deleted.length;
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
            setEntries(scrollback.all());
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
                setEntries(scrollback.all());
                return;
              }
              setOverlayPicker(entries);
            } catch (err) {
              scrollback.addError(`overlay: ${(err as Error).message}`);
              setEntries(scrollback.all());
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
          setEntries(scrollback.all());
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
            setEntries(scrollback.all());
            return;
          }
          scrollback.addUserMessage(raw);
          scrollback.suppressUserMessageMatching(expanded);
          setEntries(scrollback.all());
          if (running) {
            setQueue((q) => [...q, expanded]);
            scrollback.addInfo(`queued: ${previewLine(raw)}`);
            setEntries(scrollback.all());
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
          setEntries(scrollback.all());
          if (running) {
            setQueue((q) => [...q, body]);
            scrollback.addInfo(`queued: ${previewLine(raw)}`);
            setEntries(scrollback.all());
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
        setEntries(scrollback.all());
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
      .resolvePermission(targetSessionId, requestId, decision, remember as any)
      .catch((err) => {
        scrollback.addError(`resolvePermission: ${(err as Error).message}`);
        setEntries(scrollback.all());
      });
  }


  // Split entries: the in-flight assistant entry and any tool entries that
  // haven't yet seen their `tool_call_result` render inline below <Static>
  // so their text can keep updating (deltas for assistants, the result-aware
  // formatter summary for tool calls). Everything else is committed to the
  // terminal's native scrollback via <Static>, which never re-renders an
  // item once it has been emitted.
  //
  // Subagent rows whose `parentEntryId` references another entry are NOT
  // top-level — they're collected into `childrenByParent` and rendered
  // nested inside the parent's box, so the whole spawn_agent group commits
  // atomically when the parent's tool_call_result lands.
  const { committedEntries, inFlightEntries, childrenByParent } = useMemo<{
    committedEntries: ScrollbackEntry[];
    inFlightEntries: ScrollbackEntry[];
    childrenByParent: Map<string, ScrollbackEntry[]>;
  }>(() => {
    const childrenByParent = new Map<string, ScrollbackEntry[]>();
    for (const e of entries) {
      if (e.parentEntryId) {
        const arr = childrenByParent.get(e.parentEntryId) ?? [];
        arr.push(e);
        childrenByParent.set(e.parentEntryId, arr);
      }
    }
    const inFlight: ScrollbackEntry[] = [];
    const committed: ScrollbackEntry[] = [];
    for (const e of entries) {
      if (e.parentEntryId) continue; // rendered as nested children
      const isStreamingAssistant = e.id === streamingEntryId;
      const isPendingTool =
        e.kind === 'tool' &&
        e.toolResult === undefined &&
        e.toolError === undefined;
      if (isStreamingAssistant || isPendingTool) {
        inFlight.push(e);
      } else {
        committed.push(e);
      }
    }
    return { committedEntries: committed, inFlightEntries: inFlight, childrenByParent };
  }, [entries, streamingEntryId]);

  const staticItems = useMemo<StaticItem[]>(() => {
    const entryItems: StaticItem[] = committedEntries.map((e) => ({
      kind: 'entry',
      id: e.id,
      entry: e,
      children: childrenByParent.get(e.id) ?? [],
    }));
    return showHeader ? [{ kind: 'header', id: '__header__' }, ...entryItems] : entryItems;
  }, [committedEntries, childrenByParent, showHeader]);

  const cwdLeft: StatusBarWidget[] = [
    <Text color={theme.accent.primary}>{props.cwd}</Text>,
  ];
  const cwdRight: StatusBarWidget[] = [
    <Text color={theme.text.muted}>{`[sandbox:${sandboxMode}]`}</Text>,
  ];
  const modelLeft: StatusBarWidget[] = [
    <Text color={theme.accent.primary}>{props.modelRef}</Text>,
  ];
  const modelRight: StatusBarWidget[] = [
    usageState && (
      <UsageWidget
        usage={usageState.usage}
        contextWindow={usageState.contextWindow}
        usedContextTokens={usageState.usedContextTokens}
        unknownWindow={usageState.unknownWindow}
      />
    ),
  ];
  const hintsLeft: StatusBarWidget[] = [
    <Text color={theme.text.muted}>Esc/Ctrl+C interrupt</Text>,
    <Text color={theme.text.muted}>Ctrl+D exit</Text>,
    <Text color={theme.text.muted}>/ commands</Text>,
  ];

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
                setEntries(scrollback.all());
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
                setEntries(scrollback.all());
              })();
            }}
          />
        )}
        {menuOpen && (
          <SlashMenu items={menuItems} highlightIdx={menuHighlight} />
        )}
        <Box
          borderStyle="single"
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.text.muted}
        >
          <Text color={theme.accent.primary}>{'> '}</Text>
          <Text>
            {input}
            <Text inverse> </Text>
          </Text>
        </Box>
        <StatusBar left={cwdLeft} right={cwdRight} separatorColor={theme.text.muted} />
        <StatusBar left={modelLeft} right={modelRight} separatorColor={theme.text.muted} />
        <StatusBar left={hintsLeft} separatorColor={theme.text.muted} />
      </Box>
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
  children: ScrollbackEntry[] = [],
): React.ReactElement[] {
  const width = Math.max(10, columns);

  if (entry.kind === 'user') {
    const prefix = 'you: ';
    const lines = wrapToLines(entry.text, width, prefix.length);
    return [
      <Box key={`${entry.id}:u`} flexDirection="column">
        <Text>
          <Text color={theme.ui.accent} bold>you</Text>
          {`: ${lines[0] ?? ''}`}
        </Text>
        {lines.slice(1).map((line, i) => (
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
  if (entry.kind === 'tool') {
    const badge = entry.toolTarget === 'host' ? '[host]' : '[sandbox]';
    const namePrefix = entry.toolName ? `${entry.toolName}: ` : '';
    const prefixLen = badge.length + 1;
    const textLines = wrapToLines(`${namePrefix}${entry.text}`, width, prefixLen);
    const out: React.ReactElement[] = [
      <Box key={`${entry.id}:t`} flexDirection="column">
        <Text>
          <Text color={theme.ui.badge}>{badge}</Text>
          {' '}
          <Text color={theme.accent.secondary}>{textLines[0] ?? ''}</Text>
        </Text>
        {textLines.slice(1).map((line, i) => (
          <Box key={i} paddingLeft={prefixLen}>
            <Text color={theme.accent.secondary}>{line}</Text>
          </Box>
        ))}
        {entry.detail !== undefined &&
          wrapToLines(entry.detail, width, prefixLen).map((line, i) => (
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
                <Box key={i} paddingLeft={connector.length}>
                  <Text color={theme.text.muted}>{line}</Text>
                </Box>
              ))}
              {child.detail !== undefined &&
                wrapToLines(child.detail, width, prefixLen + connector.length).map(
                  (line, i) => (
                    <Box key={`cd${i}`} paddingLeft={connector.length}>
                      <Text color={theme.text.muted}>{line}</Text>
                    </Box>
                  ),
                )}
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
            <Text key={i} color={theme.status.error}>{line}</Text>
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
          <Text color={theme.ui.accent}>{label}</Text>
          {' '}
          <Text color={theme.text.muted}>{lines[0] ?? ''}</Text>
        </Text>
        {lines.slice(1).map((line, i) => (
          <Box key={i} paddingLeft={prefix.length}>
            <Text color={theme.text.muted}>{line}</Text>
          </Box>
        ))}
      </Box>,
    ];
  }
  if (entry.kind === 'info') {
    const lines = wrapToLines(entry.text, width, 0);
    return lines.map((line, i) => (
      <Text key={`${entry.id}:${i}`} color={theme.text.muted}>
        {line}
      </Text>
    ));
  }
  const lines = wrapToLines(entry.text, width, 0);
  return lines.map((line, i) => (
    <Text key={`${entry.id}:${i}`} color={theme.status.error}>
      {line}
    </Text>
  ));
}
