import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SHEET_SIDES,
  SHEET_SIZE_CLASS,
  SHEET_SIZES,
  Sheet,
  planSheetTab,
  sheetClosedTransform,
  sheetEnterClass,
  sheetPanelStyle,
  sheetSideLayoutClass,
  sheetSizeClass,
  type SheetSide,
  type SheetSize,
} from "./sheet";
import type { Focusable } from "@/lib/focus-trap";

/**
 * Node tests for the Sheet's pure bits (size → class map, off-screen transform,
 * Tab plan) plus a `renderToStaticMarkup` pass for every side and size, pinning
 * the a11y roles, the token chrome (`surface-raised-strong`, `--overlay`) and
 * the `Z.*` layering.
 */

const render = (props: Parameters<typeof Sheet>[0]) =>
  renderToStaticMarkup(createElement(Sheet, props));

describe("size → class map", () => {
  it("is total: every side/size pair resolves to a utility", () => {
    for (const side of SHEET_SIDES) {
      expect(Object.keys(SHEET_SIZE_CLASS[side]).sort()).toEqual(
        [...SHEET_SIZES].sort(),
      );
      for (const size of SHEET_SIZES) {
        expect(sheetSizeClass(side, size)).toBeTruthy();
      }
    }
  });

  it("sizes side sheets by width and bottom sheets by height", () => {
    expect(sheetSizeClass("right", "sm")).toBe("w-80");
    expect(sheetSizeClass("left", "md")).toBe("w-96");
    expect(sheetSizeClass("right", "lg")).toBe("w-[480px]");
    expect(sheetSizeClass("bottom", "sm")).toBe("h-72");
    expect(sheetSizeClass("bottom", "full")).toBe("h-[calc(100vh-1rem)]");
  });

  it("uses the full viewport for the `full` side sheet", () => {
    expect(sheetSizeClass("right", "full")).toContain("100vw");
    expect(sheetSizeClass("bottom", "full")).toContain("100vh");
  });

  it("anchors each side to its edge with the 8px floating gap", () => {
    expect(sheetSideLayoutClass("right")).toBe("top-2 bottom-2 right-2");
    expect(sheetSideLayoutClass("left")).toBe("top-2 bottom-2 left-2");
    expect(sheetSideLayoutClass("bottom")).toBe("left-2 right-2 bottom-2");
  });
});

describe("motion mapping", () => {
  it("closes to the matching off-screen edge", () => {
    expect(sheetClosedTransform("left")).toContain("-100%");
    expect(sheetClosedTransform("right")).toContain("100%");
    expect(sheetClosedTransform("bottom")).toContain("translateY");
  });

  it("uses the named right drawer animation only for the right side", () => {
    expect(sheetEnterClass("right", true)).toBe("animate-slide-in-right");
    expect(sheetEnterClass("left", true)).toBe("");
    expect(sheetEnterClass("bottom", true)).toBe("");
    expect(sheetEnterClass("right", false)).toBe("");
  });

  it("moves with the --dur-3 token on enter and exit", () => {
    const open = sheetPanelStyle("left", true);
    const closed = sheetPanelStyle("left", false);
    expect(String(open.transition)).toContain("var(--dur-3)");
    expect(String(closed.transition)).toContain("var(--dur-3)");
    expect(open.transform).toBe("translate(0, 0)");
    expect(closed.transform).toBe(sheetClosedTransform("left"));
    expect(closed).toMatchObject({ opacity: 0, zIndex: 60 });
  });

  it("hands the transform to the named animation for the right side", () => {
    const open = sheetPanelStyle("right", true);
    expect(open.transform).toBeUndefined();
    expect(open.zIndex).toBe(60);
    // Bottom re-times the vertical `rise` keyframe to the slow token.
    expect(String(sheetPanelStyle("bottom", true).animation)).toContain("var(--dur-3)");
  });
});

describe("Tab plan (shared focus-trap kernel)", () => {
  const stops: Focusable[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("enters at the first stop, or the last on Shift+Tab", () => {
    expect(planSheetTab(stops, { activeId: null })?.target.id).toBe("a");
    expect(planSheetTab(stops, { activeId: null, shift: true })?.target.id).toBe("c");
  });

  it("wraps at the ends", () => {
    expect(planSheetTab(stops, { activeId: "c" })?.target.id).toBe("a");
    expect(planSheetTab(stops, { activeId: "a", shift: true })?.target.id).toBe("c");
  });

  it("releases the key when there is nothing to trap", () => {
    expect(planSheetTab([], {})).toBeNull();
  });
});

describe("renderToStaticMarkup", () => {
  it("renders nothing while closed", () => {
    expect(render({ open: false, onOpenChange: () => {} })).toBe("");
  });

  it.each(SHEET_SIDES)("marks the %s panel as a token-layered modal", (side) => {
    const html = render({
      open: true,
      onOpenChange: () => {},
      side: side as SheetSide,
      size: "md",
      title: "Peek panel",
      children: "Body",
    });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain(`data-side="${side}"`);
    expect(html).toContain('data-size="md"');
    expect(html).toContain("surface-raised-strong");
    expect(html).toContain("scrollbar-thin");
    // Panel sits at Z.modal (60); scrim at Z.overlay (40) over --overlay.
    expect(html).toContain("z-index:60");
    expect(html).toContain("z-index:40");
    expect(html).toContain("var(--overlay)");
  });

  it.each(SHEET_SIZES)("applies the %s size class", (size) => {
    const html = render({ open: true, onOpenChange: () => {}, size: size as SheetSize });
    expect(html).toContain(sheetSizeClass("right", size));
  });

  it("uses the named slide animation for the right sheet", () => {
    expect(render({ open: true, onOpenChange: () => {}, side: "right" })).toContain(
      "animate-slide-in-right",
    );
  });

  it("wires the accessible name from the title", () => {
    const html = render({
      open: true,
      onOpenChange: () => {},
      panelId: "peek",
      title: "Members",
      description: "Who can edit",
    });
    expect(html).toContain('aria-labelledby="peek-title"');
    expect(html).toContain('aria-describedby="peek-desc"');
    expect(html).toContain('id="peek-title"');
  });

  it("exposes a labelled scrim for pointer dismissal", () => {
    const html = render({ open: true, onOpenChange: () => {}, closeLabel: "Dismiss" });
    expect(html).toContain("data-sheet-scrim");
    expect(html).toContain('aria-label="Dismiss"');
  });
});
