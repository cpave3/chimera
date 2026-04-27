import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { colorFor, isValidHex, loadModes } from '../src';

function makeIsolatedHome() {
  const dir = mkdtempSync(join(tmpdir(), 'chimera-modes-'));
  const home = join(dir, 'home');
  const cwd = join(dir, 'cwd');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

describe('loadModes', () => {
  it('returns the two shipped builtins by default', () => {
    const { home, cwd } = makeIsolatedHome();
    const registry = loadModes({ cwd, userHome: home, includeClaudeCompat: false });
    const names = registry.all().map((mode) => mode.name);
    expect(names).toContain('build');
    expect(names).toContain('plan');
    expect(registry.find('build')?.source).toBe('builtin');
    expect(registry.find('plan')?.source).toBe('builtin');
  });

  it('plan builtin has a read-only tools allowlist (read, glob, grep)', () => {
    const { home, cwd } = makeIsolatedHome();
    const registry = loadModes({ cwd, userHome: home, includeClaudeCompat: false });
    expect(registry.find('plan')?.tools).toEqual(['read', 'glob', 'grep']);
  });

  it('build builtin has no tools allowlist (= all tools)', () => {
    const { home, cwd } = makeIsolatedHome();
    const registry = loadModes({ cwd, userHome: home, includeClaudeCompat: false });
    expect(registry.find('build')?.tools).toBeUndefined();
  });

  it('user file overrides the builtin', () => {
    const { home, cwd } = makeIsolatedHome();
    const userModes = join(home, '.chimera', 'modes');
    mkdirSync(userModes, { recursive: true });
    writeFileSync(
      join(userModes, 'plan.md'),
      ['---', 'name: plan', 'description: my custom plan', 'tools: [read]', '---', 'custom'].join(
        '\n',
      ),
    );
    const registry = loadModes({ cwd, userHome: home, includeClaudeCompat: false });
    const plan = registry.find('plan')!;
    expect(plan.source).toBe('user');
    expect(plan.description).toBe('my custom plan');
  });

  it('honors color frontmatter when valid', () => {
    const { home, cwd } = makeIsolatedHome();
    const userModes = join(home, '.chimera', 'modes');
    mkdirSync(userModes, { recursive: true });
    writeFileSync(
      join(userModes, 'question.md'),
      [
        '---',
        'name: question',
        'description: ask the codebase',
        'tools: [read]',
        'color: "#ff5500"',
        '---',
        'body',
      ].join('\n'),
    );
    const registry = loadModes({ cwd, userHome: home, includeClaudeCompat: false });
    expect(registry.find('question')?.colorHex).toBe('#ff5500');
  });

  it('falls back to derived color and warns when frontmatter color is invalid', () => {
    const { home, cwd } = makeIsolatedHome();
    const userModes = join(home, '.chimera', 'modes');
    mkdirSync(userModes, { recursive: true });
    writeFileSync(
      join(userModes, 'broken.md'),
      [
        '---',
        'name: broken',
        'description: x',
        'color: "not-a-color"',
        '---',
        'body',
      ].join('\n'),
    );
    const warnings: string[] = [];
    const registry = loadModes({
      cwd,
      userHome: home,
      includeClaudeCompat: false,
      onWarning: (msg) => warnings.push(msg),
    });
    const mode = registry.find('broken')!;
    expect(mode.colorHex).toBe(colorFor('broken'));
    expect(warnings.some((w) => w.includes('invalid color'))).toBe(true);
  });

  it('skips files whose name does not match filename', () => {
    const { home, cwd } = makeIsolatedHome();
    const userModes = join(home, '.chimera', 'modes');
    mkdirSync(userModes, { recursive: true });
    writeFileSync(
      join(userModes, 'foo.md'),
      ['---', 'name: bar', 'description: x', '---', 'body'].join('\n'),
    );
    const warnings: string[] = [];
    const registry = loadModes({
      cwd,
      userHome: home,
      includeClaudeCompat: false,
      onWarning: (msg) => warnings.push(msg),
    });
    expect(registry.find('foo')).toBeUndefined();
    expect(registry.find('bar')).toBeUndefined();
    expect(warnings.some((w) => w.includes('does not match filename'))).toBe(true);
  });
});

describe('colorFor', () => {
  it('is deterministic', () => {
    expect(colorFor('plan')).toBe(colorFor('plan'));
  });

  it('produces distinct colors for distinct names', () => {
    expect(colorFor('plan')).not.toBe(colorFor('build'));
  });

  it('respects valid overrides', () => {
    expect(colorFor('plan', '#abc')).toBe('#aabbcc');
    expect(colorFor('plan', '#AABBCC')).toBe('#aabbcc');
  });

  it('falls back when override is invalid', () => {
    expect(colorFor('plan', 'garbage')).toBe(colorFor('plan'));
  });
});

describe('isValidHex', () => {
  it('accepts #rgb and #rrggbb in either case', () => {
    expect(isValidHex('#abc')).toBe(true);
    expect(isValidHex('#AABBCC')).toBe(true);
    expect(isValidHex('aabbcc')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isValidHex('blue')).toBe(false);
    expect(isValidHex('#zzz')).toBe(false);
    expect(isValidHex('#1234')).toBe(false);
  });
});
