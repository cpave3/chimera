import type {
  AccentTokens,
  BaseTokens,
  StatusTokens,
  SurfaceTokens,
  SyntaxTokens,
  TextTokens,
  Theme,
  UITokens,
} from './types';

export const defaultBaseTokens: BaseTokens = {
  foreground: 'white',
};

export const defaultAccentTokens: AccentTokens = {
  primary: 'cyan',
  secondary: 'blueBright',
  tertiary: 'magenta',
};

export const defaultStatusTokens: StatusTokens = {
  success: 'green',
  warning: 'yellow',
  error: 'red',
  info: 'blue',
  successBg: '#0f3a14',
  errorBg: '#3a1212',
};

export const defaultTextTokens: TextTokens = {
  primary: 'white',
  secondary: 'whiteBright',
  muted: 'gray',
};

export const defaultUITokens: UITokens = {
  badge: 'yellow',
  accent: 'magenta',
};

export const defaultSyntaxTokens: SyntaxTokens = {
  keyword: 'magenta',
  string: 'green',
  comment: 'gray',
  number: 'yellow',
  function: 'blueBright',
  type: 'cyan',
};

export const defaultSurfaceTokens: SurfaceTokens = {};

/** ANSI colour names, so the inline layout follows the terminal's own palette. */
export const defaultTheme: Theme = {
  base: defaultBaseTokens,
  accent: defaultAccentTokens,
  status: defaultStatusTokens,
  text: defaultTextTokens,
  ui: defaultUITokens,
  syntax: defaultSyntaxTokens,
  surface: defaultSurfaceTokens,
};

/**
 * The fullscreen layout paints its own background, so every colour is
 * explicit and tuned against that background.
 */
export const fullscreenTheme: Theme = {
  base: { background: '#1f1d27', foreground: '#dcd9e6' },
  accent: { primary: '#b79cf7', secondary: '#7aa7ff', tertiary: '#e6d76a' },
  status: {
    success: '#8fd18b',
    warning: '#e6d76a',
    error: '#f08a8a',
    info: '#7aa7ff',
    successBg: '#1f3326',
    errorBg: '#3a2228',
  },
  text: { primary: '#dcd9e6', secondary: '#ffffff', muted: '#7d7896', dim: '#57536a' },
  ui: { badge: '#f0b35a', accent: '#b79cf7' },
  syntax: {
    keyword: '#b79cf7',
    string: '#8fd18b',
    comment: '#7d7896',
    number: '#f0b35a',
    function: '#7aa7ff',
    type: '#e6d76a',
  },
  surface: { panel: '#1b1a22', raised: '#26232f', sunken: '#2c2937', border: '#3a3648' },
};

// NO_COLOR mode: every token resolves to 'white' (or 'gray' for muted) so the
// terminal renders nothing as colour-coded — pure text hierarchy via dim/bold.
export const plainTheme: Theme = {
  base: { foreground: 'white' },
  accent: { primary: 'white', secondary: 'white' },
  status: { success: 'white', warning: 'white', error: 'white' },
  text: { primary: 'white', secondary: 'white', muted: 'gray' },
  ui: { badge: 'white', accent: 'white' },
  syntax: {
    keyword: 'white',
    string: 'white',
    comment: 'gray',
    number: 'white',
    function: 'white',
    type: 'white',
  },
  surface: {},
};
