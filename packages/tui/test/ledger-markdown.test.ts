import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/ledger/markdown';
import { stripAnsi } from '../src/terminal/width';
import { BUILTIN_THEMES } from '../src/theme/palette';
import { createStyle } from '../src/theme/style';

const style = createStyle(BUILTIN_THEMES.default, 'ansi16');

/** The markdown as the body column draws it, without colour. */
function frame(text: string, width = 80): string {
  return renderMarkdown(text, width, style)
    .map((line) => stripAnsi(line))
    .join('\n');
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

  it('renders a table with a bordered grid instead of raw pipes', () => {
    const out = frame(
      ['| Name | Age |', '| ---- | --- |', '| Alice | 30 |', '| Bob | 25 |'].join('\n'),
    );
    expect(out).toContain('Alice');
    expect(out).toContain('Bob');
    expect(out).toContain('Name');
    expect(out).toContain('┌');
    expect(out).toContain('┐');
    expect(out).toContain('└');
    expect(out).toContain('┘');
    expect(out).toContain('│');
    expect(out).toContain('─');
  });

  it('preserves inline formatting inside table cells', () => {
    const out = frame(
      [
        '| Package | Status |',
        '| ------- | ------ |',
        '| **tui** | `ready` |',
        '| *cli* | done |',
      ].join('\n'),
    );
    expect(out).toContain('tui');
    expect(out).toContain('ready');
    expect(out).toContain('cli');
    expect(out).toContain('done');
    expect(out).not.toContain('**tui**');
    expect(out).not.toContain('`ready`');
    expect(out).not.toContain('*cli*');
  });

  it('wraps wide table cells to fit the width without crashing', () => {
    const wide = [
      '| Col1 | Col2 | Col3 | Col4 |',
      '| ---- | ---- | ---- | ---- |',
      '| short | this is a much longer cell value | x | another long value here yes |',
    ].join('\n');
    const out = frame(wide, 40);
    expect(out).toContain('short');
    expect(out).toContain('longer');
    expect(out).toContain('another');
    expect(out).toContain('┌');
    expect(out).toContain('└');
    expect(out).not.toContain('| ----');
  });

  it('sizes table columns by terminal cells, not code units', () => {
    const out = frame(['| 名前 | Age |', '| --- | --- |', '| 中文字 | 30 |'].join('\n'));
    expect(out.split('\n').map((line) => line.trimEnd())).toEqual([
      '┌────────┬─────┐',
      '│ 名前   │ Age │',
      '├────────┼─────┤',
      '│ 中文字 │ 30  │',
      '└────────┴─────┘',
    ]);
  });

  it('sizes an emoji ZWJ sequence as the two cells it occupies', () => {
    const out = frame(['| A |', '| - |', '| 👩‍💻 |'].join('\n'));
    expect(out.split('\n').map((line) => line.trimEnd())).toEqual([
      '┌────┐',
      '│ A  │',
      '├────┤',
      '│ 👩‍💻 │',
      '└────┘',
    ]);
  });

  it('stretches the borders of a row whose wide characters wrap', () => {
    const out = frame(
      ['| Word | Note |', '| --- | --- |', '| 中文字 中文字 中文字 | x |'].join('\n'),
      20,
    );
    const rows = out.split('\n').filter((line) => !/^[┌├└]/.test(line));
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      expect(row.trimEnd()).toMatch(/^│.*│$/);
      expect(row.trimEnd().split('│')).toHaveLength(4);
    }
  });
});
