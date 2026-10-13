import type { AgentEvent, PermissionDecisionAction, PermissionRequest } from '@chimera/core';
import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import { useFrame } from './frame';
import { useTheme } from './theme/ThemeProvider';

type PolicyAnalysis = Extract<AgentEvent, { type: 'permission_request' }>['policyAnalysis'];
export interface PermissionModalProps {
  command: string;
  reason?: string;
  /** Why the approval reviewer sent the request to the user. */
  reviewerReason?: string;
  target: 'host';
  policyAnalysis?: PolicyAnalysis;
  mcp?: PermissionRequest['mcp'];
  header?: string;
  onResolve: (action: PermissionDecisionAction) => void;
}

type ModalMode =
  | { kind: 'choose' }
  | { kind: 'feedback'; text: string }
  | { kind: 'pattern' | 'prefix'; text: string }
  | { kind: 'scope'; pattern: string; patternKind: 'exact' | 'glob' | 'prefix' };

interface Choice {
  /** The letter key of the earlier prompt; still works. */
  key: string;
  label: string;
  tone: 'allow' | 'deny';
  run: () => void;
}

export function PermissionModal(props: PermissionModalProps): React.ReactElement {
  const [mode, setMode] = useState<ModalMode>({ kind: 'choose' });
  const [selected, setSelected] = useState(0);
  const mandatory = Boolean(props.policyAnalysis);
  const bypass = props.policyAnalysis?.findings.some(
    (finding) =>
      finding.stageId === 'os_sandbox' && 'ruleId' in finding && finding.ruleId === 'unsandboxed',
  );
  const grantProposal = props.policyAnalysis?.grantProposal;

  const choices: Choice[] = [
    {
      key: 'a',
      label: 'Allow once',
      tone: 'allow',
      run: () => props.onResolve({ decision: 'allow' }),
    },
    ...(mandatory && grantProposal
      ? [
          {
            key: bypass ? 'w' : 'g',
            label: `Allow + session ${grantProposal.kind} ${grantProposal.path}`,
            tone: 'allow' as const,
            run: () => props.onResolve({ decision: 'allow_with_grant', grant: grantProposal }),
          },
        ]
      : []),
    ...(bypass
      ? [
          {
            key: 'A',
            label: 'Allow exact command…',
            tone: 'allow' as const,
            run: () => setMode({ kind: 'scope', pattern: props.command, patternKind: 'exact' }),
          },
          {
            key: 'g',
            label: 'Allow command prefix…',
            tone: 'allow' as const,
            run: () => setMode({ kind: 'prefix', text: props.command.trim().split(/\s+/)[0]! }),
          },
        ]
      : mandatory
        ? []
        : [
            {
              key: 'A',
              label: 'Allow & remember…',
              tone: 'allow' as const,
              run: () => setMode({ kind: 'scope', pattern: props.command, patternKind: 'exact' }),
            },
            {
              key: 'g',
              label: 'Allow pattern…',
              tone: 'allow' as const,
              run: () => setMode({ kind: 'pattern', text: props.command }),
            },
          ]),
    {
      key: 'd',
      label: 'Deny once',
      tone: 'deny',
      run: () => props.onResolve({ decision: 'deny' }),
    },
    {
      key: 'f',
      label: 'Deny with feedback…',
      tone: 'deny',
      run: () => setMode({ kind: 'feedback', text: '' }),
    },
  ];

  useInput((input, key) => {
    if (mode.kind === 'feedback') {
      if (key.return && mode.text.trim()) {
        props.onResolve({ decision: 'deny', feedback: mode.text.trim() });
      } else if (key.escape) {
        setMode({ kind: 'choose' });
      } else if (key.backspace || key.delete) {
        setMode({ kind: 'feedback', text: mode.text.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        setMode({ kind: 'feedback', text: mode.text + input });
      }
      return;
    }
    if (mode.kind === 'pattern' || mode.kind === 'prefix') {
      if (key.return) {
        setMode({
          kind: 'scope',
          pattern: mode.text,
          patternKind:
            mode.kind === 'prefix' ? 'prefix' : mode.text === props.command ? 'exact' : 'glob',
        });
      } else if (key.backspace || key.delete) {
        setMode({ ...mode, text: mode.text.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        setMode({ ...mode, text: mode.text + input });
      }
      return;
    }
    if (mode.kind === 'scope') {
      if (input === 's' || input === 'p' || input === 'g') {
        props.onResolve({
          decision: 'allow',
          remember: {
            scope: input === 's' ? 'session' : input === 'g' ? 'global' : 'project',
            pattern: mode.pattern,
            patternKind: mode.patternKind,
            ...(bypass ? { allowUnsandboxed: true } : {}),
          },
        });
      }
      return;
    }
    if (key.upArrow) {
      setSelected((index) => (index + choices.length - 1) % choices.length);
    } else if (key.downArrow) {
      setSelected((index) => (index + 1) % choices.length);
    } else if (key.return) {
      choices[selected]?.run();
    } else if (key.escape) {
      props.onResolve({ decision: 'deny' });
    } else if (/^[1-9]$/.test(input)) {
      choices[Number(input) - 1]?.run();
    } else {
      choices.find((choice) => choice.key === input)?.run();
    }
  });

  const theme = useTheme();
  const frame = useFrame('round');
  const badge = theme.ui.badge;
  const danger = theme.status.error;
  const success = theme.status.success;
  const muted = theme.text.muted;
  const bypassWarning = bypass && (
    <>
      <Text color={danger}>Warning: this command runs outside the OS sandbox.</Text>
      <Text color={danger}>
        Remembering a bypass trusts the executable, not just its arguments.
      </Text>
    </>
  );

  if (mode.kind === 'feedback') {
    return (
      <Box flexDirection="column" borderStyle={frame} borderColor={danger} padding={1}>
        <Text color={danger}>Deny with feedback (Enter to send, Esc to cancel):</Text>
        <Text>{mode.text}</Text>
      </Box>
    );
  }
  if (mode.kind === 'pattern' || mode.kind === 'prefix') {
    return (
      <Box flexDirection="column" borderStyle={frame} borderColor={badge} padding={1}>
        {bypassWarning}
        <Text color={badge}>
          Edit {mode.kind === 'prefix' ? 'command prefix' : 'pattern'} (Enter to confirm):
        </Text>
        <Text>{mode.text}</Text>
      </Box>
    );
  }
  if (mode.kind === 'scope') {
    return (
      <Box flexDirection="column" borderStyle={frame} borderColor={badge} padding={1}>
        {bypassWarning}
        {bypass && (
          <Text>
            {mode.patternKind}: {mode.pattern}
          </Text>
        )}
        <Text color={badge}>Remember for [s]ession, [p]roject, or [g]lobal?</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle={frame} borderColor={danger} padding={1}>
      <Text color={danger} bold>
        Permission required
      </Text>
      {props.header && <Text color={badge}>{props.header}</Text>}
      {props.mcp ? (
        <>
          <Text>
            Use MCP tool on the <Text bold>HOST</Text>:
          </Text>
          <Text>
            {props.mcp.server} / {props.mcp.tool}
          </Text>
          {props.mcp.preview.length > 0 && (
            <Text>
              Arguments: {props.mcp.preview.map(({ name, type }) => `${name}: ${type}`).join(', ')}
            </Text>
          )}
        </>
      ) : (
        <>
          <Text>
            Run on the <Text bold>HOST</Text>:
          </Text>
          <Text> $ {props.command}</Text>
        </>
      )}
      {props.reason && <Text color={muted}>Reason: {props.reason}</Text>}
      {props.reviewerReason && <Text color={muted}>Reviewer: {props.reviewerReason}</Text>}
      {bypassWarning}
      {props.policyAnalysis?.stages.map((stage) => (
        <Text key={stage.id} color={muted}>
          Stage {stage.id}: {stage.status}
        </Text>
      ))}
      {props.policyAnalysis?.findings.map((finding) => (
        <Text key={`${finding.stageId}:${finding.kind}:${finding.message}`} color={danger}>
          {formatFinding(finding)}
        </Text>
      ))}
      {mandatory && <Text color={muted}>Approval is not filesystem confinement.</Text>}
      <Box marginTop={1} flexDirection="column">
        {choices.map((choice, index) => {
          const active = index === selected;
          return (
            <Text key={choice.key} bold={active}>
              <Text color={badge}>{active ? '› ' : '  '}</Text>
              <Text color={choice.tone === 'allow' ? success : danger}>{`${index + 1}. `}</Text>
              {choice.label}
              <Text color={muted}>{` (${choice.key})`}</Text>
            </Text>
          );
        })}
        <Text color={muted}>↑/↓ select · enter confirm · esc deny</Text>
      </Box>
    </Box>
  );
}

function formatFinding(finding: NonNullable<PolicyAnalysis>['findings'][number]): string {
  if (finding.kind === 'risk') {
    return `Risk: ${finding.level}${finding.score === undefined ? '' : ` (${finding.score})`} — ${finding.message}`;
  }
  if (finding.kind === 'path') {
    return `${finding.operation.toUpperCase()} path: ${finding.resolvedPath ?? finding.path} — ${finding.message}`;
  }
  if (finding.kind === 'unresolved') return `Unresolved: ${finding.message}`;
  if (finding.kind === 'elevation') {
    return `Elevation (${finding.ruleId}): ${finding.message}`;
  }
  if (finding.kind === 'blocked') return `Blocked (${finding.ruleId}): ${finding.message}`;
  return `Analyzer error (${finding.stageId}): ${finding.message}`;
}
