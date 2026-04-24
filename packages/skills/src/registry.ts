import type { Skill, SkillCollision, SkillRegistry } from './types';

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

  buildIndex(): string {
    const skills = this.all();
    if (skills.length === 0) return '';
    const lines: string[] = ['# Available skills', ''];
    for (const s of skills) {
      lines.push(`- ${s.name} — ${s.description}`);
      lines.push(`  path: ${s.path}`);
    }
    return lines.join('\n');
  }
}
