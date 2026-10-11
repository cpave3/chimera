import { Box, Static } from 'ink';
import React, { useMemo } from 'react';
import { ActivityLine } from './ActivityLine';
import { describeActivity } from './activity';
import { BottomChrome } from './BottomChrome';
import { Dialogs } from './Dialogs';
import { FileMenu } from './FileMenu';
import { Header } from './Header';
import { HelpPanel } from './HelpPanel';
import { planLiveRegion } from './live-region';
import { renderPromptLines } from './prompt-view';
import { QueueList } from './QueueList';
import { SlashMenu } from './SlashMenu';
import type { ScrollbackEntry, SubagentEntry } from './scrollback';
import { TaskPanel } from './TaskPanel';
import { useTheme } from './theme/ThemeProvider';
import { clampInFlightChildren, renderEntryLines } from './transcript';
import { CHIMERA_VERSION } from './version';
import { type AppView, dialogOpen } from './view';

type StaticItem =
  | { kind: 'header'; id: '__header__' }
  | {
      kind: 'entry';
      id: string;
      entry: ScrollbackEntry;
      children: SubagentEntry[];
    };

/**
 * The layout that prints into the terminal's own scrollback: finished
 * entries go out once through `<Static>`, and a short live region under
 * them holds what is still changing.
 */
export function InlineView({ view }: { view: AppView }): React.ReactElement {
  const theme = useTheme();
  const { props, columns, sandboxMode, buffer, tasks, queue, running, compacting } = view;

  // `<Static>` renders positionally and append-only (it prints
  // `items.slice(lastLength)`), so the committed list must be a strictly
  // growing prefix of the entry order. The Scrollback store owns that
  // cursor; entries past it render in the live region below.
  const staticItems = useMemo<StaticItem[]>(() => {
    const entryItems: StaticItem[] = view.committedEntries.map((entry) => ({
      kind: 'entry',
      id: entry.id,
      entry,
      children: view.childrenByParent.get(entry.id) ?? [],
    }));
    return view.showHeader ? [{ kind: 'header', id: '__header__' }, ...entryItems] : entryItems;
  }, [view.committedEntries, view.childrenByParent, view.showHeader]);

  const liveRegion = planLiveRegion({
    rows: view.rows,
    promptLines: buffer.text.split('\n').length,
    taskCount: tasks.length,
    queuedCount: queue.length,
    helpOpen: view.helpOpen,
    modalOpen: dialogOpen(view),
  });

  // Steady-state during a run: the buffer is empty and the spinner /
  // streaming deltas re-render App many times per second. Keep the prompt
  // subtree referentially stable across those renders, and collapse the
  // outer layout to a single row when the buffer is single-line so the
  // dynamic frame's height stays exactly 1 — matching the pre-multiline
  // structure that did not flicker.
  const isMultilineBuffer = buffer.text.includes('\n');
  const isBangBuffer = buffer.text.startsWith('!');
  const promptBody = useMemo(
    () =>
      renderPromptLines(
        buffer,
        theme.accent.primary,
        theme.accent.secondary,
        view.editorOpen,
        isBangBuffer,
      ),
    [buffer, view.editorOpen, theme.accent.primary, theme.accent.secondary, isBangBuffer],
  );

  return (
    <>
      <Static key={`static-${view.transcriptEpoch}`} items={staticItems}>
        {(item) => {
          if (item.kind === 'header') {
            return (
              <Box key={item.id}>
                <Header
                  version={CHIMERA_VERSION}
                  modelRef={props.modelRef}
                  cwd={props.cwd}
                  sessionId={props.sessionId}
                  mode={props.initialMode ?? 'build'}
                  sandboxMode={sandboxMode}
                  skillCount={props.skills?.all().length ?? 0}
                  commandCount={props.commands?.list().length ?? 0}
                />
              </Box>
            );
          }
          return (
            <Box key={item.id} flexDirection="column" marginTop={1}>
              {renderEntryLines(item.entry, columns, theme, item.children, {
                sandboxActive: sandboxMode !== 'off',
              })}
            </Box>
          );
        }}
      </Static>
      <Box flexDirection="column" width={columns}>
        {view.inFlightEntries.map((entry) => (
          <Box key={entry.id} flexDirection="column" marginTop={1}>
            {renderEntryLines(
              entry,
              columns,
              theme,
              clampInFlightChildren(entry.id, view.childrenByParent.get(entry.id) ?? []),
              { sandboxActive: sandboxMode !== 'off' },
            )}
          </Box>
        ))}
        {running && liveRegion.taskLines > 0 && (
          <Box marginTop={1}>
            <TaskPanel tasks={tasks} maxLines={liveRegion.taskLines - 1} />
          </Box>
        )}
        {(running || compacting) && (
          <ActivityLine
            spinner={view.spinner}
            label={describeActivity({
              awaitingApproval: view.pending !== null,
              compacting,
              retry: view.retry,
              inFlightTool: view.inFlightTool,
              streaming: view.streaming,
            })}
            elapsedMs={Date.now() - (view.runStartedAt ?? Date.now())}
            tokens={view.runOutputTokens}
            step={running ? view.runSteps + 1 : 0}
            canInterrupt={running}
            width={columns}
          />
        )}
        {view.helpOpen && <HelpPanel />}
        <QueueList messages={queue} maxLines={liveRegion.queuedLines} />
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
      <BottomChrome
        width={columns}
        cwd={props.cwd}
        sessionId={view.activeSession.sessionId}
        running={running}
        sandboxMode={sandboxMode}
        modes={props.modes}
        activeModeName={view.activeModeName}
        pendingModeName={view.pendingModeName}
        currentModelRef={view.currentModelRef}
        visionRouteRef={view.visionRouteRef}
        forked={view.activeParentId !== null}
        tasks={tasks}
        usageState={view.usageState}
      />
    </>
  );
}
