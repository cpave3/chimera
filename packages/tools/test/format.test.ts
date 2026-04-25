import { describe, expect, it } from 'vitest';
import { clip, relPath, stripCdPrefix } from '../src/format';

describe('relPath', () => {
  it('returns the path relative to cwd when inside cwd', () => {
    expect(relPath('/work/src/foo.ts', '/work')).toBe('src/foo.ts');
  });

  it('returns just the basename when the absolute path is outside cwd', () => {
    expect(relPath('/etc/hosts', '/work')).toBe('hosts');
  });

  it('returns the basename when relative path is empty (path equals cwd)', () => {
    expect(relPath('/work', '/work')).toBe('work');
  });

  it('returns the input unchanged for an already-relative path', () => {
    expect(relPath('src/foo.ts', '/work')).toBe('src/foo.ts');
  });
});

describe('clip', () => {
  it('returns the input untouched when within the limit', () => {
    expect(clip('hello', 10)).toBe('hello');
  });

  it('truncates and appends an ellipsis past the limit', () => {
    expect(clip('hello world this is long', 10)).toBe('hello worl…');
  });

  it('collapses to the first line when input contains newlines', () => {
    expect(clip('line one\nline two', 50)).toBe('line one');
  });
});

describe('stripCdPrefix', () => {
  it('removes a leading `cd <dir> && ` so the real command shines through', () => {
    expect(stripCdPrefix('cd /work && pnpm build')).toBe('pnpm build');
  });

  it('handles quoted paths', () => {
    expect(stripCdPrefix('cd "/path with spaces" && ls -la')).toBe('ls -la');
  });

  it('returns the input unchanged when there is no cd prefix', () => {
    expect(stripCdPrefix('pnpm test')).toBe('pnpm test');
  });
});
