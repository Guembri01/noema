import { describe, expect, it } from "vitest";
import {
  activeHeadingIndex,
  buildTocItems,
  scrollBehavior,
  slugify,
  tocAnchorId,
  TOC_ACTIVE_MARKER_PX,
} from "./toc";

/**
 * B96 — TOC scroll-spy pure logic (red-first).
 *
 * Two concerns live here:
 *  1. ANCHOR STRATEGY: headings emit NO ids (StarterKit renders plain h1–h6)
 *     and the document model must stay id-free — an id heading attr would leak
 *     into the persisted JSON and break collab/serialize parity. Anchors are
 *     therefore derived from heading text (slugify + document-order dedupe)
 *     and stamped onto the rendered heading elements by `TocView` ONLY, at
 *     render time. These tests pin the slug pipeline the view depends on.
 *  2. The scroll-spy offset calc: given each heading's distance from the
 *     scroll container's top edge, which outline entry is active.
 */
describe("slugify", () => {
  it("lowercases and hyphenates words", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("folds punctuation/whitespace runs into single hyphens and trims them", () => {
    expect(slugify("  Section 1: Intro!  ")).toBe("section-1-intro");
    expect(slugify("---weird---edges---")).toBe("weird-edges");
  });

  it("keeps non-ASCII letters so unicode headings still get anchors", () => {
    expect(slugify("Café au lait")).toBe("café-au-lait");
    expect(slugify("第 1 章")).toBe("第-1-章");
  });

  it("falls back to a stable base when nothing slug-shaped remains", () => {
    expect(slugify("!!!")).toBe("section");
    expect(slugify("")).toBe("section");
    expect(slugify("   ")).toBe("section");
  });
});

describe("buildTocItems", () => {
  const heading = (text: string, level = 2, pos = 0) => ({ level, text, pos });

  it("keeps level/text/pos and adds a slug per heading", () => {
    expect(buildTocItems([heading("Intro", 3, 12)])).toEqual([
      { level: 3, text: "Intro", pos: 12, slug: "intro" },
    ]);
  });

  it("dedupes repeated heading texts in document order (-2, -3)", () => {
    const slugs = buildTocItems([
      heading("Intro", 2, 1),
      heading("Intro", 2, 40),
      heading("Intro", 3, 80),
    ]).map((item) => item.slug);
    expect(slugs).toEqual(["intro", "intro-2", "intro-3"]);
  });

  it("never collides a deduped slug with a later literal -2 heading", () => {
    // "Intro" ×2 claims intro-2, so the literal "Intro 2" must move aside —
    // the deep-tree stability guarantee: every outline row keeps a unique anchor.
    const slugs = buildTocItems([
      heading("Intro"),
      heading("Intro"),
      heading("Intro 2"),
    ]).map((item) => item.slug);
    expect(slugs).toEqual(["intro", "intro-2", "intro-2-2"]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("round-trips an empty/whitespace heading through the fallback", () => {
    expect(buildTocItems([heading("  ")])[0].slug).toBe("section");
  });
});

describe("tocAnchorId", () => {
  it("prefixes the slug so app ids (e.g. main#main) can never collide", () => {
    expect(tocAnchorId("intro")).toBe("toc-intro");
    expect(tocAnchorId("deep-dive-2")).toBe("toc-deep-dive-2");
  });
});

describe("activeHeadingIndex", () => {
  it("returns -1 when there are no headings", () => {
    expect(activeHeadingIndex([])).toBe(-1);
  });

  it("clamps to the first item before any heading reaches the reading line", () => {
    expect(activeHeadingIndex([400, 520])).toBe(0);
  });

  it("activates the last heading at/above the marker", () => {
    // Section 4 sits exactly on the reading line, 5+ are still below it.
    expect(activeHeadingIndex([400, 300, 200, 100, 0, 120, 200])).toBe(4);
  });

  it("honours the marker when deciding a borderline heading", () => {
    expect(activeHeadingIndex([100, 4], 8)).toBe(1);
    expect(activeHeadingIndex([100, 4], 2)).toBe(0);
    expect(activeHeadingIndex([12], 20)).toBe(0);
  });

  it("never activates an unrendered/hidden heading (Infinity offset)", () => {
    expect(activeHeadingIndex([10, Number.POSITIVE_INFINITY, -50])).toBe(2);
    expect(activeHeadingIndex([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY])).toBe(0);
  });

  it("lets the later of two same-offset headings (columns) win", () => {
    expect(activeHeadingIndex([-10, -10])).toBe(1);
    expect(activeHeadingIndex([50, 50])).toBe(0);
  });

  it("uses a small positive reading-line marker by default", () => {
    expect(TOC_ACTIVE_MARKER_PX).toBeGreaterThan(0);
    expect(activeHeadingIndex([TOC_ACTIVE_MARKER_PX])).toBe(0);
    expect(activeHeadingIndex([TOC_ACTIVE_MARKER_PX + 1])).toBe(0); // clamp, not crash
  });
});

describe("scrollBehavior", () => {
  it("gates the click scroll on prefers-reduced-motion", () => {
    expect(scrollBehavior(true)).toBe("auto");
    expect(scrollBehavior(false)).toBe("smooth");
  });
});
