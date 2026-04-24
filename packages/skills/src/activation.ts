import { resolve } from 'node:path';
import type { SkillRegistry, SkillSource } from './types';

/**
 * The `skill_activated` event uses a collapsed 3-value category rather than
 * the full 6-tier `SkillSource`.
 */
export type ActivationCategory = 'project' | 'user' | 'claude-compat';

export function categorize(source: SkillSource): ActivationCategory {
  if (source === 'project' || source === 'ancestor') return 'project';
  if (source === 'user') return 'user';
  return 'claude-compat';
}

export interface SkillActivationHit {
  skillName: string;
  source: ActivationCategory;
}

/**
 * Returns a function that, given the `path` argument the model passed to
 * `read`, resolves it against `cwd` and reports whether it is a known
 * SKILL.md. The caller emits the corresponding event.
 *
 * Per design D4 and task 5.3, activation fires once per read. If the model
 * reads the same SKILL.md multiple times in a session, the event is emitted
 * each time; tracking uniqueness added no observed value and complicates
 * session resumption.
 */
export function buildSkillActivationLookup(
  registry: SkillRegistry,
  cwd: string,
): (readPath: string) => SkillActivationHit | undefined {
  const byPath = new Map<string, { name: string; source: SkillSource }>();
  for (const s of registry.all()) {
    byPath.set(s.path, { name: s.name, source: s.source });
  }
  return (readPath) => {
    const abs = resolve(cwd, readPath);
    const hit = byPath.get(abs);
    if (!hit) return undefined;
    return { skillName: hit.name, source: categorize(hit.source) };
  };
}
