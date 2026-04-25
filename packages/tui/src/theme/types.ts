/**
 * Color tokens use semantic names ('primary', 'error') rather than literal
 * colors so themes can re-skin by purpose: 'error' is red by default but a
 * high-contrast theme might map it to bright orange.
 */

export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'grey'
  | 'blackBright'
  | 'redBright'
  | 'greenBright'
  | 'yellowBright'
  | 'blueBright'
  | 'magentaBright'
  | 'cyanBright'
  | 'whiteBright'
  | `#${string}`;

export interface BaseTokens {
  background?: AnsiColor;
  foreground: AnsiColor;
}

export interface AccentTokens {
  primary: AnsiColor;
  secondary: AnsiColor;
  tertiary?: AnsiColor;
}

export interface StatusTokens {
  success: AnsiColor;
  warning: AnsiColor;
  error: AnsiColor;
  info?: AnsiColor;
}

export interface TextTokens {
  primary: AnsiColor;
  secondary: AnsiColor;
  muted: AnsiColor;
}

export interface UITokens {
  badge: AnsiColor;
  accent: AnsiColor;
}

export interface Theme {
  base: BaseTokens;
  accent: AccentTokens;
  status: StatusTokens;
  text: TextTokens;
  ui: UITokens;
}

export type PartialTheme = {
  [K in keyof Theme]?: Partial<Theme[K]>;
};

export interface ThemeContextValue {
  theme: Theme;
  isUserTheme: boolean;
  /** Name from `_themeName` marker, when the active theme was set by `/theme <name>`. */
  activeName?: string;
  /** Re-read `theme.json` from disk and refresh the live theme. */
  reload: () => void;
}
