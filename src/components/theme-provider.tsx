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
}: {
  children: React.ReactNode;
  /** Per-response CSP nonce, from the middleware via `x-nonce`. */
  nonce?: string;
}) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}
