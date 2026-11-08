import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BUILTIN_THEMES,
  DIFF_TINT_TOKENS,
  isColorValue,
  isThemeToken,
  type PartialThemeTokens,
  THEME_TOKENS,
  type ThemeTokens,
} from './palette';
import { type ColorLevel, createStyle, detectColorLevel, type Style } from './style';

export type TuiLayout = 'fullscreen' | 'inline';

export function getDefaultThemePath(): string {
  return join(homedir(), '.chimera', 'theme.json');
}

/** User themes, listed by `/theme`; sibling of `theme.json`. */
export function getUserPresetsDir(): string {
  return join(homedir(), '.chimera', 'themes');
}

export type LoadResult =
  | { kind: 'ok'; theme: PartialThemeTokens; activeName?: string }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

const TOKEN_LIST = [...THEME_TOKENS, ...DIFF_TINT_TOKENS].join(', ');
const COLOR_FORMS = 'an ANSI colour name (red, brightBlack, ...), default, or #rrggbb';

/**
 * Read a theme file: flat tokens, each a colour. Keys starting with `_` are
 * notes (`_comment`) or markers (`_themeName`). The grouped format of
 * earlier versions is refused, not migrated.
 */
export function loadUserTheme(themePath: string): LoadResult {
  if (!existsSync(themePath)) return { kind: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(themePath, 'utf-8'));
  } catch (err) {
    const message = (err as Error).message;
    return {
      kind: 'error',
      message: err instanceof SyntaxError ? `invalid JSON: ${message}` : message,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'error', message: 'theme must be a JSON object' };
  }
  const entries = Object.entries(parsed).filter(([key]) => !key.startsWith('_'));
  if (entries.some(([, value]) => typeof value === 'object' && value !== null)) {
    return {
      kind: 'error',
      message: `${themePath} uses the old grouped theme format, which is no longer read. A theme is now flat tokens: ${TOKEN_LIST}.`,
    };
  }
  const theme: PartialThemeTokens = {};
  for (const [key, value] of entries) {
    if (!isThemeToken(key)) {
      return { kind: 'error', message: `unknown token "${key}"; the tokens are ${TOKEN_LIST}` };
    }
    if (!isColorValue(value)) {
      return {
        kind: 'error',
        message: `${key}: "${String(value)}" is not a colour; use ${COLOR_FORMS}`,
      };
    }
    theme[key] = value;
  }
  const rawName = (parsed as Record<string, unknown>)._themeName;
  return {
    kind: 'ok',
    theme,
    ...(typeof rawName === 'string' ? { activeName: rawName } : {}),
  };
}

export interface ResolvedTheme {
  tokens: ThemeTokens;
  style: Style;
  /** Set when `theme.json` holds a theme of the user's own. */
  isUserTheme: boolean;
  /** Name from the `_themeName` marker that `/theme <name>` writes. */
  activeName?: string;
  /** Why `theme.json` was not used; the default theme stands in. */
  error?: string;
}

/** The theme to draw with: `theme.json` over the default theme, at the terminal's colour level. */
export function resolveTheme(
  options: { themePath?: string; env?: NodeJS.ProcessEnv; level?: ColorLevel } = {},
): ResolvedTheme {
  const level = options.level ?? detectColorLevel(options.env ?? process.env);
  const result = loadUserTheme(options.themePath ?? getDefaultThemePath());
  const tokens: ThemeTokens =
    result.kind === 'ok' ? { ...BUILTIN_THEMES.default, ...result.theme } : BUILTIN_THEMES.default;
  return {
    tokens,
    style: createStyle(tokens, level),
    isUserTheme: result.kind === 'ok',
    ...(result.kind === 'ok' && result.activeName ? { activeName: result.activeName } : {}),
    ...(result.kind === 'error' ? { error: result.message } : {}),
  };
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
 * The shipped themes plus every `*.json` under `~/.chimera/themes/`. A user
 * file shadows a shipped theme of the same name. The active one is the one
 * `/theme <name>` last wrote.
 */
export function listThemes(opts: ListThemesOptions = {}): ThemeListing[] {
  const presetsDir = opts.presetsDir ?? getUserPresetsDir();
  const result = loadUserTheme(opts.themePath ?? getDefaultThemePath());
  const active = result.kind === 'ok' ? result.activeName : undefined;
  const names = new Map<string, 'builtin' | 'user'>();
  for (const name of Object.keys(BUILTIN_THEMES)) names.set(name, 'builtin');
  if (existsSync(presetsDir)) {
    for (const entry of readdirSync(presetsDir)) {
      if (entry.endsWith('.json')) names.set(entry.slice(0, -'.json'.length), 'user');
    }
  }
  return Array.from(names, ([name, source]) => ({ name, source, active: name === active })).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

export interface ApplyThemeResult {
  source: string;
  origin: 'builtin' | 'user';
}

/** Write a theme into `theme.json` with its name as the active marker. */
export function applyThemeByName(name: string, opts: ListThemesOptions = {}): ApplyThemeResult {
  const presetsDir = opts.presetsDir ?? getUserPresetsDir();
  const themePath = opts.themePath ?? getDefaultThemePath();
  const userPath = join(presetsDir, `${name}.json`);
  let theme: PartialThemeTokens;
  let applied: ApplyThemeResult;
  if (existsSync(userPath)) {
    const result = loadUserTheme(userPath);
    if (result.kind !== 'ok') {
      throw new Error(
        `theme '${name}' at ${userPath}: ${result.kind === 'error' ? result.message : 'file missing'}`,
      );
    }
    theme = result.theme;
    applied = { source: userPath, origin: 'user' };
  } else if (Object.hasOwn(BUILTIN_THEMES, name)) {
    theme = BUILTIN_THEMES[name as keyof typeof BUILTIN_THEMES];
    applied = { source: `builtin:${name}`, origin: 'builtin' };
  } else {
    throw new Error(`unknown theme '${name}'. Run /theme to see available themes.`);
  }
  mkdirSync(dirname(themePath), { recursive: true });
  writeFileSync(themePath, `${JSON.stringify({ _themeName: name, ...theme }, null, 2)}\n`, 'utf-8');
  return applied;
}
