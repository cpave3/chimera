import chalk from 'chalk';
import type { BoxProps } from 'ink';
import { useTheme } from './theme/ThemeProvider';

type FrameKind = 'round' | 'single';

const GLYPHS: Record<FrameKind, Record<string, string>> = {
  round: {
    topLeft: '╭',
    top: '─',
    topRight: '╮',
    right: '│',
    bottomRight: '╯',
    bottom: '─',
    bottomLeft: '╰',
    left: '│',
  },
  single: {
    topLeft: '┌',
    top: '─',
    topRight: '┐',
    right: '│',
    bottomRight: '┘',
    bottom: '─',
    bottomLeft: '└',
    left: '│',
  },
};

function paint(background: string): ((glyph: string) => string) | null {
  if (background.startsWith('#')) return chalk.bgHex(background);
  const name = `bg${background[0]!.toUpperCase()}${background.slice(1)}`;
  const painter = (chalk as unknown as Record<string, unknown>)[name];
  return typeof painter === 'function' ? (painter as (glyph: string) => string) : null;
}

/**
 * A border style for a box that sits on `background`. Ink draws border
 * cells with a foreground colour only, so on a painted screen they would
 * show the terminal's own background; these glyphs carry the fill with them.
 */
export function frameOn(kind: FrameKind, background: string | undefined): BoxProps['borderStyle'] {
  const painter = background ? paint(background) : null;
  if (!painter) return kind;
  return Object.fromEntries(
    Object.entries(GLYPHS[kind]).map(([edge, glyph]) => [edge, painter(glyph)]),
  ) as unknown as BoxProps['borderStyle'];
}

/** The border style for a box on the screen's base background. */
export function useFrame(kind: FrameKind): BoxProps['borderStyle'] {
  return frameOn(kind, useTheme().base.background);
}
