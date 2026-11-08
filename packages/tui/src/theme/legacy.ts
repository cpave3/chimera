import type { ColorValue, ThemeTokens } from './palette';
import type { AnsiColor, Theme } from './types';

/** Ink's name for an ANSI colour (`blackBright`), or nothing for the terminal's own. */
function inkColor(value: ColorValue): AnsiColor {
  if (value === 'default') return '' as AnsiColor;
  if (value.startsWith('bright')) {
    const base = value.slice('bright'.length);
    return `${base[0]!.toLowerCase()}${base.slice(1)}Bright` as AnsiColor;
  }
  return value as AnsiColor;
}

/**
 * The grouped theme the Ink views still read, built from the new tokens.
 * Goes when the Ink views do.
 */
export function toLegacyTheme(tokens: ThemeTokens, noColor: boolean): Theme {
  const color = (value: ColorValue) => (noColor ? ('' as AnsiColor) : inkColor(value));
  return {
    base: { foreground: color(tokens.text) },
    accent: { primary: color(tokens.accent), secondary: color(tokens.info) },
    status: {
      success: color(tokens.success),
      warning: color(tokens.warning),
      error: color(tokens.error),
      info: color(tokens.info),
      ...(tokens.diffAddBg && !noColor ? { successBg: color(tokens.diffAddBg) } : {}),
      ...(tokens.diffRemoveBg && !noColor ? { errorBg: color(tokens.diffRemoveBg) } : {}),
    },
    text: {
      primary: color(tokens.text),
      secondary: color(tokens.text),
      muted: color(tokens.muted),
      dim: color(tokens.dim),
    },
    ui: { badge: color(tokens.warning), accent: color(tokens.accent) },
    syntax: {
      keyword: color(tokens.keyword),
      string: color(tokens.string),
      comment: color(tokens.comment),
      number: color(tokens.number),
      function: color(tokens.function),
      type: color(tokens.type),
    },
    surface: {},
  };
}
