import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSkills } from '../src/load';
import { InMemorySkillRegistry } from '../src/registry';

describe('SkillRegistry.buildIndex', () => {
  it('returns empty string for an empty registry', () => {
    const reg = new InMemorySkillRegistry([], []);
    expect(reg.buildIndex()).toBe('');
  });

  it('begins with the literal header and lists name, description, path', () => {
    const reg = new InMemorySkillRegistry(
      [
        {
          name: 'pdf',
          description: 'Manipulate PDF files',
          path: '/abs/.chimera/skills/pdf/SKILL.md',
          source: 'project',
          frontmatter: {},
        },
      ],
      [],
    );
    const idx = reg.buildIndex();
    expect(idx.startsWith('# Available skills')).toBe(true);
    expect(idx).toContain('- pdf — Manipulate PDF files');
    expect(idx).toContain('path: /abs/.chimera/skills/pdf/SKILL.md');
  });

  it('emits skills in alphabetical order regardless of insertion order', () => {
    const reg = new InMemorySkillRegistry(
      [
        { name: 'zebra', description: 'z', path: '/z', source: 'project', frontmatter: {} },
        { name: 'alpha', description: 'a', path: '/a', source: 'project', frontmatter: {} },
        { name: 'mango', description: 'm', path: '/m', source: 'project', frontmatter: {} },
      ],
      [],
    );
    const idx = reg.buildIndex();
    const alphaPos = idx.indexOf('- alpha');
    const mangoPos = idx.indexOf('- mango');
    const zebraPos = idx.indexOf('- zebra');
    expect(alphaPos).toBeGreaterThan(-1);
    expect(alphaPos).toBeLessThan(mangoPos);
    expect(mangoPos).toBeLessThan(zebraPos);
  });
});

describe('loadSkills integration with buildIndex', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-skills-idx-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('yields a non-empty index when skills exist on disk', async () => {
    const cwd = join(home, 'proj');
    await mkdir(join(cwd, '.chimera', 'skills', 'pdf'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'skills', 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: PDF things\n---',
    );
    const reg = loadSkills({ cwd, userHome: home });
    const idx = reg.buildIndex();
    expect(idx).toContain('# Available skills');
    expect(idx).toContain('- pdf — PDF things');
  });
});
