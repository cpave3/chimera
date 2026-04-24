import { describe, expect, it } from 'vitest';
import { expandBody, splitArgs } from '../src/expand';
import { InMemoryCommandRegistry } from '../src/registry';
import type { Command } from '../src/types';

describe('splitArgs', () => {
  it('splits on whitespace', () => {
    expect(splitArgs('a b c')).toEqual(['a', 'b', 'c']);
  });

  it('respects balanced double quotes', () => {
    expect(splitArgs('"a b" c')).toEqual(['a b', 'c']);
  });

  it('handles multiple quoted segments', () => {
    expect(splitArgs('"one two" "three four" five')).toEqual(['one two', 'three four', 'five']);
  });

  it('returns empty array on empty input', () => {
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('   ')).toEqual([]);
  });

  it('tolerates an unclosed quote by taking the rest', () => {
    expect(splitArgs('a "b c')).toEqual(['a', 'b c']);
  });
});

describe('expandBody', () => {
  it('substitutes $ARGUMENTS with raw args', () => {
    expect(expandBody('hi $ARGUMENTS', { args: 'world!', cwd: '/' })).toBe('hi world!');
  });

  it('substitutes positional $1 $2 via whitespace split respecting quotes', () => {
    expect(
      expandBody('[$1]-[$2]', { args: '"a b" c', cwd: '/' }),
    ).toBe('[a b]-[c]');
  });

  it('leaves $PATH and other unknown $-tokens intact', () => {
    expect(
      expandBody('use $PATH and $HOME and $ARGUMENTS', { args: 'x', cwd: '/' }),
    ).toBe('use $PATH and $HOME and x');
  });

  it('missing positional becomes empty string', () => {
    expect(expandBody('a=$1 b=$2', { args: 'only', cwd: '/' })).toBe('a=only b=');
  });

  it('substitutes $CWD', () => {
    expect(expandBody('cwd=$CWD', { args: '', cwd: '/tmp/work' })).toBe('cwd=/tmp/work');
  });

  it('substitutes $DATE as YYYY-MM-DD', () => {
    const d = new Date(2026, 3, 24); // April 24, 2026 (month index 3)
    expect(expandBody('d=$DATE', { args: '', cwd: '/', date: d })).toBe('d=2026-04-24');
  });

  it('$1 does not match $10 digits', () => {
    // There is no $10 in the grammar, but ensure we don't falsely consume trailing digits.
    // "$12" should remain literal (no $12 in grammar, no $1 substitution with trailing 2).
    // Use `$1` elsewhere in the body so the template counts as arg-consuming and
    // the fallback append stays out of the frame.
    expect(expandBody('x=$12 first=$1', { args: 'a b', cwd: '/' })).toBe(
      'x=$12 first=a',
    );
  });

  it('appends args when the template consumes no arg placeholder', () => {
    const body = 'Run the propose workflow.';
    expect(expandBody(body, { args: 'add a color theme', cwd: '/' })).toBe(
      'Run the propose workflow.\n\nadd a color theme',
    );
  });

  it('does not append when args is empty', () => {
    expect(expandBody('Standalone template.', { args: '', cwd: '/' })).toBe(
      'Standalone template.',
    );
    expect(expandBody('Standalone template.', { args: '   ', cwd: '/' })).toBe(
      'Standalone template.',
    );
  });

  it('does not append when template uses $ARGUMENTS', () => {
    expect(
      expandBody('body: $ARGUMENTS', { args: 'hello', cwd: '/' }),
    ).toBe('body: hello');
  });

  it('does not append when template uses any $1-$9 positional', () => {
    expect(expandBody('first=$1', { args: 'hi', cwd: '/' })).toBe('first=hi');
  });

  it('$CWD/$DATE alone do not suppress the arg append', () => {
    // Template references env-ish scalars but not args — so extra args should still land.
    expect(expandBody('at $CWD:', { args: 'extra', cwd: '/tmp' })).toBe(
      'at /tmp:\n\nextra',
    );
  });

  it('$ARGUMENTS runs before positionals so template can use both', () => {
    expect(
      expandBody('all=[$ARGUMENTS] first=[$1]', { args: '"a b" c', cwd: '/' }),
    ).toBe('all=["a b" c] first=[a b]');
  });
});

describe('InMemoryCommandRegistry.expand', () => {
  const cmd: Command = {
    name: 'review',
    description: undefined,
    body: 'Review: $1 (priority: $2)',
    path: '/tmp/review.md',
    source: 'project',
  };
  const registry = new InMemoryCommandRegistry([cmd], [], '/tmp');

  it('expands a known command', () => {
    expect(registry.expand('review', '"auth module" urgent')).toBe(
      'Review: auth module (priority: urgent)',
    );
  });

  it('throws on unknown command', () => {
    expect(() => registry.expand('nope', '')).toThrow(/unknown command: nope/);
  });

  it('list() returns commands sorted by name', () => {
    const a: Command = { name: 'alpha', body: '', path: 'a', source: 'project' };
    const b: Command = { name: 'beta', body: '', path: 'b', source: 'project' };
    const r = new InMemoryCommandRegistry([b, a], [], '/tmp');
    expect(r.list().map((c) => c.name)).toEqual(['alpha', 'beta']);
  });
});
