import { Box, Text } from 'ink';
import { marked, type Tokens } from 'marked';
import React from 'react';
import type { Theme } from './theme';

export function renderMarkdown(text: string, theme: Theme): React.ReactElement[] {
  const tokens = marked.lexer(text).filter((t) => t.type !== 'space');
  return tokens.map((tok, i) => renderBlock(tok, theme, i, i > 0));
}

function renderBlock(
  tok: Tokens.Generic,
  theme: Theme,
  key: number,
  topGap: boolean,
): React.ReactElement {
  const gap = topGap ? 1 : 0;
  if (tok.type === 'paragraph') {
    const inline = (tok as Tokens.Paragraph).tokens ?? [];
    return (
      <Box key={key} marginTop={gap}>
        <Text>{renderInline(inline, theme)}</Text>
      </Box>
    );
  }
  if (tok.type === 'list') {
    const l = tok as Tokens.List;
    const start = typeof l.start === 'number' ? l.start : 1;
    return (
      <Box key={key} flexDirection="column" paddingLeft={2} marginTop={gap}>
        {l.items.map((item, i) => {
          const marker = l.ordered ? `${start + i}.` : '•';
          return (
            <Box key={i}>
              <Text color={theme.muted}>{marker} </Text>
              <Text>{renderInline(itemInlineTokens(item), theme)}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }
  if (tok.type === 'code') {
    const c = tok as Tokens.Code;
    const lines = c.text.split('\n');
    return (
      <Box key={key} flexDirection="column" paddingLeft={2} marginTop={gap}>
        {lines.map((line, i) => (
          <Text key={i} color={theme.secondary} dimColor>
            {line.length === 0 ? ' ' : line}
          </Text>
        ))}
      </Box>
    );
  }
  if (tok.type === 'heading') {
    const h = tok as Tokens.Heading;
    return (
      <Box key={key} marginTop={gap}>
        <Text bold color={theme.accent}>
          {renderInline(h.tokens ?? [], theme)}
        </Text>
      </Box>
    );
  }
  return (
    <Box key={key} marginTop={gap}>
      <Text>{(tok as { raw?: string }).raw ?? ''}</Text>
    </Box>
  );
}

function itemInlineTokens(item: Tokens.ListItem): Tokens.Generic[] {
  const out: Tokens.Generic[] = [];
  for (const t of item.tokens ?? []) {
    const inner = (t as { tokens?: Tokens.Generic[] }).tokens;
    if (inner && inner.length > 0) out.push(...inner);
    else out.push(t as Tokens.Generic);
  }
  return out;
}

function renderInline(
  tokens: Tokens.Generic[],
  theme: Theme,
): React.ReactNode[] {
  return tokens.map((tok, i) => renderInlineToken(tok, theme, i));
}

function renderInlineToken(
  tok: Tokens.Generic,
  theme: Theme,
  key: number,
): React.ReactNode {
  if (tok.type === 'text') {
    return <React.Fragment key={key}>{(tok as Tokens.Text).text}</React.Fragment>;
  }
  if (tok.type === 'strong') {
    return (
      <Text key={key} bold>
        {renderInline((tok as Tokens.Strong).tokens ?? [], theme)}
      </Text>
    );
  }
  if (tok.type === 'em') {
    return (
      <Text key={key} italic>
        {renderInline((tok as Tokens.Em).tokens ?? [], theme)}
      </Text>
    );
  }
  if (tok.type === 'codespan') {
    return (
      <Text key={key} color={theme.secondary}>
        {(tok as Tokens.Codespan).text}
      </Text>
    );
  }
  return <React.Fragment key={key}>{(tok as { raw?: string }).raw ?? ''}</React.Fragment>;
}
