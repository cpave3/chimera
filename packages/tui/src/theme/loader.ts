import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUILTIN_PRESETS } from './presets';
import { defaultTheme, plainTheme } from './tokens';
import type { PartialTheme, Theme } from './types';

// NO_COLOR spec: any non-empty value disables color. Empty string is ignored.
export function pickBaseTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  const v = env.NO_COLOR;
  return v !== undefined && v !== '' ? plainTheme : defaultTheme;
}

export function getDefaultThemePath(): string {
  return join(homedir(), '.chimera', 'theme.json');
}

/** User-defined preset directory; sibling of `theme.json`. */
export function getUserPresetsDir(): string {
  return join(homedir(), '.chimera', 'themes');
}

function mergeGroup<T extends object>(target: T, source?: Partial<T>): T {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ...target };
  }
  const out: T = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const v = source[key];
    if (v !== undefined) out[key] = v as T[keyof T];
  }
  return out;
}

export function deepMerge(base: Theme, user: PartialTheme): Theme {
  return {
    base: mergeGroup(base.base, user.base),
    accent: mergeGroup(base.accent, user.accent),
    status: mergeGroup(base.status, user.status),
    text: mergeGroup(base.text, user.text),
    ui: mergeGroup(base.ui, user.ui),
  };
}

export type LoadResult =
  | { kind: 'ok'; theme: PartialTheme; activeName?: string }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

const KNOWN_GROUPS = new Set(['base', 'accent', 'status', 'text', 'ui']);

export function loadUserTheme(themePath: string): LoadResult {
  if (!existsSync(themePath)) {
    return { kind: 'missing' };
  }

  let content: string;
  try {
    content = readFileSync(themePath, 'utf-8');
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { kind: 'error', message: `invalid JSON: ${(err as Error).message}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'error', message: 'theme must be a JSON object' };
  }

  const theme: PartialTheme = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (KNOWN_GROUPS.has(key)) {
      (theme as Record<string, unknown>)[key] = value;
    }
  }
  const rawName = (parsed as Record<string, unknown>)._themeName;
  const activeName = typeof rawName === 'string' ? rawName : undefined;
  return { kind: 'ok', theme, activeName };
}

export function buildTheme(baseTheme: Theme, userThemePath?: string): Theme {
  const themePath = userThemePath ?? getDefaultThemePath();
  const result = loadUserTheme(themePath);
  return result.kind === 'ok' ? deepMerge(baseTheme, result.theme) : baseTheme;
}

export interface ThemeListing {
  name: string;
  source: 'builtin' | 'user';
  active: boolean;
}

export interface ListThemesOptions {
  presetsDir?: string;
  themePath?: string;
}

/**
 * Enumerate available themes — bundled presets plus any `*.json` files
 * under `~/.chimera/themes/`. A user file with the same stem as a builtin
 * shadows it (and is reported as `source: 'user'`). Active is determined
 * by the `_themeName` marker written by `applyThemeByName`.
 */
export function listThemes(opts: ListThemesOptions = {}): ThemeListing[] {
  const presetsDir = opts.presetsDir ?? getUserPresetsDir();
  const themePath = opts.themePath ?? getDefaultThemePath();

  const result = loadUserTheme(themePath);
  const active = result.kind === 'ok' ? result.activeName : undefined;

  const names = new Map<string, 'builtin' | 'user'>();
  for (const name of Object.keys(BUILTIN_PRESETS)) names.set(name, 'builtin');
  if (existsSync(presetsDir)) {
    for (const entry of readdirSync(presetsDir)) {
      if (!entry.endsWith('.json')) continue;
      names.set(entry.slice(0, -'.json'.length), 'user');
    }
  }

  return Array.from(names, ([name, source]) => ({
    name,
    source,
    active: name === active,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface ApplyThemeResult {
  /** Absolute path of the source preset that was applied. */
  source: string;
  /** Resolved provenance of the preset. */
  origin: 'builtin' | 'user';
}

/**
 * Resolve a preset by name (user dir wins over builtin), serialise it to
 * `theme.json` with a `_themeName` marker, and return what was applied.
 * The TUI calls `useTheme().reload()` afterwards to pick up the change.
 */
export function applyThemeByName(
  name: string,
  opts: ListThemesOptions = {},
): ApplyThemeResult {
  const presetsDir = opts.presetsDir ?? getUserPresetsDir();
  const themePath = opts.themePath ?? getDefaultThemePath();

  const userPath = join(presetsDir, `${name}.json`);
  let partial: PartialTheme;
  let origin: 'builtin' | 'user';
  let source: string;

  if (existsSync(userPath)) {
    const r = loadUserTheme(userPath);
    if (r.kind !== 'ok') {
      throw new Error(`theme '${name}' at ${userPath}: ${describeLoadFailure(r)}`);
    }
    partial = r.theme;
    origin = 'user';
    source = userPath;
  } else if (Object.prototype.hasOwnProperty.call(BUILTIN_PRESETS, name)) {
    partial = BUILTIN_PRESETS[name]!;
    origin = 'builtin';
    source = `builtin:${name}`;
  } else {
    throw new Error(
      `unknown theme '${name}'. Run /theme to see available themes.`,
    );
  }

  const payload: Record<string, unknown> = { _themeName: name, ...partial };
  mkdirSync(dirname(themePath), { recursive: true });
  writeFileSync(themePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  return { source, origin };
}

function describeLoadFailure(r: LoadResult): string {
  if (r.kind === 'error') return r.message;
  if (r.kind === 'missing') return 'file missing';
  return 'unknown';
}
