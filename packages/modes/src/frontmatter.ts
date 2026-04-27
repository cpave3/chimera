export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  tools?: string[];
  model?: string;
  color?: string;
  /** Surfaced separately so callers can warn on parse failures. */
  errors: string[];
}

export interface ParsedDocument {
  frontmatter: ParsedFrontmatter;
  body: string;
}

/**
 * Parse an optional `---`-delimited YAML frontmatter for mode files. Accepts a
 * narrow subset: scalar string fields plus an inline-array form for `tools`
 * (`tools: [read, write]`). A block-list form (`tools:` then indented `- read`
 * lines) is also accepted for parity with hand-written YAML.
 */
export function parseFrontmatter(source: string): ParsedDocument {
  const errors: string[] = [];
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: { errors }, body: source };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) {
    errors.push('frontmatter "---" closing fence not found');
    return { frontmatter: { errors }, body: source };
  }

  const fm: ParsedFrontmatter = { errors };
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

    if (key === 'tools') {
      if (raw.length === 0) {
        // Block-list form: collect indented `- item` lines that follow.
        const items: string[] = [];
        while (i < end) {
          const next = lines[i]!;
          if (!/^\s+-\s*/.test(next)) break;
          const item = next.replace(/^\s+-\s*/, '').trim();
          if (item.length > 0) items.push(unquote(item));
          i += 1;
        }
        fm.tools = items;
      } else if (raw.startsWith('[') && raw.endsWith(']')) {
        const inner = raw.slice(1, -1).trim();
        if (inner.length === 0) {
          fm.tools = [];
        } else {
          fm.tools = inner.split(',').map((entry) => unquote(entry.trim()));
        }
      } else {
        errors.push(`tools: expected array, got "${raw}"`);
      }
      continue;
    }

    const value = unquote(raw);
    if (key === 'name') fm.name = value;
    else if (key === 'description') fm.description = value;
    else if (key === 'model') fm.model = value;
    else if (key === 'color') fm.color = value;
    // Unknown keys are ignored — additional keys may land in future revisions.
  }

  const body = lines.slice(end + 1).join('\n');
  return { frontmatter: fm, body };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
