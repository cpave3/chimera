import {
  ANSI_COLOR_NAMES,
  type AnsiColorName,
  type ColorToken,
  type ColorValue,
  type ThemeTokens,
} from './palette';

/** How many colours the terminal shows; `none` under `NO_COLOR`. */
export type ColorLevel = 'none' | 'ansi16' | 'ansi256' | 'truecolor';

/** NO_COLOR wins; then what COLORTERM and TERM say. */
export function detectColorLevel(env: NodeJS.ProcessEnv = process.env): ColorLevel {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')) return 'truecolor';
  if (/256col/i.test(env.TERM ?? '')) return 'ansi256';
  return 'ansi16';
}

/**
 * Foreground-only styling for a theme. Each helper closes with the reset of
 * its own attribute (`39m`, `22m`, `23m`, ...), never `0m`, so styles nest
 * inside a line without ending the styles around them.
 */
export interface Style {
  readonly level: ColorLevel;
  readonly tokens: ThemeTokens;
  /** The theme sets both diff tints and the terminal can show them. */
  readonly hasDiffTints: boolean;
  fg(token: ColorToken, text: string): string;
  /** A colour that is not a theme token, such as a mode's own colour. */
  color(value: ColorValue | undefined, text: string): string;
  diffBg(kind: 'add' | 'remove', text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  inverse(text: string): string;
  underline(text: string): string;
}

const ESC = '\x1b[';

// Under NO_COLOR the hierarchy stays: quiet tokens dim, loud ones bold.
const DIM_WITHOUT_COLOR = new Set<ColorToken>(['muted', 'dim', 'comment']);
const BOLD_WITHOUT_COLOR = new Set<ColorToken>(['accent', 'error', 'warning']);

// xterm's 16-colour palette, for placing a hex colour on a 16-colour terminal.
const ANSI_INDEX: Record<AnsiColorName, number> = Object.fromEntries(
  ANSI_COLOR_NAMES.map((name, index) => [name, index]),
) as Record<AnsiColorName, number>;

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** The xterm 256-colour entry closest to `hex`: from the 6×6×6 cube or the grey ramp. */
export function nearest256(hex: string): number {
  const [red, green, blue] = rgb(hex);
  const level = (channel: number) =>
    CUBE_LEVELS.reduce(
      (best, candidate, index) =>
        Math.abs(candidate - channel) < Math.abs(CUBE_LEVELS[best]! - channel) ? index : best,
      0,
    );
  const [cubeRed, cubeGreen, cubeBlue] = [level(red), level(green), level(blue)];
  const cubeDistance =
    (CUBE_LEVELS[cubeRed]! - red) ** 2 +
    (CUBE_LEVELS[cubeGreen]! - green) ** 2 +
    (CUBE_LEVELS[cubeBlue]! - blue) ** 2;
  const greyIndex = Math.max(0, Math.min(23, Math.round(((red + green + blue) / 3 - 8) / 10)));
  const grey = 8 + greyIndex * 10;
  const greyDistance = (grey - red) ** 2 + (grey - green) ** 2 + (grey - blue) ** 2;
  return greyDistance < cubeDistance
    ? 232 + greyIndex
    : 16 + 36 * cubeRed + 6 * cubeGreen + cubeBlue;
}

/**
 * The 16-colour entry for `hex`, by hue rather than distance: a pastel red
 * is closer to grey by distance, but it reads as red.
 */
export function nearest16(hex: string): number {
  const [red, green, blue] = rgb(hex);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const bright = max > 191;
  if (max - min < 40) {
    if (max < 64) return ANSI_INDEX.black;
    if (max < 160) return ANSI_INDEX.brightBlack;
    return max < 230 ? ANSI_INDEX.white : ANSI_INDEX.brightWhite;
  }
  let hue: number;
  const span = max - min;
  if (max === red) hue = (((green - blue) / span) % 6) * 60;
  else if (max === green) hue = ((blue - red) / span + 2) * 60;
  else hue = ((red - green) / span + 4) * 60;
  if (hue < 0) hue += 360;
  const base = (['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'] as const)[
    Math.round(hue / 60) % 6
  ]!;
  return ANSI_INDEX[base] + (bright ? 8 : 0);
}

function colorCode(value: ColorValue, level: ColorLevel, layer: 'fg' | 'bg'): string | null {
  if (level === 'none' || value === 'default') return null;
  const ansi = (index: number) =>
    layer === 'fg'
      ? String(index < 8 ? 30 + index : 90 + index - 8)
      : String(index < 8 ? 40 + index : 100 + index - 8);
  if (!value.startsWith('#')) return ansi(ANSI_INDEX[value as AnsiColorName]);
  const prefix = layer === 'fg' ? '38' : '48';
  if (level === 'truecolor') return `${prefix};2;${rgb(value).join(';')}`;
  if (level === 'ansi256') return `${prefix};5;${nearest256(value)}`;
  return ansi(nearest16(value));
}

function wrap(open: string, close: string, text: string): string {
  return text === '' ? '' : `${ESC}${open}m${text}${ESC}${close}m`;
}

export function createStyle(tokens: ThemeTokens, level: ColorLevel): Style {
  const color = (value: ColorValue | undefined, text: string) => {
    const code = value ? colorCode(value, level, 'fg') : null;
    return code ? wrap(code, '39', text) : text;
  };
  const tint = (value: ColorValue | undefined) =>
    value && value !== 'default' ? colorCode(value, level, 'bg') : null;
  const addTint = tint(tokens.diffAddBg);
  const removeTint = tint(tokens.diffRemoveBg);
  const hasDiffTints = addTint !== null && removeTint !== null;
  return {
    level,
    tokens,
    hasDiffTints,
    fg(token, text) {
      if (level === 'none') {
        if (DIM_WITHOUT_COLOR.has(token)) return wrap('2', '22', text);
        if (BOLD_WITHOUT_COLOR.has(token)) return wrap('1', '22', text);
        return text;
      }
      // On 16 colours `dim` and `muted` are often the same grey; faint keeps them apart.
      if (token === 'dim' && level === 'ansi16' && !tokens.dim.startsWith('#')) {
        const code = colorCode(tokens.dim, level, 'fg');
        return code ? wrap(`2;${code}`, '22;39', text) : wrap('2', '22', text);
      }
      return color(tokens[token], text);
    },
    color,
    diffBg(kind, text) {
      if (!hasDiffTints) return text;
      return wrap((kind === 'add' ? addTint : removeTint)!, '49', text);
    },
    bold: (text) => wrap('1', '22', text),
    dim: (text) => wrap('2', '22', text),
    italic: (text) => wrap('3', '23', text),
    inverse: (text) => wrap('7', '27', text),
    underline: (text) => wrap('4', '24', text),
  };
}

/** No escape codes at all: for output that is piped or written to a file. */
export function createPlainStyle(tokens: ThemeTokens): Style {
  const same = (text: string) => text;
  return {
    level: 'none',
    tokens,
    hasDiffTints: false,
    fg: (_token, text) => text,
    color: (_value, text) => text,
    diffBg: (_kind, text) => text,
    bold: same,
    dim: same,
    italic: same,
    inverse: same,
    underline: same,
  };
}
