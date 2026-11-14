import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildTiers, materializeBuiltins, parseFrontmatter, parseToolsCsv } from '@chimera/core';
import { BUILTIN_AGENTS } from './builtin';
import type { AgentCollision, AgentDefinition, AgentSource, LoadAgentsOptions } from './types';

export interface DiscoverResult {
  agents: AgentDefinition[];
  collisions: AgentCollision[];
}

export { parseToolsCsv };

export function discover(opts: LoadAgentsOptions): DiscoverResult {
  const tiers = buildTiers({
    cwd: opts.cwd,
    modBundles: opts.modBundles,
    userHome: opts.userHome,
    includeClaudeCompat: opts.includeClaudeCompat,
    assetType: 'agents',
    builtinDir: materializeBuiltins('agents', BUILTIN_AGENTS),
  });
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
        source: tier.source as AgentSource,
        frontmatter: parsed.frontmatter,
      };
      const existing = byName.get(name);
      // A definition that replaces a built-in one is the supported way to
      // change it, not a mistake to report.
      if (existing && agent.source === 'builtin') continue;
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
