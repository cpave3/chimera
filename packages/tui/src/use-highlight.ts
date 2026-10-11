import { useCallback, useRef, useState } from 'react';

/**
 * The highlighted row of a list, readable by a key handler at once.
 *
 * React applies a state update on the next render. A handler that reads the
 * state after "down, Enter" in one burst of input therefore acts on the row
 * before the move. `current` always holds the newest row.
 */
export function useHighlight(initial: number | (() => number)): {
  highlight: number;
  current: { readonly current: number };
  move: (next: (index: number) => number) => void;
} {
  const [highlight, setHighlight] = useState(initial);
  const current = useRef(highlight);
  const move = useCallback((next: (index: number) => number) => {
    current.current = next(current.current);
    setHighlight(current.current);
  }, []);
  return { highlight, current, move };
}
