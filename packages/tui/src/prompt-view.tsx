import { Box, Text } from 'ink';
import React from 'react';
import { cursorLineCol, type MultilineBuffer } from './input/buffer';

export function previewLine(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
}

export function renderPromptLines(
  buffer: MultilineBuffer,
  accentColor: string,
  bangColor: string,
  editorOpen: boolean,
  isBang: boolean,
): React.ReactElement[] {
  const allLines = buffer.text.split('\n');
  const { line: cursorLine, col: cursorCol } = cursorLineCol(buffer);
  return allLines.map((lineText, idx) => {
    const isFirst = idx === 0;
    const prefix = isFirst ? (isBang ? 'bash > ' : '> ') : '  ';
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
