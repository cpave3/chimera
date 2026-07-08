import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface ParsedDocument {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Parse an optional `---`-delimited YAML frontmatter. Supports a flat mapping
 * of `key: value` pairs (scalar values only). Quoted values (single or double)
 * are unquoted. Block scalars (`|`, `>`, `|-`, `>-`, `|+`, `>+`) are supported.
 * If no `---` fence is present, the frontmatter is empty and the body is the
 * whole input.
 */
export function parseFrontmatter(source: string): ParsedDocument {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: source };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return { frontmatter: {}, body: source };
  }

  const frontmatter: Record<string, string> = {};
  let i = 1;
  while (i < end) {
    const line = lines[i]!;
    i += 1;
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const raw = line.slice(colon + 1).trim();

    // Block scalar indicators: `|`, `|-`, `|+` (literal — keep newlines);
    // `>`, `>-`, `>+` (folded — collapse consecutive lines with spaces).
    const blockMatch = /^([|>])([+-]?)$/.exec(raw);
    if (blockMatch) {
      const style = blockMatch[1]!; // '|' or '>'
      const collected: string[] = [];
      while (i < end) {
        const next = lines[i]!;
        // Block ends at the first non-blank line that isn't indented more
        // than the key (frontmatter keys sit at column 0).
        if (next.length > 0 && !next.startsWith(' ') && !next.startsWith('\t')) {
          break;
        }
        collected.push(next);
        i += 1;
      }
      // Strip common leading indentation and collapse per style.
      const indent = minIndent(collected);
      const stripped = collected.map((l) => l.slice(indent));
      frontmatter[key] =
        style === '|' ? stripped.join('\n').replace(/\s+$/, '') : foldLines(stripped);
      continue;
    }

    frontmatter[key] = unquote(raw);
  }

  const body = lines.slice(end + 1).join('\n');
  return { frontmatter, body };
}

function minIndent(lines: string[]): number {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    let n = 0;
    while (n < l.length && (l[n] === ' ' || l[n] === '\t')) n += 1;
    if (n < min) min = n;
  }
  return Number.isFinite(min) ? min : 0;
}

/**
 * YAML folded-scalar collapse: join consecutive non-empty lines with a space,
 * preserve paragraph breaks (blank line → newline).
 */
function foldLines(lines: string[]): string {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      out.push(current.join(' '));
      current = [];
    }
  };
  for (const l of lines) {
    if (l.trim().length === 0) {
      flush();
      out.push('');
    } else {
      current.push(l.trim());
    }
  }
  flush();
  return out.join('\n').replace(/\s+$/, '');
}

function unquote(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

export interface Tier {
  source: string;
  dir: string;
}

export interface BuildTiersOptions {
  cwd: string;
  userHome?: string;
  includeClaudeCompat?: boolean;
  /**
   * When true, append three `.agents/` tiers (project / ancestor / user-home)
   * after the `.claude/` tiers, as a cross-tool compatibility root analogous
   * to `.claude/`. Defaults to false.
   */
  includeAgentsCompat?: boolean;
  /** Subdirectory name under `.chimera/` and `.claude/`, e.g. 'commands', 'skills'. */
  assetType: string;
  /** If provided, appended as the lowest-priority tier. */
  builtinDir?: string;
}

/**
 * Build the ordered tier list for asset discovery. Order is priority
 * (higher-priority tiers come first; later tiers lose on collision):
 *
 *   1. <cwd>/.chimera/<assetType>/
 *   2. ancestors/.chimera/<assetType>/ (walk up to nearest .git/ or userHome)
 *   3. <userHome>/.chimera/<assetType>/
 *   4. <cwd>/.claude/<assetType>/                       (if includeClaudeCompat)
 *   5. ancestors/.claude/<assetType>/                   (if includeClaudeCompat)
 *   6. <userHome>/.claude/<assetType>/                  (if includeClaudeCompat)
 *   7. <cwd>/.agents/<assetType>/                        (if includeAgentsCompat)
 *   8. ancestors/.agents/<assetType>/                    (if includeAgentsCompat)
 *   9. <userHome>/.agents/<assetType>/                   (if includeAgentsCompat)
 *  10. <builtinDir>                                     (if provided)
 */
export function buildTiers(opts: BuildTiersOptions): Tier[] {
  const cwd = resolve(opts.cwd);
  const userHome = resolve(opts.userHome ?? homedir());
  const includeClaudeCompat = opts.includeClaudeCompat !== false;
  const includeAgentsCompat = opts.includeAgentsCompat === true;
  const assetType = opts.assetType;

  const ancestors = ancestorsBetween(cwd, userHome);

  const tiers: Tier[] = [];
  tiers.push({ source: 'project', dir: join(cwd, '.chimera', assetType) });
  for (const anc of ancestors) {
    tiers.push({ source: 'ancestor', dir: join(anc, '.chimera', assetType) });
  }
  tiers.push({ source: 'user', dir: join(userHome, '.chimera', assetType) });

  if (includeClaudeCompat) {
    tiers.push({ source: 'claude-project', dir: join(cwd, '.claude', assetType) });
    for (const anc of ancestors) {
      tiers.push({ source: 'claude-ancestor', dir: join(anc, '.claude', assetType) });
    }
    tiers.push({ source: 'claude-user', dir: join(userHome, '.claude', assetType) });
  }

  if (includeAgentsCompat) {
    tiers.push({ source: 'agents-project', dir: join(cwd, '.agents', assetType) });
    for (const anc of ancestors) {
      tiers.push({ source: 'agents-ancestor', dir: join(anc, '.agents', assetType) });
    }
    tiers.push({ source: 'agents-user', dir: join(userHome, '.agents', assetType) });
  }

  if (opts.builtinDir) {
    tiers.push({ source: 'builtin', dir: opts.builtinDir });
  }

  return tiers;
}

/**
 * Walk from `start`'s parent up toward the nearest .git/ marker (or `stopAt`
 * if no git root is found). Returns intermediate directories (exclusive of
 * `start`, exclusive of `stopAt`).
 */
export function ancestorsBetween(start: string, stopAt: string): string[] {
  const out: string[] = [];
  let dir = start;
  const seen = new Set<string>();
  while (true) {
    const parent = dirname(dir);
    if (parent === dir || seen.has(parent)) break;
    seen.add(parent);

    if (isGitRoot(dir)) break;

    // Stop at userHome without including it — the dedicated `user` tier
    // handles `<userHome>/.chimera/<asset>/` directly.
    if (parent === stopAt) break;
    if (parent !== start) out.push(parent);
    dir = parent;
    if (isGitRoot(dir)) break;
  }
  return out;
}

export function isGitRoot(dir: string): boolean {
  try {
    const st = statSync(join(dir, '.git'));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

export interface DiscoveredFile {
  absPath: string;
  /** Path relative to the tier root, using forward slashes. */
  relPath: string;
}

/**
 * Yield every `.md` file under `root`, recursing into subdirectories. Symlinks
 * are followed via `statSync` so dirs created as symlinks still resolve.
 * Missing or unreadable dirs are silently skipped.
 */
export function* walkMarkdownFiles(root: string): Generator<DiscoveredFile> {
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
 * Parse a comma-separated tools list (e.g. `Read, Grep, Glob, Bash`).
 * Returns lowercased, trimmed, deduplicated names. Empty input yields an
 * empty array.
 */
export function parseToolsCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
