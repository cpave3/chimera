import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTiers, parseFrontmatter } from '@chimera/core';
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

const TOOL_ENTRY = /^([\w-]+)\s*(?:\(([^)]*)\))?$/;

/**
 * Parse a mode's tool list: names separated by commas, each with an
 * optional limit, as in `read, spawn_agent(explore, review)`. A comma inside
 * the parentheses belongs to the limit. Names are lowercased; a name given
 * twice counts once.
 */
export function parseToolEntries(raw: string): {
  tools: string[];
  limits: Record<string, string[]>;
} {
  const entries: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of raw) {
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) {
      entries.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  entries.push(current);

  const tools: string[] = [];
  const limits: Record<string, string[]> = {};
  for (const entry of entries) {
    const match = TOOL_ENTRY.exec(unquote(entry.trim()));
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    if (!tools.includes(name)) tools.push(name);
    if (match[2] !== undefined) {
      limits[name] = match[2]
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '');
    }
  }
  return { tools, limits };
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

      // `tools` is a list of names, each with an optional limit in parentheses.
      let toolsParsed: string[] | undefined;
      let toolLimits: Record<string, string[]> | undefined;
      const toolsRaw = fm.tools;
      if (toolsRaw !== undefined) {
        const trimmed = toolsRaw.trim();
        const inner =
          trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
        const parsedTools = parseToolEntries(inner);
        toolsParsed = parsedTools.tools;
        if (Object.keys(parsedTools.limits).length > 0) toolLimits = parsedTools.limits;
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
        toolLimits,
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
