import type { AgentEvent, PermissionDecisionAction, PermissionRequest } from '@chimera/core';
import { Box, type DOMElement, getScrollHeight, measureElement, Text, useInput } from 'ink';
import React, { type MutableRefObject, useLayoutEffect, useRef, useState } from 'react';
import { useFrame } from './frame';
import { useTheme } from './theme/ThemeProvider';
import type { DialogScroller } from './view';

type PolicyAnalysis = Extract<AgentEvent, { type: 'permission_request' }>['policyAnalysis'];
export interface PermissionModalProps {
  command: string;
  reason?: string;
  /** Why the approval reviewer sent the request to the user. */
  reviewerReason?: string;
  /** What the System One check found; it follows the words "System One". */
  systemOneNote?: string;
  target: 'host';
  policyAnalysis?: PolicyAnalysis;
  mcp?: PermissionRequest['mcp'];
  header?: string;
  /** Rows the prompt may take; past them the request scrolls above the choices. */
  maxHeight?: number;
  /** Where the prompt leaves its scroller for the layout's page keys and wheel. */
  scrollerRef?: MutableRefObject<DialogScroller | null>;
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
  const [mode, setModeState] = useState<ModalMode>({ kind: 'choose' });
  // Keys can arrive faster than renders: a paste into the feedback text, for
  // one. Each key must start from the mode the key before it left.
  const modeRef = useRef(mode);
  const setMode = (next: ModalMode) => {
    modeRef.current = next;
    setModeState(next);
  };
  const [selected, setSelectedState] = useState(0);
  const selectedRef = useRef(selected);
  const setSelected = (next: number) => {
    selectedRef.current = next;
    setSelectedState(next);
  };
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
    const current = modeRef.current;
    if (current.kind === 'feedback') {
      if (key.return && current.text.trim()) {
        props.onResolve({ decision: 'deny', feedback: current.text.trim() });
      } else if (key.escape) {
        setMode({ kind: 'choose' });
      } else if (key.backspace || key.delete) {
        setMode({ kind: 'feedback', text: current.text.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        setMode({ kind: 'feedback', text: current.text + input });
      }
      return;
    }
    if (current.kind === 'pattern' || current.kind === 'prefix') {
      if (key.return) {
        setMode({
          kind: 'scope',
          pattern: current.text,
          patternKind:
            current.kind === 'prefix'
              ? 'prefix'
              : current.text === props.command
                ? 'exact'
                : 'glob',
        });
      } else if (key.backspace || key.delete) {
        setMode({ ...current, text: current.text.slice(0, -1) });
      } else if (input && !key.ctrl && !key.meta) {
        setMode({ ...current, text: current.text + input });
      }
      return;
    }
    if (current.kind === 'scope') {
      if (input === 's' || input === 'p' || input === 'g') {
        props.onResolve({
          decision: 'allow',
          remember: {
            scope: input === 's' ? 'session' : input === 'g' ? 'global' : 'project',
            pattern: current.pattern,
            patternKind: current.patternKind,
            ...(bypass ? { allowUnsandboxed: true } : {}),
          },
        });
      }
      return;
    }
    if (key.upArrow) {
      setSelected((selectedRef.current + choices.length - 1) % choices.length);
    } else if (key.downArrow) {
      setSelected((selectedRef.current + 1) % choices.length);
    } else if (key.return) {
      choices[selectedRef.current]?.run();
    } else if (key.escape) {
      props.onResolve({ decision: 'deny' });
    } else if (/^[1-9]$/.test(input)) {
      choices[Number(input) - 1]?.run();
    } else {
      choices.find((choice) => choice.key === input)?.run();
    }
  });

  const theme = useTheme();
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
      <PromptFrame
        key="feedback"
        borderColor={danger}
        header={<Text color={danger}>Deny with feedback (Enter to send, Esc to cancel):</Text>}
        followEnd
        maxHeight={props.maxHeight}
        scrollerRef={props.scrollerRef}
      >
        <Text>{mode.text}</Text>
      </PromptFrame>
    );
  }
  if (mode.kind === 'pattern' || mode.kind === 'prefix') {
    return (
      <PromptFrame
        key="edit"
        borderColor={badge}
        header={
          <>
            {bypassWarning}
            <Text color={badge}>
              Edit {mode.kind === 'prefix' ? 'command prefix' : 'pattern'} (Enter to confirm):
            </Text>
          </>
        }
        followEnd
        maxHeight={props.maxHeight}
        scrollerRef={props.scrollerRef}
      >
        <Text>{mode.text}</Text>
      </PromptFrame>
    );
  }
  if (mode.kind === 'scope') {
    return (
      <PromptFrame
        key="scope"
        borderColor={badge}
        footer={<Text color={badge}>Remember for [s]ession, [p]roject, or [g]lobal?</Text>}
        maxHeight={props.maxHeight}
        scrollerRef={props.scrollerRef}
      >
        {bypassWarning}
        {bypass && (
          <Text>
            {mode.patternKind}: {mode.pattern}
          </Text>
        )}
      </PromptFrame>
    );
  }

  const choiceList = (
    <Box flexDirection="column" marginTop={1}>
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
  );

  return (
    <PromptFrame
      key="choose"
      borderColor={danger}
      footer={choiceList}
      maxHeight={props.maxHeight}
      scrollerRef={props.scrollerRef}
    >
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
      {props.systemOneNote && <Text color={muted}>System One {props.systemOneNote}</Text>}
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
    </PromptFrame>
  );
}

// Past the end of any prompt; Ink clamps it to the last line.
const FOLLOW_END = 1_000_000_000;

interface PromptFrameProps {
  borderColor: string;
  /** Lines that stay in view above the part that scrolls. */
  header?: React.ReactNode;
  /** Lines that stay in view under the part that scrolls. */
  footer?: React.ReactNode;
  /** Start at the last line and stay there: the body is text being typed. */
  followEnd?: boolean;
  maxHeight?: number;
  scrollerRef?: MutableRefObject<DialogScroller | null>;
  children: React.ReactNode;
}

/**
 * The prompt's border, with a body that gives up rows when the layout has
 * fewer than the prompt needs: the body scrolls, and the header and the
 * footer stay put.
 */
function PromptFrame({
  borderColor,
  header,
  footer,
  followEnd = false,
  maxHeight,
  scrollerRef,
  children,
}: PromptFrameProps): React.ReactElement {
  const theme = useTheme();
  const frame = useFrame('round');
  const bodyRef = useRef<DOMElement>(null);
  // null follows the end; a number is a line the user scrolled to.
  const [scrollTop, setScrollTop] = useState<number | null>(followEnd ? null : 0);
  // A burst of wheel reports arrives between two renders; each one must
  // start from where the one before it left off.
  const scrollTopRef = useRef(scrollTop);

  function scrollBy(lines: number): boolean {
    const body = bodyRef.current;
    if (!body) return false;
    const lastTop = getScrollHeight(body) - measureElement(body).height;
    if (lastTop <= 0) return false;
    // A taller screen may have left the old position past the end.
    const current = Math.min(scrollTopRef.current ?? lastTop, lastTop);
    const target = Math.max(0, Math.min(lastTop, current + lines));
    scrollTopRef.current = followEnd && target >= lastTop ? null : target;
    setScrollTop(scrollTopRef.current);
    return true;
  }

  // Rows of the body on screen and rows of what it holds, as Ink last laid them out.
  const [extent, setExtent] = useState({ shown: 0, total: 0 });
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const shown = measureElement(body).height;
    const total = getScrollHeight(body);
    if (shown !== extent.shown || total !== extent.total) setExtent({ shown, total });
  });
  const lastTop = extent.total - extent.shown;
  const firstShown = Math.min(scrollTop ?? lastTop, lastTop);

  // A layout effect: a key that arrives right after a render must find the scroller.
  useLayoutEffect(() => {
    if (!scrollerRef) return;
    scrollerRef.current = {
      scrollBy,
      scrollPages: (pages) => {
        const body = bodyRef.current;
        return body ? scrollBy(pages * Math.max(1, measureElement(body).height - 1)) : false;
      },
    };
    return () => {
      scrollerRef.current = null;
    };
  });

  return (
    <Box
      flexDirection="column"
      borderStyle={frame}
      borderColor={borderColor}
      padding={1}
      maxHeight={maxHeight}
    >
      {header && (
        <Box flexDirection="column" flexShrink={0}>
          {header}
        </Box>
      )}
      <Box
        ref={bodyRef}
        flexDirection="column"
        flexShrink={1}
        overflowY="scroll"
        overflowX="hidden"
        scrollTop={scrollTop ?? FOLLOW_END}
        scrollbarThumbColor={theme.text.dim ?? theme.text.muted}
      >
        {/* A scroll box squeezes its children to fit; this one keeps the lines whole. */}
        <Box flexDirection="column" flexShrink={0} backgroundColor={theme.base.background}>
          {children}
        </Box>
      </Box>
      {lastTop > 0 && (
        <Box flexShrink={0}>
          <Text color={theme.text.dim ?? theme.text.muted} wrap="truncate">
            {`lines ${firstShown + 1}–${firstShown + extent.shown} of ${extent.total} · pgup/pgdn scroll`}
          </Text>
        </Box>
      )}
      {footer && (
        <Box flexDirection="column" flexShrink={0}>
          {footer}
        </Box>
      )}
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
