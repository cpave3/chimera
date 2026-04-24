export interface ParsedDocument {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Parse an optional `---`-delimited YAML frontmatter. Supports a flat mapping
 * of `key: value` pairs (scalar values only). Quoted values (single or double)
 * are unquoted. If no `---` fence is present, the frontmatter is empty and the
 * body is the whole input.
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
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]!;
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const raw = line.slice(colon + 1).trim();
    frontmatter[key] = unquote(raw);
  }

  const body = lines.slice(end + 1).join('\n');
  return { frontmatter, body };
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
