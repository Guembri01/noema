import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DUR, EASE } from "@/lib/design-tokens";

// `page-editor.tsx` pulls in the browser-only KaTeX stylesheet and a server
// action; stub both so the pure motion mapping can be imported under vitest's
// node environment (the same seam `page-editor-engines.test.ts` uses).
vi.mock("katex/dist/katex.min.css", () => ({}));
vi.mock("@/server/actions/pages", () => ({
  updatePageAction: vi.fn(),
  getPageContentAction: vi.fn(),
}));

import {
  EditorRowChrome,
  blockMotionClass,
  blockMotionFrames,
  blockMotionOptions,
  dragActiveClass,
  dropIndicatorOptions,
  dropLiftStyle,
  dropSettleFrames,
  dropSettleOptions,
  rowChromeClass,
  type RowChromeState,
} from "@/components/editor/page-editor";

/**
 * The editor's micro-interactions are driven by pure mappings so the view code
 * and these tests cannot drift: insert/remove (height+opacity), the drop
 * indicator / drag lift, and the hover chrome. The React behaviour around them
 * (`el.animate`, the DragHandle callbacks) stays in `page-editor.tsx`.
 */

describe("block insert/remove motion", () => {
  it("grows an inserted block from zero height and fades it in", () => {
    const frames = blockMotionFrames("insert", 48);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ height: "0px", opacity: 0, overflow: "hidden" });
    expect(frames[1]).toMatchObject({ height: "48px", opacity: 1, overflow: "hidden" });
  });

  it("collapses a removed block to zero height (the reverse)", () => {
    const frames = blockMotionFrames("remove", 48);
    expect(frames[0]).toMatchObject({ height: "48px", opacity: 1 });
    expect(frames[1]).toMatchObject({ height: "0px", opacity: 0 });
  });

  it("rounds the measured height and never emits a negative one", () => {
    expect(blockMotionFrames("insert", 47.6)[1].height).toBe("48px");
    expect(blockMotionFrames("remove", -5)[0].height).toBe("0px");
    expect(blockMotionFrames("insert", Number.NaN)[1].height).toBe("0px");
  });

  it("animates inside the 140–180 ms window on the smooth easing token", () => {
    expect(blockMotionOptions()).toEqual({ duration: DUR.base, easing: EASE.smooth });
    expect(blockMotionOptions().duration).toBeGreaterThanOrEqual(140);
    expect(blockMotionOptions().duration).toBeLessThanOrEqual(180);
  });

  it("marks enter and leave with distinct classes", () => {
    expect(blockMotionClass("insert")).not.toBe(blockMotionClass("remove"));
    expect(blockMotionClass("insert")).toContain("noema-block");
  });
});

describe("drop indicator / drag lift motion", () => {
  it("draws a 2px accent drop line", () => {
    expect(dropIndicatorOptions()).toEqual({
      color: "var(--accent)",
      width: 2,
      class: "noema-drop-indicator",
    });
  });

  it("drops every transition while a drag is live (1:1 tracking)", () => {
    expect(dragActiveClass(true)).toContain("u-no-transition");
    expect(dragActiveClass(false)).toBe("");
  });

  it("lifts the dragged block with shadow-2 and a slight scale", () => {
    expect(dropLiftStyle()).toEqual({
      boxShadow: "var(--shadow-2)",
      transform: "scale(1.01)",
    });
  });

  it("settles with the spring easing over the base duration", () => {
    expect(dropSettleOptions()).toEqual({ duration: DUR.base, easing: EASE.spring });
    const frames = dropSettleFrames();
    expect(frames[0].transform).toBe("scale(1.01)");
    expect(frames[1].transform).toBe("scale(1)");
    expect(frames[0].boxShadow).toBe("var(--shadow-2)");
  });
});

describe("row chrome hover/focus mapping", () => {
  it("shows on hover, with colour-only motion", () => {
    const cls = rowChromeClass({ hovered: true });
    expect(cls).toContain("opacity-100");
    expect(cls).toContain("u-colors");
    expect(cls).toContain("noema-row-chrome");
  });

  it("hides with no hover, focus or selection", () => {
    expect(rowChromeClass()).toContain("opacity-0");
    expect(rowChromeClass({})).toContain("opacity-0");
  });

  it("stays visible while focused or selected (keyboard parity)", () => {
    expect(rowChromeClass({ focused: true })).toContain("opacity-100");
    expect(rowChromeClass({ selected: true })).toContain("opacity-100");
  });
});

describe("EditorRowChrome (renderToStaticMarkup)", () => {
  const markup = (state?: RowChromeState) =>
    renderToStaticMarkup(createElement(EditorRowChrome, state ? { state } : {}));

  it("renders the grip and add affordances as vector chrome", () => {
    const html = markup({ hovered: true });
    expect(html).toContain("noema-drag-handle");
    expect(html).toContain("noema-row-add");
    expect(html).toContain("data-row-chrome");
    expect(html).toContain("<svg");
    expect(html).not.toContain("⋮⋮");
  });

  it("renders the add affordance as a real, labelled button when wired", () => {
    const html = renderToStaticMarkup(
      createElement(EditorRowChrome, {
        state: { hovered: true },
        onAdd: () => {},
      }),
    );
    expect(html).toContain('aria-label="Add a block below"');
    expect(html).toMatch(/<button[^>]*noema-row-add/);
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("is visible in the hover state", () => {
    const html = markup({ hovered: true });
    expect(html).toContain("opacity-100");
    expect(html).toContain('data-chrome-visible="true"');
  });

  it("is visible in the selected state", () => {
    const html = markup({ selected: true });
    expect(html).toContain("opacity-100");
    expect(html).toContain('data-chrome-visible="true"');
  });

  it("is hidden when the row is neither hovered, focused nor selected", () => {
    const html = markup();
    expect(html).toContain("opacity-0");
    expect(html).toContain('data-chrome-visible="false"');
    expect(html).not.toContain("opacity-100");
  });
});
