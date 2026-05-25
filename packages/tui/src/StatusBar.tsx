import { Box, Text } from 'ink';
import React, { memo } from 'react';

export type StatusBarWidget = React.ReactNode;

export interface StatusBarProps {
  /** Widgets rendered left-to-right, pinned to the left edge. */
  left?: StatusBarWidget[];
  /** Widgets rendered left-to-right, pinned to the right edge. */
  right?: StatusBarWidget[];
  /** String rendered between consecutive widgets in the same group. */
  separator?: string;
  /** Color for the separator text. */
  separatorColor?: string;
}

function sameArray(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * A single-row status bar with two widget groups: one pinned to each edge,
 * separated by a stretchy spacer in the middle. Widgets are just React nodes
 * — any `<Text>` or composition thereof works — so each can own its own
 * styling. Falsy entries (null / undefined / false) are dropped so call sites
 * can use conditional rendering inline:
 *
 *     <StatusBar right={[scrolling && <Indicator />]} />
 *
 * Memoised so that referentially-stable widget arrays avoid re-renders.
 */
export const StatusBar = memo(function StatusBar({
  left = [],
  right = [],
  separator = ' · ',
  separatorColor,
}: StatusBarProps): React.ReactElement {
  const leftItems = left.filter((x) => x !== null && x !== undefined && x !== false);
  const rightItems = right.filter((x) => x !== null && x !== undefined && x !== false);

  return (
    <Box height={1} overflow="hidden">
      <Box>
        {leftItems.map((item, i) => (
          <Box
            // biome-ignore lint/suspicious/noArrayIndexKey: opaque React nodes, index is stable ordering
            key={`l-${i}`}
          >
            {i > 0 && <Text color={separatorColor}>{separator}</Text>}
            {item}
          </Box>
        ))}
      </Box>
      {rightItems.length > 0 && (
        <>
          <Box flexGrow={1} />
          <Box>
            {rightItems.map((item, i) => (
              <Box
                // biome-ignore lint/suspicious/noArrayIndexKey: opaque React nodes, index is stable ordering
                key={`r-${i}`}
              >
                {i > 0 && <Text color={separatorColor}>{separator}</Text>}
                {item}
              </Box>
            ))}
          </Box>
        </>
      )}
    </Box>
  );
}, arePropsEqual);

function arePropsEqual(prev: StatusBarProps, next: StatusBarProps): boolean {
  return (
    prev.separator === next.separator &&
    prev.separatorColor === next.separatorColor &&
    sameArray(prev.left, next.left) &&
    sameArray(prev.right, next.right)
  );
}
