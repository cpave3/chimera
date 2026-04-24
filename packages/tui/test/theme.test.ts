import { afterEach, describe, expect, it } from 'vitest';
import { buildTheme } from '../src/theme';

describe('theme', () => {
  const original = process.env.NO_COLOR;

  afterEach(() => {
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  });

  it('yields colored theme when NO_COLOR unset', () => {
    delete process.env.NO_COLOR;
    const t = buildTheme();
    expect(t.primary).toBeDefined();
  });

  it('yields plain theme when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    const t = buildTheme();
    expect(t.primary).toBeUndefined();
    expect(t.danger).toBeUndefined();
  });
});
