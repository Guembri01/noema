import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { UndoRedoProvider } from "@/components/providers/undo-redo-provider";
import { ActionErrorGuard } from "@/components/action-error-guard";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { getCurrentUser } from "@/lib/auth";
import { directionOf } from "@/lib/i18n";

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
  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-fg antialiased">
        <ThemeProvider>
          <TooltipProvider delayDuration={400}>
            <a href="#main" className="skip-link">
              Skip to content
            </a>
            <UndoRedoProvider>{children}</UndoRedoProvider>
            <ActionErrorGuard locale={locale} />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
