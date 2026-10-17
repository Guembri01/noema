import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NOEMA_MARK,
  NOEMA_MARK_PATH,
  NoemaMark,
  noemaMarkInkCentre,
  noemaMarkInkCoverage,
} from "./noema-mark";

/**
 * The brand mark, measured.
 *
 * A logo is easy to "improve" into something smaller than its slot: the first
 * version drew 11 units in a 24-unit box (~46% coverage) and read as a thin
 * glyph inside a big circle. These assertions pin the properties that make it
 * legible at 20px, so the next edit cannot quietly undo them.
 */
describe("NoemaMark geometry", () => {
  it("fills its slot: the ink covers more than half the viewBox on both axes", () => {
    const { width, height } = noemaMarkInkCoverage();
    expect(width).toBeGreaterThan(0.55);
    expect(height).toBeGreaterThan(0.55);
    // …and never bleeds into the corners, which would clip on a round button.
    expect(width).toBeLessThan(0.85);
    expect(height).toBeLessThan(0.85);
  });

  it("is optically centred", () => {
    const { x, y } = noemaMarkInkCentre();
    const middle = NOEMA_MARK.size / 2;
    expect(Math.abs(x - middle)).toBeLessThan(0.25);
    expect(Math.abs(y - middle)).toBeLessThan(0.25);
  });

  it("keeps the stroke inside a legible band", () => {
    // Below ~2.4 a 20px render thins out; above 3 the counters close up.
    expect(NOEMA_MARK.stroke).toBeGreaterThanOrEqual(2.4);
    expect(NOEMA_MARK.stroke).toBeLessThanOrEqual(3);
  });

  it("draws the letterform as left stem, diagonal, right stem", () => {
    const { left, right, top, bottom } = NOEMA_MARK.glyph;
    expect(NOEMA_MARK_PATH).toBe(`M${left} ${bottom}V${top}L${right} ${bottom}V${top}`);
    // The diagonal has to travel right and down, or it is not an "N".
    expect(right).toBeGreaterThan(left);
    expect(bottom).toBeGreaterThan(top);
  });
});

describe("NoemaMark render", () => {
  const html = renderToStaticMarkup(createElement(NoemaMark, { className: "h-5 w-5" }));

  it("paints with currentColor and carries no colour literals", () => {
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain("fill=\"none\"");
    // The design layer owns colour: a hex here would not follow the theme.
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(html).not.toContain("rgb(");
  });

  it("is decorative: it never announces itself twice inside a named control", () => {
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).toContain(`viewBox="0 0 ${NOEMA_MARK.size} ${NOEMA_MARK.size}"`);
  });

  it("accepts the caller's size class", () => {
    expect(html).toContain('class="h-5 w-5"');
  });
});
