import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChimeraClient } from '@chimera/client';
import type { CommandRegistry } from '@chimera/commands';
import type { AgentEvent, SessionId } from '@chimera/core';
import { PermissionModal } from './PermissionModal';
import { Scrollback, type ScrollbackEntry } from './scrollback';
import { SLASH_MENU_MAX_ROWS, SlashMenu, type SlashMenuItem } from './SlashMenu';
import { BUILTIN_COMMANDS, findClosestCommand, isBuiltin } from './slash-commands';
import { buildTheme, type Theme } from './theme';

export interface AppProps {
  client: ChimeraClient;
  sessionId: SessionId;
  modelRef: string;
  cwd: string;
  commands?: CommandRegistry;
  /**
   * Subscribe to mouse wheel events. Returns unsubscribe. When the harness
   * doesn't support mouse reporting (e.g. non-TTY), this may be omitted or
   * return a no-op unsubscribe.
   */
  subscribeWheel?: (handler: (dir: 'up' | 'down') => void) => () => void;
}

interface PendingPermission {
  requestId: string;
  command: string;
  reason?: string;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function App(props: AppProps): React.ReactElement {
  const theme = useMemo(() => buildTheme(), []);
  const app = useApp();
  const { stdout } = useStdout();
  const scrollback = useMemo(() => new Scrollback(), []);
  const [entries, setEntries] = useState<ScrollbackEntry[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<number>(stdout?.rows ?? 30);
  const [columns, setColumns] = useState<number>(stdout?.columns ?? 80);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setRows(stdout.rows ?? 30);
      setColumns(stdout.columns ?? 80);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  const [lastCtrlC, setLastCtrlC] = useState<number>(0);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [menuHighlight, setMenuHighlight] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  // Bumped when the commands registry reloads so useMemos re-derive.
  const [registryVersion, setRegistryVersion] = useState(0);
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);

  // On first mount, surface commands-registry warnings (one per collision).
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
    // Only once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to wheel events for scrollback paging. We read the current line
  // count and viewport size via refs so the subscription itself never churns
  // on content updates.
  const linesLenRef = useRef(0);
  const scrollRowsRef = useRef(0);
  useEffect(() => {
    if (!props.subscribeWheel) return;
    return props.subscribeWheel((dir) => {
      if (dir === 'up') {
        const max = Math.max(0, linesLenRef.current - scrollRowsRef.current);
        setScrollOffset((o) => Math.min(max, o + 3));
      } else {
        setScrollOffset((o) => Math.max(0, o - 3));
      }
    });
  }, [props.subscribeWheel]);

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
    return [...builtins, ...users];
  }, [input, props.commands, menuDismissed, registryVersion]);

  const menuOpen = menuItems.length > 0;

  // Reset menu highlight + dismissal when input changes.
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
  }, [props.client, props.sessionId]);

  // Reserved row calc happens before useInput so the key handler can consult it.
  const inputLineRows = Math.max(1, Math.ceil((input.length + 3) / Math.max(10, columns)));
  const modalRows = pending ? 7 : 0;
  const menuRows = menuOpen ? Math.min(menuItems.length, SLASH_MENU_MAX_ROWS) + 2 : 0;
  const reserved = 1 + modalRows + menuRows + inputLineRows + 1;
  const scrollRows = Math.max(3, rows - reserved);

  function apply(ev: AgentEvent | { type: 'permission_timeout'; requestId: string }): void {
    scrollback.apply(ev as AgentEvent);
    setEntries(scrollback.all());
    if (ev.type === 'assistant_text_delta') {
      setStreaming(true);
    } else if (ev.type === 'permission_request') {
      setPending({ requestId: ev.requestId, command: ev.command, reason: ev.reason });
    } else if (ev.type === 'permission_resolved' || ev.type === 'permission_timeout') {
      setPending(null);
    } else if (ev.type === 'run_finished') {
      setRunning(false);
      setStreaming(false);
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

    // Scrollback paging (always available).
    if (key.pageUp) {
      const step = Math.max(1, Math.floor(scrollRows / 2));
      const maxOffset = Math.max(0, entries.length - 1);
      setScrollOffset((o) => Math.min(maxOffset, o + step));
      return;
    }
    if (key.pageDown) {
      const step = Math.max(1, Math.floor(scrollRows / 2));
      setScrollOffset((o) => Math.max(0, o - step));
      return;
    }

    // Slash-menu key handling.
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
        // If input already matches the highlighted command exactly, submit.
        if (!sel || input === `/${sel.name}`) {
          // fall through to submit below
        } else {
          setInput(`/${sel.name} `);
          return;
        }
      }
    }

    if (key.return) {
      if (input.trim().length === 0) return;
      const text = input;
      setInput('');
      setScrollOffset(0); // always return to live tail on submit
      historyRef.current.push(text);
      historyIdxRef.current = historyRef.current.length;
      void handleSubmit(text);
      return;
    }
    if (key.upArrow && input.length === 0) {
      if (historyRef.current.length === 0) return;
      historyIdxRef.current = Math.max(0, historyIdxRef.current - 1);
      setInput(historyRef.current[historyIdxRef.current] ?? '');
      return;
    }
    if (key.downArrow && input.length === 0) {
      historyIdxRef.current = Math.min(
        historyRef.current.length,
        historyIdxRef.current + 1,
      );
      setInput(historyRef.current[historyIdxRef.current] ?? '');
      return;
    }
    if (key.tab && input.startsWith('/')) {
      // Menu-closed Tab fallback: if the user dismissed the menu but still
      // wants prefix completion, do a best-effort single-match fill.
      const match = BUILTIN_COMMANDS.find((c) => c.name.startsWith(input));
      if (match) {
        setInput(match.name);
      } else if (props.commands) {
        const userMatch = props.commands
          .list()
          .find((c) => `/${c.name}`.startsWith(input));
        if (userMatch) setInput(`/${userMatch.name}`);
      }
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
        scrollback.clear();
        setEntries([]);
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
        // Fall through to the user-template registry.
        const templateName = name!.startsWith('/') ? name!.slice(1) : name!;
        const template = props.commands?.find(templateName);
        if (template) {
          let expanded: string;
          try {
            expanded = props.commands!.expand(templateName, arg, { cwd: props.cwd });
          } catch (err) {
            scrollback.addError(
              `/${templateName}: ${(err as Error).message}`,
            );
            setEntries(scrollback.all());
            return;
          }
          // Show the invocation the user typed, not the expanded template body.
          scrollback.addUserMessage(raw);
          scrollback.suppressUserMessageMatching(expanded);
          setEntries(scrollback.all());
          void sendUserMessage(expanded);
          return;
        }
        const suggestion = findClosestCommand(name!, props.commands);
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

  // Flatten all scrollback entries to a single stream of rendered lines.
  // The scroll viewport is a line-level window over this stream, so tall
  // messages can be clipped mid-body and the user always sees *something*.
  const allLines = useMemo(
    () => entries.flatMap((e) => renderEntryLines(e, columns, theme)),
    [entries, columns, theme],
  );

  // scrollOffset is measured in lines back from the live tail. We defensively
  // clamp again in the render memo so a momentarily over-large state (e.g.
  // between a wheel burst and the normalization effect) never produces
  // negative `end` — which would silently drop lines from the *bottom* via
  // `slice(0, -N)`.
  const visibleLines = useMemo(() => {
    const maxOffset = Math.max(0, allLines.length - scrollRows);
    const effectiveOffset = Math.max(0, Math.min(maxOffset, scrollOffset));
    const end = allLines.length - effectiveOffset;
    const start = Math.max(0, end - scrollRows);
    return allLines.slice(start, end);
  }, [allLines, scrollOffset, scrollRows]);

  // Normalize scrollOffset state to a sane range when the buffer shrinks
  // (e.g. /clear) or the viewport grows. Max is "top of the buffer", which
  // leaves the first viewport-full fully visible.
  useEffect(() => {
    const maxOffset = Math.max(0, allLines.length - scrollRows);
    if (scrollOffset > maxOffset) setScrollOffset(maxOffset);
  }, [allLines.length, scrollRows, scrollOffset]);

  // When the line stream grows while the user is scrolled back, keep the
  // absolute viewport anchored on the same content by bumping scrollOffset by
  // the number of new lines. Also syncs linesLenRef and scrollRowsRef (used
  // by the wheel handler) here so both are current without a second effect.
  const prevLinesLenRef = useRef(0);
  useEffect(() => {
    const prev = prevLinesLenRef.current;
    prevLinesLenRef.current = allLines.length;
    linesLenRef.current = allLines.length;
    scrollRowsRef.current = scrollRows;
    if (allLines.length > prev && scrollOffset > 0) {
      const delta = allLines.length - prev;
      setScrollOffset((o) => (o > 0 ? o + delta : o));
    }
  }, [allLines.length, scrollOffset, scrollRows]);


  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box>
        <Text color={theme.primary}>
          Chimera · {shortId} · {props.cwd} · {props.modelRef} · [sandbox:off]
        </Text>
      </Box>
      <Box flexDirection="column" height={scrollRows} overflow="hidden">
        {visibleLines}
      </Box>
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
      <Box>
        <Text color={theme.primary}>{'> '}</Text>
        <Text>
          {input}
          <Text inverse> </Text>
        </Text>
      </Box>
      <Box>
        <Text color={theme.muted}>
          Ctrl+C interrupt · Ctrl+D exit · / commands · wheel or PgUp/PgDn to scroll
        </Text>
        {scrollOffset > 0 && (
          <Text color={theme.accent}>
            {'  '}[scrolled back {scrollOffset}]
          </Text>
        )}
        {running && (
          <Text color={theme.accent}>
            {'  '}
            {SPINNER_FRAMES[spinnerFrame]} {streaming ? 'streaming…' : 'waiting for model…'}
          </Text>
        )}
      </Box>
    </Box>
  );
}

/**
 * Wrap plain text into hard lines sized to the terminal. Splits on explicit
 * `\n` first, then breaks each segment at `width` characters. The first
 * segment's available width is reduced by `firstOffset` so prefixes like
 * "you: " or "[host] " line up.
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

/**
 * Render a scrollback entry as an array of one-line `<Text>` elements. The
 * entry's styling (kind-based color, bold prefix, tool badge, etc.) applies
 * to the first line; continuation lines get the entry's base color only.
 */
function renderEntryLines(
  entry: ScrollbackEntry,
  columns: number,
  theme: Theme,
): React.ReactElement[] {
  const width = Math.max(10, columns);

  if (entry.kind === 'user') {
    const prefix = 'you: ';
    const lines = wrapToLines(entry.text, width, prefix.length);
    return lines.map((line, i) => (
      <Text key={`${entry.id}:${i}`}>
        {i === 0 ? (
          <>
            <Text color={theme.accent} bold>
              you
            </Text>
            {`: ${line}`}
          </>
        ) : (
          line
        )}
      </Text>
    ));
  }

  if (entry.kind === 'assistant') {
    const lines = wrapToLines(entry.text, width, 0);
    return lines.map((line, i) => <Text key={`${entry.id}:${i}`}>{line}</Text>);
  }

  if (entry.kind === 'tool') {
    const badge = entry.toolTarget === 'host' ? '[host]' : '[sandbox]';
    const prefixLen = badge.length + 1;
    const textLines = wrapToLines(entry.text, width, prefixLen);
    const out: React.ReactElement[] = textLines.map((line, i) => (
      <Text key={`${entry.id}:t:${i}`}>
        {i === 0 ? (
          <>
            <Text color={theme.badge}>{badge}</Text>
            {' '}
            <Text color={theme.secondary}>{line}</Text>
          </>
        ) : (
          <Text color={theme.secondary}>{line}</Text>
        )}
      </Text>
    ));
    if (entry.toolError) {
      const errLines = wrapToLines(` — error: ${entry.toolError}`, width, 0);
      for (let i = 0; i < errLines.length; i += 1) {
        out.push(
          <Text key={`${entry.id}:e:${i}`} color={theme.danger}>
            {errLines[i]}
          </Text>,
        );
      }
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

  // error
  const lines = wrapToLines(entry.text, width, 0);
  return lines.map((line, i) => (
    <Text key={`${entry.id}:${i}`} color={theme.danger}>
      {line}
    </Text>
  ));
}
