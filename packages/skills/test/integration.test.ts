import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSystemPrompt } from '@chimera/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSkills } from '../src/load';

describe('skills ↔ composeSystemPrompt integration', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-skills-int-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('empty registry contributes no header to the composed prompt', () => {
    const reg = loadSkills({ cwd: home, userHome: home });
    const prompt = composeSystemPrompt({
      cwd: home,
      home,
      extensions: [() => reg.buildIndex() || null],
    });
    expect(prompt).not.toContain('# Available skills');
  });

  it('populated registry appends the index block after AGENTS.md content', async () => {
    const cwd = join(home, 'proj');
    await mkdir(join(cwd, '.chimera', 'skills', 'pdf'), { recursive: true });
    await writeFile(
      join(cwd, '.chimera', 'skills', 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: PDF things\n---',
    );
    await writeFile(join(cwd, 'AGENTS.md'), 'AGENTS-CONTENT');

    const reg = loadSkills({ cwd, userHome: home });
    const prompt = composeSystemPrompt({
      cwd,
      home,
      extensions: [() => reg.buildIndex() || null],
    });

    const agentsIdx = prompt.indexOf('AGENTS-CONTENT');
    const skillsIdx = prompt.indexOf('# Available skills');
    expect(agentsIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeGreaterThan(agentsIdx);
    expect(prompt).toContain('- pdf — PDF things');
  });
});
