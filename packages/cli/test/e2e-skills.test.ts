import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSkillsList } from '../src/commands/skills';

async function capture(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as { write: (s: string) => boolean }).write = orig;
  }
  return chunks.join('');
}

describe('chimera skills E2E', () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-skills-e2e-'));
    workspace = join(home, 'workspace');
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('lists a project-scoped skill as JSON', async () => {
    await mkdir(join(workspace, '.chimera', 'skills', 'pdf'), { recursive: true });
    await writeFile(
      join(workspace, '.chimera', 'skills', 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: PDF things\n---',
    );

    const out = await capture(() =>
      runSkillsList({ cwd: workspace, home, json: true }),
    );
    const data = JSON.parse(out);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ name: 'pdf', source: 'project' });
  });

  it('prefers .chimera tier over .claude tier on a name collision', async () => {
    await mkdir(join(workspace, '.chimera', 'skills', 'git'), { recursive: true });
    await mkdir(join(workspace, '.claude', 'skills', 'git'), { recursive: true });
    await writeFile(
      join(workspace, '.chimera', 'skills', 'git', 'SKILL.md'),
      '---\nname: git\ndescription: chimera-native\n---',
    );
    await writeFile(
      join(workspace, '.claude', 'skills', 'git', 'SKILL.md'),
      '---\nname: git\ndescription: claude-compat\n---',
    );
    const out = await capture(() =>
      runSkillsList({ cwd: workspace, home, json: true }),
    );
    const data = JSON.parse(out);
    const git = data.find((s: { name: string }) => s.name === 'git');
    expect(git).toMatchObject({ source: 'project', description: 'chimera-native' });
  });

  it('--no-claude-compat suppresses .claude/skills entries', async () => {
    await mkdir(join(workspace, '.claude', 'skills', 'mail'), { recursive: true });
    await writeFile(
      join(workspace, '.claude', 'skills', 'mail', 'SKILL.md'),
      '---\nname: mail\ndescription: mail\n---',
    );
    const out = await capture(() =>
      runSkillsList({ cwd: workspace, home, json: true, claudeCompat: false }),
    );
    const data = JSON.parse(out);
    expect(data.map((s: { name: string }) => s.name)).not.toContain('mail');
  });
});
