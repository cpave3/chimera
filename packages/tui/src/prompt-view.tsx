import { Box, Text } from 'ink';
import React from 'react';
import { cursorLineCol, type MultilineBuffer } from './input/buffer';

export { previewLine } from './preview-line';

export interface PromptStyle {
  /** Leads the first line of a message. */
  marker: string;
  /** Leads the first line of a `!` shell command. */
  bangMarker: string;
  /** Shown while the buffer is empty, under the cursor. */
  placeholder?: string;
  placeholderColor?: string;
}

const INLINE_PROMPT_STYLE: PromptStyle = { marker: '> ', bangMarker: 'bash > ' };

export function renderPromptLines(
  buffer: MultilineBuffer,
  accentColor: string,
  bangColor: string,
  editorOpen: boolean,
  isBang: boolean,
  style: PromptStyle = INLINE_PROMPT_STYLE,
): React.ReactElement[] {
  const allLines = buffer.text.split('\n');
  const { line: cursorLine, col: cursorCol } = cursorLineCol(buffer);
  if (buffer.text === '' && style.placeholder && !editorOpen) {
    // The cursor sits on the placeholder's first letter, so the text does
    // not jump a column when the first key replaces it.
    return [
      <Box key={0}>
        <Text color={accentColor}>{style.marker}</Text>
        <Text color={style.placeholderColor}>
          {`\x1b[7m${style.placeholder[0]}\x1b[27m${style.placeholder.slice(1)}`}
        </Text>
      </Box>,
    ];
  }
  return allLines.map((lineText, idx) => {
    const isFirst = idx === 0;
    const prefix = isFirst ? (isBang ? style.bangMarker : style.marker) : '  ';
    const color = isBang ? bangColor : accentColor;
    const showCursor = idx === cursorLine && !editorOpen;
    if (!showCursor) {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
        <Box key={idx}>
          <Text color={isFirst ? color : undefined}>{prefix}</Text>
          <Text>{lineText}</Text>
        </Box>
      );
    }
    const pre = lineText.slice(0, cursorCol);
    const atChar = cursorCol < lineText.length ? lineText[cursorCol]! : ' ';
    const post = cursorCol < lineText.length ? lineText.slice(cursorCol + 1) : '';
    // Render the cursor line as a single <Text> with embedded SGR inverse
    // escapes so the terminal wraps continuously. Three sibling <Text>
    // nodes (pre / inverse / post) detach the cursor from the text flow
    // because Ink treats each as a separate flex item.
    const lineWithCursor = `${pre}\x1b[7m${atChar}\x1b[27m${post}`;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: positional index is stable for wrap output
      <Box key={idx}>
        <Text color={isFirst ? color : undefined}>{prefix}</Text>
        <Text>{lineWithCursor}</Text>
      </Box>
    );
  });
}
