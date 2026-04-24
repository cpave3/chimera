import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseFrontmatter } from './frontmatter';
import type { Command, CommandCollision, CommandSource, LoadCommandsOptions } from './types';

interface Tier {
  source: CommandSource;
  dir: string;
}

/**
 * Build the ordered tier list for command discovery. Order is priority
 * (higher-priority tiers come first; later tiers lose on collision):
 *
 *   1. <cwd>/.chimera/commands/
 *   2. ancestors/.chimera/commands/ (walk up to nearest .git/ or userHome)
 *   3. <userHome>/.chimera/commands/
 *   4. <cwd>/.claude/commands/                       (if includeClaudeCompat)
 *   5. ancestors/.claude/commands/                   (if includeClaudeCompat)
 *   6. <userHome>/.claude/commands/                  (if includeClaudeCompat)
 */
export function buildTiers(opts: LoadCommandsOptions): Tier[] {
  const cwd = resolve(opts.cwd);
  const userHome = resolve(opts.userHome ?? homedir());
  const includeClaudeCompat = opts.includeClaudeCompat !== false;

  const ancestors = ancestorsBetween(cwd, userHome);

  const tiers: Tier[] = [];
  tiers.push({ source: 'project', dir: join(cwd, '.chimera', 'commands') });
  for (const anc of ancestors) {
    tiers.push({ source: 'ancestor', dir: join(anc, '.chimera', 'commands') });
  }
  tiers.push({ source: 'user', dir: join(userHome, '.chimera', 'commands') });

  if (includeClaudeCompat) {
    tiers.push({ source: 'claude-project', dir: join(cwd, '.claude', 'commands') });
    for (const anc of ancestors) {
      tiers.push({ source: 'claude-ancestor', dir: join(anc, '.claude', 'commands') });
    }
    tiers.push({ source: 'claude-user', dir: join(userHome, '.claude', 'commands') });
  }

  return tiers;
}

/**
 * Walk from `start`'s parent up toward the nearest .git/ marker (or `stopAt`),
 * returning intermediate ancestor directories. The ancestor walk itself
 * terminates at the git root or `stopAt`, whichever comes first; `stopAt` is
 * included only if no git root is found.
 */
function ancestorsBetween(start: string, stopAt: string): string[] {
  const out: string[] = [];
  let dir = start;
  const seen = new Set<string>();
  while (true) {
    const parent = dirname(dir);
    if (parent === dir || seen.has(parent)) break;
    seen.add(parent);

    // If `dir` itself is a git root, stop before going further.
    if (isGitRoot(dir)) break;

    // Skip cwd itself (that's tier 1); include intermediate ancestors.
    if (parent !== start) out.push(parent);
    if (parent === stopAt) break;
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

export interface DiscoverResult {
  commands: Command[];
  collisions: CommandCollision[];
}

/**
 * Scan all tiers, returning the winning Command per name plus a collision
 * report (higher-tier-wins).
 */
export function discover(opts: LoadCommandsOptions): DiscoverResult {
  const tiers = buildTiers(opts);
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
        source: tier.source,
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

interface DiscoveredFile {
  absPath: string;
  /** Path relative to the tier root, using forward slashes. */
  relPath: string;
}

/**
 * Yield every `.md` file under `root`, recursing into subdirectories. Symlinks
 * are followed via `statSync` so namespace dirs created as symlinks still
 * resolve. Missing or unreadable dirs are silently skipped (consistent with
 * the single-tier semantics of the old flat scan).
 */
function* walkMarkdownFiles(root: string): Generator<DiscoveredFile> {
  const stack: Array<{ dir: string; rel: string }> = [{ dir: root, rel: '' }];
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const nextRel = rel ? `${rel}/${ent.name}` : ent.name;
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        try {
          const st = statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        stack.push({ dir: abs, rel: nextRel });
        continue;
      }
      if (isFile && ent.name.endsWith('.md')) {
        yield { absPath: abs, relPath: nextRel };
      }
    }
  }
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
