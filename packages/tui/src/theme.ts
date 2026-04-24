export interface Theme {
  primary?: string;
  secondary?: string;
  muted?: string;
  success?: string;
  danger?: string;
  badge?: string;
  accent?: string;
}

const COLORED_THEME: Theme = {
  primary: 'cyan',
  secondary: 'blueBright',
  muted: 'gray',
  success: 'green',
  danger: 'red',
  badge: 'yellow',
  accent: 'magenta',
};

const PLAIN_THEME: Theme = {};

export function buildTheme(): Theme {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return PLAIN_THEME;
  }
  return COLORED_THEME;
}
