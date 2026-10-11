/** How closely the text a model supplied had to match the file. */
export type MatchLevel = 'exact' | 'trailing-whitespace' | 'any-whitespace';

export interface TolerantMatch {
  level: Exclude<MatchLevel, 'exact'>;
  /** Character range of the matched lines in the file. */
  start: number;
  end: number;
  replacement: string;
}

const LEVELS: Array<{ level: TolerantMatch['level']; same: (a: string, b: string) => boolean }> = [
  { level: 'trailing-whitespace', same: (a, b) => a.trimEnd() === b.trimEnd() },
  { level: 'any-whitespace', same: (a, b) => a.trim() === b.trim() },
];

const MAX_CLOSEST_LINES = 20;
const MIN_CLOSEST_SIMILARITY = 0.5;

function blockLines(text: string): string[] {
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function leadingWhitespace(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/**
 * Find `oldString` in `content` as a block of whole lines, ignoring first
 * trailing whitespace and then indentation. Returns undefined when no level
 * matches. Throws when a level matches more than one place: guessing which
 * one the model meant is how an edit lands in the wrong function.
 */
export function locateTolerant(
  content: string,
  oldString: string,
  newString: string,
): TolerantMatch | undefined {
  const fileLines = content.split('\n');
  const oldLines = blockLines(oldString);
  if (oldLines.every((line) => line.trim() === '')) return undefined;

  for (const { level, same } of LEVELS) {
    const starts: number[] = [];
    for (let start = 0; start + oldLines.length <= fileLines.length; start += 1) {
      if (oldLines.every((line, offset) => same(fileLines[start + offset]!, line))) {
        starts.push(start);
      }
    }
    if (starts.length === 0) continue;
    if (starts.length > 1) {
      throw new Error(
        `old_string matches ${starts.length} places once whitespace is ignored (lines ${starts
          .map((start) => start + 1)
          .join(', ')}). Include more surrounding lines so it matches one place.`,
      );
    }

    const first = starts[0]!;
    const lineOffsets: number[] = [];
    let offset = 0;
    for (const line of fileLines) {
      lineOffsets.push(offset);
      offset += line.length + 1;
    }
    const lastLine = first + oldLines.length - 1;
    const start = lineOffsets[first]!;
    let end = lineOffsets[lastLine]! + fileLines[lastLine]!.length;

    if (newString === '') {
      // Deleting whole lines takes their line break with them.
      if (end < content.length) end += 1;
      return { level, start, end, replacement: '' };
    }

    let newLines = blockLines(newString);
    if (level === 'any-whitespace') {
      // The model's indentation was off, so its replacement is off by the
      // same amount: swap its indentation for the file's.
      const anchor = oldLines.findIndex((line) => line.trim() !== '');
      const oldIndent = leadingWhitespace(oldLines[anchor]!);
      const fileIndent = leadingWhitespace(fileLines[first + anchor]!);
      newLines = newLines.map((line) =>
        line.trim() !== '' && line.startsWith(oldIndent)
          ? fileIndent + line.slice(oldIndent.length)
          : line,
      );
    }
    return { level, start, end, replacement: newLines.join('\n') };
  }
  return undefined;
}

/** Dice coefficient over character bigrams: 1 for equal strings, 0 for unrelated ones. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const bigram = a.slice(index, index + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  let shared = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const bigram = b.slice(index, index + 2);
    const remaining = bigrams.get(bigram) ?? 0;
    if (remaining > 0) {
      bigrams.set(bigram, remaining - 1);
      shared += 1;
    }
  }
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

/**
 * The error for an `old_string` that matches nothing. When part of the file
 * looks like what the model asked for, show it with line numbers so the model
 * can correct the call without reading the file again.
 */
export function describeMiss(content: string, oldString: string): string {
  const fileLines = content.split('\n').map((line) => line.trim());
  const oldLines = blockLines(oldString).map((line) => line.trim());
  let best = { start: -1, score: 0 };
  for (let start = 0; start + oldLines.length <= fileLines.length; start += 1) {
    let total = 0;
    for (let offset = 0; offset < oldLines.length; offset += 1) {
      total += similarity(fileLines[start + offset]!, oldLines[offset]!);
    }
    const score = total / oldLines.length;
    if (score > best.score) best = { start, score };
  }
  if (best.start < 0 || best.score < MIN_CLOSEST_SIMILARITY) {
    return 'old_string not found. Nothing in the file resembles it; read the file again.';
  }
  const rawLines = content.split('\n');
  const shown = Math.min(oldLines.length, MAX_CLOSEST_LINES);
  const block = rawLines
    .slice(best.start, best.start + shown)
    .map((line, offset) => `${best.start + offset + 1}: ${line}`)
    .join('\n');
  const range = `${best.start + 1}-${best.start + oldLines.length}`;
  const cut = oldLines.length > shown ? `\n… ${oldLines.length - shown} more lines` : '';
  return (
    `old_string not found. The closest text in the file is at lines ${range}:\n${block}${cut}\n` +
    'Copy the text to replace exactly from these lines.'
  );
}
