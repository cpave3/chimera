import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChimeraClient } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type { AgentEvent, SessionId } from '@chimera/core';
import type { SkillRegistry } from '@chimera/skills';
import { Header } from './Header';
import { renderMarkdown } from './markdown';
import { PermissionModal } from './PermissionModal';
import { Scrollback, type ScrollbackEntry } from './scrollback';
import { SlashMenu, type SlashMenuItem } from './SlashMenu';
import { BUILTIN_COMMANDS, findClosestCommand, isBuiltin } from './slash-commands';
import { StatusBar, type StatusBarWidget } from './StatusBar';
import { buildTheme, type Theme } from './theme';

export interface AppProps {
  client: ChimeraClient;
  sessionId: SessionId;
  modelRef: string;
  cwd: string;
  commands?: CommandRegistry;
  skills?: SkillRegistry;
}

interface PendingPermission {
  requestId: string;
  command: string;
  reason?: string;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CHIMERA_VERSION = '0.1.0';

type StaticItem =
  | { kind: 'header'; id: '__header__' }
  | { kind: 'entry'; id: string; entry: ScrollbackEntry };

export function App(props: AppProps): React.ReactElement {
  const theme = useMemo(() => buildTheme(), []);
  const app = useApp();
  const { stdout } = useStdout();
  const scrollback = useMemo(() => new Scrollback(), []);
  const [entries, setEntries] = useState<ScrollbackEntry[]>([]);
  const [input, setInputState] = useState('');
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [running, setRunning] = useState(false);
  const [columns, setColumns] = useState<number>(stdout?.columns ?? 80);
  const [lastCtrlC, setLastCtrlC] = useState<number>(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [streaming, setStreaming] = useState(false);
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

  // Filtered slash-menu items derived from input + registry.
  const menuItems = useMemo<SlashMenuItem[]>(() => {
    if (!input.startsWith('/') || input.includes(' ') || menuDismissed) return [];
    const partial = input.slice(1).toLowerCase();
    const builtins: SlashMenuItem[] = BUILTIN_COMMANDS
      .filter((c) => c.name.toLowerCase().slice(1).startsWith(partial))
      .map((c) => ({
        name: c.name.slice(1),
        description: c.description,
        kind: 'builtin' as const,
      }));
    const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
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
  }, [input, props.commands, props.skills, menuDismissed, registryVersion]);

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

  // Subscribe to events.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        for await (const ev of props.client.subscribe(props.sessionId, {
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
  }, [props.client, props.sessionId]);

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
    } else if (ev.type === 'run_finished') {
      setRunning(false);
      setStreaming(false);
      setStreamingEntryId(null);
    }
  }

  useInput((char, key) => {
    if (pending) return; // handled by modal

    if (key.ctrl && char === 'c') {
      if (running) {
        void props.client.interrupt(props.sessionId);
        scrollback.addInfo('interrupt sent');
        setEntries(scrollback.all());
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
    await sendUserMessage(text);
  }

  async function sendUserMessage(text: string): Promise<void> {
    setRunning(true);
    setStreaming(false);
    try {
      for await (const _ev of props.client.send(props.sessionId, text)) {
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
                await props.client.removeRule(props.sessionId, idx);
                scrollback.addInfo(`removed rule ${idx}`);
              }
            } else {
              const rules = await props.client.listRules(props.sessionId);
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
      case '/reload': {
        const reg = props.commands;
        if (!reg?.reload) {
          scrollback.addInfo('commands: reload not supported in this session.');
          setEntries(scrollback.all());
          return;
        }
        void reg.reload().catch((err) => {
          scrollback.addError(`reload failed: ${(err as Error).message}`);
          setEntries(scrollback.all());
        });
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
          void sendUserMessage(expanded);
          return;
        }
        const skill = props.skills?.find(templateName);
        if (skill) {
          const body = expandSkillInvocation(skill.name, skill.path, arg);
          scrollback.addUserMessage(raw);
          scrollback.suppressUserMessageMatching(body);
          setEntries(scrollback.all());
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
    remember?: { scope: 'session' } | { scope: 'project'; pattern: string; patternKind: 'exact' | 'glob' },
  ): void {
    if (!pending) return;
    const requestId = pending.requestId;
    setPending(null);
    void props.client.resolvePermission(props.sessionId, requestId, decision, remember as any).catch(
      (err) => {
        scrollback.addError(`resolvePermission: ${(err as Error).message}`);
        setEntries(scrollback.all());
      },
    );
  }

  const shortId = props.sessionId.slice(-8);
  const hrLine = '─'.repeat(Math.max(1, columns));

  // Split entries: the in-flight assistant entry renders inline below
  // <Static> so its text can keep updating on every delta. Everything else
  // is committed to the terminal's native scrollback via <Static>.
  const { committedEntries, inFlightEntry } = useMemo<{
    committedEntries: ScrollbackEntry[];
    inFlightEntry: ScrollbackEntry | null;
  }>(() => {
    if (!streamingEntryId) return { committedEntries: entries, inFlightEntry: null };
    const idx = entries.findIndex((e) => e.id === streamingEntryId);
    if (idx < 0) return { committedEntries: entries, inFlightEntry: null };
    const before = entries.slice(0, idx);
    const after = entries.slice(idx + 1);
    return {
      committedEntries: [...before, ...after],
      inFlightEntry: entries[idx] ?? null,
    };
  }, [entries, streamingEntryId]);

  const staticItems = useMemo<StaticItem[]>(() => {
    const entryItems: StaticItem[] = committedEntries.map((e) => ({
      kind: 'entry',
      id: e.id,
      entry: e,
    }));
    return showHeader ? [{ kind: 'header', id: '__header__' }, ...entryItems] : entryItems;
  }, [committedEntries, showHeader]);

  const sessionLeft: StatusBarWidget[] = [
    <Text color={theme.primary} bold>
      Chimera
    </Text>,
    <Text color={theme.primary}>{shortId}</Text>,
    <Text color={theme.primary}>{props.cwd}</Text>,
    <Text color={theme.primary}>{props.modelRef}</Text>,
  ];
  const sessionRight: StatusBarWidget[] = [
    <Text color={theme.muted}>[sandbox:off]</Text>,
  ];
  const hintsLeft: StatusBarWidget[] = [
    <Text color={theme.muted}>Ctrl+C interrupt</Text>,
    <Text color={theme.muted}>Ctrl+D exit</Text>,
    <Text color={theme.muted}>/ commands</Text>,
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
                  theme={theme}
                />
              </Box>
            );
          }
          return (
            <Box key={item.id} flexDirection="column" marginTop={1}>
              {renderEntryLines(item.entry, columns, theme)}
            </Box>
          );
        }}
      </Static>
      <Box flexDirection="column" width={columns}>
        {inFlightEntry && (
          <Box flexDirection="column" marginTop={1}>
            {renderEntryLines(inFlightEntry, columns, theme)}
          </Box>
        )}
        {running && (
          <Box>
            <Text color={theme.accent}>
              {SPINNER_FRAMES[spinnerFrame]} {streaming ? 'streaming…' : 'waiting…'}
            </Text>
          </Box>
        )}
        {pending && (
          <PermissionModal
            command={pending.command}
            reason={pending.reason}
            target="host"
            theme={theme}
            onResolve={onResolve}
          />
        )}
        {menuOpen && (
          <SlashMenu items={menuItems} highlightIdx={menuHighlight} theme={theme} />
        )}
        <Box height={1}>
          <Text color={theme.muted}>{hrLine}</Text>
        </Box>
        <Box>
          <Text color={theme.primary}>{'> '}</Text>
          <Text>
            {input}
            <Text inverse> </Text>
          </Text>
        </Box>
        <StatusBar left={sessionLeft} right={sessionRight} separatorColor={theme.muted} />
        <StatusBar left={hintsLeft} separatorColor={theme.muted} />
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
): React.ReactElement[] {
  const width = Math.max(10, columns);

  if (entry.kind === 'user') {
    const prefix = 'you: ';
    const lines = wrapToLines(entry.text, width, prefix.length);
    return [
      <Box key={`${entry.id}:u`} flexDirection="column">
        <Text>
          <Text color={theme.accent} bold>you</Text>
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
    const prefixLen = badge.length + 1;
    const textLines = wrapToLines(entry.text, width, prefixLen);
    const out: React.ReactElement[] = [
      <Box key={`${entry.id}:t`} flexDirection="column">
        <Text>
          <Text color={theme.badge}>{badge}</Text>
          {' '}
          <Text color={theme.secondary}>{textLines[0] ?? ''}</Text>
        </Text>
        {textLines.slice(1).map((line, i) => (
          <Box key={i} paddingLeft={prefixLen}>
            <Text color={theme.secondary}>{line}</Text>
          </Box>
        ))}
        {entry.skillName && (
          <Box paddingLeft={prefixLen}>
            <Text color={theme.accent}>📚 skill: {entry.skillName}</Text>
          </Box>
        )}
      </Box>,
    ];
    if (entry.toolError) {
      const errLines = wrapToLines(`error: ${entry.toolError}`, width, prefixLen);
      out.push(
        <Box key={`${entry.id}:e`} flexDirection="column" paddingLeft={prefixLen}>
          {errLines.map((line, i) => (
            <Text key={i} color={theme.danger}>{line}</Text>
          ))}
        </Box>,
      );
    }
    return out;
  }
  if (entry.kind === 'info') {
    const lines = wrapToLines(entry.text, width, 0);
    return lines.map((line, i) => (
      <Text key={`${entry.id}:${i}`} color={theme.muted}>
        {line}
      </Text>
    ));
  }
  const lines = wrapToLines(entry.text, width, 0);
  return lines.map((line, i) => (
    <Text key={`${entry.id}:${i}`} color={theme.danger}>
      {line}
    </Text>
  ));
}
