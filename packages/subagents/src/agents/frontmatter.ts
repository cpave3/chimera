export interface ParsedDocument {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Parse an optional `---`-delimited YAML frontmatter. Supports a flat mapping
 * of `key: value` pairs (scalar values only). Quoted values (single or double)
 * are unquoted. Block scalars (`|`, `>`) are supported. If no `---` fence is
 * present, the frontmatter is empty and the body is the whole input.
 *
 * Forked from @chimera/skills to keep @chimera/subagents free of a workspace
 * dependency on the skills package.
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

    const blockMatch = /^([|>])([+-]?)$/.exec(raw);
    if (blockMatch) {
      const style = blockMatch[1]!;
      const collected: string[] = [];
      while (i < end) {
        const next = lines[i]!;
        if (next.length > 0 && !next.startsWith(' ') && !next.startsWith('\t')) {
          break;
        }
        collected.push(next);
        i += 1;
      }
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

/**
 * Parse a comma-separated tools list as written in agent frontmatter
 * (e.g. `Read, Grep, Glob, Bash`). Returns lowercased, trimmed, deduplicated
 * names. Empty input yields an empty array.
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
