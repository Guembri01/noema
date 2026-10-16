import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PageTreeNode } from "@/server/queries";

/**
 * W10 — live SSR check for the virtualized sidebar.
 *
 * This renders the real `PageTree` component (not just the pure plan) with a
 * 200-row workspace and asserts that only the viewport window reaches the DOM:
 * the classic nested path would have emitted all 200 rows. Server rendering runs
 * no effects, so the component's `SIDEBAR_VIEWPORT_FALLBACK` fixes the window
 * deterministically. `next/navigation` and `next/link` are stubbed (there is no
 * Next runtime here) and the Radix tooltip is passed through — the same stubbing
 * pattern `src/app/a11y-layout.test.ts` uses.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children }: { href: string; children?: ReactNode }) =>
      h("a", { href }, children ?? null),
  };
});

vi.mock("@/components/ui/tooltip", async () => {
  const { createElement: h } = await import("react");
  return {
    TooltipProvider: ({ children }: { children?: ReactNode }) => h("div", null, children ?? null),
    Tooltip: ({ children }: { children?: ReactNode }) => h("div", null, children ?? null),
  };
});

const { SIDEBAR_ROW_HEIGHT, PageTree } = await import("@/components/sidebar/page-tree");

const node = (id: string): PageTreeNode => ({
  id,
  parentId: null,
  teamspaceId: null,
  title: `Page ${id}`,
  icon: null,
  type: "PAGE",
  position: 0,
  isFavorite: false,
});

const renderSidebar = (tree: PageTreeNode[]) =>
  renderToStaticMarkup(
    createElement(PageTree, {
      tree,
      teamspaces: [],
      projects: [],
      workspace: { id: "ws", slug: "ws" },
      locale: "en",
      expanded: new Set<string>(),
      setExpanded: () => {},
      pending: false,
      addPage: () => {},
      discuss: () => {},
      startTransition: () => {},
    }),
  );

const countRows = (html: string) => (html.match(/data-page-row/g) ?? []).length;

describe("PageTree SSR — a 200-page workspace renders only the window", () => {
  const tree = Array.from({ length: 200 }, (_, i) => node(`p${i}`));

  it("materialises far fewer rows than the workspace holds", () => {
    const html = renderSidebar(tree);
    const rows = countRows(html);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(40);
    expect(rows).toBeLessThan(tree.length);
  });

  it("reserves the full scroll height but omits off-window rows", () => {
    const html = renderSidebar(tree);
    // 200 rows + the private-section header, all one row tall.
    expect(html).toContain(`height:${(tree.length + 1) * SIDEBAR_ROW_HEIGHT}px`);
    expect(html).toContain('data-page-id="p0"');
    expect(html).not.toContain('data-page-id="p150"');
  });
});

describe("PageTree SSR — a short tree keeps the classic markup", () => {
  it("renders every row without a virtualization spacer", () => {
    const tree = Array.from({ length: 10 }, (_, i) => node(`s${i}`));
    const html = renderSidebar(tree);
    expect(countRows(html)).toBe(10);
    // No absolute-positioned spacer for a tree below the threshold.
    expect(html).not.toContain("height:308px");
  });
});
