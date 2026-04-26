import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discover } from '../src/discovery';

describe('discover', () => {
  let root: string;
  let globalRoot: string;
  let projectRoot: string;
  let cwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-hooks-disc-'));
    globalRoot = join(root, 'global');
    projectRoot = join(root, 'project');
    cwd = join(root, 'cwd');
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  async function makeScript(dir: string, name: string, mode = 0o755): Promise<string> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, '#!/bin/sh\nexit 0\n');
    await chmod(path, mode);
    return path;
  }

  it('returns executable files only, skipping non-executables', async () => {
    const eventDir = join(projectRoot, 'PostToolUse');
    const exec = await makeScript(eventDir, 'a.sh');
    const nonExec = join(eventDir, 'b.sh');
    await writeFile(nonExec, '#!/bin/sh\nexit 0\n');
    await chmod(nonExec, 0o644);

    const result = await discover('PostToolUse', cwd, { globalRoot, projectRoot });
    expect(result.project).toEqual([exec]);
    expect(result.global).toEqual([]);
  });

  it('skips broken symlinks', async () => {
    const eventDir = join(projectRoot, 'Stop');
    await mkdir(eventDir, { recursive: true });
    await symlink(join(root, 'does-not-exist'), join(eventDir, 'broken'));
    const real = await makeScript(eventDir, 'real.sh');

    const result = await discover('Stop', cwd, { globalRoot, projectRoot });
    expect(result.project).toEqual([real]);
  });

  it('orders entries lexicographically per directory; globals first in caller view', async () => {
    const globalDir = join(globalRoot, 'UserPromptSubmit');
    const projectDir = join(projectRoot, 'UserPromptSubmit');
    const g2 = await makeScript(globalDir, 'b-global.sh');
    const g1 = await makeScript(globalDir, 'a-global.sh');
    const p2 = await makeScript(projectDir, 'b-project.sh');
    const p1 = await makeScript(projectDir, 'a-project.sh');

    const result = await discover('UserPromptSubmit', cwd, { globalRoot, projectRoot });
    expect(result.global).toEqual([g1, g2]);
    expect(result.project).toEqual([p1, p2]);
  });

  it('returns empty arrays when directories do not exist', async () => {
    const result = await discover('SessionEnd', cwd, { globalRoot, projectRoot });
    expect(result).toEqual({ global: [], project: [] });
  });

  it('ignores subdirectories', async () => {
    const eventDir = join(projectRoot, 'PostToolUse');
    await mkdir(join(eventDir, 'subdir'), { recursive: true });
    const realScript = await makeScript(eventDir, 'real.sh');

    const result = await discover('PostToolUse', cwd, { globalRoot, projectRoot });
    expect(result.project).toEqual([realScript]);
  });
});
