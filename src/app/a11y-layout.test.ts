import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getCurrentUser } from "@/lib/auth";
import RootLayout from "./layout";

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(),
}));

// Vitest does not run the Next PostCSS pipeline; stub the stylesheet import.
vi.mock("./globals.css", () => ({}));

// UI chrome is irrelevant to the document-shell contract (check:a11y audits
// html lang/dir, skip link, landmarks) — pass children through, skip the rest.
vi.mock("@/components/theme-provider", async () => {
  const { createElement: h } = await import("react");
  return {
    ThemeProvider: ({ children }: { children?: ReactNode }) => h("div", null, children ?? null),
  };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { createElement: h } = await import("react");
  return {
    TooltipProvider: ({ children }: { children?: ReactNode }) => h("div", null, children ?? null),
  };
});
vi.mock("@/components/action-error-guard", () => ({
  ActionErrorGuard: () => null,
}));
vi.mock("@/components/ui/toaster", () => ({
  Toaster: () => null,
}));

// Structural contract copied from scripts/check-a11y.mjs — the audit the app
// must satisfy even while the database is unreachable (B46 failure mode:
// root-layout getCurrentUser() threw P1001 and Next served a bare document).
const hasLangDir = (html: string) =>
  /<html[^>]+lang="[a-z-]+"/i.test(html) && /<html[^>]+dir="(ltr|rtl)"/i.test(html);
const hasSkipLink = (html: string) => /<a[^>]+href="#main"/i.test(html);

describe("root layout shell when the session lookup fails (DB outage)", () => {
  beforeEach(() => {
    vi.mocked(getCurrentUser).mockReset();
  });

  it("still renders lang/dir and the skip link when getCurrentUser rejects", async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(
      new Error("P1001: Can't reach database server at `localhost:5433`"),
    );
    const tree = await RootLayout({ children: createElement("div", null, "content") });
    const html = renderToStaticMarkup(tree);
    expect(hasLangDir(html)).toBe(true);
    expect(hasSkipLink(html)).toBe(true);
    expect(html).toContain("content");
  });

  it("keeps the user locale direction on the happy path", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: "u1",
      email: "demo@example.test",
      name: "Demo",
      avatarUrl: null,
      theme: "light",
      locale: "ar",
    });
    const tree = await RootLayout({ children: createElement("div", null, "content") });
    const html = renderToStaticMarkup(tree);
    expect(hasLangDir(html)).toBe(true);
    expect(html).toContain('dir="rtl"');
  });
});
