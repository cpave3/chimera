import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const NEXT_VERSION = join(import.meta.dirname, '..', '..', '..', 'scripts', 'next-version.sh');
const repositories: string[] = [];

/** A repository with one commit carrying these tags. */
function repositoryWith(tags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'chimera-tags-'));
  repositories.push(dir);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git('init', '-q');
  git(
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x',
  );
  for (const tag of tags) git('tag', tag);
  return dir;
}

function nextVersion(tags: string[], bump: string): string {
  const result = spawnSync('bash', [NEXT_VERSION, bump], {
    cwd: repositoryWith(tags),
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

afterEach(() => {
  for (const dir of repositories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('next-version.sh', () => {
  it('starts from v0.0.0 with no tags', () => {
    expect(nextVersion([], 'patch')).toBe('v0.0.1');
    expect(nextVersion([], 'minor')).toBe('v0.1.0');
    expect(nextVersion([], 'major')).toBe('v1.0.0');
  });

  it('bumps each part, resetting the ones after it', () => {
    expect(nextVersion(['v1.4.2'], 'patch')).toBe('v1.4.3');
    expect(nextVersion(['v1.4.2'], 'minor')).toBe('v1.5.0');
    expect(nextVersion(['v1.4.2'], 'major')).toBe('v2.0.0');
  });

  it('ignores prereleases and other tags', () => {
    expect(
      nextVersion(['v0.2.0', 'v0.3.0-rc.1', 'v9.9.9-beta', 'latest', 'release-5'], 'patch'),
    ).toBe('v0.2.1');
  });

  it('compares parts as numbers, not text', () => {
    expect(nextVersion(['v0.9.0', 'v0.10.0', 'v0.2.0'], 'patch')).toBe('v0.10.1');
    expect(nextVersion(['v1.9.9', 'v1.10.0', 'v1.10.10', 'v1.10.9'], 'patch')).toBe('v1.10.11');
  });

  it('refuses an unknown bump', () => {
    const result = spawnSync('bash', [NEXT_VERSION, 'huge'], {
      cwd: repositoryWith([]),
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
  });
});
