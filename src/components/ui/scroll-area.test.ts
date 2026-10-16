import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SCROLLBAR_CLASS,
  SCROLL_ORIENTATION,
  ScrollArea,
  edgeFade,
} from "./scroll-area";

/**
 * DS07 ScrollArea — the pure `edgeFade` resolver is pinned for every
 * fade/edge combination; `renderToStaticMarkup` checks the container's classes,
 * max-height and the mobile-safe overflow contract.
 */

const h = createElement;

describe("ScrollArea maps", () => {
  it("uses the shared thin-scrollbar utility", () => {
    expect(SCROLLBAR_CLASS).toBe("scrollbar-thin");
  });

  it("keeps native overflow (never hidden) on every axis", () => {
    expect(SCROLL_ORIENTATION.vertical).toContain("overflow-y-auto");
    expect(SCROLL_ORIENTATION.horizontal).toContain("overflow-x-auto");
    expect(SCROLL_ORIENTATION.both).toBe("overflow-auto");
    for (const cls of Object.values(SCROLL_ORIENTATION)) {
      expect(cls).not.toMatch(/(^|\s)overflow-hidden(\s|$)/);
    }
  });
});

describe("edgeFade resolver", () => {
  it("never masks when fade is none", () => {
    expect(edgeFade("none", { top: true, bottom: true })).toEqual({});
  });

  it("uses .edge-fade-b only while the bottom overflows", () => {
    expect(edgeFade("bottom", { top: false, bottom: true }).className).toBe(
      "edge-fade-b",
    );
    expect(edgeFade("bottom", { top: true, bottom: false })).toEqual({});
  });

  it("masks the top edge only while the top overflows", () => {
    const faded = edgeFade("top", { top: true, bottom: false });
    expect(faded.style?.maskImage).toContain("linear-gradient");
    expect(faded.style?.WebkitMaskImage).toBe(faded.style?.maskImage);
    expect(edgeFade("top", { top: false, bottom: true })).toEqual({});
  });

  it("handles both edges and every partial state", () => {
    const both = edgeFade("both", { top: true, bottom: true });
    expect(both.style?.maskImage).toContain("linear-gradient");
    expect(both.className).toBeUndefined();

    const topOnly = edgeFade("both", { top: true, bottom: false });
    expect(topOnly.style?.maskImage).toContain("linear-gradient");

    expect(edgeFade("both", { top: false, bottom: true }).className).toBe(
      "edge-fade-b",
    );
    expect(edgeFade("both", { top: false, bottom: false })).toEqual({});
  });
});

describe("ScrollArea render", () => {
  it("renders the styled scroll container", () => {
    const html = renderToStaticMarkup(h(ScrollArea, null, "rows"));
    expect(html).toContain("scrollbar-thin");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("rows");
    // Server render cannot know the overflow, so no fade yet (no layout shift).
    expect(html).not.toContain("edge-fade-b");
  });

  it("applies an optional max-height", () => {
    const px = renderToStaticMarkup(h(ScrollArea, { maxHeight: 280 }));
    expect(px).toContain("max-height:280px");
    const vh = renderToStaticMarkup(h(ScrollArea, { maxHeight: "40vh" }));
    expect(vh).toContain("max-height:40vh");
  });

  it.each(["vertical", "horizontal", "both"] as const)(
    "supports orientation=%s",
    (orientation) => {
      const html = renderToStaticMarkup(h(ScrollArea, { orientation }));
      for (const token of SCROLL_ORIENTATION[orientation].split(" ")) {
        expect(html).toContain(token);
      }
    },
  );

  it.each(["none", "top", "bottom", "both"] as const)(
    "accepts fade=%s without touching mobile overflow",
    (fade) => {
      const html = renderToStaticMarkup(h(ScrollArea, { fade }));
      expect(html).toContain("scrollbar-thin");
      expect(html).not.toMatch(/overflow:hidden/);
    },
  );
});
