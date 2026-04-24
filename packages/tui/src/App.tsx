import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent, SessionId } from '@chimera/core';
import { PermissionModal } from './PermissionModal';
import { Scrollback, type ScrollbackEntry } from './scrollback';
import { BUILTIN_COMMANDS, findClosestCommand } from './slash-commands';
import { buildTheme, type Theme } from './theme';

export interface AppProps {
  client: ChimeraClient;
  sessionId: SessionId;
  modelRef: string;
  cwd: string;
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
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);

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
    if (key.return) {
      if (input.trim().length === 0) return;
      const text = input;
      setInput('');
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
      const match = BUILTIN_COMMANDS.find((c) => c.name.startsWith(input));
      if (match) setInput(match.name);
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
        const lines = BUILTIN_COMMANDS.map((c) => `${c.name} — ${c.description}`);
        scrollback.addInfo(lines.join('\n'));
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
      default: {
        const suggestion = findClosestCommand(name!);
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

  // Reserve rows for header(1) + input(≥1, grows with wrap) + footer(1) +
  // permission modal (~7 when active). Tail the scrollback so input + footer
  // stay visible.
  const inputLineRows = Math.max(1, Math.ceil((input.length + 3) / Math.max(10, columns)));
  const modalRows = pending ? 7 : 0;
  const reserved = 1 + modalRows + inputLineRows + 1;
  const scrollRows = Math.max(3, rows - reserved);
  const visibleEntries = entries.slice(Math.max(0, entries.length - scrollRows));

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box>
        <Text color={theme.primary}>
          Chimera · {shortId} · {props.cwd} · {props.modelRef} · [sandbox:off]
        </Text>
      </Box>
      <Box flexDirection="column" height={scrollRows} overflow="hidden">
        {visibleEntries.map((e) => (
          <ScrollbackRow key={e.id} entry={e} theme={theme} />
        ))}
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
      <Box>
        <Text color={theme.primary}>{'> '}</Text>
        <Text>
          {input}
          <Text inverse> </Text>
        </Text>
      </Box>
      <Box>
        <Text color={theme.muted}>
          Ctrl+C interrupt · Ctrl+D exit · / commands
        </Text>
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

function ScrollbackRow({
  entry,
  theme,
}: {
  entry: ScrollbackEntry;
  theme: Theme;
}): React.ReactElement {
  if (entry.kind === 'user') {
    return (
      <Text>
        <Text color={theme.accent} bold>
          you
        </Text>
        : {entry.text}
      </Text>
    );
  }
  if (entry.kind === 'assistant') {
    return <Text>{entry.text}</Text>;
  }
  if (entry.kind === 'tool') {
    const badge = entry.toolTarget === 'host' ? '[host]' : '[sandbox]';
    return (
      <Text>
        <Text color={theme.badge}>{badge}</Text>{' '}
        <Text color={theme.secondary}>{entry.text}</Text>
        {entry.toolError ? <Text color={theme.danger}> — error: {entry.toolError}</Text> : null}
      </Text>
    );
  }
  if (entry.kind === 'info') {
    return <Text color={theme.muted}>{entry.text}</Text>;
  }
  return <Text color={theme.danger}>{entry.text}</Text>;
}
