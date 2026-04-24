import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSkills } from '../src/load';

describe('loadSkills discovery', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-skills-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('loads a project skill with valid frontmatter', async () => {
    const cwd = join(home, 'proj');
    await mkdir(join(cwd, '.chimera', 'skills', 'pdf'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'skills', 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: Manipulate PDF files\n---\nbody',
    );

    const reg = loadSkills({ cwd, userHome: home });
    const skill = reg.find('pdf');
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('pdf');
    expect(skill?.description).toBe('Manipulate PDF files');
    expect(skill?.source).toBe('project');
  });

  it('preserves optional frontmatter fields on the registry entry', async () => {
    const cwd = join(home, 'p-opt');
    await mkdir(join(cwd, '.chimera', 'skills', 'pdf'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'skills', 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: Manipulate PDF files\nversion: 1.2.3\nlicense: MIT\n---\nbody',
    );
    const reg = loadSkills({ cwd, userHome: home });
    const s = reg.find('pdf');
    expect(s?.frontmatter['version']).toBe('1.2.3');
    expect(s?.frontmatter['license']).toBe('MIT');
  });

  it('skips a SKILL.md whose frontmatter name does not match directory', async () => {
    const cwd = join(home, 'p-mismatch');
    await mkdir(join(cwd, '.chimera', 'skills', 'real'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'skills', 'real', 'SKILL.md'),
      '---\nname: wrong\ndescription: nope\n---',
    );
    const warnings: string[] = [];
    const reg = loadSkills({ cwd, userHome: home, onWarning: (m) => warnings.push(m) });
    expect(reg.find('real')).toBeUndefined();
    expect(reg.find('wrong')).toBeUndefined();
    expect(warnings.some((w) => /name.*missing|does not match/i.test(w))).toBe(true);
  });

  it('skips a SKILL.md missing description with a warning', async () => {
    const cwd = join(home, 'p-nodesc');
    await mkdir(join(cwd, '.chimera', 'skills', 'broken'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'skills', 'broken', 'SKILL.md'),
      '---\nname: broken\n---\nno description',
    );
    const warnings: string[] = [];
    const reg = loadSkills({ cwd, userHome: home, onWarning: (m) => warnings.push(m) });
    expect(reg.find('broken')).toBeUndefined();
    expect(warnings.some((w) => /description/.test(w))).toBe(true);
  });

  it('project tier shadows claude-compat tier with one warning', async () => {
    const cwd = join(home, 'p-collide');
    await mkdir(join(cwd, '.chimera', 'skills', 'git'), { recursive: true });
    await mkdir(join(cwd, '.claude', 'skills', 'git'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'skills', 'git', 'SKILL.md'),
      '---\nname: git\ndescription: chimera-native git\n---',
    );
    await writeFile(
      join(cwd, '.claude', 'skills', 'git', 'SKILL.md'),
      '---\nname: git\ndescription: claude-compat git\n---',
    );
    const warnings: string[] = [];
    const reg = loadSkills({ cwd, userHome: home, onWarning: (m) => warnings.push(m) });
    const g = reg.find('git');
    expect(g?.source).toBe('project');
    expect(g?.description).toBe('chimera-native git');
    expect(reg.collisions().length).toBe(1);
    expect(warnings.some((w) => /shadowed/.test(w))).toBe(true);
  });

  it('includeClaudeCompat=false skips .claude/skills tiers', async () => {
    const cwd = join(home, 'p-no-compat');
    await mkdir(join(cwd, '.claude', 'skills', 'git'), { recursive: true });
    await writeFile(
      join(cwd, '.claude', 'skills', 'git', 'SKILL.md'),
      '---\nname: git\ndescription: only-claude\n---',
    );
    const reg = loadSkills({ cwd, userHome: home, includeClaudeCompat: false });
    expect(reg.find('git')).toBeUndefined();
  });

  it('discovers user-home skills when nothing in cwd', async () => {
    await mkdir(join(home, '.chimera', 'skills', 'pdf'), { recursive: true });
    await writeFile(
      join(home, '.chimera', 'skills', 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: user-home pdf\n---',
    );
    const cwd = join(home, 'somewhere');
    await mkdir(cwd, { recursive: true });
    const reg = loadSkills({ cwd, userHome: home });
    expect(reg.find('pdf')?.source).toBe('user');
  });

  it('ancestor walk stops at a .git root', async () => {
    const repo = join(home, 'repo');
    const nested = join(repo, 'pkg', 'deep');
    await mkdir(nested, { recursive: true });
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, '.chimera', 'skills', 'team'), { recursive: true });
    await writeFile(
      join(repo, '.chimera', 'skills', 'team', 'SKILL.md'),
      '---\nname: team\ndescription: repo-root skill\n---',
    );
    const reg = loadSkills({ cwd: nested, userHome: home });
    expect(reg.find('team')?.source).toBe('ancestor');
  });

  it('returns an empty registry when nothing exists', () => {
    const reg = loadSkills({ cwd: home, userHome: home });
    expect(reg.all()).toEqual([]);
    expect(reg.paths().size).toBe(0);
  });

  it('all() is stable-sorted by name', async () => {
    const cwd = join(home, 'p-sort');
    await mkdir(join(cwd, '.chimera', 'skills', 'bravo'), { recursive: true });
    await mkdir(join(cwd, '.chimera', 'skills', 'alpha'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'skills', 'bravo', 'SKILL.md'),
      '---\nname: bravo\ndescription: b\n---',
    );
    await writeFile(
      join(cwd, '.chimera', 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: a\n---',
    );
    const reg = loadSkills({ cwd, userHome: home });
    expect(reg.all().map((s) => s.name)).toEqual(['alpha', 'bravo']);
  });

  it('paths() returns the absolute SKILL.md locations', async () => {
    const cwd = join(home, 'p-paths');
    await mkdir(join(cwd, '.chimera', 'skills', 'pdf'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'skills', 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: pdf\n---',
    );
    const reg = loadSkills({ cwd, userHome: home });
    const paths = reg.paths();
    expect(paths.size).toBe(1);
    expect([...paths][0]).toMatch(/\.chimera\/skills\/pdf\/SKILL\.md$/);
  });
});
