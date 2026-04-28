import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseFrontmatter } from './frontmatter';
import type { AgentCollision, AgentDefinition, AgentSource, LoadAgentsOptions } from './types';

interface Tier {
  source: AgentSource;
  dir: string;
}

export interface DiscoverResult {
  agents: AgentDefinition[];
  collisions: AgentCollision[];
}

export function buildTiers(opts: LoadAgentsOptions): Tier[] {
  const cwd = resolve(opts.cwd);
  const userHome = resolve(opts.userHome ?? homedir());
  const includeClaudeCompat = opts.includeClaudeCompat !== false;

  const ancestors = ancestorsBetween(cwd, userHome);

  const tiers: Tier[] = [];
  tiers.push({ source: 'project', dir: join(cwd, '.chimera', 'agents') });
  for (const anc of ancestors) {
    tiers.push({ source: 'ancestor', dir: join(anc, '.chimera', 'agents') });
  }
  tiers.push({ source: 'user', dir: join(userHome, '.chimera', 'agents') });

  if (includeClaudeCompat) {
    tiers.push({ source: 'claude-project', dir: join(cwd, '.claude', 'agents') });
    for (const anc of ancestors) {
      tiers.push({ source: 'claude-ancestor', dir: join(anc, '.claude', 'agents') });
    }
    tiers.push({ source: 'claude-user', dir: join(userHome, '.claude', 'agents') });
  }

  return tiers;
}

function ancestorsBetween(start: string, stopAt: string): string[] {
  const out: string[] = [];
  let dir = start;
  const seen = new Set<string>();
  while (true) {
    const parent = dirname(dir);
    if (parent === dir || seen.has(parent)) break;
    seen.add(parent);

    if (isGitRoot(dir)) break;

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

export function discover(opts: LoadAgentsOptions): DiscoverResult {
  const tiers = buildTiers(opts);
  const byName = new Map<string, AgentDefinition>();
  const collisions: AgentCollision[] = [];
  const warn = opts.onWarning ?? (() => {});

  for (const tier of tiers) {
    let entries: string[];
    try {
      entries = readdirSync(tier.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const filePath = join(tier.dir, entry);
      let raw: string;
      try {
        const st = statSync(filePath);
        if (!st.isFile()) continue;
        raw = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const parsed = parseFrontmatter(raw);
      const fileBase = basename(entry, '.md');
      const declaredName = parsed.frontmatter.name?.trim();
      const name = declaredName || fileBase;
      const description = parsed.frontmatter.description?.trim();

      if (declaredName && declaredName !== fileBase) {
        warn(
          `agents: ${filePath} skipped — frontmatter "name" (${declaredName}) does not match filename`,
        );
        continue;
      }
      if (!description) {
        warn(`agents: ${filePath} skipped — frontmatter "description" is required`);
        continue;
      }

      const agent: AgentDefinition = {
        name,
        description,
        body: parsed.body,
        path: filePath,
        source: tier.source,
        frontmatter: parsed.frontmatter,
      };
      const existing = byName.get(name);
      if (existing) {
        collisions.push({
          name,
          winner: existing.source,
          loser: agent.source,
          winnerPath: existing.path,
          loserPath: agent.path,
        });
        warn(
          `agents: "${name}" at ${agent.path} is shadowed by ${existing.path} (tier ${existing.source})`,
        );
        continue;
      }
      byName.set(name, agent);
    }
  }

  return { agents: [...byName.values()], collisions };
}
