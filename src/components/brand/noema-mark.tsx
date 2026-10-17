/**
 * Noema's mark: the "N" monogram, drawn with the current text colour.
 *
 * The first version was a hand-written path spanning 11×11 in a 24×24 viewBox
 * with a 2.4 stroke, so on the 20px Ask-AI button the ink covered ~46% of the
 * square and read as a thin glyph rattling inside a large circle. The geometry
 * below is measured rather than eyeballed — `noema-mark.test.ts` pins the ink
 * coverage, the centring and the stroke weight — and it is exported so the
 * button, the assistant's header and the app icon all draw one letterform.
 *
 * It stays an inline SVG (not an image file) and paints with `currentColor`, so
 * it is legible in light, dark and high-contrast themes without a second asset.
 */

/** The mark's geometry, in viewBox units. */
export const NOEMA_MARK = {
  /** Square viewBox side. */
  size: 24,
  /** Stroke weight. Heavier than a hairline, lighter than a chunky UI icon. */
  stroke: 2.5,
  /** The glyph's ink box *before* the stroke is applied. */
  glyph: { left: 5.5, right: 18.5, top: 6, bottom: 18 },
} as const;

const { left, right, top, bottom } = NOEMA_MARK.glyph;

/**
 * The letterform as one stroked polyline: left stem up, diagonal down, right
 * stem up. Round caps and joins (applied at render) turn the corners into the
 * soft terminals the rest of the UI uses.
 */
export const NOEMA_MARK_PATH = `M${left} ${bottom}V${top}L${right} ${bottom}V${top}`;

/**
 * How much of the viewBox the mark covers, stroke included, as fractions.
 *
 * This is the number that made the old mark look small: 0.46 wide in a button
 * whose icon box was already only half the button. Anything under ~0.55 reads
 * as a glyph that failed to fill its slot.
 */
export function noemaMarkInkCoverage(): { width: number; height: number } {
  return {
    width: (right - left + NOEMA_MARK.stroke) / NOEMA_MARK.size,
    height: (bottom - top + NOEMA_MARK.stroke) / NOEMA_MARK.size,
  };
}

/** Centre of the ink, in viewBox units — for the optical-centring test. */
export function noemaMarkInkCentre(): { x: number; y: number } {
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/**
 * The mark. Decorative by contract: every surface that renders it either sits
 * inside a control that names itself, or carries its own visible label, so
 * announcing the glyph again would only add noise.
 */
export function NoemaMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${NOEMA_MARK.size} ${NOEMA_MARK.size}`}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={NOEMA_MARK_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={NOEMA_MARK.stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
