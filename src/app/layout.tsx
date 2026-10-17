import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { DesktopThemeSync } from "@/components/desktop-theme-sync";
import { DesktopShellBridge } from "@/components/desktop-shell-bridge";
import { OfflineProvider } from "@/components/providers/offline-provider";
import { OfflineIndicator } from "@/components/offline-indicator";
import { UndoRedoProvider } from "@/components/providers/undo-redo-provider";
import { ActionErrorGuard } from "@/components/action-error-guard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { headers, cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth";
import { insideDesktopShell, NONCE_HEADER } from "@/lib/security-headers";
import { RUNTIME_ATTRIBUTE } from "@/lib/runtime-mode";
import { directionOf } from "@/lib/i18n";
import { normalizeTheme, THEME_COOKIE } from "@/lib/theme-preference";

export const metadata: Metadata = {
  title: {
    default: "Noema",
    template: "%s · Noema",
  },
  description:
    "Noema is an open-source, self-hosted workspace for notes, docs and databases.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // B46 (a11y): a failed session lookup (e.g. transient DB outage) must not
  // replace the whole document with a bare error page — check:a11y then loses
  // lang/dir, the skip link and the landmarks. Degrade to the default locale
  // instead; failing child segments are caught by app/error.tsx.
  let locale = "en";
  try {
    const user = await getCurrentUser();
    locale = user?.locale ?? locale;
  } catch {
    locale = "en";
  }
  const dir = directionOf(locale);
  // The middleware mints a nonce per document request; handing it to next-themes
  // is what lets its inline bootstrap run under `script-src 'self' 'nonce-…'`.
  //
  // `headers()` throws *synchronously* outside a request scope (static rendering,
  // unit tests), so this needs a real try/catch — a `.catch()` on a promise that
  // was never created does not help, and a throw here would take down the whole
  // document instead of degrading to "no nonce".
  let nonce: string | undefined;
  try {
    nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  } catch {
    nonce = undefined;
  }
  // The desktop shell's stored theme, handed over as a cookie by the middleware.
  // It only decides what a *first* paint uses (next-themes prefers its own
  // `localStorage` once there is one) — which is exactly the case that used to
  // flash: a changed port means a new origin, so `localStorage` is empty while
  // the window chrome is already painted in the stored theme.
  //
  // `cookies()` throws outside a request scope for the same reason `headers()`
  // does, so it needs the same guard.
  let defaultTheme = "light";
  try {
    defaultTheme = normalizeTheme((await cookies()).get(THEME_COOKIE)?.value) ?? "light";
  } catch {
    defaultTheme = "light";
  }
  // The mode, rendered into the document: the shell navigates this window from
  // its own page to the served app, so an object injected into the old document
  // does not survive — this does. `runtimeMode()` reads it back.
  const runtimeModeAttribute = {
    [RUNTIME_ATTRIBUTE]: insideDesktopShell() ? "desktop" : "site",
  };
  return (
    <html
      lang={locale}
      dir={dir}
      {...runtimeModeAttribute}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-bg text-fg antialiased">
        <ThemeProvider nonce={nonce} defaultTheme={defaultTheme}>
          <TooltipProvider delayDuration={400}>
            <OfflineProvider>
              <a href="#main" className="skip-link">
                Skip to content
              </a>
              <UndoRedoProvider>{children}</UndoRedoProvider>
              <OfflineIndicator />
              <ActionErrorGuard locale={locale} />
              <DesktopThemeSync />
              {/* The other direction: the native menu's clicks, turned into
                  window events the workspace shell serves. Inert on the site. */}
              <DesktopShellBridge />
              <Toaster />
            </OfflineProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
