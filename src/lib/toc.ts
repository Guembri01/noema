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
 *
 * Additive deep-linking layer (same rule — view-only, never persisted):
 * `slugifyHeading` / `buildHeadingAnchors` produce deterministic,
 * collision-free anchor ids (`-1`, `-2`, … suffix chain) for deep links and
 * backlinks, and `activeHeadingIndex(headings, scrollOffset, opts)` /
 * `activeHeading(...)` run the scroll-spy maths against absolute heading tops
 * plus the scroll position (with an `offsetBias` for sticky-header heights).
 * The legacy `(relativeTops, marker)` form is untouched.
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
 * Deep-link anchor id for a heading: {@link slugify} plus collision-free
 * suffixing against a caller-owned `used` set (pass the same set across a
 * document to keep ids unique). On collision the suffix chain `-1`, `-2`, …
 * is appended, skipping any suffix already claimed in `used`; every emitted
 * id is registered back into `used`. Without `used` the call is stateless —
 * same text, same id. Unicode letters survive (URL fragments percent-encode
 * them fine), matching {@link slugify}'s anchor strategy.
 */
export function slugifyHeading(text: string, used?: Set<string>): string {
  const base = slugify(text);
  if (!used) return base;
  let slug = base;
  for (let suffix = 1; used.has(slug); suffix += 1) {
    slug = `${base}-${suffix}`;
  }
  used.add(slug);
  return slug;
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

/** A heading paired with its stable, collision-free deep-link anchor id. */
export interface TocAnchor extends TocHeading {
  /**
   * Anchor id derived from the heading text via {@link slugifyHeading}
   * (deduped in document order with the `-1`, `-2`, … chain). Never
   * persisted; deterministic for a given heading list.
   */
  id: string;
}

/**
 * Assign every heading a stable anchor id for deep links/backlinks. Pure and
 * deterministic: same input headings → same ids, across calls. Duplicate
 * titles get unique ids (`intro`, `intro-1`, …) and a fresh `used` set per
 * call so results never leak between invocations.
 */
export function buildHeadingAnchors(headings: readonly TocHeading[]): TocAnchor[] {
  const used = new Set<string>();
  return headings.map((heading) => ({
    ...heading,
    id: slugifyHeading(heading.text, used),
  }));
}

/**
 * The DOM id stamped on the heading element that `slug` anchors to. Prefixed
 * so it can never collide with application ids (`<main id="main">`, …).
 */
export function tocAnchorId(slug: string): string {
  return `toc-${slug}`;
}

/**
 * A heading carrying its top edge offset (px from the scroll origin, e.g.
 * `heading.offsetTop` or `rect.top + scrollTop`).
 */
export interface ScrollSpyHeading {
  /** Distance from the scroll origin to the heading's top edge, in px. */
  top: number;
}

export interface ActiveHeadingOptions {
  /**
   * Extra px added to the scroll position before comparing — the sticky
   * header's height, so a heading tucked under the header counts as in view.
   * Defaults to 0.
   */
  offsetBias?: number;
}

/**
 * Scroll-spy core. Two call forms, dispatched on the first element:
 *
 * 1. **Headings form** (deep-link/scroll-position friendly): given headings
 *    each with a known `top` and the current `scrollOffset`, returns the
 *    index of the LAST heading at/above `scrollOffset + offsetBias` — i.e.
 *    the heading currently in view. Clamped to [0, n−1]: scrolled above the
 *    first heading → 0, scrolled past the last → n−1. Empty list → `-1`
 *    (no headings, nothing active).
 * 2. **Legacy relative-tops form** (TocView): `relativeTops[i]` is heading
 *    i's distance from the scroll container's top edge (`Infinity` marks a
 *    hidden/unrendered heading), and `marker` is the reading line in that
 *    local space (defaults to {@link TOC_ACTIVE_MARKER_PX}). Before the first
 *    heading reaches the line the first entry stays active (clamp — there is
 *    always a current entry while headings exist), and `-1` means
 *    "no headings".
 */
export function activeHeadingIndex<T extends ScrollSpyHeading>(
  headings: readonly T[],
  scrollOffset?: number,
  opts?: ActiveHeadingOptions,
): number;
export function activeHeadingIndex(relativeTops: readonly number[], marker?: number): number;
export function activeHeadingIndex(
  tops: readonly (number | ScrollSpyHeading)[],
  second?: number,
  opts?: ActiveHeadingOptions,
): number {
  if (tops.length === 0) return -1;
  const first = tops[0];
  // Legacy form: plain numbers = relative tops, `second` = marker (reading
  // line in container-local space).
  if (typeof first === "number") {
    const marker = second ?? TOC_ACTIVE_MARKER_PX;
    let active = 0;
    for (let i = 0; i < tops.length; i += 1) {
      const top = tops[i];
      if (typeof top === "number" && top <= marker) active = i;
    }
    return active;
  }
  // Headings form: objects with `top`, `second` = scrollOffset, bias added.
  const readingLine = (second ?? 0) + (opts?.offsetBias ?? 0);
  let active = 0;
  for (let i = 0; i < tops.length; i += 1) {
    const heading = tops[i];
    if (typeof heading !== "number" && heading.top <= readingLine) active = i;
  }
  return active;
}

/**
 * Convenience wrapper over the headings form of {@link activeHeadingIndex}:
 * returns the heading currently in view, or `undefined` when the outline is
 * empty. Extra heading fields are preserved (generic over `T`).
 */
export function activeHeading<T extends ScrollSpyHeading>(
  headings: readonly T[],
  scrollOffset?: number,
  opts?: ActiveHeadingOptions,
): T | undefined {
  const index = activeHeadingIndex(headings, scrollOffset, opts);
  return index === -1 ? undefined : headings[index];
}

/**
 * prefers-reduced-motion gate for the outline click scroll: instant jumps for
 * users who opt out of motion, smooth scrolling otherwise.
 */
export function scrollBehavior(prefersReducedMotion: boolean): "auto" | "smooth" {
  return prefersReducedMotion ? "auto" : "smooth";
}
