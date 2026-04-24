import { Box } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown';
import { buildTheme } from '../src/theme';

function frame(text: string): string {
  const theme = buildTheme();
  const { lastFrame, unmount } = render(
    <Box flexDirection="column">{renderMarkdown(text, theme)}</Box>,
  );
  const out = lastFrame() ?? '';
  unmount();
  return out;
}

describe('renderMarkdown', () => {
  it('renders a plain paragraph', () => {
    expect(frame('Hello world.')).toContain('Hello world.');
  });

  it('separates paragraphs with a blank line', () => {
    const out = frame('first paragraph.\n\nsecond paragraph.');
    expect(out).toMatch(/first paragraph\.\s*\n\s*\n\s*second paragraph\./);
  });

  it('renders a bullet list with visible bullet markers', () => {
    const out = frame('- apples\n- pears');
    expect(out).toContain('apples');
    expect(out).toContain('pears');
    expect(out).toContain('•');
  });

  it('renders an ordered list with numeric markers', () => {
    const out = frame('1. first\n2. second');
    expect(out).toContain('first');
    expect(out).toContain('second');
    expect(out).toMatch(/1\.\s+first/);
    expect(out).toMatch(/2\.\s+second/);
  });

  it('renders a fenced code block, preserving lines and hiding fences', () => {
    const out = frame('```ts\nconst x = 1;\nconst y = 2;\n```');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('const y = 2;');
    expect(out).not.toContain('```');
  });

  it('renders a heading without the hash markers', () => {
    const out = frame('## Overview');
    expect(out).toContain('Overview');
    expect(out).not.toContain('##');
  });

  it('renders bold, italic, and inline code without their markers', () => {
    const out = frame('say **hello** and *there* and `run()`.');
    expect(out).toContain('hello');
    expect(out).toContain('there');
    expect(out).toContain('run()');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`run()`');
  });
});
