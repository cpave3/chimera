import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityLine } from './ActivityLine';
import { describeActivity } from './activity';
import { ContextPanel, type Peer } from './ContextPanel';
import { Dialogs } from './Dialogs';
import { FileMenu } from './FileMenu';
import { HelpPanel } from './HelpPanel';
import { renderPromptLines } from './prompt-view';
import { QueueList } from './QueueList';
import { SlashMenu } from './SlashMenu';
import { TaskPanel } from './TaskPanel';
import { TranscriptPane } from './TranscriptPane';
import { useTheme } from './theme/ThemeProvider';
import type { AppView } from './view';
import { readWorktree, type WorktreeStatus } from './worktree';

/** Below this the transcript needs every column, so the panel goes. */
export const MIN_COLUMNS_FOR_PANEL = 100;
const PANEL_SHARE = 0.27;
const MIN_PANEL_WIDTH = 32;
const MAX_PANEL_WIDTH = 42;

/** The panel takes about a quarter of the screen, within what its rows need. */
export function panelWidth(columns: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.round(columns * PANEL_SHARE)));
}

/** Key hints in display order, each with the order in which it gives way. */
const IDLE_HINTS: Array<[text: string, keep: number]> = [
  ['⇧⇥ mode', 2],
  ['/ commands', 3],
  ['@ file', 1],
  ['^b panel', 0],
  ['? help', 4],
];
const RUN_HINTS: Array<[text: string, keep: number]> = [
  ['enter steer', 2],
  ['tab queue', 0],
  ['esc interrupt', 1],
];
const HINT_SEPARATOR = ' · ';

/** Join the hints that fit in `room`, dropping the least useful first. */
export function fitHints(hints: Array<[text: string, keep: number]>, room: number): string {
  let kept = hints;
  while (kept.length > 1 && kept.map(([text]) => text).join(HINT_SEPARATOR).length > room) {
    const least = Math.min(...kept.map(([, keep]) => keep));
    kept = kept.filter(([, keep]) => keep !== least);
  }
  return kept.map(([text]) => text).join(HINT_SEPARATOR);
}
const COLUMN_PADDING = 2;
const MAX_QUEUED_LINES = 3;
const MAX_TASK_LINES = 6;
const WORKTREE_SETTLE_MS = 400;
const PEERS_INTERVAL_MS = 5_000;
// The skills index is prose, priced like the rest of the estimate: four characters a token.
const CHARACTERS_PER_TOKEN = 4;

const PROMPT_STYLE = { marker: '› ', bangMarker: '$ ', placeholder: 'message chimera' };

/** Estimated size of the system prompt, read again whenever the context count moves. */
function useSystemTokens(view: AppView, enabled: boolean): number | null {
  const [systemTokens, setSystemTokens] = useState<number | null>(null);
  const { client, sessionId } = view.activeSession;
  const usedContextTokens = view.usageState?.usedContextTokens ?? null;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    client.getContextBreakdown(sessionId).then(
      (breakdown) => {
        if (!cancelled) setSystemTokens(breakdown.systemPromptTokens);
      },
      () => {
        if (!cancelled) setSystemTokens(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, usedContextTokens, enabled]);
  return systemTokens;
}

/** The working tree, read at start and after each burst of finished work. */
function useWorktree(view: AppView, enabled: boolean): WorktreeStatus | null {
  const [worktree, setWorktree] = useState<WorktreeStatus | null>(null);
  const read = view.props.readWorktree ?? readWorktree;
  const { cwd } = view.props;
  const finishedCount = view.committedEntries.length;
  const { running } = view;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      read(cwd).then(
        (status) => {
          if (!cancelled) setWorktree(status);
        },
        () => {},
      );
    }, WORKTREE_SETTLE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [read, cwd, finishedCount, running, enabled]);
  return worktree;
}

function usePeers(view: AppView, enabled: boolean): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  const { listPeers } = view.props;
  useEffect(() => {
    if (!enabled || !listPeers) return;
    let cancelled = false;
    const refresh = () => {
      listPeers().then(
        (found) => {
          if (!cancelled) setPeers(found);
        },
        () => {},
      );
    };
    refresh();
    const timer = setInterval(refresh, PEERS_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [listPeers, enabled]);
  return peers;
}

/**
 * The layout that owns the screen: the transcript scrolls in its own pane
 * above the prompt, and a context panel stays in view beside it.
 */
export function FullscreenView({ view }: { view: AppView }): React.ReactElement {
  const theme = useTheme();
  const { props, columns, rows, buffer, running, compacting, tasks } = view;
  const [scrolled, setScrolled] = useState(false);
  const onScrolledChange = useCallback((next: boolean) => setScrolled(next), []);

  const panelFits = columns >= MIN_COLUMNS_FOR_PANEL;
  const panelShown = view.panelOpen && panelFits;
  const panelColumns = panelShown ? panelWidth(columns) : 0;
  const textWidth = Math.max(20, columns - panelColumns - 2 * COLUMN_PADDING);
  const dim = theme.text.dim ?? theme.text.muted;

  const systemTokens = useSystemTokens(view, panelShown);
  const worktree = useWorktree(view, panelShown);
  const peers = usePeers(view, panelShown);
  // The registry answers a new index only when a skill file changes.
  const skillsIndex = props.skills?.buildIndex() ?? '';
  const skillsTokens = Math.ceil(skillsIndex.length / CHARACTERS_PER_TOKEN);

  const isBangBuffer = buffer.text.startsWith('!');
  const promptBody = useMemo(
    () =>
      renderPromptLines(
        buffer,
        theme.ui.accent,
        theme.accent.secondary,
        view.editorOpen,
        isBangBuffer,
        { ...PROMPT_STYLE, placeholderColor: dim },
      ),
    [buffer, view.editorOpen, theme.ui.accent, theme.accent.secondary, isBangBuffer, dim],
  );

  // Kept apart from the element so the badge colour follows a mode file reload.
  const modeColor = (name: string) => props.modes?.find(name)?.colorHex ?? theme.accent.secondary;
  const pendingMode =
    view.pendingModeName && view.pendingModeName !== view.activeModeName
      ? view.pendingModeName
      : null;
  const usage = view.usageState;
  const percent =
    usage && usage.contextWindow > 0
      ? Math.round((usage.usedContextTokens / usage.contextWindow) * 100)
      : null;
  const facts = panelShown
    ? ''
    : `${view.currentModelRef}${percent === null ? '' : ` · ${percent}%`}`;
  const badge = ` ${view.activeModeName.toUpperCase()} `;
  const pendingBadge = pendingMode ? ` → ${pendingMode.toUpperCase()}` : '';
  const hintRoom =
    textWidth - badge.length - pendingBadge.length - 2 - (facts === '' ? 0 : facts.length + 2);
  const hints = scrolled
    ? 'pgdn to the latest output'
    : fitHints(
        running ? RUN_HINTS : IDLE_HINTS.filter(([text]) => panelFits || text !== '^b panel'),
        hintRoom,
      );

  const lastElapsedRef = useRef(0);
  if (view.runStartedAt !== null) lastElapsedRef.current = Date.now() - view.runStartedAt;

  return (
    <Box width={columns} height={rows} overflow="hidden" backgroundColor={theme.base.background}>
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        paddingX={COLUMN_PADDING}
        paddingTop={1}
      >
        <TranscriptPane view={view} width={textWidth} onScrolledChange={onScrolledChange} />
        {!panelShown && running && tasks.length > 0 && (
          <Box marginTop={1} flexShrink={0}>
            <TaskPanel tasks={tasks} maxLines={MAX_TASK_LINES} />
          </Box>
        )}
        {(running || compacting) && (
          <Box marginTop={1} flexShrink={0}>
            <ActivityLine
              spinner={view.spinner}
              label={describeActivity({
                awaitingApproval: view.pending !== null,
                compacting,
                retry: view.retry,
                inFlightTool: view.inFlightTool,
                streaming: view.streaming,
              })}
              elapsedMs={lastElapsedRef.current}
              tokens={view.runOutputTokens}
              step={running ? view.runSteps + 1 : 0}
              canInterrupt={running}
              width={textWidth}
            />
          </Box>
        )}
        <Box flexDirection="column" flexShrink={0}>
          {view.helpOpen && <HelpPanel />}
          <QueueList messages={view.queue} maxLines={MAX_QUEUED_LINES} />
          <Dialogs view={view} />
          {view.menuItems.length > 0 && (
            <SlashMenu items={view.menuItems} highlightIdx={view.menuHighlight} />
          )}
          {view.fileMenuItems.length > 0 && (
            <FileMenu
              paths={view.fileMenuItems}
              highlightIdx={Math.min(view.fileMenuHighlight, view.fileMenuItems.length - 1)}
            />
          )}
        </Box>
        {theme.surface.raised ? (
          <Box
            flexDirection="column"
            flexShrink={0}
            marginTop={1}
            paddingX={COLUMN_PADDING}
            paddingY={1}
            backgroundColor={theme.surface.raised}
          >
            {promptBody}
          </Box>
        ) : (
          // Without a fill, a rule above the prompt sets it apart.
          <Box
            flexDirection="column"
            flexShrink={0}
            borderStyle="single"
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
            borderColor={theme.text.muted}
          >
            {promptBody}
          </Box>
        )}
        <Box flexShrink={0} width={textWidth} justifyContent="space-between">
          <Text wrap="truncate">
            <Text
              backgroundColor={modeColor(view.activeModeName)}
              color={theme.base.background ?? 'black'}
              bold
            >
              {badge}
            </Text>
            {pendingMode && <Text color={modeColor(pendingMode)}>{pendingBadge}</Text>}
            <Text color={dim}>{`  ${hints}`}</Text>
          </Text>
          {facts !== '' && <Text color={theme.text.muted}>{facts}</Text>}
        </Box>
      </Box>
      {panelShown && (
        <ContextPanel
          width={panelColumns}
          modelRef={view.currentModelRef}
          visionRouteRef={view.visionRouteRef}
          sessionId={view.activeSession.sessionId}
          forked={view.activeParentId !== null}
          cwd={props.cwd}
          sandboxMode={view.sandboxMode}
          skillCount={props.skills?.all().length ?? 0}
          commandCount={props.commands?.list().length ?? 0}
          usageState={view.usageState}
          systemTokens={systemTokens}
          skillsTokens={skillsTokens}
          tasks={tasks}
          worktree={worktree}
          peers={peers}
        />
      )}
    </Box>
  );
}
