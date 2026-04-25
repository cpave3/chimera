import type { AccentTokens, BaseTokens, StatusTokens, TextTokens, Theme, UITokens } from './types';

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

export const defaultTheme: Theme = {
  base: defaultBaseTokens,
  accent: defaultAccentTokens,
  status: defaultStatusTokens,
  text: defaultTextTokens,
  ui: defaultUITokens,
};

// NO_COLOR mode: every token resolves to 'white' (or 'gray' for muted) so the
// terminal renders nothing as colour-coded — pure text hierarchy via dim/bold.
export const plainTheme: Theme = {
  base: { foreground: 'white' },
  accent: { primary: 'white', secondary: 'white' },
  status: { success: 'white', warning: 'white', error: 'white' },
  text: { primary: 'white', secondary: 'white', muted: 'gray' },
  ui: { badge: 'white', accent: 'white' },
};
