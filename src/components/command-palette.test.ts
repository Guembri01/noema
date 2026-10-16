import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PageTreeNode } from "@/server/queries";

/**
 * DS18 — evidence for the command palette.
 *
 * The launcher's decisions are extracted as pure helpers so they can be pinned
 * in the Node sandbox: fuzzy highlight ranges, grouped/counted sections,
 * wrapped navigation, the "did you mean" suggestion and the long-list scroll
 * geometry. A `renderToStaticMarkup` pass then proves the real component wires
 * them into the dialog, listbox and live region with 0 / 1 / many results.
 *
 * `next/navigation` is stubbed and Radix's portal is replaced by a pass-through
 * so the palette (which lives in a portal in the browser) renders inline here —
 * the same stubbing pattern `page-tree.render.test.ts` uses.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@radix-ui/react-dialog", async () => {
  const { createElement: h } = await import("react");
  type MockProps = {
    children?: ReactNode;
    open?: boolean;
    role?: string;
    className?: string;
    "aria-modal"?: string | boolean;
    [key: string]: unknown;
  };
  const PassThrough = ({ children }: { children?: ReactNode }) => h("div", null, children ?? null);
  return {
    Root: ({ open, children }: MockProps) =>
      open === false ? null : h("div", null, (children as ReactNode) ?? null),
    Trigger: PassThrough,
    Close: PassThrough,
    Portal: PassThrough,
    Overlay: PassThrough,
    Content: ({ children, role, className, ...rest }: MockProps) =>
      h(
        "div",
        { role, className, "aria-modal": rest["aria-modal"] },
        (children as ReactNode) ?? null,
      ),
  };
});

const {
  PALETTE_ROW_HEIGHT,
  PALETTE_VIRTUAL_THRESHOLD,
  buildPaletteSections,
  commandShortcutHints,
  emptyStateCopy,
  flattenSections,
  highlightRanges,
  mergeHighlightRanges,
  moveActiveIndex,
  paletteGroupHeading,
  paletteScrollTop,
  resultCountLabel,
  suggestQuery,
  CommandPalette,
} = await import("@/components/command-palette");

type ItemArgs = Partial<Parameters<typeof buildPaletteSections>[0][number]>;

let seq = 0;
const item = (args: ItemArgs = {}) => ({
  key: `k${seq++}`,
  group: "actions" as const,
  type: "action" as const,
  label: "Label",
  searchText: "Label",
  icon: null,
  run: () => {},
  ...args,
});

const pageNode = (id: string, title: string, type = "PAGE"): PageTreeNode => ({
  id,
  parentId: null,
  teamspaceId: null,
  title,
  icon: null,
  type: type as PageTreeNode["type"],
  position: 0,
  isFavorite: false,
});

describe("mergeHighlightRanges", () => {
  it("merges adjacent and duplicate indices into half-open ranges", () => {
    expect(mergeHighlightRanges([0, 1, 2, 5, 7, 8])).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 6 },
      { start: 7, end: 9 },
    ]);
    expect(mergeHighlightRanges([3, 3, 4])).toEqual([{ start: 3, end: 5 }]);
  });

  it("sorts unordered input and drops invalid indices", () => {
    expect(mergeHighlightRanges([8, 0, 2, 1, 7, 5])).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 6 },
      { start: 7, end: 9 },
    ]);
    expect(mergeHighlightRanges([-1, 1.5, 2, Number.NaN])).toEqual([{ start: 2, end: 3 }]);
  });

  it("is empty for no matches", () => {
    expect(mergeHighlightRanges([])).toEqual([]);
  });
});

describe("highlightRanges", () => {
  it("highlights the fuzzy-matched characters, not a substring", () => {
    // "Create a new page": C(0) … n(9) … p(13).
    expect(highlightRanges("Create a new page", "cnp")).toEqual([
      { start: 0, end: 1 },
      { start: 9, end: 10 },
      { start: 13, end: 14 },
    ]);
  });

  it("slices back to exactly the matched characters", () => {
    const ranges = highlightRanges("Toggle sidebar", "tsb");
    const matched = ranges.map((range) => "Toggle sidebar".slice(range.start, range.end)).join("");
    expect(matched.toLowerCase()).toBe("tsb");
  });

  it("returns nothing for an empty query or a non-match", () => {
    expect(highlightRanges("Pages", "")).toEqual([]);
    expect(highlightRanges("Pages", "zzzz")).toEqual([]);
    expect(highlightRanges("", "p")).toEqual([]);
  });
});

describe("buildPaletteSections", () => {
  it("groups, counts and orders Actions · Pages · Databases · Recent · Settings", () => {
    const items = [
      item({ key: "a1" }),
      item({ key: "a2" }),
      item({ key: "p1", group: "pages", type: "page", pageId: "pg-1", label: "Alpha" }),
      item({ key: "p2", group: "pages", type: "page", pageId: "pg-2", label: "Beta" }),
      item({ key: "d1", group: "databases", type: "database", pageId: "db-1", label: "Roadmap" }),
      item({ key: "s1", group: "settings", type: "theme", label: "Dark" }),
    ];
    const sections = buildPaletteSections(items, {
      query: "",
      recentRank: new Map([["pg-2", 0]]),
    });

    expect(sections.map((section) => section.id)).toEqual([
      "actions",
      "pages",
      "databases",
      "recent",
      "settings",
    ]);
    expect(sections.map((section) => section.count)).toEqual([2, 1, 1, 1, 1]);
    // The recent page moved out of Pages and into Recent — no row twice.
    const recent = sections.find((section) => section.id === "recent");
    const pages = sections.find((section) => section.id === "pages");
    expect(recent?.entries.map((entry) => entry.item.key)).toEqual(["p2"]);
    expect(pages?.entries.map((entry) => entry.item.key)).toEqual(["p1"]);
  });

  it("drops empty sections and keeps the count equal to the entries length", () => {
    const sections = buildPaletteSections([item({ key: "a1", label: "Create a new page" })], {
      query: "",
    });
    expect(sections.map((section) => section.id)).toEqual(["actions"]);
    expect(sections[0].count).toBe(sections[0].entries.length);
  });

  it("returns nothing when the query matches nothing", () => {
    const items = [item({ key: "a1", label: "Create", searchText: "create" })];
    expect(buildPaletteSections(items, { query: "zzzz" })).toEqual([]);
  });

  it("ranks within a section and narrows to the matching group only", () => {
    const items = [
      item({ key: "a1", label: "Toggle sidebar", searchText: "toggle sidebar" }),
      item({ key: "s1", group: "settings", type: "theme", label: "Toggle theme", searchText: "toggle theme" }),
    ];
    const sections = buildPaletteSections(items, { query: "toggle" });
    expect(sections.map((section) => section.id)).toEqual(["actions", "settings"]);
    expect(sections.every((section) => section.count === 1)).toBe(true);
  });
});

describe("flattenSections", () => {
  it("flattens sections into the single keyboard cursor order", () => {
    const items = [
      item({ key: "a1" }),
      item({ key: "p1", group: "pages", type: "page", pageId: "pg", label: "Page" }),
    ];
    const flat = flattenSections(buildPaletteSections(items, { query: "" }));
    expect(flat.map((entry) => entry.key)).toEqual(["a1", "p1"]);
  });
});

describe("moveActiveIndex (wrapped navigation)", () => {
  it("wraps at both ends for ArrowDown / ArrowUp", () => {
    expect(moveActiveIndex(2, "ArrowDown", 3)).toBe(0);
    expect(moveActiveIndex(0, "ArrowUp", 3)).toBe(2);
    expect(moveActiveIndex(1, "ArrowDown", 3)).toBe(2);
  });

  it("jumps to the ends for Home / End", () => {
    expect(moveActiveIndex(2, "Home", 5)).toBe(0);
    expect(moveActiveIndex(0, "End", 5)).toBe(4);
  });

  it("steps a screenful and clamps for PageDown / PageUp", () => {
    expect(moveActiveIndex(0, "PageDown", 3)).toBe(2);
    expect(moveActiveIndex(2, "PageUp", 3)).toBe(0);
  });

  it("is a no-op for other keys and an empty list yields 0", () => {
    expect(moveActiveIndex(1, "Enter", 3)).toBe(1);
    expect(moveActiveIndex(1, "ArrowDown", 0)).toBe(0);
  });
});

describe("suggestQuery / emptyStateCopy (did you mean)", () => {
  const candidates = ["Create a new page", "Toggle sidebar", "Search all pages"];

  it("suggests the closest label or one of its words", () => {
    expect(suggestQuery("craete", candidates)).toBe("Create a new page");
    expect(suggestQuery("toogle", candidates)).toBe("Toggle sidebar");
  });

  it("returns null when nothing is close enough or the query is blank", () => {
    expect(suggestQuery("zzzzzzzz", candidates)).toBeNull();
    expect(suggestQuery("", candidates)).toBeNull();
    expect(suggestQuery("   ", candidates)).toBeNull();
  });

  it("builds the empty-state message plus an optional suggestion", () => {
    const hit = emptyStateCopy("toogle", candidates);
    expect(hit.message).toContain("No commands match");
    expect(hit.message).toContain("toogle");
    expect(hit.suggestion).toBe("Toggle sidebar");

    const miss = emptyStateCopy("zzzzzzzz", candidates);
    expect(miss.suggestion).toBeNull();
  });
});

describe("paletteScrollTop (long-list geometry via virtual-list)", () => {
  it("defers to the DOM for short lists", () => {
    expect(
      paletteScrollTop({ active: 0, count: PALETTE_VIRTUAL_THRESHOLD, viewportSize: 200, scrollTop: 0 }),
    ).toBeNull();
  });

  it("returns an in-range scrollTop for a long list and keeps the row visible", () => {
    const count = PALETTE_VIRTUAL_THRESHOLD + 50;
    const viewportSize = 10 * PALETTE_ROW_HEIGHT;
    const top0 = paletteScrollTop({ active: 0, count, viewportSize, scrollTop: 5000 });
    expect(top0).toBe(0);

    const last = count - 1;
    const maxScroll = count * PALETTE_ROW_HEIGHT - viewportSize;
    const topLast = paletteScrollTop({ active: last, count, viewportSize, scrollTop: 0 });
    expect(topLast).not.toBeNull();
    expect(topLast ?? -1).toBeGreaterThan(0);
    expect(topLast ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(maxScroll);
  });
});

describe("resultCountLabel", () => {
  it("pluralises the live-region count", () => {
    expect(resultCountLabel(1)).toBe("1 result");
    expect(resultCountLabel(3)).toBe("3 results");
    expect(resultCountLabel(0)).toBe("0 results");
  });
});

describe("headings and shortcut hints", () => {
  it("resolves a heading per group id", () => {
    expect(paletteGroupHeading("actions", "en")).toBe("Actions");
    expect(paletteGroupHeading("pages", "en")).toBe("Pages");
    expect(paletteGroupHeading("databases", "en")).toBe("Databases");
    expect(paletteGroupHeading("recent", "en")).toBe("Recent");
    expect(paletteGroupHeading("settings", "en")).toBe("Settings");
  });

  it("reads platform-aware hints from the shortcut registry", () => {
    const mac = commandShortcutHints(true);
    const win = commandShortcutHints(false);
    expect(mac["action:create-page"]).toBe("⌘N");
    expect(win["action:search"]).toBe("Ctrl+K");
    expect(win["action:toggle-sidebar"]).toBe("Ctrl+Shift+\\");
  });
});

/* ------------------------------------------------------------------ *
 * SSR wiring — the real component at 0 / 1 / many results
 * ------------------------------------------------------------------ */

const renderPalette = (props: {
  pages?: PageTreeNode[];
  initialQuery?: string;
  highlightMatches?: boolean;
}) =>
  renderToStaticMarkup(
    createElement(CommandPalette, {
      open: true,
      onOpenChange: () => {},
      workspaceSlug: "ws",
      locale: "en",
      pages: props.pages ?? [],
      onCreatePage: () => {},
      onToggleSidebar: () => {},
      initialQuery: props.initialQuery,
      highlightMatches: props.highlightMatches,
    }),
  );

const countOptions = (html: string) => (html.match(/role="option"/g) ?? []).length;

describe("CommandPalette SSR", () => {
  it("0 results: renders the empty state and a polite live region, no listbox", () => {
    const html = renderPalette({ initialQuery: "zzzz" });
    expect(html).toContain("No commands match");
    expect(html).toContain("zzzz");
    expect(countOptions(html)).toBe(0);
    expect(html).not.toContain('role="listbox"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("1 result: one option, the matched characters highlighted, a single group", () => {
    const html = renderPalette({ initialQuery: "toggle sidebar" });
    expect(countOptions(html)).toBe(1);
    expect(html).toContain('data-palette-group="actions"');
    expect(html).toContain('data-count="1"');
    expect(html).toContain("<mark");
    expect(html).toContain("Toggle sidebar");
  });

  it("many results: grouped + counted sections, dialog a11y, motion and key hints", () => {
    const pages = [
      pageNode("p1", "Alpha"),
      pageNode("p2", "Beta"),
      pageNode("db1", "Roadmap", "DATABASE"),
    ];
    const html = renderPalette({ pages });

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('data-palette-group="actions"');
    expect(html).toContain('data-palette-group="pages"');
    expect(html).toContain('data-palette-group="databases"');
    expect(html).toContain('data-palette-group="settings"');
    expect(html).toContain('data-count="2"');
    expect(countOptions(html)).toBeGreaterThan(5);

    // Combobox wiring: labelled, expanded and pointing at the active row.
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-activedescendant="command-palette-option-0"');

    // Motion classes: the rise token and the thin scrollbar.
    expect(html).toContain("animate-rise");
    expect(html).toContain("scrollbar-thin");

    // Footer key hints.
    expect(html).toContain("navigate");
    expect(html).toContain("Run");
    expect(html).toContain("Close");
  });

  it("can disable match highlighting", () => {
    const withMarks = renderPalette({ initialQuery: "toggle", highlightMatches: true });
    const withoutMarks = renderPalette({ initialQuery: "toggle", highlightMatches: false });
    expect(withMarks).toContain("<mark");
    expect(withoutMarks).not.toContain("<mark");
  });
});
