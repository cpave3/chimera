import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseFrontmatter } from './frontmatter';
import type { LoadSkillsOptions, Skill, SkillCollision, SkillSource } from './types';

interface Tier {
  source: SkillSource;
  dir: string;
}

export interface DiscoverResult {
  skills: Skill[];
  collisions: SkillCollision[];
}

export function buildTiers(opts: LoadSkillsOptions): Tier[] {
  const cwd = resolve(opts.cwd);
  const userHome = resolve(opts.userHome ?? homedir());
  const includeClaudeCompat = opts.includeClaudeCompat !== false;

  const ancestors = ancestorsBetween(cwd, userHome);

  const tiers: Tier[] = [];
  tiers.push({ source: 'project', dir: join(cwd, '.chimera', 'skills') });
  for (const anc of ancestors) {
    tiers.push({ source: 'ancestor', dir: join(anc, '.chimera', 'skills') });
  }
  tiers.push({ source: 'user', dir: join(userHome, '.chimera', 'skills') });

  if (includeClaudeCompat) {
    tiers.push({ source: 'claude-project', dir: join(cwd, '.claude', 'skills') });
    for (const anc of ancestors) {
      tiers.push({ source: 'claude-ancestor', dir: join(anc, '.claude', 'skills') });
    }
    tiers.push({ source: 'claude-user', dir: join(userHome, '.claude', 'skills') });
  }

  return tiers;
}

/**
 * Walk from `start`'s parent up toward the nearest .git/ marker (or `stopAt`
 * if no git root is found). Returns intermediate directories (exclusive of
 * `start`, inclusive of the git root itself).
 */
function ancestorsBetween(start: string, stopAt: string): string[] {
  const out: string[] = [];
  let dir = start;
  const seen = new Set<string>();
  while (true) {
    const parent = dirname(dir);
    if (parent === dir || seen.has(parent)) break;
    seen.add(parent);

    if (isGitRoot(dir)) break;

    // Stop at userHome without including it — the dedicated `user` tier
    // handles `<userHome>/.chimera/skills/` directly, so listing it here
    // would double-count and give the ancestor tier undeserved priority.
    if (parent === stopAt) break;
    if (parent !== start) out.push(parent);
    dir = parent;
    if (isGitRoot(dir)) break;
  }
  return out;
}

function isGitRoot(dir: string): boolean {
  try {
    const st = statSync(join(dir, '.git'));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

export function discover(opts: LoadSkillsOptions): DiscoverResult {
  const tiers = buildTiers(opts);
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
        source: tier.source,
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
