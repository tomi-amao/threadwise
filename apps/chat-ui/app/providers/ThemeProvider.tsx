import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { writeThemeCookie, type Theme } from '~/lib/theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * `initialTheme` comes from the server (the cookie), so the first render already matches
 * what the server put on `<html>`. Changing the theme updates the class immediately and
 * persists the cookie; no reload or revalidation is needed.
 */
export function ThemeProvider({
  initialTheme,
  children,
}: {
  initialTheme: Theme;
  children: React.ReactNode;
}) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    writeThemeCookie(next);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
