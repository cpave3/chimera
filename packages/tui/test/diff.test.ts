import { describe, expect, it } from 'vitest';
import { lineDiff } from '../src/diff';

describe('lineDiff', () => {
  it('returns all-same when both sides are equal', () => {
    expect(lineDiff(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([
      { kind: 'same', line: 'a' },
      { kind: 'same', line: 'b' },
      { kind: 'same', line: 'c' },
    ]);
  });

  it('renders a pure insertion as same + add', () => {
    expect(lineDiff(['a', 'b'], ['a', 'X', 'b'])).toEqual([
      { kind: 'same', line: 'a' },
      { kind: 'add', line: 'X' },
      { kind: 'same', line: 'b' },
    ]);
  });

  it('renders a pure deletion as same + del', () => {
    expect(lineDiff(['a', 'X', 'b'], ['a', 'b'])).toEqual([
      { kind: 'same', line: 'a' },
      { kind: 'del', line: 'X' },
      { kind: 'same', line: 'b' },
    ]);
  });

  it('renders complete replacement with no shared lines as del then add', () => {
    expect(lineDiff(['a', 'b'], ['x', 'y'])).toEqual([
      { kind: 'del', line: 'a' },
      { kind: 'del', line: 'b' },
      { kind: 'add', line: 'x' },
      { kind: 'add', line: 'y' },
    ]);
  });

  it('keeps interleaved unchanged lines as context in order', () => {
    const out = lineDiff(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'D']);
    // Common subsequence is a, c. So b→B and d→D become del/add pairs around the common lines.
    const kinds = out.map((entry) => entry.kind);
    const lines = out.map((entry) => entry.line);
    expect(kinds.indexOf('same')).toBeLessThan(kinds.lastIndexOf('same'));
    expect(lines).toContain('a');
    expect(lines).toContain('c');
    expect(lines).toContain('b');
    expect(lines).toContain('B');
    expect(lines).toContain('d');
    expect(lines).toContain('D');
    // Same-kind entries for 'a' and 'c'
    expect(out.find((entry) => entry.line === 'a')?.kind).toBe('same');
    expect(out.find((entry) => entry.line === 'c')?.kind).toBe('same');
    expect(out.find((entry) => entry.line === 'b')?.kind).toBe('del');
    expect(out.find((entry) => entry.line === 'B')?.kind).toBe('add');
    expect(out.find((entry) => entry.line === 'd')?.kind).toBe('del');
    expect(out.find((entry) => entry.line === 'D')?.kind).toBe('add');
  });

  it('handles empty old (pure insertion)', () => {
    expect(lineDiff([], ['x', 'y'])).toEqual([
      { kind: 'add', line: 'x' },
      { kind: 'add', line: 'y' },
    ]);
  });

  it('handles empty new (pure deletion)', () => {
    expect(lineDiff(['x', 'y'], [])).toEqual([
      { kind: 'del', line: 'x' },
      { kind: 'del', line: 'y' },
    ]);
  });

  it('pairs the first occurrence when a line is repeated on one side', () => {
    expect(lineDiff(['a', 'a', 'b'], ['a', 'b'])).toEqual([
      { kind: 'same', line: 'a' },
      { kind: 'del', line: 'a' },
      { kind: 'same', line: 'b' },
    ]);
  });
});
