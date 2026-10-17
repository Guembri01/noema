import { secureCookies } from "./cookie-security";

/**
 * Handing the desktop shell's stored theme to the served app.
 *
 * The app keeps its theme in `localStorage` (`next-themes`), but that store is
 * keyed by **origin** — and the desktop shell serves on `127.0.0.1:<port>`, a
 * port it only *prefers* to keep (`sidecar::choose_port`). When another program
 * has taken that port the origin changes, `localStorage` starts empty, and the
 * page falls back to `next-themes`' `defaultTheme` while the window chrome is
 * still painted in the theme the shell has stored. The result is a flash of the
 * wrong theme on every launch after a port change — and worse, `set_theme` then
 * reports the wrong theme back to the shell, which persists it.
 *
 * The fix is to let the *server* render the right theme into the first
 * document. The shell cannot set a header on the navigation it performs, so it
 * appends the value as a query parameter instead; the middleware turns that into
 * a cookie (a one-request hop that also cleans the URL) and the root layout
 * reads the cookie as `defaultTheme`. Nothing is rendered from the query string,
 * so there is no injection surface, and the value is validated against a closed
 * set before it is ever stored.
 *
 * Pure functions only, so the rule is unit-testable without a request.
 */

/** Cookie the middleware writes and the root layout reads. */
export const THEME_COOKIE = "noema-theme";

/** Query parameter the desktop shell appends to its first navigation. */
export const THEME_QUERY_PARAM = "theme";

/** The values `next-themes` accepts as a preference (`system` resolves live). */
export const THEME_NAMES = ["light", "dark", "system"] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

/** A year: the value is refreshed on every launch anyway. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The cookie attributes used by the middleware (kept here so they have one home).
 *
 * B31: the cookie carries `Secure` in production, like every other cookie of
 * the app. It is *not* `__Host-`-prefixed: the value is one of three theme
 * names, checked against a closed set, so a cookie a sibling domain planted
 * could only pick a theme — never unlock anything. The prefix is for the
 * cookies that carry a credential.
 */
export const THEME_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  secure: secureCookies(),
  maxAge: THEME_COOKIE_MAX_AGE,
} as const;

/**
 * Coerce an arbitrary string (query parameter or cookie) to a known theme.
 *
 * Anything unrecognised — a typo, a stale value from an older release, an
 * attacker-supplied string — is `null`, never a guess. The caller decides the
 * fallback, which is what keeps a junk value from silently becoming a
 * preference.
 */
export function normalizeTheme(value: string | null | undefined): ThemeName | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toLowerCase();
  return (THEME_NAMES as readonly string[]).includes(candidate)
    ? (candidate as ThemeName)
    : null;
}

/** The theme to store, and the URL to send the browser to instead. */
export interface ThemeHandoff {
  theme: ThemeName;
  /** Absolute-path location with the theme parameter removed. */
  location: string;
}

/**
 * Decide whether a document request is carrying the shell's theme.
 *
 * Returns the theme to remember and the URL to redirect to (the same path, with
 * only the theme parameter removed — other parameters are preserved). `null`
 * means "nothing to do", which is every request on the hosted site and every
 * request after the first in the desktop app.
 */
export function themeHandoff(pathname: string, search: string): ThemeHandoff | null {
  const theme = normalizeTheme(new URLSearchParams(search).get(THEME_QUERY_PARAM));
  if (!theme) return null;

  const params = new URLSearchParams(search);
  params.delete(THEME_QUERY_PARAM);
  const rest = params.toString();
  return { theme, location: rest ? `${pathname}?${rest}` : pathname };
}
