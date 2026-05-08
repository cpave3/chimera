import { readFileSync } from 'node:fs';
import { buildTiers, walkMarkdownFiles, parseFrontmatter } from '@chimera/core';
import type { Command, CommandCollision, CommandSource, LoadCommandsOptions } from './types';

export interface DiscoverResult {
  commands: Command[];
  collisions: CommandCollision[];
}

/**
 * Convert a tier-relative `.md` path into a command name. Subdirectories
 * become colon-separated namespace prefixes (matching Claude Code's
 * convention): `opsx/explore.md` → `opsx:explore`.
 */
function toCommandName(relPath: string): string {
  if (!relPath.endsWith('.md')) return '';
  const stem = relPath.slice(0, -'.md'.length);
  if (!stem) return '';
  return stem.split('/').join(':');
}

/**
 * Scan all tiers, returning the winning Command per name plus a collision
 * report (higher-tier-wins).
 */
export function discover(opts: LoadCommandsOptions): DiscoverResult {
  const tiers = buildTiers({
    cwd: opts.cwd,
    userHome: opts.userHome,
    includeClaudeCompat: opts.includeClaudeCompat,
    assetType: 'commands',
  });
  const byName = new Map<string, Command>();
  const collisions: CommandCollision[] = [];

  for (const tier of tiers) {
    for (const file of walkMarkdownFiles(tier.dir)) {
      const name = toCommandName(file.relPath);
      if (!name) continue;
      let body: string;
      try {
        body = readFileSync(file.absPath, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(body);
      const cmd: Command = {
        name,
        description: parsed.frontmatter['description'],
        body: parsed.body,
        path: file.absPath,
        source: tier.source as CommandSource,
      };
      const existing = byName.get(name);
      if (existing) {
        collisions.push({
          name,
          winner: existing.source,
          loser: cmd.source,
          winnerPath: existing.path,
          loserPath: cmd.path,
        });
        continue;
      }
      byName.set(name, cmd);
    }
  }

  return { commands: [...byName.values()], collisions };
}
