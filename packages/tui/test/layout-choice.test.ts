import { describe, expect, it } from 'vitest';
import { resolveLayout } from '../src/mount';

describe('resolveLayout', () => {
  const terminal = { isTTY: true, term: 'xterm-256color' };

  it('takes the full screen unless told otherwise', () => {
    expect(resolveLayout(undefined, terminal)).toBe('fullscreen');
    expect(resolveLayout('fullscreen', terminal)).toBe('fullscreen');
  });

  it('prints inline when the user asks for it', () => {
    expect(resolveLayout('inline', terminal)).toBe('inline');
  });

  it('prints inline when the terminal cannot show a fullscreen program', () => {
    expect(resolveLayout('fullscreen', { isTTY: false, term: 'xterm-256color' })).toBe('inline');
    expect(resolveLayout(undefined, { isTTY: true, term: 'dumb' })).toBe('inline');
  });
});
