import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, findClosestCommand } from '../src/slash-commands';

describe('slash commands', () => {
  it('contains /help, /clear, /new, /sessions, /exit, /model, /rules', () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual(
      ['/clear', '/exit', '/help', '/model', '/new', '/rules', '/sessions'].sort(),
    );
  });

  it('findClosestCommand returns the command itself when it exists', () => {
    expect(findClosestCommand('/help')).toBe('/help');
  });

  it('findClosestCommand suggests /help for /halp', () => {
    expect(findClosestCommand('/halp')).toBe('/help');
  });

  it('returns null for wildly different input', () => {
    expect(findClosestCommand('/foobarbaz')).toBeNull();
  });
});
