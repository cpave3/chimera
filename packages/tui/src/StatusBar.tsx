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

/** Shallow comparison for plain objects used as React props.
 *  Only recurses into plain objects and arrays; anything else falls back
 *  to `Object.is`. This keeps the comparison O(tree-size) and safe from
 *  prototype-chain or circular-reference problems. */
function samePlainObject(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    // Values compared via sameNode so nested primitives / arrays / elements
    // are handled consistently.
    if (!sameNode(a[key], b[key])) return false;
  }
  return true;
}

/** Deep structural equality for React nodes used in StatusBar widgets.
 *  Falls back to reference equality for non-serialisable props (functions,
 *  refs, etc.) so the comparison stays O(tree-size) and conservative. */
function sameNode(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return a === b;

  const aIsElement = React.isValidElement(a);
  const bIsElement = React.isValidElement(b);
  if (aIsElement !== bIsElement) return false;

  if (aIsElement && bIsElement) {
    if (a.type !== b.type) return false;
    if (a.key !== b.key) return false;
    const aProps = a.props as Record<string, unknown>;
    const bProps = b.props as Record<string, unknown>;
    return samePlainObject(aProps, bProps);
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return sameArray(a, b);
  }

  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    Object.getPrototypeOf(a) === Object.prototype &&
    Object.getPrototypeOf(b) === Object.prototype
  ) {
    return samePlainObject(a as Record<string, unknown>, b as Record<string, unknown>);
  }

  return false;
}

function sameArray(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameNode(a[i], b[i])) return false;
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
 * Memoised so that structurally-equal widget arrays avoid re-renders, even
 * when React has recreated the JSX elements (e.g. useMemo cache eviction).
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
