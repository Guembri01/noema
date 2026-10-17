/**
 * Image sizing math — the pure intrinsic-vs-box arithmetic behind an image
 * block and a page cover (FEATURE_MATRIX "Image resize": rows :82 and :558).
 *
 * The editor stores an intrinsic size and needs to answer: how big is this
 * picture inside a content box, how does a cover crop to its frame, and what
 * does dragging a resize handle to `N%` or `Wpx` do to the stored numbers?
 * Those are all pure functions of `Size`, so they live here and vitest owns
 * them (new logic starts as a pure lib) — the React/DOM wiring and
 * the persisted node fields are separate. This module is deliberately
 * independent of `src/lib/media.ts`, which owns handle-drag *percentage*
 * maths; this one owns the pixel geometry.
 *
 * Contract: every result is integer pixels (`Math.round`), inputs are never
 * mutated, and anything unusable — a zero or non-finite side, a non-finite
 * percentage/bound — fails closed to a zero size (or `0` for a ratio/pixel)
 * rather than throwing or emitting `NaN` into a style attribute.
 */

/** A width/height pair, in whole pixels. */
export type Size = { w: number; h: number };

/** Optional per-axis caps for {@link clampSize}; an absent cap is unbounded. */
export type SizeBounds = { maxW?: number; maxH?: number };

/** The zero size every guard returns; also a useful "unknown" sentinel. */
export const ZERO_SIZE: Size = { w: 0, h: 0 };

/** `"1200x800"`, `"1200X800"`, `"1200×800"`, `"1200 x 800"` (case-insensitive). */
const DIMENSION_PATTERN = /^(\d+)\s*[x×*]\s*(\d+)$/i;

/** A bare unsigned integer, treated as a square side. */
const SQUARE_PATTERN = /^\d+$/;

const isPositive = (value: number): boolean => Number.isFinite(value) && value > 0;

/** Round a positive dimension to whole pixels; anything else collapses to 0. */
const roundDim = (value: number): number => (isPositive(value) ? Math.round(value) : 0);

/** A fresh zero size — callers can hold it without aliasing the constant. */
const zero = (): Size => ({ ...ZERO_SIZE });

/** Pair a width and height, or a fresh zero size if either side is unusable. */
function size(w: number, h: number): Size {
  return isPositive(w) && isPositive(h) ? { w: Math.round(w), h: Math.round(h) } : zero();
}

/**
 * Parse a stored intrinsic size. Accepts an `"WxH"` string (either `x` case or
 * the `×` sign, spaces allowed) or a bare number/`"512"` side, which is treated
 * as a square. Anything garbage — wrong shape, zero, negative, non-finite —
 * degrades to {@link ZERO_SIZE} instead of throwing.
 */
export function parseDimensions(input: string | number): Size {
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0
      ? { w: Math.round(input), h: Math.round(input) }
      : zero();
  }
  const text = input.trim();
  const pair = DIMENSION_PATTERN.exec(text);
  if (pair) {
    const w = Number(pair[1]);
    const h = Number(pair[2]);
    return isPositive(w) && isPositive(h) ? { w, h } : zero();
  }
  if (SQUARE_PATTERN.test(text)) {
    const side = Number(text);
    return isPositive(side) ? { w: side, h: side } : zero();
  }
  return zero();
}

/**
 * Scale `intrinsic` down — or up — so it fits entirely inside `box`, keeping
 * its aspect ratio: the CSS `object-fit: contain` result. The smaller ratio
 * wins, so at least one axis touches the box and the other letterboxes.
 * A zero/non-finite intrinsic or box yields a zero size.
 */
export function fitContain(intrinsic: Size, box: Size): Size {
  if (!isPositive(intrinsic.w) || !isPositive(intrinsic.h)) return zero();
  if (!isPositive(box.w) || !isPositive(box.h)) return zero();
  const scale = Math.min(box.w / intrinsic.w, box.h / intrinsic.h);
  return { w: roundDim(intrinsic.w * scale), h: roundDim(intrinsic.h * scale) };
}

/**
 * Scale `intrinsic` so it covers `box` entirely, keeping its aspect ratio: the
 * CSS `object-fit: cover` result. The larger ratio wins, so at least one axis
 * fills the box and the other overflows (the caller crops). A zero/non-finite
 * intrinsic or box yields a zero size.
 */
export function fitCover(intrinsic: Size, box: Size): Size {
  if (!isPositive(intrinsic.w) || !isPositive(intrinsic.h)) return zero();
  if (!isPositive(box.w) || !isPositive(box.h)) return zero();
  const scale = Math.max(box.w / intrinsic.w, box.h / intrinsic.h);
  return { w: roundDim(intrinsic.w * scale), h: roundDim(intrinsic.h * scale) };
}

/** Clamp one axis to an optional maximum; a missing/nonsense cap is unbounded. */
function clampAxis(value: number, max: number | undefined): number {
  const base = isPositive(value) ? Math.round(value) : 0;
  if (typeof max !== "number" || !isPositive(max)) return base;
  return Math.min(base, Math.round(max));
}

/**
 * Clamp each axis to its own cap, independently of the other — a `maxW` does
 * not rescale the height (that ratio-preserving job is {@link fitContain}).
 * An absent, zero, negative or non-finite cap leaves that axis untouched.
 * Always returns a fresh object.
 */
export function clampSize(size: Size, bounds: SizeBounds = {}): Size {
  return { w: clampAxis(size.w, bounds.maxW), h: clampAxis(size.h, bounds.maxH) };
}

/**
 * Width ÷ height of a size (`1.5` for `1200x800`). A zero or non-finite side
 * has no meaningful ratio and reports `0` rather than `Infinity`/`NaN`.
 */
export function aspectRatio(size: Size): number {
  if (!isPositive(size.w) || !isPositive(size.h)) return 0;
  return size.w / size.h;
}

/**
 * Scale both axes by `percent` (`50` halves, `150` grows by half), rounded to
 * whole pixels. A zero, negative or non-finite percentage — or a degenerate
 * size — collapses to a zero size.
 */
export function scalePercent(size: Size, percent: number): Size {
  if (!isPositive(size.w) || !isPositive(size.h)) return zero();
  if (!Number.isFinite(percent) || percent <= 0) return zero();
  const factor = percent / 100;
  return { w: roundDim(size.w * factor), h: roundDim(size.h * factor) };
}

/**
 * Resize to a target `width` while preserving the intrinsic ratio, returning
 * the derived height: the "resize by width" drag. A zero-in-width intrinsic
 * (nothing to preserve the ratio from) or a non-positive/non-finite target
 * yields a zero size.
 */
export function resizeByWidth(intrinsic: Size, width: number): Size {
  if (!isPositive(intrinsic.w) || !isPositive(intrinsic.h)) return zero();
  if (!isPositive(width)) return zero();
  const w = Math.round(width);
  return size(w, (w * intrinsic.h) / intrinsic.w);
}

/**
 * Resolve a percentage of a container to whole pixels, e.g. `50%` of an 800px
 * frame is `400`. Non-finite input reports `0` so callers never write `NaNpx`.
 */
export function percentToPx(pct: number, container: number): number {
  if (!Number.isFinite(pct) || !Number.isFinite(container)) return 0;
  return Math.round((pct / 100) * container);
}
