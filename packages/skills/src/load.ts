import { discover } from './discover';
import { InMemorySkillRegistry } from './registry';
import type { LoadSkillsOptions, SkillRegistry } from './types';

export function loadSkills(opts: LoadSkillsOptions): SkillRegistry {
  const { skills, collisions } = discover(opts);
  return new InMemorySkillRegistry(skills, collisions);
}
