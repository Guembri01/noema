import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
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
  const user = await getCurrentUser();
  const locale = user?.locale ?? "en";
  const dir = directionOf(locale);
  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-fg antialiased">
        <ThemeProvider>
          <TooltipProvider delayDuration={400}>
            <a href="#main" className="skip-link">
              Skip to content
            </a>
            {children}
            <ActionErrorGuard locale={locale} />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
