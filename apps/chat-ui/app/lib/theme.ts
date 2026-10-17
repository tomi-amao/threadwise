/**
 * Theme preference. Stored in a cookie (not localStorage) so the server can render the
 * correct `<html class>` on the first byte; localStorage is only readable after
 * hydration, which flashed the wrong theme.
 *
 * Light is the default. There is one Light/Dark toggle and no "System" option.
 */

export type Theme = 'light' | 'dark';

export const THEME_COOKIE = 'tw-theme';
export const DEFAULT_THEME: Theme = 'light';

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** Reads the theme from a Cookie header (server) or document.cookie (client). */
export function parseTheme(cookieHeader: string | null | undefined): Theme {
  if (!cookieHeader) return DEFAULT_THEME;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === THEME_COOKIE) {
      const value = decodeURIComponent(rest.join('='));
      return isTheme(value) ? value : DEFAULT_THEME;
    }
  }
  return DEFAULT_THEME;
}

/** Client only. One year, whole site. */
export function writeThemeCookie(theme: Theme) {
  document.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
