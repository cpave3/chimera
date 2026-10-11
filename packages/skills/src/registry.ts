import { basename, dirname } from 'node:path';
import type { Skill, SkillCollision, SkillIndexOptions, SkillRegistry } from './types';

// The estimate used across Chimera for prose.
const CHARACTERS_PER_TOKEN = 4;

export class InMemorySkillRegistry implements SkillRegistry {
  private readonly byName: Map<string, Skill>;
  private readonly _collisions: SkillCollision[];
  private readonly _paths: Set<string>;

  constructor(skills: Skill[], collisions: SkillCollision[]) {
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    this.byName = new Map(sorted.map((s) => [s.name, s]));
    this._collisions = collisions;
    this._paths = new Set(sorted.map((s) => s.path));
  }

  all(): Skill[] {
    return [...this.byName.values()];
  }

  find(name: string): Skill | undefined {
    return this.byName.get(name);
  }

  paths(): Set<string> {
    return new Set(this._paths);
  }

  collisions(): SkillCollision[] {
    return [...this._collisions];
  }

  buildIndex(options: SkillIndexOptions = {}): string {
    const skills = this.all();
    if (skills.length === 0) return '';
    const lines: string[] = ['# Available skills', ''];
    for (const s of skills) {
      lines.push(`- ${s.name} — ${s.description}`);
      lines.push(`  path: ${s.path}`);
    }
    const full = lines.join('\n');
    if (
      options.maxTokens === undefined ||
      full.length / CHARACTERS_PER_TOKEN <= options.maxTokens
    ) {
      return full;
    }
    return this.buildNameIndex(skills);
  }

  /** Names only, grouped by skills directory: what a very large library costs per request. */
  private buildNameIndex(skills: Skill[]): string {
    const byDirectory = new Map<string, string[]>();
    const elsewhere: Skill[] = [];
    for (const skill of skills) {
      const skillDirectory = dirname(skill.path);
      if (basename(skill.path) !== 'SKILL.md' || basename(skillDirectory) !== skill.name) {
        elsewhere.push(skill);
        continue;
      }
      const root = dirname(skillDirectory);
      byDirectory.set(root, [...(byDirectory.get(root) ?? []), skill.name]);
    }
    return [
      '# Available skills',
      '',
      `There are ${skills.length} skills, too many to describe here. To use one, read its file first: <directory>/<name>/SKILL.md.`,
      '',
      ...[...byDirectory].map(([root, names]) => `- ${root}: ${names.join(', ')}`),
      ...elsewhere.map((skill) => `- ${skill.name}: ${skill.path}`),
    ].join('\n');
  }
}
