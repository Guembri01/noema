import { describe, expect, it } from "vitest";
import {
  activeHeading,
  activeHeadingIndex,
  buildHeadingAnchors,
  buildTocItems,
  scrollBehavior,
  slugify,
  slugifyHeading,
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
 *
 * Additive rows (deep-linking + scroll-position form):
 *  - `slugifyHeading` / `buildHeadingAnchors`: deterministic, collision-free
 *    anchor ids for deep links/backlinks (`-1`, `-2`, … suffix chain).
 *  - `activeHeadingIndex(headings, scrollOffset, opts)`: the same spy maths
 *    expressed against absolute heading tops + the scroll position, with an
 *    `offsetBias` for sticky-header heights. The legacy
 *    `(relativeTops, marker)` form stays byte-compatible.
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

describe("slugifyHeading", () => {
  it("produces the URL-safe base for deep links when nothing is claimed yet", () => {
    expect(slugifyHeading("Getting Started")).toBe("getting-started");
    expect(slugifyHeading("Intro")).toBe("intro");
  });

  it("lowercases, strips punctuation and keeps unicode letters", () => {
    expect(slugifyHeading("Café — Übung #3!")).toBe("café-übung-3");
    expect(slugifyHeading("  Setup: [done]  ")).toBe("setup-done");
  });

  it("routes empty/punctuation-only text through the section fallback", () => {
    expect(slugifyHeading("")).toBe("section");
    expect(slugifyHeading("   ")).toBe("section");
    expect(slugifyHeading("!!!")).toBe("section");
  });

  it("suffixes collisions -1, -2, … and registers every id in used", () => {
    const used = new Set<string>();
    expect(slugifyHeading("Intro", used)).toBe("intro");
    expect(slugifyHeading("Intro", used)).toBe("intro-1");
    expect(slugifyHeading("Intro", used)).toBe("intro-2");
    // every emitted id is tracked so later headings can never shadow earlier ones
    expect(used).toEqual(new Set(["intro", "intro-1", "intro-2"]));
  });

  it("skips suffixes already claimed in a pre-seeded used set", () => {
    const used = new Set(["intro", "intro-1"]);
    expect(slugifyHeading("Intro", used)).toBe("intro-2");
    expect(slugifyHeading("Intro", used)).toBe("intro-3");
  });

  it("chains the fallback for colliding empty-text headings too", () => {
    const used = new Set<string>();
    expect(slugifyHeading("", used)).toBe("section");
    expect(slugifyHeading("   ", used)).toBe("section-1");
  });

  it("is stateless without a used set (same input → same id)", () => {
    expect(slugifyHeading("Intro")).toBe(slugifyHeading("Intro"));
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

describe("buildHeadingAnchors", () => {
  const heading = (text: string, level = 2, pos = 0) => ({ level, text, pos });

  it("keeps heading fields and adds a stable id per heading", () => {
    expect(buildHeadingAnchors([heading("Intro", 3, 12)])).toEqual([
      { level: 3, text: "Intro", pos: 12, id: "intro" },
    ]);
  });

  it("assigns unique ids across duplicate titles (-1, -2, …)", () => {
    const ids = buildHeadingAnchors([
      heading("Intro", 2, 1),
      heading("Intro", 2, 40),
      heading("Intro", 3, 80),
    ]).map((item) => item.id);
    expect(ids).toEqual(["intro", "intro-1", "intro-2"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic — repeated calls on the same input agree", () => {
    const headings = [heading("Setup"), heading("Setup"), heading("Teardown")];
    expect(buildHeadingAnchors(headings)).toEqual(buildHeadingAnchors(headings));
  });

  it("chains blank headings through the section fallback", () => {
    const ids = buildHeadingAnchors([heading("  "), heading("!!!")]).map((item) => item.id);
    expect(ids).toEqual(["section", "section-1"]);
  });

  it("returns an empty list for an empty outline", () => {
    expect(buildHeadingAnchors([])).toEqual([]);
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

describe("activeHeadingIndex — headings + scrollOffset form", () => {
  const at = (...tops: number[]) => tops.map((top) => ({ top }));

  it("returns -1 when there are no headings", () => {
    expect(activeHeadingIndex([], 120)).toBe(-1);
  });

  it("clamps to 0 while scrolled above the first heading", () => {
    expect(activeHeadingIndex(at(200, 400), 0)).toBe(0);
    expect(activeHeadingIndex(at(200, 400), 199)).toBe(0);
  });

  it("activates a heading exactly on the reading line", () => {
    expect(activeHeadingIndex(at(200, 400), 200)).toBe(0);
    expect(activeHeadingIndex(at(200, 400), 400)).toBe(1);
  });

  it("activates the last heading at/above the scroll position between headings", () => {
    expect(activeHeadingIndex(at(200, 400, 600), 399)).toBe(0);
    expect(activeHeadingIndex(at(200, 400, 600), 401)).toBe(1);
  });

  it("clamps to the last heading when scrolled past the end", () => {
    expect(activeHeadingIndex(at(200, 400), 9_999)).toBe(1);
  });

  it("adds offsetBias (sticky-header height) to the reading line", () => {
    const headings = at(100, 400);
    expect(activeHeadingIndex(headings, 336, { offsetBias: 64 })).toBe(1);
    expect(activeHeadingIndex(headings, 336, { offsetBias: 0 })).toBe(0);
    expect(activeHeadingIndex(headings, 336)).toBe(0); // bias defaults to 0
  });

  it("dispatches on the first element: numbers stay legacy (relative tops + marker)", () => {
    // Same numbers, different defaults: the legacy marker defaults to
    // TOC_ACTIVE_MARKER_PX (8) so heading 2 wins; the headings form defaults
    // to scrollOffset 0 / offsetBias 0 so neither is at/above → clamp 0.
    expect(activeHeadingIndex([9, 4])).toBe(1);
    expect(activeHeadingIndex(at(9, 4))).toBe(0);
    expect(activeHeadingIndex(at(9, 4), 4)).toBe(1);
  });
});

describe("activeHeading", () => {
  it("returns undefined when there are no headings", () => {
    expect(activeHeading([], 120)).toBeUndefined();
  });

  it("returns the heading object in view (identity, extra fields intact)", () => {
    const headings = [
      { level: 2, text: "Intro", pos: 4, top: 100 },
      { level: 3, text: "Detail", pos: 40, top: 300 },
    ];
    expect(activeHeading(headings, 90)).toBe(headings[0]);
    expect(activeHeading(headings, 350)).toBe(headings[1]);
  });

  it("applies offsetBias to the reading line", () => {
    const headings = [
      { text: "A", top: 200 },
      { text: "B", top: 500 },
    ];
    expect(activeHeading(headings, 436, { offsetBias: 64 })?.text).toBe("B");
    expect(activeHeading(headings, 436)?.text).toBe("A"); // bias defaults to 0
  });
});

describe("scrollBehavior", () => {
  it("gates the click scroll on prefers-reduced-motion", () => {
    expect(scrollBehavior(true)).toBe("auto");
    expect(scrollBehavior(false)).toBe("smooth");
  });
});
