import { describe, expect, it } from 'vitest';
import { PasteRegistry, shouldCompactPaste } from '../src/input/paste';

describe('large text pastes', () => {
  it('compacts pastes with at least five lines or 1,000 characters', () => {
    expect(shouldCompactPaste('one\ntwo\nthree\nfour\nfive')).toBe(true);
    expect(shouldCompactPaste('x'.repeat(1_000))).toBe(true);
    expect(shouldCompactPaste('one\ntwo\nthree\nfour')).toBe(false);
    expect(shouldCompactPaste('x'.repeat(999))).toBe(false);
  });

  it('expands only placeholders registered for the current draft', () => {
    const registry = new PasteRegistry();
    const label = registry.register('alpha\nbeta\ngamma\ndelta\nepsilon');

    expect(label).toBe('[Pasted text #1, 5 lines]');
    expect(registry.expand(`before ${label} after`)).toBe(
      'before alpha\nbeta\ngamma\ndelta\nepsilon after',
    );
    expect(registry.expand('[Pasted text #99, 5 lines]')).toBe('[Pasted text #99, 5 lines]');
  });
});
