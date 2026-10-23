import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SLASH_FOOTER_HINTS,
  SLASH_GROUP_ORDER,
  SlashMenuSurface,
  buildSlashRows,
  highlightSegments,
  type SlashMenuItem,
  type SlashRow,
  type SlashRowEntry,
} from "./slash-menu";

/**
 * ds05 — slash menu. The ranking policy lives in `@/lib/slash-commands`; this
 * file pins the two pure mappings the menu adds on top of it (section grouping
 * with a "Recently used" slot, and fuzzy label highlighting) and statically
 * renders the chrome at zero and many results.
 */

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

describe("buildSlashRows", () => {
  const entries: SlashRowEntry[] = [
    { id: "Text", group: "basic" },
    { id: "Image", group: "media" },
    { id: "Linked database", group: "database" },
    { id: "Equation", group: "advanced" },
    { id: "Heading 1", group: "basic" },
  ];

  const ids = (rows: SlashRow[]) =>
    rows.filter((row): row is Extract<SlashRow, { kind: "item" }> => row.kind === "item").map((row) => row.id);
  const headers = (rows: SlashRow[]) =>
    rows.filter((row): row is Extract<SlashRow, { kind: "header" }> => row.kind === "header").map((row) => row.group);

  it("buckets into the canonical section order", () => {
    const rows = buildSlashRows(entries);
    expect(headers(rows)).toEqual(["basic", "media", "database", "advanced"]);
    // Item order inside a section follows the ranked input.
    expect(ids(rows).slice(0, 2)).toEqual(["Text", "Heading 1"]);
  });

  it("prepends a Recently used section when there are no matches", () => {
    const rows = buildSlashRows(entries, { recentIds: ["Equation", "Image"] });
    expect(headers(rows)[0]).toBe("recent");
    expect(ids(rows).slice(0, 2)).toEqual(["Equation", "Image"]);
    // A recent row is never duplicated in its own section.
    expect(ids(rows).filter((id) => id === "Equation")).toHaveLength(1);
    expect(headers(rows)).not.toContain("advanced");
  });

  it("drops the Recently used section while searching", () => {
    const rows = buildSlashRows(entries, { query: "eq", recentIds: ["Image"] });
    expect(headers(rows)).not.toContain("recent");
    expect(ids(rows)).toContain("Equation");
  });

  it("honours the recent cap and ignores ids no longer present", () => {
    const rows = buildSlashRows(entries, {
      recentIds: ["Gone", "Equation", "Image", "Text"],
      recentLimit: 2,
    });
    expect(ids(rows).slice(0, 2)).toEqual(["Equation", "Image"]);
    expect(headers(rows).filter((group) => group === "recent")).toHaveLength(1);
  });

  it("assigns a flat, monotonic index across sections", () => {
    const rows = buildSlashRows(entries, { recentIds: ["Image"] });
    const indexes = rows
      .filter((row): row is Extract<SlashRow, { kind: "item" }> => row.kind === "item")
      .map((row) => row.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(indexes).toEqual(indexes.map((_, i) => i));
  });
});

/* -------------------------------------------------------------------------- */
/* Fuzzy highlight                                                             */
/* -------------------------------------------------------------------------- */

describe("highlightSegments", () => {
  it("flags a fuzzy subsequence", () => {
    expect(highlightSegments("Heading 1", "hd1")).toEqual([
      { text: "H", match: true },
      { text: "ea", match: false },
      { text: "d", match: true },
      { text: "ing ", match: false },
      { text: "1", match: true },
    ]);
  });

  it("ignores a leading slash and casing", () => {
    expect(highlightSegments("Quote", "/QT")).toEqual([
      { text: "Q", match: true },
      { text: "uo", match: false },
      { text: "t", match: true },
      { text: "e", match: false },
    ]);
  });

  it("leaves the text plain when the query is not a subsequence", () => {
    expect(highlightSegments("Quote", "zzz")).toEqual([{ text: "Quote", match: false }]);
  });

  it("handles the empty cases", () => {
    expect(highlightSegments("", "a")).toEqual([]);
    expect(highlightSegments("Text", "")).toEqual([{ text: "Text", match: false }]);
    expect(highlightSegments("Text", "   ")).toEqual([{ text: "Text", match: false }]);
  });
});

/* -------------------------------------------------------------------------- */
/* Static render                                                               */
/* -------------------------------------------------------------------------- */

const DEFS: SlashRowEntry[] = [
  { id: "Text", group: "basic" },
  { id: "Heading 1", group: "basic" },
  { id: "Image", group: "media" },
  { id: "Linked database", group: "database" },
  { id: "Equation", group: "advanced" },
];

const itemById = new Map<string, SlashMenuItem>(
  DEFS.map((def) => [
    def.id,
    {
      label: def.id,
      hint: `${def.id} hint`,
      icon: createElement("span", null, "•"),
      ...(def.id === "Heading 1" ? { shortcut: "⌘ ⌥ 1" } : {}),
    },
  ]),
);

const renderMenu = (rows: SlashRow[], query = ""): string =>
  renderToStaticMarkup(
    createElement(SlashMenuSurface, {
      rows,
      itemById,
      active: 0,
      query,
      style: { left: 12, top: 24 },
    }),
  );

describe("SlashMenuSurface", () => {
  it("renders many results as grouped, sticky, tokenised chrome", () => {
    const html = renderMenu(buildSlashRows(DEFS), "he");
    expect(html).toContain('data-testid="slash-menu"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    // Tokens: raised surface, the rise entrance, Z.popover, thin scrollbars.
    expect(html).toContain("surface-raised");
    expect(html).toContain("animate-rise");
    expect(html).toContain("z-index:50");
    expect(html).toContain("scrollbar-thin");
    expect(html).toContain("sticky");
    // Grouped sticky headings, from the canonical taxonomy.
    expect(html).toContain(">Basic<");
    expect(html).toContain(">Media<");
    expect(html).toContain(">Database<");
    expect(html).toContain(">Advanced<");
    // The active row is a neutral surface, the others transparent.
    expect(html).toContain("bg-surface-2");
    expect(html).toContain('aria-selected="true"');
    // Fuzzy highlight on "he" inside "Heading 1".
    expect(html).toMatch(/<mark[^>]*>He<\/mark>/);
    // Right-aligned shortcut keycaps.
    expect(html).toContain("⌘");
    expect(html).toContain("⌥");
    // Footer key hints.
    expect(html).toContain(SLASH_FOOTER_HINTS.navigate);
    expect(html).toContain(SLASH_FOOTER_HINTS.select);
    expect(html).toContain(SLASH_FOOTER_HINTS.dismiss);
  });

  it("renders a real empty state when nothing matches", () => {
    const html = renderMenu([], "zzz");
    expect(html).toContain('data-testid="slash-menu"');
    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain("No results");
    expect(html).toContain("No command matches");
    expect(html).not.toContain('role="option"');
  });

  it("exposes the section order contract", () => {
    expect(SLASH_GROUP_ORDER).toEqual(["recent", "basic", "media", "database", "advanced"]);
  });
});
