"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * next-themes injects an inline bootstrap script (it applies the stored theme
 * before paint, which is what stops a flash of the wrong theme).
 *
 * That script is the one inline script React does **not** nonce, so the CSP has to
 * allow it — and pinning a `sha256` of third-party-generated code goes stale the
 * moment the library or the props change. It did: the served script hashed to a
 * different value than the pin, so the browser blocked it in production while the
 * dev server (a laxer CSP) hid the problem.
 *
 * Passing the request nonce is the durable fix: the script becomes
 * `nonce="…"`, which the per-response policy already allows, and no hash of
 * generated code is trusted.
 */
export function ThemeProvider({
  children,
  nonce,
  defaultTheme = "light",
}: {
  children: React.ReactNode;
  /** Per-response CSP nonce, from the middleware via `x-nonce`. */
  nonce?: string;
  /**
   * What a first paint uses, before `localStorage` has an opinion.
   *
   * The root layout passes the desktop shell's stored theme (via the cookie the
   * middleware sets); the site passes nothing and keeps `"light"`. Without this
   * the desktop app fell back to `"light"` on any launch whose port had changed,
   * flashing a light page under a dark title bar — and then told the shell the
   * theme was light, persisting the mistake.
   */
  defaultTheme?: string;
}) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme={defaultTheme}
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}
