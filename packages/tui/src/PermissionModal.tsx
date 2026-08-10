import type { AgentEvent, PermissionDecisionAction } from '@chimera/core';
import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import { useTheme } from './theme/ThemeProvider';

type PolicyAnalysis = Extract<AgentEvent, { type: 'permission_request' }>['policyAnalysis'];
export interface PermissionModalProps {
  command: string;
  reason?: string;
  target: 'host';
  policyAnalysis?: PolicyAnalysis;
  header?: string;
  onResolve: (action: PermissionDecisionAction) => void;
}

type ModalMode =
  | { kind: 'choose' }
  | { kind: 'feedback'; text: string }
  | { kind: 'pattern'; text: string }
  | { kind: 'scope'; pattern: string };

export function PermissionModal(props: PermissionModalProps): React.ReactElement {
  const [mode, setMode] = useState<ModalMode>({ kind: 'choose' });
  const mandatory = Boolean(props.policyAnalysis);

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
    if (mode.kind === 'pattern') {
      if (key.return) setMode({ kind: 'scope', pattern: mode.text });
      else if (key.backspace || key.delete) {
        setMode({ kind: 'pattern', text: mode.text.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        setMode({ kind: 'pattern', text: mode.text + input });
      }
      return;
    }
    if (mode.kind === 'scope') {
      if (input === 's') {
        props.onResolve({ decision: 'allow', remember: { scope: 'session' } });
      } else if (input === 'p') {
        props.onResolve({
          decision: 'allow',
          remember: {
            scope: 'project',
            pattern: mode.pattern,
            patternKind: mode.pattern === props.command ? 'exact' : 'glob',
          },
        });
      }
      return;
    }
    if (input === 'a') props.onResolve({ decision: 'allow' });
    else if (input === 'd') props.onResolve({ decision: 'deny' });
    else if (input === 'f') setMode({ kind: 'feedback', text: '' });
    else if (mandatory && input === 'g' && props.policyAnalysis?.grantProposal) {
      props.onResolve({ decision: 'allow_with_grant', grant: props.policyAnalysis.grantProposal });
    } else if (!mandatory && input === 'A') {
      setMode({ kind: 'scope', pattern: props.command });
    } else if (!mandatory && input === 'g') {
      setMode({ kind: 'pattern', text: props.command });
    }
  });

  const theme = useTheme();
  const badge = theme.ui.badge;
  const danger = theme.status.error;
  const success = theme.status.success;
  const muted = theme.text.muted;

  if (mode.kind === 'feedback') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={danger} padding={1}>
        <Text color={danger}>Deny with feedback (Enter to send, Esc to cancel):</Text>
        <Text>{mode.text}</Text>
      </Box>
    );
  }
  if (mode.kind === 'pattern') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={badge} padding={1}>
        <Text color={badge}>Edit pattern (Enter to confirm):</Text>
        <Text>{mode.text}</Text>
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
        <Text>
          <Text color={success}>[a]</Text> Allow once <Text color={danger}>[d]</Text> Deny once{' '}
          <Text color={danger}>[f]</Text> Deny with feedback
        </Text>
        {mandatory && props.policyAnalysis?.grantProposal ? (
          <Text>
            <Text color={success}>[g]</Text> Allow + session{' '}
            {props.policyAnalysis.grantProposal.kind} {props.policyAnalysis.grantProposal.path}
          </Text>
        ) : null}
        {!mandatory && (
          <Text>
            <Text color={success}>[A]</Text> Allow &amp; remember <Text color={success}>[g]</Text>{' '}
            Allow pattern...
          </Text>
        )}
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
  return `Analyzer error (${finding.stageId}): ${finding.message}`;
}
