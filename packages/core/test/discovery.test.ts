import { describe, expect, it } from 'vitest';
import {
  parseFrontmatter,
  parseToolsCsv,
  buildTiers,
  ancestorsBetween,
  isGitRoot,
  walkMarkdownFiles,
} from '../src/discovery';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('parseFrontmatter', () => {
  it('returns empty frontmatter when no --- fence exists', () => {
    const { frontmatter, body } = parseFrontmatter('just a body');
    expect(frontmatter).toEqual({});
    expect(body).toBe('just a body');
  });

  it('parses flat key:value pairs', () => {
    const { frontmatter } = parseFrontmatter('---\nname: pdf\ndescription: hello\n---\nbody');
    expect(frontmatter).toEqual({ name: 'pdf', description: 'hello' });
  });

  it('strips surrounding quotes', () => {
    const { frontmatter } = parseFrontmatter('---\ndescription: "hi there"\n---');
    expect(frontmatter['description']).toBe('hi there');
  });

  it('supports folded block scalars (>): multi-line joined by spaces', () => {
    const src = ['---', 'name: pdf', 'description: >', '  First line', '  second line', '---'].join(
      '\n',
    );
    expect(parseFrontmatter(src).frontmatter['description']).toBe('First line second line');
  });

  it('supports literal block scalars (|): preserves newlines', () => {
    const src = ['---', 'name: pdf', 'description: |', '  line 1', '  line 2', '---'].join('\n');
    expect(parseFrontmatter(src).frontmatter['description']).toBe('line 1\nline 2');
  });

  it('block scalar ends at the next non-indented key', () => {
    const src = ['---', 'description: >', '  first', '  second', 'version: 1.0.0', '---'].join(
      '\n',
    );
    const fm = parseFrontmatter(src).frontmatter;
    expect(fm['description']).toBe('first second');
    expect(fm['version']).toBe('1.0.0');
  });

  it('body is everything after the closing fence', () => {
    const { body } = parseFrontmatter('---\nname: x\n---\nhello\nworld');
    expect(body).toBe('hello\nworld');
  });

  it('treats an unterminated fence as a body', () => {
    const parsed = parseFrontmatter('---\nname: x');
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe('---\nname: x');
  });
});

describe('parseToolsCsv', () => {
  it('lowercases, trims, and dedupes', () => {
    expect(parseToolsCsv('Read, Grep, GLOB,read')).toEqual(['read', 'grep', 'glob']);
  });

  it('returns [] for empty / undefined input', () => {
    expect(parseToolsCsv(undefined)).toEqual([]);
    expect(parseToolsCsv('')).toEqual([]);
    expect(parseToolsCsv(',, ,')).toEqual([]);
  });
});

describe('buildTiers', () => {
  it('produces project/ancestor/user + claude tiers with correct assetType', () => {
    const cwd = '/proj';
    const userHome = '/home';
    const tiers = buildTiers({ cwd, userHome, assetType: 'commands', includeClaudeCompat: true });
    const dirs = tiers.map((t) => t.dir);
    expect(dirs).toContain('/proj/.chimera/commands');
    expect(dirs).toContain('/home/.chimera/commands');
    expect(dirs).toContain('/proj/.claude/commands');
    expect(dirs).toContain('/home/.claude/commands');
  });

  it('omits claude tiers when includeClaudeCompat is false', () => {
    const tiers = buildTiers({
      cwd: '/proj',
      userHome: '/home',
      assetType: 'skills',
      includeClaudeCompat: false,
    });
    const dirs = tiers.map((t) => t.dir);
    expect(dirs.some((d) => d.includes('.claude'))).toBe(false);
  });

  it('appends builtinDir when provided', () => {
    const tiers = buildTiers({
      cwd: '/proj',
      userHome: '/home',
      assetType: 'modes',
      builtinDir: '/builtin',
    });
    expect(tiers[tiers.length - 1]).toEqual({ source: 'builtin', dir: '/builtin' });
  });

  it('defaults userHome to os.homedir()', () => {
    const tiers = buildTiers({ cwd: '/proj', assetType: 'agents' });
    expect(tiers.some((t) => t.source === 'user')).toBe(true);
  });
});

describe('ancestorsBetween', () => {
  it('returns intermediate ancestors', () => {
    const ancestors = ancestorsBetween('/a/b/c', '/a');
    expect(ancestors).toContain('/a/b');
  });

  it('stops at stopAt boundary', () => {
    const ancestors = ancestorsBetween('/a/b/c', '/a/b');
    expect(ancestors).toEqual([]);
  });

  it('does not include stopAt itself', () => {
    const ancestors = ancestorsBetween('/a/b/c', '/a');
    expect(ancestors).not.toContain('/a');
  });
});

describe('isGitRoot', () => {
  it('returns true when .git directory exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chimera-git-'));
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(isGitRoot(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when .git is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chimera-nogit-'));
    expect(isGitRoot(dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('walkMarkdownFiles', () => {
  it('yields markdown files recursively', () => {
    const root = mkdtempSync(join(tmpdir(), 'chimera-walk-'));
    const sub = join(root, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, 'a.md'), 'a');
    writeFileSync(join(root, 'b.txt'), 'b');
    writeFileSync(join(sub, 'c.md'), 'c');

    const files = [...walkMarkdownFiles(root)];
    const relPaths = files.map((f) => f.relPath).sort();
    expect(relPaths).toEqual(['a.md', 'sub/c.md']);

    rmSync(root, { recursive: true, force: true });
  });

  it('silently skips missing dirs', () => {
    expect([...walkMarkdownFiles('/nonexistent')]).toEqual([]);
  });
});
