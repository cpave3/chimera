import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colorFor, isValidHex } from './color';
import { parseFrontmatter } from './frontmatter';
import type { LoadModesOptions, Mode, ModeCollision, ModeSource } from './types';

interface Tier {
  source: ModeSource;
  dir: string;
}

export interface DiscoverResult {
  modes: Mode[];
  collisions: ModeCollision[];
}

export function buildTiers(opts: LoadModesOptions): Tier[] {
  const cwd = resolve(opts.cwd);
  const userHome = resolve(opts.userHome ?? homedir());
  const includeClaudeCompat = opts.includeClaudeCompat !== false;

  const ancestors = ancestorsBetween(cwd, userHome);

  const tiers: Tier[] = [];
  tiers.push({ source: 'project', dir: join(cwd, '.chimera', 'modes') });
  for (const ancestor of ancestors) {
    tiers.push({ source: 'ancestor', dir: join(ancestor, '.chimera', 'modes') });
  }
  tiers.push({ source: 'user', dir: join(userHome, '.chimera', 'modes') });

  if (includeClaudeCompat) {
    tiers.push({ source: 'claude-project', dir: join(cwd, '.claude', 'modes') });
    for (const ancestor of ancestors) {
      tiers.push({ source: 'claude-ancestor', dir: join(ancestor, '.claude', 'modes') });
    }
    tiers.push({ source: 'claude-user', dir: join(userHome, '.claude', 'modes') });
  }

  const builtinDir = builtinModesDir();
  if (builtinDir) tiers.push({ source: 'builtin', dir: builtinDir });

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
    // handles `<userHome>/.chimera/modes/` directly, so listing it here
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

/**
 * Locate the bundled `builtin/` directory at runtime. The directory ships at
 * `<package-root>/builtin/`, which is `../builtin/` from the compiled
 * `dist/index.js`. During vitest, `import.meta.url` points into `src/`, so
 * `../builtin/` from there also lands on the package root's `builtin/`.
 */
function builtinModesDir(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = resolve(here, '..', 'builtin');
    const st = statSync(candidate);
    if (st.isDirectory()) return candidate;
  } catch {
    // ignore
  }
  return undefined;
}

export function discover(opts: LoadModesOptions): DiscoverResult {
  const tiers = buildTiers(opts);
  const byName = new Map<string, Mode>();
  const collisions: ModeCollision[] = [];
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
      let isFile = false;
      try {
        isFile = statSync(filePath).isFile();
      } catch {
        continue;
      }
      if (!isFile) continue;

      const stem = entry.slice(0, -'.md'.length);
      if (stem.length === 0) continue;

      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const parsed = parseFrontmatter(raw);
      const fm = parsed.frontmatter;
      for (const error of fm.errors) {
        warn(`modes: ${filePath} — ${error}`);
      }

      const name = (fm.name ?? '').trim();
      const description = (fm.description ?? '').trim();
      if (!name || name !== stem) {
        warn(`modes: ${filePath} skipped — frontmatter "name" missing or does not match filename`);
        continue;
      }
      if (!description) {
        warn(`modes: ${filePath} skipped — frontmatter "description" is required`);
        continue;
      }

      let rawColor = fm.color;
      if (rawColor !== undefined && !isValidHex(rawColor)) {
        warn(`modes: ${filePath} has invalid color "${rawColor}"; falling back to derived color`);
        rawColor = undefined;
      }
      const colorHex = colorFor(name, rawColor);

      const mode: Mode = {
        name,
        description,
        body: parsed.body,
        tools: fm.tools,
        model: fm.model,
        rawColor: fm.color,
        colorHex,
        path: filePath,
        source: tier.source,
        cycle: fm.cycle ?? true,
      };

      const existing = byName.get(name);
      if (existing) {
        collisions.push({
          name,
          winner: existing.source,
          loser: mode.source,
          winnerPath: existing.path,
          loserPath: mode.path,
        });
        warn(`modes: "${name}" at ${mode.path} is shadowed by ${existing.path}`);
        continue;
      }
      byName.set(name, mode);
    }
  }

  return { modes: [...byName.values()], collisions };
}
