import { Box, Text } from 'ink';
import React from 'react';

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

/**
 * A single-row status bar with two widget groups: one pinned to each edge,
 * separated by a stretchy spacer in the middle. Widgets are just React nodes
 * — any `<Text>` or composition thereof works — so each can own its own
 * styling. Falsy entries (null / undefined / false) are dropped so call sites
 * can use conditional rendering inline:
 *
 *     <StatusBar right={[scrolling && <Indicator />]} />
 */
export function StatusBar({
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
          <Box key={`l-${i}`}>
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
              <Box key={`r-${i}`}>
                {i > 0 && <Text color={separatorColor}>{separator}</Text>}
                {item}
              </Box>
            ))}
          </Box>
        </>
      )}
    </Box>
  );
}
