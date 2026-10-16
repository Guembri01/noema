import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SKELETON_FILL,
  SKELETON_HEADER_WIDTH,
  SKELETON_LAST_LINE_WIDTH,
  SKELETON_MAX_TABLE_COLS,
  SKELETON_MAX_TABLE_ROWS,
  SKELETON_TEXT_MAX_LINES,
  Skeleton,
  skeletonLineCount,
  skeletonLineWidths,
  skeletonTableRows,
  type SkeletonProps,
} from "./skeleton";

/**
 * ds04 — the skeleton's pure geometry (which keeps the placeholder from
 * shifting when data lands) plus a render check for every variant.
 */

const render = (props: SkeletonProps = {}) =>
  renderToStaticMarkup(createElement(Skeleton, props));

/** How many shimmering bars a piece of markup contains. */
const barCount = (html: string) =>
  html.split("notion-skeleton").length - 1;

describe("skeletonLineWidths", () => {
  it("renders 1–3 lines with the last at 60%", () => {
    expect(skeletonLineWidths(1)).toEqual([SKELETON_LAST_LINE_WIDTH]);
    expect(skeletonLineWidths(2)).toEqual(["100%", SKELETON_LAST_LINE_WIDTH]);
    expect(skeletonLineWidths(3)).toEqual([
      "100%",
      "100%",
      SKELETON_LAST_LINE_WIDTH,
    ]);
  });

  it("clamps junk and out-of-range counts", () => {
    expect(skeletonLineCount(0)).toBe(1);
    expect(skeletonLineCount(-4)).toBe(1);
    expect(skeletonLineCount(Number.NaN)).toBe(1);
    expect(skeletonLineCount(2.9)).toBe(2);
    expect(skeletonLineCount(99)).toBe(SKELETON_TEXT_MAX_LINES);
    expect(skeletonLineWidths(0)).toHaveLength(1);
    expect(skeletonLineWidths(9)).toHaveLength(SKELETON_TEXT_MAX_LINES);
  });
});

describe("skeletonTableRows", () => {
  it("prepends a header row of narrower cells", () => {
    const grid = skeletonTableRows(3, 2);
    expect(grid).toHaveLength(4); // header + 3 body rows
    expect(grid[0]).toEqual([SKELETON_HEADER_WIDTH, SKELETON_HEADER_WIDTH]);
    expect(grid[1]).toEqual(["100%", "100%"]);
  });

  it("clamps rows and cols to sane bounds", () => {
    expect(skeletonTableRows(-5, 0)).toHaveLength(2); // header + 1 body row
    expect(skeletonTableRows(999, 1)).toHaveLength(SKELETON_MAX_TABLE_ROWS + 1);
    expect(skeletonTableRows(1, 999)[0]).toHaveLength(SKELETON_MAX_TABLE_COLS);
  });
});

describe("Skeleton markup", () => {
  it.each(["text", "block", "circle", "card", "row", "table"] as const)(
    "renders the %s variant with the token shimmer fill",
    (variant) => {
      const html = render({ variant });
      expect(html).toContain("notion-skeleton");
      expect(html).toContain("animate-shimmer");
      expect(html).toContain('aria-hidden="true"');
      expect(SKELETON_FILL).toContain("animate-shimmer");
    },
  );

  it("paints one bar per text line and keeps the last line at 60%", () => {
    const html = render({ variant: "text", lines: 2 });
    expect(barCount(html)).toBe(2);
    expect(html).toMatch(/width:\s*60%/);
  });

  it("gives the table variant a header plus the requested rows", () => {
    const html = render({ variant: "table", rows: 3, cols: 2 });
    expect(barCount(html)).toBe((3 + 1) * 2);
    expect(html).toContain('data-skeleton="table"');
  });

  it("merges caller classes and props", () => {
    const html = render({
      variant: "block",
      className: "max-w-xs",
      "data-testid": "row-skeleton",
    } as SkeletonProps);
    expect(html).toContain("max-w-xs");
    expect(html).toContain('data-testid="row-skeleton"');
  });
});
