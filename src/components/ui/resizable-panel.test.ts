import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResizablePanel,
  clampPanelSize,
  dragPanelSize,
  nudgePanelSize,
  type PanelBounds,
} from "./resizable-panel";

/**
 * ResizablePanel — the pure size resolvers are pinned for every boundary, and
 * `renderToStaticMarkup` checks the real `separator` control (orientation,
 * value range, focus ring) and the token-driven, drag-frozen transition.
 */

const h = createElement;
const BOUNDS: PanelBounds = { min: 200, max: 520, fallback: 240 };

describe("clampPanelSize", () => {
  it("clamps into the range and rounds to whole px", () => {
    expect(clampPanelSize(300, 200, 520, 240)).toBe(300);
    expect(clampPanelSize(199.6, 200, 520, 240)).toBe(200);
    expect(clampPanelSize(600, 200, 520, 240)).toBe(520);
    expect(clampPanelSize(300.4, 200, 520, 240)).toBe(300);
  });

  it("falls back for non-finite input", () => {
    expect(clampPanelSize(Number.NaN, 200, 520, 240)).toBe(240);
    expect(clampPanelSize(Number.POSITIVE_INFINITY, 200, 520, 240)).toBe(240);
    expect(clampPanelSize(Number.NaN, 200, 520, Number.NaN)).toBe(200);
  });

  it("tolerates an inverted range", () => {
    expect(clampPanelSize(300, 520, 200, 240)).toBe(300);
    expect(clampPanelSize(50, 520, 200, 240)).toBe(200);
  });
});

describe("dragPanelSize", () => {
  it("grows toward the pointer for an end-edge handle", () => {
    expect(dragPanelSize(240, 60, BOUNDS, "end")).toBe(300);
  });

  it("shrinks toward the pointer for a start-edge handle", () => {
    expect(dragPanelSize(240, 60, BOUNDS, "start")).toBe(200);
    expect(dragPanelSize(240, -60, BOUNDS, "start")).toBe(300);
  });

  it("clamps to the limits and ignores a non-finite delta", () => {
    expect(dragPanelSize(240, 999, BOUNDS, "end")).toBe(520);
    expect(dragPanelSize(240, -999, BOUNDS, "end")).toBe(200);
    expect(dragPanelSize(240, Number.NaN, BOUNDS, "end")).toBe(240);
  });

  it("falls back when the start size is unusable", () => {
    expect(dragPanelSize(Number.NaN, 20, BOUNDS, "end")).toBe(260);
  });
});

describe("nudgePanelSize", () => {
  it("steps by the delta and clamps", () => {
    expect(nudgePanelSize(240, 12, BOUNDS)).toBe(252);
    expect(nudgePanelSize(240, -40, BOUNDS)).toBe(200);
    expect(nudgePanelSize(520, 40, BOUNDS)).toBe(520);
  });

  it("falls back for non-finite current and delta", () => {
    expect(nudgePanelSize(Number.NaN, 12, BOUNDS)).toBe(252);
    expect(nudgePanelSize(240, Number.NaN, BOUNDS)).toBe(240);
  });
});

function render(over: {
  orientation?: "vertical" | "horizontal";
  width?: number;
  as?: "div" | "aside" | "section";
} = {}): string {
  return renderToStaticMarkup(
    h(
      ResizablePanel,
      {
        defaultWidth: 240,
        min: 200,
        max: 520,
        label: "Resize panel",
        handleTitle: "Drag to resize",
        testId: "panel",
        handleTestId: "panel-handle",
        children: h("span", null, "body") as ReactNode,
        ...over,
      },
    ),
  );
}

describe("ResizablePanel render", () => {
  it("renders a focusable separator with the full ARIA value range", () => {
    const html = render();
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-label="Resize panel"');
    expect(html).toContain('aria-valuemin="200"');
    expect(html).toContain('aria-valuemax="520"');
    expect(html).toContain('aria-valuenow="240"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("focus-ring");
    expect(html).toContain('title="Drag to resize"');
    expect(html).toContain('data-testid="panel-handle"');
  });

  it("sizes the panel and animates on a motion token at rest", () => {
    const html = render();
    expect(html).toContain('data-testid="panel"');
    expect(html).toContain("width:240px");
    expect(html).toContain("var(--dur-2)");
    expect(html).not.toContain("u-no-transition");
  });

  it("uses the requested element and a horizontal axis", () => {
    const html = render({ orientation: "horizontal", as: "aside" });
    expect(html).toContain("<aside");
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain("height:240px");
    expect(html).toContain("cursor-row-resize");
  });

  it("reflects a controlled width", () => {
    const html = render({ width: 300 });
    expect(html).toContain('aria-valuenow="300"');
    expect(html).toContain("width:300px");
  });
});
