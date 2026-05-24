import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTiers, parseFrontmatter, parseToolsCsv } from '@chimera/core';
import { colorFor, isValidHex } from './color';
import type { LoadModesOptions, Mode, ModeCollision, ModeSource } from './types';

export interface DiscoverResult {
  modes: Mode[];
  collisions: ModeCollision[];
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
    const candidate = join(here, '..', 'builtin');
    const st = statSync(candidate);
    if (st.isDirectory()) return candidate;
  } catch {
    // ignore
  }
  return undefined;
}

export function discover(opts: LoadModesOptions): DiscoverResult {
  const tiers = buildTiers({
    cwd: opts.cwd,
    userHome: opts.userHome,
    includeClaudeCompat: opts.includeClaudeCompat,
    assetType: 'modes',
    builtinDir: builtinModesDir(),
  });
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

      // Validate cycle boolean if present.
      let cycleParsed: boolean | undefined;
      const cycleRaw = fm.cycle;
      if (cycleRaw !== undefined) {
        const lower = cycleRaw.toLowerCase();
        if (lower === 'true' || lower === 'yes') cycleParsed = true;
        else if (lower === 'false' || lower === 'no') cycleParsed = false;
        else warn(`modes: ${filePath} — cycle: expected boolean, got "${cycleRaw}"`);
      }

      // Validate inline tools array if present.
      let toolsParsed: string[] | undefined;
      const toolsRaw = fm.tools;
      if (toolsRaw !== undefined) {
        const trimmed = toolsRaw.trim();
        if (trimmed.length === 0) {
          // Handle empty value followed by block-list form not supported in core parser.
          // The subagent/skills block scalar `|` form works via parseFrontmatter,
          // but the mode-specific indented-list form is handled here.
          toolsParsed = parseToolsCsv(toolsRaw);
        } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          const inner = trimmed.slice(1, -1).trim();
          if (inner.length === 0) {
            toolsParsed = [];
          } else {
            toolsParsed = inner.split(',').map((item) => unquote(item.trim()));
          }
        } else if (/^\s*-\s*/.test(trimmed)) {
          // Single-line `- item` not expected; treat as CSV.
          toolsParsed = parseToolsCsv(toolsRaw);
        } else {
          toolsParsed = parseToolsCsv(toolsRaw);
        }
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

      let rawColor: string | undefined = fm.color;
      if (rawColor !== undefined && !isValidHex(rawColor)) {
        warn(`modes: ${filePath} has invalid color "${rawColor}"; falling back to derived color`);
        rawColor = undefined;
      }
      const colorHex = colorFor(name, rawColor);

      const mode: Mode = {
        name,
        description,
        body: parsed.body,
        tools: toolsParsed,
        model: fm.model,
        rawColor,
        colorHex,
        path: filePath,
        source: tier.source as ModeSource,
        cycle: cycleParsed ?? true,
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
