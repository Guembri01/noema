/**
 * B96 — pure table-of-contents logic: view-local anchor slugs and the
 * scroll-spy offset calculation.
 *
 * ANCHOR STRATEGY (deliberate, pinned by toc.test.ts): headings emit NO ids
 * today (StarterKit renders plain h1–h6 with no id attribute) and none may be
 * invented in the document model — an `id` heading attr would leak into the
 * persisted doc JSON, duplicate across pages and drift from collab/Y.js
 * serialization. Anchors therefore exist ONLY in the view: `TocView` derives a
 * slug per heading from its text here (slugify + document-order dedupe) and
 * stamps `tocAnchorId(slug)` onto the rendered heading element at render time.
 * Nothing is written back to the doc; the ids vanish with the DOM.
 */

export interface TocHeading {
  /** Outline depth (1–6). */
  level: number;
  /** Heading text as it appears in the document (already trimmed). */
  text: string;
  /** ProseMirror document position of the heading node. */
  pos: number;
}

export interface TocItem extends TocHeading {
  /**
   * View-local anchor slug (deduped in document order). Never persisted.
   */
  slug: string;
}

/** Base slug for headings with no slug-shaped characters. */
const SLUG_FALLBACK = "section";

/**
 * Reading-line offset in px below the scroll container's top edge at which a
 * heading becomes the active outline entry. Small on purpose: it absorbs
 * sub-pixel rounding from `scrollIntoView` (so the clicked heading stays
 * active) without flipping the spy early.
 */
export const TOC_ACTIVE_MARKER_PX = 8;

/**
 * Lowercase, fold every run of non-letter/non-digit characters into a single
 * hyphen and trim the ends. Unicode letters/number survive so `Café au lait`
 * still anchors; anything left without a single slug character falls back to
 * {@link SLUG_FALLBACK}.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? SLUG_FALLBACK : slug;
}

/**
 * Attach a unique anchor slug to every heading in document order. Repeated
 * texts dedupe with `-2`, `-3`, … and a deduped slug can never collide with a
 * later literal `<name>-2` heading — every outline row keeps its own anchor.
 */
export function buildTocItems(headings: readonly TocHeading[]): TocItem[] {
  const used = new Set<string>();
  return headings.map((heading) => {
    const base = slugify(heading.text);
    let slug = base;
    for (let suffix = 2; used.has(slug); suffix += 1) {
      slug = `${base}-${suffix}`;
    }
    used.add(slug);
    return { ...heading, slug };
  });
}

/**
 * The DOM id stamped on the heading element that `slug` anchors to. Prefixed
 * so it can never collide with application ids (`<main id="main">`, …).
 */
export function tocAnchorId(slug: string): string {
  return `toc-${slug}`;
}

/**
 * Scroll-spy core. `relativeTops[i]` is heading i's distance from the scroll
 * container's top edge (`headingRect.top - containerRect.top`, recomputed per
 * scroll event; `Infinity` marks a heading that is hidden/unrendered).
 *
 * Returns the index of the active outline entry: the LAST heading at/above
 * `marker`. Before the first heading reaches the line the first entry stays
 * active (clamp — there is always a current entry while headings exist), and
 * `-1` means "no headings".
 */
export function activeHeadingIndex(
  relativeTops: readonly number[],
  marker: number = TOC_ACTIVE_MARKER_PX,
): number {
  if (relativeTops.length === 0) return -1;
  let active = 0;
  for (let i = 0; i < relativeTops.length; i += 1) {
    if (relativeTops[i] <= marker) active = i;
  }
  return active;
}

/**
 * prefers-reduced-motion gate for the outline click scroll: instant jumps for
 * users who opt out of motion, smooth scrolling otherwise.
 */
export function scrollBehavior(prefersReducedMotion: boolean): "auto" | "smooth" {
  return prefersReducedMotion ? "auto" : "smooth";
}
