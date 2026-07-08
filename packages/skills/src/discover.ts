import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildTiers, parseFrontmatter } from '@chimera/core';
import type { LoadSkillsOptions, Skill, SkillCollision, SkillSource } from './types';

export interface DiscoverResult {
  skills: Skill[];
  collisions: SkillCollision[];
}

export function discover(opts: LoadSkillsOptions): DiscoverResult {
  const tiers = buildTiers({
    cwd: opts.cwd,
    userHome: opts.userHome,
    includeClaudeCompat: opts.includeClaudeCompat,
    includeAgentsCompat: opts.includeAgentsCompat ?? true,
    assetType: 'skills',
  });
  const byName = new Map<string, Skill>();
  const collisions: SkillCollision[] = [];
  const warn = opts.onWarning ?? (() => {});

  for (const tier of tiers) {
    let entries: string[];
    try {
      entries = readdirSync(tier.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dirPath = join(tier.dir, entry);
      let isDir = false;
      try {
        isDir = statSync(dirPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;

      const skillFile = join(dirPath, 'SKILL.md');
      let body: string;
      try {
        const st = statSync(skillFile);
        if (!st.isFile()) continue;
        body = readFileSync(skillFile, 'utf8');
      } catch {
        continue;
      }

      const parsed = parseFrontmatter(body);
      const name = parsed.frontmatter['name']?.trim();
      const description = parsed.frontmatter['description']?.trim();
      if (!name || name !== basename(dirPath)) {
        warn(
          `skills: ${skillFile} skipped — frontmatter "name" missing or does not match directory`,
        );
        continue;
      }
      if (!description) {
        warn(`skills: ${skillFile} skipped — frontmatter "description" is required`);
        continue;
      }

      const skill: Skill = {
        name,
        description,
        path: skillFile,
        source: tier.source as SkillSource,
        frontmatter: parsed.frontmatter,
      };
      const existing = byName.get(name);
      if (existing) {
        collisions.push({
          name,
          winner: existing.source,
          loser: skill.source,
          winnerPath: existing.path,
          loserPath: skill.path,
        });
        warn(
          `skills: "${name}" at ${skill.path} is shadowed by ${existing.path} (tier ${existing.source})`,
        );
        continue;
      }
      byName.set(name, skill);
    }
  }

  return { skills: [...byName.values()], collisions };
}
