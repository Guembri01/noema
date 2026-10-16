import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEIGHT_PX,
  DEFAULT_OVERSCAN,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_VISIBLE_ROWS,
  MAX_HEIGHT_PX,
  MIN_HEIGHT_PX,
  describeInlineDatabase,
  parseInlineDatabaseBlock,
  resolveShell,
  resolveViewConfig,
  rowWindow,
  validateInlineDatabaseBlock,
  type InlineDatabaseBlock,
} from "@/lib/inline-database";
import { normalizeViewConfig, type ViewConfig } from "@/lib/database-query";

/**
 * Inline-database block shell engine (docs/specs/database-deep.md §1 "Inline
 * database block" — "view config incomplete", height/scroll shell).
 *
 * `src/lib/inline-database.ts` did not exist when this file was first written
 * (module-not-found -> suite red; scripts/LOOP_PLAYBOOK.md "Red-first").
 *
 * An inline-database block is a database *instance* embedded in a page. It
 * records how the shell lays the instance out (display + height mode) and the
 * pure helpers below resolve the CSS height, whether the block scrolls /
 * virtualizes, the visible row window, the effective view config, and a
 * deterministic description.
 *
 * Everything here is pure: no Prisma, no React, no clock, no I/O. Inputs are
 * never mutated; the parser tolerates junk and the validator reports issues
 * instead of throwing.
 */

const block = (over: Partial<InlineDatabaseBlock> = {}): InlineDatabaseBlock => ({
  id: "blk-1",
  databaseId: "db-1",
  display: "table",
  heightMode: "auto",
  ...over,
});

/** A block with a display/height value that is not in the union (junk input). */
const junk = (over: Record<string, unknown>): InlineDatabaseBlock =>
  over as unknown as InlineDatabaseBlock;

describe("parseInlineDatabaseBlock", () => {
  it("normalizes a complete raw block", () => {
    const parsed = parseInlineDatabaseBlock({
      id: "  blk-1  ",
      databaseId: "  db-1  ",
      viewId: "  v1  ",
      display: "board",
      heightMode: "fixed",
      heightPx: 480,
      showTitle: true,
      showViewsBar: false,
      maxRows: 25,
    });
    expect(parsed).toEqual({
      id: "blk-1",
      databaseId: "db-1",
      viewId: "v1",
      display: "board",
      heightMode: "fixed",
      heightPx: 480,
      showTitle: true,
      showViewsBar: false,
      maxRows: 25,
    });
  });

  it("defaults an unknown display to table and an unknown height mode to auto", () => {
    const parsed = parseInlineDatabaseBlock({
      id: "b",
      databaseId: "d",
      display: "mosaic",
      heightMode: "fit",
    });
    expect(parsed?.display).toBe("table");
    expect(parsed?.heightMode).toBe("auto");
  });

  it("defaults a missing display and height mode", () => {
    const parsed = parseInlineDatabaseBlock({ id: "b", databaseId: "d" });
    expect(parsed?.display).toBe("table");
    expect(parsed?.heightMode).toBe("auto");
    expect(parsed?.viewId).toBeUndefined();
  });

  it("drops a non-positive, non-finite or non-numeric heightPx", () => {
    for (const heightPx of [0, -10, Number.NaN, Number.POSITIVE_INFINITY, "500"]) {
      expect(parseInlineDatabaseBlock({ id: "b", databaseId: "d", heightPx })?.heightPx).toBe(
        undefined,
      );
    }
  });

  it("floors a fractional heightPx and maxRows", () => {
    const parsed = parseInlineDatabaseBlock({
      id: "b",
      databaseId: "d",
      heightMode: "fixed",
      heightPx: 480.9,
      maxRows: 12.8,
    });
    expect(parsed?.heightPx).toBe(480);
    expect(parsed?.maxRows).toBe(12);
  });

  it("drops a non-positive or non-finite maxRows", () => {
    for (const maxRows of [0, -3, Number.NaN]) {
      expect(parseInlineDatabaseBlock({ id: "b", databaseId: "d", maxRows })?.maxRows).toBe(
        undefined,
      );
    }
  });

  it("keeps only boolean show flags", () => {
    const parsed = parseInlineDatabaseBlock({
      id: "b",
      databaseId: "d",
      showTitle: "yes",
      showViewsBar: 1,
    });
    expect(parsed?.showTitle).toBeUndefined();
    expect(parsed?.showViewsBar).toBeUndefined();
  });

  it("drops a blank viewId instead of keeping an empty string", () => {
    expect(parseInlineDatabaseBlock({ id: "b", databaseId: "d", viewId: "   " })?.viewId).toBe(
      undefined,
    );
  });

  it("returns null for a non-object", () => {
    expect(parseInlineDatabaseBlock(null)).toBeNull();
    expect(parseInlineDatabaseBlock("nope")).toBeNull();
    expect(parseInlineDatabaseBlock(["b", "d"])).toBeNull();
  });

  it("returns null when identity is missing", () => {
    expect(parseInlineDatabaseBlock({ id: "  ", databaseId: "d" })).toBeNull();
    expect(parseInlineDatabaseBlock({ id: "b", databaseId: "" })).toBeNull();
    expect(parseInlineDatabaseBlock({ databaseId: "d" })).toBeNull();
  });

  it("never mutates the raw input", () => {
    const raw = { id: "b", databaseId: "d", junk: true };
    const before = JSON.parse(JSON.stringify(raw));
    parseInlineDatabaseBlock(raw);
    expect(raw).toEqual(before);
  });
});

describe("validateInlineDatabaseBlock", () => {
  const exists = () => true;

  it("accepts a well-formed block", () => {
    const result = validateInlineDatabaseBlock(block(), { exists });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("flags a dangling database", () => {
    const result = validateInlineDatabaseBlock(block(), { exists: () => false });
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("missing_database");
  });

  it("flags an unknown view only when a view checker is provided", () => {
    const bound = block({ viewId: "v9" });
    expect(validateInlineDatabaseBlock(bound, { exists }).valid).toBe(true);
    const result = validateInlineDatabaseBlock(bound, {
      exists,
      viewExists: (_db, viewId) => viewId !== "v9",
    });
    expect(result.issues.map((i) => i.code)).toContain("unknown_view");
  });

  it("skips the view check when the database itself is missing", () => {
    const result = validateInlineDatabaseBlock(block({ viewId: "v9" }), {
      exists: () => false,
      viewExists: () => false,
    });
    expect(result.issues.map((i) => i.code)).not.toContain("unknown_view");
  });

  it("flags an unknown display", () => {
    const result = validateInlineDatabaseBlock(junk({ ...block(), display: "mosaic" }), {
      exists,
    });
    expect(result.issues.map((i) => i.code)).toContain("unknown_display");
  });

  it("flags an unknown height mode", () => {
    const result = validateInlineDatabaseBlock(junk({ ...block(), heightMode: "fit" }), {
      exists,
    });
    expect(result.issues.map((i) => i.code)).toContain("invalid_height_mode");
  });

  it("flags a bad heightPx", () => {
    const result = validateInlineDatabaseBlock(
      block({ heightMode: "fixed", heightPx: 0 }),
      { exists },
    );
    expect(result.issues.map((i) => i.code)).toContain("invalid_height_px");
  });

  it("flags a bad maxRows", () => {
    const result = validateInlineDatabaseBlock(block({ maxRows: -1 }), { exists });
    expect(result.issues.map((i) => i.code)).toContain("invalid_max_rows");
  });

  it("flags empty identity fields", () => {
    const result = validateInlineDatabaseBlock(block({ id: "", databaseId: "" }), { exists });
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("empty_id");
    expect(codes).toContain("empty_database_id");
  });

  it("collects multiple independent issues", () => {
    const result = validateInlineDatabaseBlock(
      junk({ id: "", databaseId: "db-x", display: "nope", heightMode: "nope" }),
      { exists: () => false },
    );
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("empty_id");
    expect(codes).toContain("missing_database");
    expect(codes).toContain("unknown_display");
    expect(codes).toContain("invalid_height_mode");
  });
});

describe("resolveShell — height modes", () => {
  it("auto grows to fit its content and never scrolls without a maxRows cap", () => {
    expect(resolveShell(block(), { contentHeight: 200, viewportHeight: 800 })).toEqual({
      heightCss: "auto",
      scroll: false,
      stickyHeader: false,
      virtual: false,
    });
  });

  it("auto stays 'auto' while the content is under the maxRows cap", () => {
    const shell = resolveShell(block({ maxRows: 10 }), {
      contentHeight: 200,
      viewportHeight: 800,
    });
    expect(shell.heightCss).toBe("auto");
    expect(shell.scroll).toBe(false);
  });

  it("auto clamps to maxRows * row height and scrolls past it", () => {
    const shell = resolveShell(block({ maxRows: 10 }), {
      contentHeight: 500,
      viewportHeight: 800,
    });
    expect(shell.heightCss).toBe(`${10 * DEFAULT_ROW_HEIGHT}px`);
    expect(shell.scroll).toBe(true);
  });

  it("fixed uses the default height and does not scroll when the content fits", () => {
    const shell = resolveShell(block({ heightMode: "fixed" }), {
      contentHeight: 100,
      viewportHeight: 900,
    });
    expect(shell.heightCss).toBe(`${DEFAULT_HEIGHT_PX}px`);
    expect(shell.scroll).toBe(false);
  });

  it("fixed scrolls when the content exceeds its height", () => {
    const shell = resolveShell(junk({ ...block(), heightMode: "fixed", heightPx: 500 }), {
      contentHeight: 600,
      viewportHeight: 900,
    });
    expect(shell.heightCss).toBe("500px");
    expect(shell.scroll).toBe(true);
  });

  it("fixed clamps below the minimum height", () => {
    const shell = resolveShell(junk({ ...block(), heightMode: "fixed", heightPx: 10 }), {
      contentHeight: 10,
      viewportHeight: 900,
    });
    expect(shell.heightCss).toBe(`${MIN_HEIGHT_PX}px`);
  });

  it("fixed clamps above the maximum height", () => {
    const shell = resolveShell(junk({ ...block(), heightMode: "fixed", heightPx: 5000 }), {
      contentHeight: 10,
      viewportHeight: 0,
    });
    expect(shell.heightCss).toBe(`${MAX_HEIGHT_PX}px`);
  });

  it("fixed never exceeds the viewport", () => {
    const shell = resolveShell(junk({ ...block(), heightMode: "fixed", heightPx: 900 }), {
      contentHeight: 10,
      viewportHeight: 600,
    });
    expect(shell.heightCss).toBe("600px");
  });

  it("fixed floors the ceiling at the minimum even for a tiny viewport", () => {
    const shell = resolveShell(junk({ ...block(), heightMode: "fixed", heightPx: 900 }), {
      contentHeight: 10,
      viewportHeight: 40,
    });
    expect(shell.heightCss).toBe(`${MIN_HEIGHT_PX}px`);
  });

  it("full fills the viewport", () => {
    const shell = resolveShell(block({ heightMode: "full" }), {
      contentHeight: 100,
      viewportHeight: 700,
    });
    expect(shell.heightCss).toBe("700px");
    expect(shell.scroll).toBe(false);
  });

  it("full falls back to the minimum height when the viewport is unknown", () => {
    const shell = resolveShell(block({ heightMode: "full" }), {
      contentHeight: 0,
      viewportHeight: 0,
    });
    expect(shell.heightCss).toBe(`${MIN_HEIGHT_PX}px`);
  });

  it("treats a negative contentHeight as zero", () => {
    const shell = resolveShell(block(), { contentHeight: -50, viewportHeight: 700 });
    expect(shell.scroll).toBe(false);
    expect(shell.virtual).toBe(false);
  });
});

describe("resolveShell — scroll / sticky / virtual thresholds", () => {
  it("sticks the header on a scrolling table", () => {
    const shell = resolveShell(junk({ ...block(), heightMode: "fixed", heightPx: 300 }), {
      contentHeight: 2000,
      viewportHeight: 900,
    });
    expect(shell.scroll).toBe(true);
    expect(shell.stickyHeader).toBe(true);
  });

  it("does not stick a header for non-row displays", () => {
    const shell = resolveShell(
      junk({ ...block(), display: "board", heightMode: "fixed", heightPx: 300 }),
      { contentHeight: 2000, viewportHeight: 900 },
    );
    expect(shell.scroll).toBe(true);
    expect(shell.stickyHeader).toBe(false);
    expect(shell.virtual).toBe(false);
  });

  it("does not virtualize a gallery even when it scrolls", () => {
    const shell = resolveShell(
      junk({ ...block(), display: "gallery", heightMode: "full" }),
      { contentHeight: 5000, viewportHeight: 400 },
    );
    expect(shell.scroll).toBe(true);
    expect(shell.virtual).toBe(false);
  });

  it("virtualizes only once the content passes two screens of a row display", () => {
    const base = junk({ ...block(), heightMode: "fixed", heightPx: MIN_HEIGHT_PX });
    const atThreshold = resolveShell(base, {
      contentHeight: MIN_HEIGHT_PX * 2,
      viewportHeight: 900,
    });
    const pastThreshold = resolveShell(base, {
      contentHeight: MIN_HEIGHT_PX * 2 + 1,
      viewportHeight: 900,
    });
    expect(atThreshold.virtual).toBe(false);
    expect(pastThreshold.virtual).toBe(true);
  });

  it("virtualizes a full-height table with a long row set", () => {
    const shell = resolveShell(block({ heightMode: "full" }), {
      contentHeight: 4000,
      viewportHeight: 500,
    });
    expect(shell.scroll).toBe(true);
    expect(shell.stickyHeader).toBe(true);
    expect(shell.virtual).toBe(true);
  });
});

describe("rowWindow", () => {
  it("uses the default overscan and visible-row fallback", () => {
    expect(rowWindow(block(), { scrollTop: 0, rowHeight: DEFAULT_ROW_HEIGHT })).toEqual({
      start: 0,
      end: DEFAULT_VISIBLE_ROWS + DEFAULT_OVERSCAN,
      count: DEFAULT_VISIBLE_ROWS + DEFAULT_OVERSCAN,
      overscan: DEFAULT_OVERSCAN,
    });
  });

  it("offsets the window by scrollTop and applies the overscan on both sides", () => {
    const window = rowWindow(block({ maxRows: 10 }), {
      scrollTop: 400,
      rowHeight: 40,
      overscan: 2,
    });
    expect(window).toEqual({ start: 8, end: 22, count: 14, overscan: 2 });
  });

  it("uses maxRows as the visible row count", () => {
    const window = rowWindow(block({ maxRows: 5 }), {
      scrollTop: 0,
      rowHeight: 40,
      overscan: 0,
    });
    expect(window.end).toBe(5);
    expect(window.count).toBe(5);
  });

  it("clamps a negative overscan to the default", () => {
    const window = rowWindow(block(), { scrollTop: 0, rowHeight: 32, overscan: -3 });
    expect(window.overscan).toBe(DEFAULT_OVERSCAN);
  });

  it("treats a non-positive rowHeight as the default", () => {
    const window = rowWindow(block({ maxRows: 4 }), {
      scrollTop: 64,
      rowHeight: 0,
      overscan: 0,
    });
    expect(window.start).toBe(2);
  });

  it("clamps a negative scrollTop to the first row", () => {
    const window = rowWindow(block({ maxRows: 4 }), {
      scrollTop: -500,
      rowHeight: 32,
      overscan: 1,
    });
    expect(window.start).toBe(0);
  });

  it("falls back to the default visible rows when maxRows is not positive", () => {
    const window = rowWindow(block({ maxRows: 0 }), {
      scrollTop: 0,
      rowHeight: 32,
      overscan: 0,
    });
    expect(window.end).toBe(DEFAULT_VISIBLE_ROWS);
  });

  it("keeps count consistent with start and end", () => {
    const window = rowWindow(block({ maxRows: 12 }), {
      scrollTop: 1000,
      rowHeight: 50,
      overscan: 3,
    });
    expect(window.count).toBe(window.end - window.start);
    expect(window.start).toBe(17);
    expect(window.end).toBe(35);
  });
});

describe("resolveViewConfig", () => {
  const source: ViewConfig = {
    filters: [{ propertyId: "status", operator: "is", value: "todo" }],
    chartType: "pie",
    chartAggregate: "sum",
    visiblePropertyIds: ["status", "due"],
  };

  it("applies the block's display over the source view type", () => {
    const resolved = resolveViewConfig(block({ display: "board" }), {
      ...source,
      type: "chart",
    } as ViewConfig & { type: string });
    expect(resolved.display).toBe("board");
  });

  it("keeps the source view config while overriding display", () => {
    const resolved = resolveViewConfig(block({ display: "chart" }), source);
    expect(resolved.chartType).toBe("pie");
    expect(resolved.chartAggregate).toBe("sum");
    expect(resolved.filters).toEqual(source.filters);
    expect(resolved.display).toBe("chart");
  });

  it("treats a missing source view as an empty config", () => {
    const resolved = resolveViewConfig(block({ display: "list" }), null);
    expect(resolved.display).toBe("list");
    expect(normalizeViewConfig(resolved)).toEqual({});
  });

  it("normalizes the source and drops unknown keys", () => {
    const resolved = resolveViewConfig(block(), {
      ...source,
      bogus: "nope",
    } as ViewConfig & { bogus: string });
    expect("bogus" in (resolved as Record<string, unknown>)).toBe(false);
    expect(resolved.filters).toEqual(source.filters);
  });

  it("does not mutate the block or the source", () => {
    const target = block();
    const beforeBlock = JSON.parse(JSON.stringify(target));
    const beforeSource = JSON.parse(JSON.stringify(source));
    resolveViewConfig(target, source);
    expect(target).toEqual(beforeBlock);
    expect(source).toEqual(beforeSource);
  });
});

describe("describeInlineDatabase", () => {
  it("names a table block through its view", () => {
    expect(describeInlineDatabase(block({ id: "blk-1", viewId: "v1" }))).toBe(
      "Table inline database of db-1 via view v1 (blk-1; auto height)",
    );
  });

  it("names a list block through the default view", () => {
    expect(describeInlineDatabase(block({ id: "blk-2", databaseId: "db-2", display: "list" }))).toBe(
      "List inline database of db-2 via default view (blk-2; auto height)",
    );
  });

  it("spells out fixed height, row cap and shell flags", () => {
    expect(
      describeInlineDatabase(
        junk({
          id: "blk-3",
          databaseId: "db-3",
          viewId: "v3",
          display: "chart",
          heightMode: "fixed",
          heightPx: 500,
          maxRows: 50,
          showTitle: true,
          showViewsBar: true,
        }),
      ),
    ).toBe(
      "Chart inline database of db-3 via view v3 (blk-3; fixed 500px, max 50 rows, title, views bar)",
    );
  });
});
