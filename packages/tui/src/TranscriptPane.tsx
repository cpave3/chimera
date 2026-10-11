import { Box, type DOMElement, getScrollHeight, measureElement, StaticRender, Text } from 'ink';
import React, { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScrollbackEntry, SubagentEntry } from './scrollback';
import { useTheme } from './theme/ThemeProvider';
import type { Theme } from './theme/types';
import { entryGap, renderEntryLines } from './transcript';
import type { AppView } from './view';

/** Finished entries mounted at a time, and how many more a scroll to the top adds. */
export const WINDOW_STEP = 300;
// Past the end of any transcript; Ink clamps it to the last line.
const FOLLOW_END = 1_000_000_000;

// A scroll box must not squeeze its rows to fit: the rows that do not fit are what it scrolls.
const NO_SHRINK = { flexShrink: 0 } as const;

interface FinishedEntryProps {
  entry: ScrollbackEntry;
  subagents: SubagentEntry[];
  width: number;
  gap: number;
  theme: Theme;
  sandboxActive: boolean;
}

/**
 * A finished entry never changes, so its drawn lines are cached: Ink reuses
 * them on every later frame instead of walking the entry's nodes again. The
 * cache lives as long as the element, so the caller keys the element by
 * whatever the drawing depends on.
 *
 * The box carries the background itself: the scroll box draws its content
 * as one block, and a cell the entry leaves blank would otherwise show the
 * terminal's own background.
 */
const FinishedEntry = memo(function FinishedEntry({
  entry,
  subagents,
  width,
  gap,
  theme,
  sandboxActive,
}: FinishedEntryProps): React.ReactElement {
  return (
    <StaticRender width={width} style={NO_SHRINK}>
      <Box
        flexDirection="column"
        paddingTop={gap}
        width={width}
        backgroundColor={theme.base.background}
      >
        {renderEntryLines(entry, width, theme, subagents, { sandboxActive })}
      </Box>
    </StaticRender>
  );
});

const NO_SUBAGENTS: SubagentEntry[] = [];

export interface TranscriptPaneProps {
  view: AppView;
  /** Columns of text in the pane. */
  width: number;
  /** Tells the layout whether the user has scrolled away from the end. */
  onScrolledChange: (scrolled: boolean) => void;
}

/**
 * The transcript of the fullscreen layout: a scroll box that follows the
 * newest output until the user scrolls, then holds still.
 */
export function TranscriptPane({
  view,
  width,
  onScrolledChange,
}: TranscriptPaneProps): React.ReactElement {
  const theme = useTheme();
  const paneRef = useRef<DOMElement>(null);
  // null follows the end; a number is a line the user scrolled to.
  const [scrollTop, setScrollTopState] = useState<number | null>(null);
  // A burst of wheel reports arrives between two renders; each one must
  // start from where the one before it left off.
  const scrollTopRef = useRef<number | null>(null);
  const setScrollTop = (next: number | null) => {
    scrollTopRef.current = next;
    setScrollTopState(next);
  };
  const [windowStart, setWindowStart] = useState(0);
  // The scroll height before the window grew upward, to keep the view in place.
  const heightBeforeGrowthRef = useRef<number | null>(null);
  const themeVersionRef = useRef({ theme, version: 0 });
  if (themeVersionRef.current.theme !== theme) {
    themeVersionRef.current = { theme, version: themeVersionRef.current.version + 1 };
  }

  const windowStep = view.props.transcriptWindow ?? WINDOW_STEP;
  const finished = view.committedEntries;
  let firstMounted = Math.min(windowStart, finished.length);
  // Nobody reads the top while the view follows the end, so the window
  // slides forward there; a scrolled view keeps every entry it has.
  if (scrollTop === null && finished.length - firstMounted > 2 * windowStep) {
    firstMounted = finished.length - windowStep;
    setWindowStart(firstMounted);
  }

  useEffect(() => {
    setScrollTop(null);
    setWindowStart(0);
  }, [view.transcriptEpoch]);

  useEffect(() => {
    onScrolledChange(scrollTop !== null);
  }, [scrollTop, onScrolledChange]);

  // Layout effects, not passive ones: Ink has laid the new entries out by
  // now, and a key that arrives after a long render must not find the old
  // window or the old scroller.
  useLayoutEffect(() => {
    const before = heightBeforeGrowthRef.current;
    heightBeforeGrowthRef.current = null;
    const pane = paneRef.current;
    if (before === null || !pane) return;
    const added = getScrollHeight(pane) - before;
    if (added > 0 && scrollTopRef.current !== null) setScrollTop(scrollTopRef.current + added);
  }, [windowStart]);

  function scrollBy(lines: number): void {
    const pane = paneRef.current;
    if (!pane) return;
    const scrollHeight = getScrollHeight(pane);
    const lastTop = Math.max(0, scrollHeight - measureElement(pane).height);
    const current = scrollTopRef.current ?? lastTop;
    // A scroll up from the top asks for the entries before the window.
    if (current === 0 && lines < 0 && firstMounted > 0) {
      if (heightBeforeGrowthRef.current === null) {
        heightBeforeGrowthRef.current = scrollHeight;
        setWindowStart(Math.max(0, firstMounted - windowStep));
      }
      return;
    }
    const target = Math.max(0, Math.min(lastTop, current + lines));
    setScrollTop(target >= lastTop ? null : target);
  }

  useLayoutEffect(() => {
    view.scrollerRef.current = {
      scrollBy,
      scrollPages: (pages) => {
        const pane = paneRef.current;
        if (pane) scrollBy(pages * Math.max(1, measureElement(pane).height - 1));
      },
      toEnd: () => setScrollTop(null),
    };
    return () => {
      view.scrollerRef.current = null;
    };
  });

  const sandboxActive = view.sandboxMode !== 'off';
  const mounted = firstMounted > 0 ? finished.slice(firstMounted) : finished;
  const cacheKey = `${width}:${themeVersionRef.current.version}`;
  const empty = finished.length === 0 && view.inFlightEntries.length === 0;

  return (
    <Box
      ref={paneRef}
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      overflowY="scroll"
      overflowX="hidden"
      backgroundColor={theme.base.background}
      scrollTop={scrollTop ?? FOLLOW_END}
      scrollbar={scrollTop !== null}
      scrollbarThumbColor={theme.text.dim ?? theme.text.muted}
    >
      {firstMounted > 0 && (
        <Box flexShrink={0} width={width} backgroundColor={theme.base.background}>
          <Text color={theme.text.dim ?? theme.text.muted}>
            {`… ${firstMounted} earlier ${firstMounted === 1 ? 'entry' : 'entries'} · scroll up for more`}
          </Text>
        </Box>
      )}
      {empty && (
        <Box flexShrink={0} width={width} backgroundColor={theme.base.background}>
          <Text color={theme.text.dim ?? theme.text.muted}>
            Describe a task to start. Press ? for the keys.
          </Text>
        </Box>
      )}
      {mounted.map((entry, index) => (
        <FinishedEntry
          key={`${entry.id}:${cacheKey}`}
          entry={entry}
          subagents={view.childrenByParent.get(entry.id) ?? NO_SUBAGENTS}
          width={width}
          gap={firstMounted + index === 0 ? 0 : entryGap(finished[firstMounted + index - 1], entry)}
          theme={theme}
          sandboxActive={sandboxActive}
        />
      ))}
      {view.inFlightEntries.map((entry, index) => (
        <Box
          key={entry.id}
          flexDirection="column"
          flexShrink={0}
          width={width}
          backgroundColor={theme.base.background}
          paddingTop={
            index === 0 && finished.length === 0
              ? 0
              : entryGap(view.inFlightEntries[index - 1] ?? finished.at(-1), entry)
          }
        >
          {renderEntryLines(entry, width, theme, view.childrenByParent.get(entry.id) ?? [], {
            sandboxActive,
          })}
        </Box>
      ))}
    </Box>
  );
}
