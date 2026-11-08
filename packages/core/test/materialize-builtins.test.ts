import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materializeBuiltins } from '../src/discovery';

describe('materializeBuiltins', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chimera-builtins-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes the files where a discovery tier can read them', () => {
    const dir = materializeBuiltins(
      'skills',
      { 'tidy/SKILL.md': '---\nname: tidy\n---\nbody' },
      root,
    );
    expect(readFileSync(join(dir, 'tidy', 'SKILL.md'), 'utf8')).toBe('---\nname: tidy\n---\nbody');
  });

  it('gives the same directory for the same contents, and another for new contents', () => {
    const first = materializeBuiltins('modes', { 'build.md': 'one' }, root);
    expect(materializeBuiltins('modes', { 'build.md': 'one' }, root)).toBe(first);
    const changed = materializeBuiltins('modes', { 'build.md': 'two' }, root);
    expect(changed).not.toBe(first);
    expect(readFileSync(join(first, 'build.md'), 'utf8')).toBe('one');
  });
});
