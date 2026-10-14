/**
 * Cover reposition — focal-point model for a page cover image
 * (docs/MISSING_FEATURES.md §1 "Editor & blocks", row "Cover reposition":
 * "Drag the cover image position.").
 *
 * A `CoverPosition` is where the visible centre of the cover image sits,
 * expressed as percentages: `{ x: 0, y: 0 }` is top-left, `{ x: 50, y: 50 }`
 * is centred and `{ x: 100, y: 100 }` is bottom-right. That maps directly onto
 * the CSS `object-position` / `background-position` pair, so the stored value
 * needs no server-side transform — `formatObjectPosition` is the only bridge.
 *
 * Everything here is pure and dependency-free: parsing never throws (garbage,
 * `NaN` and `Infinity` degrade to the centred default), every result is
 * clamped into `0..100`, and helpers always return fresh objects so callers can
 * keep immutable state. Dragging is just `nudgePosition` with the pointer
 * delta; the UI wiring (persisting the field, pointer capture) is a separate
 * slice.
 */

/** Visible centre of a cover image, as percentages from the top-left corner. */
export type CoverPosition = { x: number; y: number };

/** Centred focal point — a new cover starts here. */
export const DEFAULT_COVER_POSITION: CoverPosition = { x: 50, y: 50 };

/** Inclusive low/high bound of a focal-point axis, in percent. */
export const MIN_COVER_POSITION = 0;
export const MAX_COVER_POSITION = 100;

/** Loose shape accepted from persisted/stored data. */
type RawCoverPosition = { x?: unknown; y?: unknown };

const clampAxis = (value: number): number =>
  Math.min(MAX_COVER_POSITION, Math.max(MIN_COVER_POSITION, value));

/** Round to hundredths so float drag math never leaks `49.99999` into CSS. */
const roundHundredths = (value: number): number => Math.round(value * 100) / 100;

/**
 * Coerce one stored axis to a finite number. Numbers pass through (when
 * finite); strings are trimmed and may carry a trailing `%` ("30%" → 30).
 * Anything else — `null`, booleans, objects, `NaN`, `Infinity` — is absent.
 */
function toFiniteAxis(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/%$/, "");
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Clamp a focal point into `0..100`, defaulting each missing/invalid axis to
 * the centred 50 — a bad `x` never drags a good `y` to an unrelated value.
 * Always returns a fresh object; the input is never mutated.
 */
export function normalizeCoverPosition(
  value: RawCoverPosition | null | undefined,
): CoverPosition {
  return {
    x: clampAxis(toFiniteAxis(value?.x) ?? DEFAULT_COVER_POSITION.x),
    y: clampAxis(toFiniteAxis(value?.y) ?? DEFAULT_COVER_POSITION.y),
  };
}

/**
 * Tolerant parser for a stored cover position. Accepts:
 * - a `{ x, y }` object (numeric or `"30%"` strings),
 * - a `[x, y]` tuple,
 * - a CSS-like `"x% y%"` / `"x y"` / `"x, y"` string,
 * - anything else (`undefined`, `null`, numbers, junk) → the centred default.
 *
 * Never throws; out-of-range values clamp and a missing axis defaults to 50.
 */
export function parseCoverPosition(raw: unknown): CoverPosition {
  if (typeof raw === "string") {
    const parts = raw.trim().split(/[\s,]+/).filter((part) => part !== "");
    return normalizeCoverPosition({ x: parts[0], y: parts[1] });
  }
  if (Array.isArray(raw)) {
    return normalizeCoverPosition({ x: raw[0], y: raw[1] });
  }
  if (raw !== null && typeof raw === "object") {
    return normalizeCoverPosition(raw as RawCoverPosition);
  }
  return { ...DEFAULT_COVER_POSITION };
}

/**
 * CSS `object-position` (and `background-position`) value for a focal point,
 * e.g. `"50% 40%"`. The input is normalized first, so an out-of-range or
 * non-finite position still renders a valid string.
 */
export function formatObjectPosition(position: CoverPosition): string {
  const { x, y } = normalizeCoverPosition(position);
  return `${roundHundredths(x)}% ${roundHundredths(y)}%`;
}

/**
 * Move a focal point by a pointer/percentage delta, clamped to `0..100`.
 * Non-finite deltas are ignored per axis (a dropped pointer event leaves the
 * position where it was). Returns a fresh object.
 */
export function nudgePosition(position: CoverPosition, dx: number, dy: number): CoverPosition {
  const base = normalizeCoverPosition(position);
  const stepX = Number.isFinite(dx) ? dx : 0;
  const stepY = Number.isFinite(dy) ? dy : 0;
  return normalizeCoverPosition({ x: base.x + stepX, y: base.y + stepY });
}
