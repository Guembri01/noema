import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DS-12 — sidebar row states & tree motion.
 *
 * Two proofs live here:
 *  1. the *pure* class mapping per row state (hover / selected / focus / drag)
 *     and the expanded/collapsed animation classes — no DOM needed; and
 *  2. `renderToStaticMarkup` of one row in each state, so the classes actually
 *     reach the markup (and the same shell is used in classic + virtual mode).
 *
 * `next/navigation`, `next/link` and the Radix tooltip are stubbed exactly as
 * `page-tree.render.test.ts` does — there is no Next/Radix runtime in node.
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
    default: ({ href, children, className }: { href: string; children?: ReactNode; className?: string }) =>
      h("a", { href, className }, children ?? null),
  };
});

vi.mock("@/components/ui/tooltip", async () => {
  const { createElement: h } = await import("react");
  return {
    TooltipProvider: ({ children }: { children?: ReactNode }) => h("div", null, children ?? null),
    Tooltip: ({ children }: { children?: ReactNode }) => h("div", null, children ?? null),
  };
});

const {
  PageTree,
  PageTreeRow,
  PAGE_TREE_CHILDREN_INNER,
  pageChevronButtonClass,
  pageChevronClass,
  PAGE_CHEVRON_MOTION,
  PAGE_TREE_CHILDREN_MOTION,
  pageRowClass,
  pageRowLinkClass,
  pageRowSettleStyle,
  pageTreeChildrenClass,
  edgeScrollDelta,
} = await import("@/components/sidebar/page-tree");
import type { PageRowState } from "@/components/sidebar/page-tree";
import type { PageTreeNode } from "@/server/queries";

// --- 1. Pure class mapping -------------------------------------------------

describe("pageRowClass — row states map to token classes only", () => {
  it("default row: hover tint + shared colour/press utilities, no selection", () => {
    const cls = pageRowClass();
    expect(cls).toContain("hover:bg-surface-2"); // hover tint via tokens
    expect(cls).toContain("u-colors"); // colour transition token
    expect(cls).toContain("u-interactive"); // press = scale(0.985)
    expect(cls).not.toContain("bg-accent-soft");
    expect(cls).not.toContain("u-no-transition");
  });

  it("selected row: accent-soft fill + accent left rail", () => {
    const cls = pageRowClass({ selected: true });
    expect(cls).toContain("bg-accent-soft");
    expect(cls).toContain("before:bg-accent");
    expect(cls).toContain("before:w-0.5");
    expect(cls).toContain("relative"); // rail anchors to the row
  });

  it("dragging row: 1:1 tracking + lift", () => {
    const cls = pageRowClass({ dragging: true });
    expect(cls).toContain("u-no-transition"); // never lags the cursor
    expect(cls).toContain("shadow-2"); // subtle lift
    expect(cls).toContain("scale-[1.02]");
    expect(cls).toContain("z-[var(--z-drag)]"); // layering via tokens
    expect(cls).not.toContain("bg-accent-soft");
  });

  it("selected AND dragging keeps both treatments", () => {
    const cls = pageRowClass({ selected: true, dragging: true });
    expect(cls).toContain("bg-accent-soft");
    expect(cls).toContain("u-no-transition");
  });
});

describe("focus / chevron / child-list classes", () => {
  it("the title link owns the focus ring (keyboard never shows the hover tint)", () => {
    expect(pageRowLinkClass()).toContain("focus-ring");
    expect(pageRowLinkClass()).not.toContain("bg-surface-2");
    expect(pageRowLinkClass(true)).toContain("hidden");
  });

  it("chevron rotates 90° over --dur-2 with --ease-smooth", () => {
    const open = pageChevronClass(true);
    expect(open).toContain("rotate-90");
    expect(open).toContain("transition-transform");
    // Motion lives on the token layer (inline), never an arbitrary duration class.
    expect(open).not.toContain("duration-[");
    expect(PAGE_CHEVRON_MOTION.transitionDuration).toBe("var(--dur-2)");
    expect(PAGE_CHEVRON_MOTION.transitionTimingFunction).toBe("var(--ease-smooth)");
    expect(pageChevronClass(false)).not.toContain("rotate-90");
  });

  it("chevron hit area is 20×20 inside a 24 px minimum", () => {
    const cls = pageChevronButtonClass(true);
    expect(cls).toContain("h-6"); // 24px minimum overall
    expect(cls).toContain("w-5"); // 20px wide
    expect(pageChevronButtonClass(false)).toContain("invisible");
  });

  it("expanded/collapsed child list animates height+opacity over --dur-2", () => {
    const open = pageTreeChildrenClass(true);
    const closed = pageTreeChildrenClass(false);
    for (const cls of [open, closed]) {
      expect(cls).toContain("transition-[grid-template-rows,opacity]");
      // No arbitrary duration class — the motion is the token-layer constant.
      expect(cls).not.toContain("duration-[");
      expect(cls).toContain("overflow-hidden");
    }
    expect(PAGE_TREE_CHILDREN_MOTION.transitionDuration).toBe("var(--dur-2)");
    expect(PAGE_TREE_CHILDREN_MOTION.transitionTimingFunction).toBe("var(--ease-smooth)");
    expect(open).toContain("grid-rows-[1fr]");
    expect(open).toContain("opacity-100");
    expect(closed).toContain("grid-rows-[0fr]");
    expect(closed).toContain("opacity-0");
    // The inner box must allow the row to reach zero height.
    expect(PAGE_TREE_CHILDREN_INNER).toContain("min-h-0");
  });

  it("the drop settle springs back over --dur-3 / --ease-spring", () => {
    expect(pageRowSettleStyle(false)).toEqual({});
    const style = pageRowSettleStyle(true);
    expect(style.transition).toContain("var(--ease-spring)");
    expect(style.transition).toContain("var(--dur-3)");
  });
});

describe("edgeScrollDelta — drag auto-scroll geometry", () => {
  it("scrolls toward whichever edge the pointer nears", () => {
    expect(edgeScrollDelta(5, 0, 100)).toBeLessThan(0);
    expect(edgeScrollDelta(95, 0, 100)).toBeGreaterThan(0);
    expect(edgeScrollDelta(50, 0, 100)).toBe(0);
  });

  it("a non-positive zone disables auto-scroll", () => {
    expect(edgeScrollDelta(5, 0, 100, 0)).toBe(0);
  });
});

// --- 2. Rendered row in each state ----------------------------------------

const row = (state?: PageRowState, expanded = false) =>
  renderToStaticMarkup(
    createElement(PageTreeRow, {
      id: "p1",
      title: "Page One",
      icon: null,
      type: "PAGE",
      href: "/w/ws/p1",
      depth: 1,
      hasChildren: true,
      expanded,
      state,
      onToggle: () => {},
      draggable: true,
      onDragStart: () => {},
      onDragEnd: () => {},
    }),
  );

describe("PageTreeRow SSR — every state reaches the markup", () => {
  it("default row", () => {
    const html = row();
    expect(html).toContain("data-page-row");
    expect(html).toContain('data-page-id="p1"');
    expect(html).toContain("hover:bg-surface-2");
    expect(html).toContain("u-interactive");
    expect(html).toContain("focus-ring");
    expect(html).not.toContain("data-selected");
    expect(html).not.toContain("data-dragging");
  });

  it("selected row", () => {
    const html = row({ selected: true });
    expect(html).toContain('data-selected=""');
    expect(html).toContain("bg-accent-soft");
    expect(html).toContain("before:bg-accent");
    expect(html).toContain('aria-current="page"');
  });

  it("dragging row", () => {
    const html = row({ dragging: true });
    expect(html).toContain('data-dragging=""');
    expect(html).toContain("u-no-transition");
    expect(html).toContain("shadow-2");
    expect(html).toContain("scale-[1.02]");
  });

  it("expanded row exposes the rotated chevron to assistive tech", () => {
    const html = row(undefined, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("rotate-90");
  });
});

// --- 3. Both render modes use the same row shell ---------------------------

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

describe("PageTree — hover/press classes apply in classic AND virtual mode", () => {
  it("classic (short) tree", () => {
    const html = renderSidebar(Array.from({ length: 8 }, (_, i) => node(`s${i}`)));
    expect(html).toContain("hover:bg-surface-2");
    expect(html).toContain("u-interactive");
  });

  it("virtualized (long) tree", () => {
    const html = renderSidebar(Array.from({ length: 200 }, (_, i) => node(`p${i}`)));
    // The window still renders rows, and they carry the same state classes.
    expect((html.match(/data-page-row/g) ?? []).length).toBeGreaterThan(0);
    expect(html).toContain("hover:bg-surface-2");
    expect(html).toContain("u-interactive");
  });
});
