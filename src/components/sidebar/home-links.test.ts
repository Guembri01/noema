import { describe, expect, it, vi } from "vitest";

/**
 * DS20 — sidebar home links.
 *
 * The favorite / recent row labels, the recency ordering and the quick-link
 * active test are pure and pinned here. Server Actions / Next / sonner are
 * stubbed so the module can be imported in the Node sandbox.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/w/demo",
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@/server/actions/pages", () => ({ toggleFavoriteAction: vi.fn(async () => ({ ok: true })) }));

import {
  FAVORITE_FALLBACK_ICON,
  RECENT_FALLBACK_ICON,
  favoriteRowLabel,
  quickLinkActive,
  recentRowLabel,
  recentRows,
  sidebarRowLabel,
  type SidebarPage,
} from "./home-links";

const PAGE = (overrides: Partial<SidebarPage> = {}): SidebarPage => ({
  id: "p1",
  title: "Notes",
  icon: "📝",
  ...overrides,
});

describe("row labels", () => {
  it("uses the page's own icon and title", () => {
    expect(favoriteRowLabel(PAGE())).toEqual({ icon: "📝", label: "Notes" });
    expect(recentRowLabel(PAGE())).toEqual({ icon: "📝", label: "Notes" });
  });

  it("falls back to the star / clock glyph and the Untitled key", () => {
    expect(favoriteRowLabel(PAGE({ icon: null, title: "  " }))).toEqual({
      icon: FAVORITE_FALLBACK_ICON,
      label: "Untitled",
    });
    expect(recentRowLabel(PAGE({ icon: "", title: "" }))).toEqual({
      icon: RECENT_FALLBACK_ICON,
      label: "Untitled",
    });
  });

  it("tolerates a missing page", () => {
    expect(sidebarRowLabel(null, "•")).toEqual({ icon: "•", label: "Untitled" });
  });
});

describe("recentRows", () => {
  const pages: SidebarPage[] = [
    { id: "a", title: "A", icon: null },
    { id: "b", title: "B", icon: null },
    { id: "c", title: "C", icon: null },
    { id: "b", title: "B again", icon: null },
  ];

  it("returns newest first, deduped by id", () => {
    expect(recentRows(pages).map((page) => page.id)).toEqual(["b", "c", "a"]);
  });

  it("caps to the requested limit and ignores a bad limit gracefully", () => {
    expect(recentRows(pages, 2).map((page) => page.id)).toEqual(["b", "c"]);
    expect(recentRows(pages, 0)).toEqual([]);
  });

  it("drops keyless rows", () => {
    expect(recentRows([{ id: "", title: "x", icon: null }, ...pages]).map((p) => p.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});

describe("quickLinkActive", () => {
  it("matches prefixes by default and exact when asked", () => {
    expect(quickLinkActive("/w/demo/tickets", "/w/demo/tickets")).toBe(true);
    expect(quickLinkActive("/w/demo/tickets/123", "/w/demo/tickets")).toBe(true);
    expect(quickLinkActive("/w/demo/inbox", "/w/demo/inbox", true)).toBe(true);
    expect(quickLinkActive("/w/demo/inbox/1", "/w/demo/inbox", true)).toBe(false);
    expect(quickLinkActive("/w/demo/projects", "/w/demo/tickets")).toBe(false);
    expect(quickLinkActive("/w/demo", "")).toBe(false);
  });
});
