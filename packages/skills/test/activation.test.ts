import { describe, expect, it } from 'vitest';
import { buildSkillActivationLookup, categorizeSkillSource } from '../src';
import { InMemorySkillRegistry } from '../src/registry';

describe('categorizeSkillSource', () => {
  it('maps the 6 tiers into the 3-value activation category', () => {
    expect(categorizeSkillSource('project')).toBe('project');
    expect(categorizeSkillSource('ancestor')).toBe('project');
    expect(categorizeSkillSource('user')).toBe('user');
    expect(categorizeSkillSource('claude-project')).toBe('claude-compat');
    expect(categorizeSkillSource('claude-ancestor')).toBe('claude-compat');
    expect(categorizeSkillSource('claude-user')).toBe('claude-compat');
  });
});

describe('buildSkillActivationLookup', () => {
  const cwd = '/abs/cwd';
  const reg = new InMemorySkillRegistry(
    [
      {
        name: 'pdf',
        description: 'pdf',
        path: '/abs/cwd/.chimera/skills/pdf/SKILL.md',
        source: 'project',
        frontmatter: {},
      },
      {
        name: 'mail',
        description: 'mail',
        path: '/home/u/.claude/skills/mail/SKILL.md',
        source: 'claude-user',
        frontmatter: {},
      },
    ],
    [],
  );
  const lookup = buildSkillActivationLookup(reg, cwd);

  it('matches a relative read path for a project skill', () => {
    const hit = lookup('.chimera/skills/pdf/SKILL.md');
    expect(hit).toEqual({ skillName: 'pdf', source: 'project' });
  });

  it('matches an absolute read path for a claude-compat skill', () => {
    const hit = lookup('/home/u/.claude/skills/mail/SKILL.md');
    expect(hit).toEqual({ skillName: 'mail', source: 'claude-compat' });
  });

  it('returns undefined for non-skill paths', () => {
    expect(lookup('src/index.ts')).toBeUndefined();
    expect(lookup('.chimera/skills/other/SKILL.md')).toBeUndefined();
  });
});
