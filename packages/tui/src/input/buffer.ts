export type MultilineBuffer = { text: string; cursor: number };

export const EMPTY_BUFFER: MultilineBuffer = { text: '', cursor: 0 };

export function insertChar(buf: MultilineBuffer, ch: string): MultilineBuffer {
  return insertText(buf, ch);
}

export function insertText(buf: MultilineBuffer, text: string): MultilineBuffer {
  if (text.length === 0) return buf;
  const next = buf.text.slice(0, buf.cursor) + text + buf.text.slice(buf.cursor);
  return { text: next, cursor: buf.cursor + text.length };
}

export function insertNewline(buf: MultilineBuffer): MultilineBuffer {
  // If the char immediately before cursor is `\`, replace it with `\n`.
  if (endsWithUnescapedBackslashAtCursor(buf)) {
    const next = buf.text.slice(0, buf.cursor - 1) + '\n' + buf.text.slice(buf.cursor);
    return { text: next, cursor: buf.cursor };
  }
  return insertText(buf, '\n');
}

export function backspace(buf: MultilineBuffer): MultilineBuffer {
  if (buf.cursor === 0) return buf;
  const next = buf.text.slice(0, buf.cursor - 1) + buf.text.slice(buf.cursor);
  return { text: next, cursor: buf.cursor - 1 };
}

export function deleteForward(buf: MultilineBuffer): MultilineBuffer {
  if (buf.cursor >= buf.text.length) return buf;
  const next = buf.text.slice(0, buf.cursor) + buf.text.slice(buf.cursor + 1);
  return { text: next, cursor: buf.cursor };
}

export function moveLeft(buf: MultilineBuffer): MultilineBuffer {
  if (buf.cursor === 0) return buf;
  return { text: buf.text, cursor: buf.cursor - 1 };
}

export function moveRight(buf: MultilineBuffer): MultilineBuffer {
  if (buf.cursor >= buf.text.length) return buf;
  return { text: buf.text, cursor: buf.cursor + 1 };
}

export function moveLineStart(buf: MultilineBuffer): MultilineBuffer {
  const prevNl = buf.text.lastIndexOf('\n', buf.cursor - 1);
  const start = prevNl === -1 ? 0 : prevNl + 1;
  if (start === buf.cursor) return buf;
  return { text: buf.text, cursor: start };
}

export function moveLineEnd(buf: MultilineBuffer): MultilineBuffer {
  const nextNl = buf.text.indexOf('\n', buf.cursor);
  const end = nextNl === -1 ? buf.text.length : nextNl;
  if (end === buf.cursor) return buf;
  return { text: buf.text, cursor: end };
}

export function moveUp(
  buf: MultilineBuffer,
  stickyCol: number | null,
): { buf: MultilineBuffer; col: number } {
  const { line, col } = cursorLineCol(buf);
  if (line === 0) return { buf, col: stickyCol ?? col };
  const desiredCol = stickyCol ?? col;
  const allLines = lines(buf);
  const targetLine = line - 1;
  const targetText = allLines[targetLine] ?? '';
  const targetCol = Math.min(desiredCol, targetText.length);
  return {
    buf: { text: buf.text, cursor: lineColToOffset(allLines, targetLine, targetCol) },
    col: desiredCol,
  };
}

export function moveDown(
  buf: MultilineBuffer,
  stickyCol: number | null,
): { buf: MultilineBuffer; col: number } {
  const { line, col } = cursorLineCol(buf);
  const allLines = lines(buf);
  if (line >= allLines.length - 1) return { buf, col: stickyCol ?? col };
  const desiredCol = stickyCol ?? col;
  const targetLine = line + 1;
  const targetText = allLines[targetLine] ?? '';
  const targetCol = Math.min(desiredCol, targetText.length);
  return {
    buf: { text: buf.text, cursor: lineColToOffset(allLines, targetLine, targetCol) },
    col: desiredCol,
  };
}

export function replaceAll(_buf: MultilineBuffer, text: string): MultilineBuffer {
  return { text, cursor: text.length };
}

export function endsWithUnescapedBackslashAtCursor(buf: MultilineBuffer): boolean {
  return buf.cursor > 0 && buf.text[buf.cursor - 1] === '\\';
}

export function cursorLineCol(buf: MultilineBuffer): { line: number; col: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < buf.cursor; i++) {
    if (buf.text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: buf.cursor - lineStart };
}

export function lines(buf: MultilineBuffer): string[] {
  return buf.text.split('\n');
}

function lineColToOffset(allLines: string[], line: number, col: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    offset += (allLines[i]?.length ?? 0) + 1;
  }
  return offset + col;
}
