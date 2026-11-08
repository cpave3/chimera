import { displayWidth, graphemes } from '../terminal/width';

/** A stretch of text drawn one way; `paint` adds its escape codes. */
export interface Run {
  text: string;
  paint?: (text: string) => string;
}

export const LABEL_WIDTH = 7;
const LABEL_GAP = 2;
/** Where the body column starts: the label column and the gap after it. */
export const BODY_INDENT = ' '.repeat(LABEL_WIDTH + LABEL_GAP);

export function bodyWidth(width: number): number {
  return Math.max(10, width - BODY_INDENT.length);
}

export function paintRuns(runs: Run[]): string {
  return runs.map((run) => (run.paint ? run.paint(run.text) : run.text)).join('');
}

interface Piece {
  text: string;
  width: number;
  paint?: (text: string) => string;
  space: boolean;
}

function pieces(runs: Run[]): Piece[][] {
  // One list of words per hard line; a word may span runs.
  const lines: Piece[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      for (const token of part.split(/( +)/)) {
        if (token === '') continue;
        lines.at(-1)!.push({
          text: token,
          width: displayWidth(token),
          paint: run.paint,
          space: token.startsWith(' '),
        });
      }
    });
  }
  return lines;
}

/** Cut a piece too wide for a line into pieces that fit. */
function split(piece: Piece, width: number): Piece[] {
  const out: Piece[] = [];
  let text = '';
  let used = 0;
  for (const grapheme of graphemes(piece.text)) {
    if (used + grapheme.width > width && text !== '') {
      out.push({ ...piece, text, width: used });
      text = '';
      used = 0;
    }
    text += grapheme.text;
    used += grapheme.width;
  }
  if (text !== '') out.push({ ...piece, text, width: used });
  return out;
}

/**
 * Wrap styled text to `width` cells, breaking between words. A word wider
 * than a line is cut. Spaces at a break are dropped; line breaks in the
 * text are kept. Each line comes back painted.
 */
export function wrapRuns(runs: Run[], width: number): string[] {
  const room = Math.max(1, width);
  const out: string[] = [];
  for (const hardLine of pieces(runs)) {
    // Words are runs of adjacent non-space pieces.
    const words: Piece[][] = [];
    let current: Piece[] = [];
    for (const piece of hardLine) {
      if (piece.space) {
        if (current.length > 0) words.push(current);
        words.push([piece]);
        current = [];
      } else current.push(piece);
    }
    if (current.length > 0) words.push(current);

    let line: Piece[] = [];
    let used = 0;
    let atHardStart = true;
    const flush = () => {
      atHardStart = false;
      while (line.length > 0 && line.at(-1)!.space) {
        used -= line.at(-1)!.width;
        line.pop();
      }
      out.push(line.map((piece) => (piece.paint ? piece.paint(piece.text) : piece.text)).join(''));
      line = [];
      used = 0;
    };
    for (const word of words) {
      const wordWidth = word.reduce((sum, piece) => sum + piece.width, 0);
      if (word[0]!.space) {
        // Spaces at a break go; indentation at the start of a hard line stays.
        if (used > 0 || atHardStart) {
          line.push(word[0]!);
          used += wordWidth;
        }
        continue;
      }
      if (used + wordWidth > room && used > 0) flush();
      if (wordWidth > room) {
        for (const piece of word) {
          for (const part of split(piece, room)) {
            if (used + part.width > room) flush();
            line.push(part);
            used += part.width;
          }
        }
        continue;
      }
      line.push(...word);
      used += wordWidth;
    }
    flush();
  }
  return out;
}

/** Wrap plain text and paint every line the same way. */
export function wrapText(text: string, width: number, paint?: (text: string) => string): string[] {
  return wrapRuns([{ text, paint }], width);
}
