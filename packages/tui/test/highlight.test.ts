import { describe, expect, it } from 'vitest';
import { highlightCode } from '../src/highlight';
import { deepMerge } from '../src/theme/loader';
import { defaultTheme } from '../src/theme/tokens';

describe('highlightCode', () => {
  it('classifies keywords, strings, numbers and comments in TypeScript', () => {
    const lines = highlightCode('const greeting = "hi"; // note\nreturn 42;', 'ts');

    expect(lines).toHaveLength(2);
    expect(lines![0]).toContainEqual({ text: 'const', token: 'keyword' });
    expect(lines![0]).toContainEqual({ text: '"hi"', token: 'string' });
    expect(lines![0]).toContainEqual({ text: '// note', token: 'comment' });
    expect(lines![1]).toContainEqual({ text: 'return', token: 'keyword' });
    expect(lines![1]).toContainEqual({ text: '42', token: 'number' });
  });

  it('keeps every character of the source', () => {
    const source = 'function add(a: number, b: number) {\n  return a + b; // sum\n}\n';

    const lines = highlightCode(source, 'typescript')!;

    expect(lines.map((line) => line.map((segment) => segment.text).join('')).join('\n')).toBe(
      source,
    );
  });

  it('carries a token across the lines of a block comment', () => {
    const lines = highlightCode('/* one\n   two */\nlet x;', 'js')!;

    expect(lines[0]).toEqual([{ text: '/* one', token: 'comment' }]);
    expect(lines[1]).toEqual([{ text: '   two */', token: 'comment' }]);
  });

  it('knows the usual aliases', () => {
    for (const language of [
      'ts',
      'tsx',
      'js',
      'json',
      'sh',
      'bash',
      'py',
      'python',
      'go',
      'rust',
      'yaml',
    ]) {
      expect(highlightCode('x', language), language).toBeDefined();
    }
  });

  it('declines a language it does not know, no language, and very long blocks', () => {
    expect(highlightCode('x', 'klingon')).toBeUndefined();
    expect(highlightCode('x', undefined)).toBeUndefined();
    expect(
      highlightCode(Array.from({ length: 500 }, () => 'x = 1').join('\n'), 'python'),
    ).toBeUndefined();
  });
});

describe('syntax theme tokens', () => {
  it('are part of the default theme', () => {
    expect(Object.keys(defaultTheme.syntax).sort()).toEqual([
      'comment',
      'function',
      'keyword',
      'number',
      'string',
      'type',
    ]);
  });

  it('are inherited by a user theme that does not set them', () => {
    const theme = deepMerge(defaultTheme, { accent: { primary: 'green' } });
    expect(theme.syntax).toEqual(defaultTheme.syntax);
  });

  it('can be overridden one at a time', () => {
    const theme = deepMerge(defaultTheme, { syntax: { keyword: '#ff0000' } });
    expect(theme.syntax.keyword).toBe('#ff0000');
    expect(theme.syntax.string).toBe(defaultTheme.syntax.string);
  });
});
