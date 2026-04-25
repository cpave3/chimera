import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  deepMerge,
  getDefaultThemePath,
  loadUserTheme,
  pickBaseTheme,
} from './loader';
import { defaultTheme } from './tokens';
import type { Theme, ThemeContextValue } from './types';

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
    const base = pickBaseTheme();
    const path = themePath ?? getDefaultThemePath();
    const result = loadUserTheme(path);
    if (result.kind === 'ok') {
      setState({
        theme: deepMerge(base, result.theme),
        isUserTheme: true,
        activeName: result.activeName,
      });
    } else {
      setState({ theme: base, isUserTheme: false, activeName: undefined });
    }
  }, [themePath]);

  const value = useMemo<ThemeContextValue>(
    () => ({ ...state, reload }),
    [state, reload],
  );
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
