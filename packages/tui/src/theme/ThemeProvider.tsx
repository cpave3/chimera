import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { toLegacyTheme } from './legacy';
import { resolveTheme } from './loader';
import { BUILTIN_THEMES } from './palette';
import type { Theme, ThemeContextValue } from './types';

const defaultTheme = toLegacyTheme(BUILTIN_THEMES.default, false);

const ThemeContext = createContext<ThemeContextValue>({
  theme: defaultTheme,
  isUserTheme: false,
  activeName: undefined,
  reload: () => undefined,
});

export interface ThemeProviderProps {
  theme?: Theme;
  isUserTheme?: boolean;
  activeName?: string;
  /** Override the disk path read by `reload()`. Tests pass a temp file. */
  themePath?: string;
  children: React.ReactNode;
}

interface ThemeState {
  theme: Theme;
  isUserTheme: boolean;
  activeName: string | undefined;
}

export function ThemeProvider({
  theme = defaultTheme,
  isUserTheme = false,
  activeName,
  themePath,
  children,
}: ThemeProviderProps): React.ReactElement {
  const [state, setState] = useState<ThemeState>({
    theme,
    isUserTheme,
    activeName,
  });

  const reload = useCallback(() => {
    const resolved = resolveTheme({ themePath });
    setState({
      theme: toLegacyTheme(resolved.tokens, resolved.style.level === 'none'),
      isUserTheme: resolved.isUserTheme,
      activeName: resolved.activeName,
    });
  }, [themePath]);

  const value = useMemo<ThemeContextValue>(() => ({ ...state, reload }), [state, reload]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext).theme;
}

/** Full context — needed by `/theme` to invoke `reload()` and read `activeName`. */
export function useThemeContext(): ThemeContextValue {
  return useContext(ThemeContext);
}

export { ThemeContext };
