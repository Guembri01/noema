import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * ds08 — search-results polish.
 *
 * Two proofs live here:
 *  1. the *pure* mappings the list leans on — the type label, the type → tag
 *     hue mapping, the teaser height estimator and the teaser builder; and
 *  2. `renderToStaticMarkup` of a result row and the no-result empty state
 *     (plus a windowed smoke test), so the token-backed row, chip and empty
 *     state actually reach the markup.
 *
 * The component is a client shell over a Server Action, `next/link` and
 * `sonner`; all three are stubbed here (there is no Next runtime in node).
 */

vi.mock("@/server/actions/search", () => ({
  loadMoreSearchAction: vi.fn(async () => ({ results: [], nextOffset: null })),
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({
      href,
      children,
      className,
      tabIndex,
      "data-active": dataActive,
    }: {
      href: string;
      children?: unknown;
      className?: string;
      tabIndex?: number;
      "data-active"?: string;
    }) =>
      h(
        "a",
        { href, className, tabIndex, "data-active": dataActive },
        children as never,
      ),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const {
  SEARCH_RESULT_TYPES,
  SearchResults,
  heightFromTeaser,
  pageTeaser,
  resultTypeHue,
  resultTypeLabel,
} = await import("./search-results");
type SearchResultsProps = Parameters<typeof SearchResults>[0];
type SearchRow = import("./search-results").SearchRow;

const { TAG_PALETTE } = await import("@/lib/design-tokens");

/* -------------------------------------------------------------------------- */
/* 1. Pure mappings                                                           */
/* -------------------------------------------------------------------------- */

describe("resultTypeLabel — result type → chip copy", () => {
  it("maps the known engine types", () => {
    expect(resultTypeLabel("PAGE")).toBe("Pages");
    expect(resultTypeLabel("DATABASE")).toBe("Databases");
  });

  it("passes an unknown type through untouched", () => {
    expect(resultTypeLabel("WHATEVER")).toBe("WHATEVER");
  });
});

describe("resultTypeHue — result type → tag palette", () => {
  it("gives each known type a distinct tag hue", () => {
    expect(resultTypeHue("PAGE")).toBe("blue");
    expect(resultTypeHue("DATABASE")).toBe("purple");
  });

  it("falls back to gray and never leaks an unknown hue", () => {
    expect(resultTypeHue("TICKET")).toBe("gray");
    for (const type of [...SEARCH_RESULT_TYPES, "TICKET", ""]) {
      expect(TAG_PALETTE).toContain(resultTypeHue(type));
    }
  });
});

describe("heightFromTeaser — row height estimate", () => {
  it("uses the base height for a teaser-less row", () => {
    expect(heightFromTeaser("")).toBe(44);
  });

  it("grows one line-height per estimated teaser line", () => {
    expect(heightFromTeaser("short")).toBe(68);
    expect(heightFromTeaser("x".repeat(65))).toBe(92);
  });

  it("caps pathological teasers so the estimate can never reserve the viewport", () => {
    expect(heightFromTeaser("x".repeat(64 * 6))).toBe(188);
    expect(heightFromTeaser("x".repeat(64 * 40))).toBe(188);
  });
});

describe("pageTeaser — real content preferred, snippet as fallback", () => {
  it("prefers the page's blocks when they carry the query", () => {
    const teaser = pageTeaser(
      { blocks: [{ type: "paragraph", text: "Alpha beta gamma" }], snippet: "ignored" },
      160,
      "beta",
    );
    expect(teaser).toBe("Alpha beta gamma");
  });

  it("reads the snippet as a paragraph when there are no blocks", () => {
    expect(pageTeaser({ snippet: "The quick brown fox jumps" }, 160, "")).toBe(
      "The quick brown fox jumps",
    );
  });

  it("falls back to a snippet that surfaces the match when the teaser cannot", () => {
    const teaser = pageTeaser(
      { blocks: [{ type: "paragraph", text: "Unrelated body" }], snippet: "Alpha appears here" },
      160,
      "Alpha",
    );
    expect(teaser).toBe("Alpha appears here");
  });

  it("truncates at a word boundary and is total over junk", () => {
    expect(pageTeaser({ snippet: "one two three four five" }, 12, "")).toBe("one two…");
    expect(pageTeaser({}, 160, "x")).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Rendered rows / empty state                                             */
/* -------------------------------------------------------------------------- */

const row = (over: Partial<SearchRow> = {}): SearchRow => ({
  id: "p1",
  title: "Alpha",
  icon: null,
  type: "PAGE",
  snippet: "Alpha body text",
  ...over,
});

const renderResults = (over: Partial<SearchResultsProps> = {}): string =>
  renderToStaticMarkup(
    createElement(SearchResults, {
      workspaceId: "ws",
      slug: "acme",
      query: "Alpha",
      initial: [row()],
      nextOffset: null,
      locale: "en",
      ...over,
    } as SearchResultsProps),
  );

/** Token discipline shared by every rendered snapshot. */
function expectTokensOnly(html: string): void {
  expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  expect(html).not.toMatch(
    /\b(?:red|green|amber|orange|yellow|emerald|slate|zinc|neutral)-\d{2,3}\b/,
  );
}

describe("SearchResults — a result row", () => {
  it("renders the row with the active tint, focus ring and highlighted match", () => {
    const html = renderResults();
    expect(html).toContain('href="/w/acme/p1"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain("bg-accent-soft");
    expect(html).toContain("focus-ring");
    // The match is emphasised with --accent ink on --accent-soft.
    expect(html).toMatch(/<mark[^>]*bg-accent-soft/);
    expect(html).toMatch(/<mark[^>]*text-accent/);
    expect(html).toContain(">Alpha</mark>");
    expectTokensOnly(html);
  });

  it("renders the type chips from the tag palette", () => {
    const html = renderResults();
    expect(html).toContain("tag tag-blue");
    expect(html).toContain("tag tag-purple");
    expect(html).toContain("--tag-blue-fg");
    expect(html).toContain("--tag-purple-fg");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Pages");
    expect(html).toContain("Databases");
    expectTokensOnly(html);
  });

  it("keeps the plain list for short result sets (no virtual region)", () => {
    const html = renderResults();
    expect(html).toContain("<ul");
    expect(html).not.toContain('role="region"');
  });

  it("keeps the windowed scroller for long result sets", () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      row({ id: `p${index}`, title: `Page ${index}` }),
    );
    const html = renderResults({ initial: many, query: "Page" });
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Search results"');
    // Only the visible window mounts, never all fifty rows.
    const mounted = html.match(/href="\/w\/acme\//g) ?? [];
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(many.length);
    expectTokensOnly(html);
  });

  it("marks only the roving cursor row active", () => {
    const html = renderResults({
      initial: [row({ id: "p1" }), row({ id: "p2", title: "Beta" })],
    });
    expect(html.match(/data-active="true"/g)).toHaveLength(1);
  });
});

describe("SearchResults — empty / no-result state", () => {
  it("renders the EmptyState primitive and no list", () => {
    const html = renderResults({ initial: [] });
    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain("No results");
    expect(html).toContain("Try a different search or clear the type filters.");
    expect(html).toMatch(/<svg/); // the SearchX glyph
    expect(html).not.toContain("<ul");
    expect(html).toContain("0 results for");
    expectTokensOnly(html);
  });
});
