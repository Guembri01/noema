import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VirtualList } from "./virtual-list";

/**
 * VirtualList — the shared windowed-render primitive.
 *
 * The window maths is pinned in `@/lib/virtual-list.test.ts`; this suite pins
 * the DOM shape the primitive owns: only the visible slice mounts, each row sits
 * at its true offset over a spacer carrying the full height, and the scroll
 * viewport keeps the caller's accessibility attributes.
 */

const h = createElement;

/** A fixed-height list of `count` string rows. */
function renderFixed(count: number, scrollTop = 0, overscan = 0): string {
  return renderToStaticMarkup(
    h(VirtualList<string>, {
      items: Array.from({ length: count }, (_, index) => `row-${index}`),
      scrollTop,
      viewportHeight: 40,
      itemHeight: 20,
      overscan,
      getKey: (item) => item,
      renderItem: (item) => h("span", null, item),
    }),
  );
}

const rowCount = (html: string): number => (html.match(/<li/g) ?? []).length;

describe("VirtualList window", () => {
  it("mounts only the slice in view and sizes the spacer to the full list", () => {
    const html = renderFixed(100, 0);
    // 40px viewport / 20px rows = rows 0 and 1.
    expect(rowCount(html)).toBe(2);
    expect(html).toContain("row-0");
    expect(html).toContain("row-1");
    expect(html).not.toContain("row-2");
    // Spacer carries the whole list height so the scrollbar matches.
    expect(html).toContain("height:2000px");
  });

  it("follows the scroll offset", () => {
    const html = renderFixed(100, 60);
    expect(html).not.toContain("row-2");
    expect(html).toContain("row-3");
    expect(html).toContain("row-4");
    expect(html).not.toContain("row-5");
  });

  it("widens the window by overscan on both sides", () => {
    const html = renderFixed(100, 60, 2);
    expect(html).toContain("row-1");
    expect(html).toContain("row-6");
    expect(rowCount(html)).toBe(6);
  });

  it("renders no rows for an empty list but still renders the spacer", () => {
    const html = renderFixed(0);
    expect(rowCount(html)).toBe(0);
    expect(html).toContain("height:0px");
  });

  it("positions each row at its true offset", () => {
    const html = renderFixed(6, 40);
    expect(html).toContain("top:40px"); // row 2
    expect(html).toContain("top:60px"); // row 3
  });
});

describe("VirtualList variable heights", () => {
  it("walks cumulative heights when heightOf is supplied", () => {
    const heights = [10, 20, 30, 40, 50];
    const html = renderToStaticMarkup(
      h(VirtualList<string>, {
        items: ["a", "b", "c", "d", "e"],
        scrollTop: 30,
        viewportHeight: 30,
        itemHeight: 20,
        heightOf: (index) => heights[index] ?? 0,
        getKey: (item) => item,
        renderItem: (item) => h("span", null, item),
      }),
    );
    // Tops 0/10/30/60/100: the window starts at the row under scrollTop 30.
    expect(html).toContain("top:30px");
    expect(html).not.toContain(">a<");
  });
});

describe("VirtualList scroller contract", () => {
  it("forwards region semantics and the viewport height", () => {
    const html = renderToStaticMarkup(
      h(VirtualList<string>, {
        items: ["a"],
        scrollTop: 0,
        viewportHeight: 240,
        itemHeight: 20,
        overscan: 4,
        getKey: (item) => item,
        renderItem: (item) => h("span", null, item),
        scrollerProps: {
          role: "region",
          "aria-label": "Results",
          tabIndex: -1,
          "aria-busy": true,
        },
        className: "overflow-y-auto",
        rowClassName: "absolute inset-x-0",
        rowStyle: { height: 20 },
      }),
    );
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Results"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("height:240px");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("absolute inset-x-0");
    expect(html).toContain("height:20px");
    expect(html).toContain("relative");
  });

  it("keeps a surface's row markers and per-row classes", () => {
    const html = renderToStaticMarkup(
      h(VirtualList<string>, {
        items: ["a", "b"],
        scrollTop: 0,
        viewportHeight: 40,
        itemHeight: 20,
        getKey: (item) => item,
        renderItem: (item) => h("span", null, item),
        rowClassName: (item) => `row-${item}`,
        rowAttributes: () => ({ "data-row": "yes" }),
      }),
    );
    expect(html).toContain('data-row="yes"');
    expect(html).toContain("row-a");
    expect(html).toContain("row-b");
  });
});
