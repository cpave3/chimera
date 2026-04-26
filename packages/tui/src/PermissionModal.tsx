import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import { useTheme } from './theme/ThemeProvider';

export interface PermissionModalProps {
  command: string;
  reason?: string;
  target: 'host';
  /** Optional banner shown above the prompt (e.g. for subagent-routed prompts). */
  header?: string;
  onResolve: (
    decision: 'allow' | 'deny',
    remember?:
      | { scope: 'session' }
      | { scope: 'project'; pattern: string; patternKind: 'exact' | 'glob' },
  ) => void;
}

type ModalMode =
  | { kind: 'choose' }
  | { kind: 'pattern'; decision: 'allow' }
  | { kind: 'scope'; decision: 'allow' | 'deny'; pattern: string | null };

export function PermissionModal(props: PermissionModalProps): React.ReactElement {
  const [mode, setMode] = useState<ModalMode>({ kind: 'choose' });
  const [pattern, setPattern] = useState(props.command);

  useInput((input, key) => {
    if (mode.kind === 'choose') {
      if (input === 'a') {
        props.onResolve('allow');
      } else if (input === 'A') {
        setMode({ kind: 'scope', decision: 'allow', pattern: props.command });
      } else if (input === 'd') {
        props.onResolve('deny');
      } else if (input === 'D') {
        setMode({ kind: 'scope', decision: 'deny', pattern: props.command });
      } else if (input === 'g') {
        setMode({ kind: 'pattern', decision: 'allow' });
      }
      return;
    }
    if (mode.kind === 'pattern') {
      if (key.return) {
        setMode({ kind: 'scope', decision: mode.decision, pattern });
      } else if (key.backspace || key.delete) {
        setPattern((p) => p.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setPattern((p) => p + input);
      }
      return;
    }
    if (mode.kind === 'scope') {
      if (input === 's' || input === 'p') {
        if (mode.pattern) {
          props.onResolve(mode.decision, {
            scope: input === 's' ? 'session' : 'project',
            pattern: mode.pattern,
            patternKind: mode.pattern === props.command ? 'exact' : 'glob',
          } as
            | { scope: 'project'; pattern: string; patternKind: 'exact' | 'glob' }
            | { scope: 'session' });
          if (input === 's' && mode.pattern === props.command) {
            // Pure session-scope: no pattern stored, just session flag.
            // The resolve callback interprets it.
          }
        } else {
          props.onResolve(mode.decision, { scope: input === 's' ? 'session' : 'project' } as any);
        }
      }
    }
  });

  const theme = useTheme();
  const badge = theme.ui.badge;
  const danger = theme.status.error;
  const success = theme.status.success;
  const muted = theme.text.muted;

  if (mode.kind === 'pattern') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={badge} padding={1}>
        <Text color={badge}>Edit pattern (Enter to confirm):</Text>
        <Text>{pattern}</Text>
      </Box>
    );
  }

  if (mode.kind === 'scope') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={badge} padding={1}>
        <Text color={badge}>Remember for [s]ession or [p]roject?</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={danger} padding={1}>
      <Text color={danger} bold>
        Permission required
      </Text>
      {props.header && <Text color={badge}>{props.header}</Text>}
      <Text>
        Run on the <Text bold>HOST</Text>:
      </Text>
      <Text> $ {props.command}</Text>
      {props.reason && <Text color={muted}>Reason: {props.reason}</Text>}
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color={success}>[a]</Text> Allow once <Text color={success}>[A]</Text> Allow &amp;
          remember this command
        </Text>
        <Text>
          <Text color={success}>[g]</Text> Allow pattern... <Text color={danger}>[d]</Text> Deny
          once
        </Text>
        <Text>
          <Text color={danger}>[D]</Text> Deny &amp; remember
        </Text>
      </Box>
    </Box>
  );
}
