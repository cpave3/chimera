import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCommands } from '../src/load';

describe('loadCommands discovery', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-commands-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('loads a project command with frontmatter', async () => {
    const cwd = join(home, 'proj');
    await mkdir(join(cwd, '.chimera', 'commands'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'commands', 'review.md'),
      '---\ndescription: Review diff\n---\nReview: $ARGUMENTS',
    );

    const reg = loadCommands({ cwd, userHome: home });
    const cmd = reg.find('review');
    expect(cmd).toBeDefined();
    expect(cmd?.description).toBe('Review diff');
    expect(cmd?.body).toBe('Review: $ARGUMENTS');
    expect(cmd?.source).toBe('project');
  });

  it('loads a command without frontmatter (description undefined)', async () => {
    const cwd = join(home, 'p2');
    await mkdir(join(cwd, '.chimera', 'commands'), { recursive: true });
    await writeFile(join(cwd, '.chimera', 'commands', 'say-hi.md'), 'Hello!');
    const reg = loadCommands({ cwd, userHome: home });
    const cmd = reg.find('say-hi');
    expect(cmd?.body).toBe('Hello!');
    expect(cmd?.description).toBeUndefined();
  });

  it('project tier shadows claude-compat tier, one warning logged', async () => {
    const cwd = join(home, 'p3');
    await mkdir(join(cwd, '.chimera', 'commands'), { recursive: true });
    await mkdir(join(cwd, '.claude', 'commands'), { recursive: true });
    await writeFile(join(cwd, '.chimera', 'commands', 'review.md'), 'chimera');
    await writeFile(join(cwd, '.claude', 'commands', 'review.md'), 'claude');

    const warnings: string[] = [];
    const reg = loadCommands({
      cwd,
      userHome: home,
      onWarning: (m) => warnings.push(m),
    });

    expect(reg.find('review')?.body).toBe('chimera');
    expect(reg.find('review')?.source).toBe('project');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/review/);
    expect(warnings[0]).toMatch(/shadowed/);
  });

  it('includeClaudeCompat=false skips .claude/commands entries', async () => {
    const cwd = join(home, 'p4');
    await mkdir(join(cwd, '.claude', 'commands'), { recursive: true });
    await writeFile(join(cwd, '.claude', 'commands', 'only-claude.md'), 'x');

    const reg = loadCommands({
      cwd,
      userHome: home,
      includeClaudeCompat: false,
    });
    expect(reg.find('only-claude')).toBeUndefined();
  });

  it('returns empty registry when nothing exists', () => {
    const reg = loadCommands({ cwd: home, userHome: home });
    expect(reg.list()).toEqual([]);
  });

  it('loads a namespaced command from a .chimera/commands subdirectory', async () => {
    const cwd = join(home, 'nested-chimera');
    await mkdir(join(cwd, '.chimera', 'commands', 'ops'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'commands', 'ops', 'deploy.md'),
      '---\ndescription: Ship it\n---\nrolling deploy',
    );

    const reg = loadCommands({ cwd, userHome: home });
    const cmd = reg.find('ops:deploy');
    expect(cmd).toBeDefined();
    expect(cmd?.body).toBe('rolling deploy');
    expect(cmd?.description).toBe('Ship it');
    expect(cmd?.source).toBe('project');
  });

  it('loads a namespaced command from a .claude/commands subdirectory', async () => {
    const cwd = join(home, 'nested-claude');
    await mkdir(join(cwd, '.claude', 'commands', 'opsx'), { recursive: true });
    await writeFile(
      join(cwd, '.claude', 'commands', 'opsx', 'explore.md'),
      'explore template',
    );

    const reg = loadCommands({ cwd, userHome: home });
    const cmd = reg.find('opsx:explore');
    expect(cmd?.body).toBe('explore template');
    expect(cmd?.source).toBe('claude-project');
  });

  it('joins deeper nesting with colons', async () => {
    const cwd = join(home, 'deep');
    await mkdir(join(cwd, '.chimera', 'commands', 'a', 'b'), { recursive: true });
    await writeFile(join(cwd, '.chimera', 'commands', 'a', 'b', 'c.md'), 'deep');
    const reg = loadCommands({ cwd, userHome: home });
    expect(reg.find('a:b:c')?.body).toBe('deep');
  });

  it('ancestor walk terminates at a .git root', async () => {
    const repo = join(home, 'repo');
    const sub = join(repo, 'pkg', 'nested');
    await mkdir(sub, { recursive: true });
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, '.chimera', 'commands'), { recursive: true });
    await writeFile(join(repo, '.chimera', 'commands', 'root-cmd.md'), 'root');

    const reg = loadCommands({ cwd: sub, userHome: home });
    expect(reg.find('root-cmd')?.body).toBe('root');
  });
});
