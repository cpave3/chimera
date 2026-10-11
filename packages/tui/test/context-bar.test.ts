import { describe, expect, it } from 'vitest';
import { contextBar } from '../src/context-bar';

describe('contextBar', () => {
  it('fills the bar by the share of the window in use', () => {
    const cells = contextBar({
      used: 76_000,
      window: 200_000,
      systemTokens: 0,
      skillsTokens: 0,
      cells: 50,
    });
    expect(cells).toEqual({ system: 0, skills: 0, history: 19, free: 31 });
  });

  it('splits the filled part into system, skills and history', () => {
    const cells = contextBar({
      used: 76_000,
      window: 200_000,
      systemTokens: 38_000,
      skillsTokens: 22_000,
      cells: 100,
    });
    expect(cells).toEqual({ system: 8, skills: 11, history: 19, free: 62 });
  });

  it('gives a small part one cell so that it shows', () => {
    const cells = contextBar({
      used: 100_000,
      window: 200_000,
      systemTokens: 1_200,
      skillsTokens: 200,
      cells: 20,
    });
    expect(cells.system).toBe(1);
    expect(cells.skills).toBe(1);
    expect(cells.system + cells.skills + cells.history).toBe(10);
  });

  it('never claims more for the system prompt than the provider counted in total', () => {
    const cells = contextBar({
      used: 4_000,
      window: 200_000,
      systemTokens: 9_000,
      skillsTokens: 2_000,
      cells: 40,
    });
    expect(cells.history).toBe(0);
    expect(cells.system + cells.skills).toBe(1);
    expect(cells.free).toBe(39);
  });

  it('is empty before the first step and without a known window', () => {
    expect(
      contextBar({ used: 0, window: 200_000, systemTokens: 0, skillsTokens: 0, cells: 10 }),
    ).toEqual({
      system: 0,
      skills: 0,
      history: 0,
      free: 10,
    });
    expect(
      contextBar({ used: 500, window: 0, systemTokens: 0, skillsTokens: 0, cells: 10 }).free,
    ).toBe(10);
  });

  it('fills every cell when the window is full', () => {
    const cells = contextBar({
      used: 250_000,
      window: 200_000,
      systemTokens: 0,
      skillsTokens: 0,
      cells: 10,
    });
    expect(cells).toEqual({ system: 0, skills: 0, history: 10, free: 0 });
  });
});
