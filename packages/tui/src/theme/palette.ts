/**
 * The semantic colour tokens every line component draws with. A value is an
 * ANSI colour name, which follows the terminal's own palette, `default` for
 * the terminal's own foreground, or `#rrggbb`.
 */
export const THEME_TOKENS = [
  'text',
  'muted',
  'dim',
  'accent',
  'info',
  'success',
  'warning',
  'error',
  'diffAdd',
  'diffRemove',
  'keyword',
  'string',
  'number',
  'comment',
  'function',
  'type',
] as const;

/** Background tints for added and removed diff rows: the only backgrounds a theme paints. */
export const DIFF_TINT_TOKENS = ['diffAddBg', 'diffRemoveBg'] as const;

export type ColorToken = (typeof THEME_TOKENS)[number];
export type DiffTintToken = (typeof DIFF_TINT_TOKENS)[number];
export type SyntaxToken = 'keyword' | 'string' | 'number' | 'comment' | 'function' | 'type';

export const ANSI_COLOR_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export type AnsiColorName = (typeof ANSI_COLOR_NAMES)[number];
export type ColorValue = AnsiColorName | 'default' | `#${string}`;

export type ThemeTokens = Record<ColorToken, ColorValue> &
  Partial<Record<DiffTintToken, ColorValue>>;

export type PartialThemeTokens = Partial<ThemeTokens>;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isColorValue(value: unknown): value is ColorValue {
  return (
    typeof value === 'string' &&
    (value === 'default' ||
      (ANSI_COLOR_NAMES as readonly string[]).includes(value) ||
      HEX_COLOR.test(value))
  );
}

export function isThemeToken(name: string): name is ColorToken | DiffTintToken {
  return (
    (THEME_TOKENS as readonly string[]).includes(name) ||
    (DIFF_TINT_TOKENS as readonly string[]).includes(name)
  );
}

/** The terminal's own 16 colours; the background is never painted. */
const defaultTheme: ThemeTokens = {
  text: 'default',
  muted: 'brightBlack',
  dim: 'brightBlack',
  accent: 'magenta',
  info: 'blue',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  diffAdd: 'green',
  diffRemove: 'red',
  keyword: 'magenta',
  string: 'green',
  number: 'yellow',
  comment: 'brightBlack',
  function: 'blue',
  type: 'cyan',
};

/** The tuned palette of the Ledger prototype, with tints behind diff rows. */
const chimeraTheme: ThemeTokens = {
  text: '#dcdae4',
  muted: '#8b879c',
  dim: '#5e5a6e',
  accent: '#b79cf7',
  info: '#7aa7ff',
  success: '#8fd18b',
  warning: '#e6c46a',
  error: '#f08a8a',
  diffAdd: '#8fd18b',
  diffRemove: '#f08a8a',
  diffAddBg: '#213826',
  diffRemoveBg: '#3d2329',
  keyword: '#b79cf7',
  string: '#8fd18b',
  number: '#f0b35a',
  comment: '#8b879c',
  function: '#7aa7ff',
  type: '#e6c46a',
};

export const BUILTIN_THEMES = { default: defaultTheme, chimera: chimeraTheme } as const;

export type BuiltinThemeName = keyof typeof BUILTIN_THEMES;
