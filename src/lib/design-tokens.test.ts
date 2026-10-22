import { describe, expect, it } from "vitest";
import {
  BREAKPOINT,
  DUR,
  EASE,
  RADIUS,
  SHADOW,
  SPACE,
  TAG_PALETTE,
  Z,
  isTagHue,
  tagClass,
  tagStyle,
} from "@/lib/design-tokens";

/**
 * The tokens are duplicated on purpose: `globals.css` declares the CSS
 * variables, this module exposes the numbers to JSX. These tests pin the values
 * so the two cannot drift silently, and pin the ordering rules the layering
 * depends on.
 */
describe("design tokens", () => {
  it("keeps the z-index scale strictly ordered", () => {
    const order = [Z.base, Z.sticky, Z.sidebar, Z.overlay, Z.popover, Z.modal, Z.toast, Z.tooltip, Z.drag];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]).toBeGreaterThan(order[i - 1]);
    }
  });

  it("keeps the duration scale ordered and within a sane range", () => {
    expect(DUR.instant).toBeLessThan(DUR.fast);
    expect(DUR.fast).toBeLessThan(DUR.base);
    expect(DUR.base).toBeLessThan(DUR.slow);
    expect(DUR.slow).toBeLessThan(DUR.slower);
    expect(DUR.slower).toBeLessThanOrEqual(400);
  });

  it("uses three easings with the smooth one as the default", () => {
    expect(EASE.smooth).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(EASE.spring).toContain("1.32"); // overshoot = spring
    expect(new Set(Object.values(EASE)).size).toBe(3);
  });

  it("uses a small radius scale (Notion-like, never pill-shaped)", () => {
    expect(RADIUS.xs).toBeLessThan(RADIUS.sm);
    expect(RADIUS.sm).toBeLessThan(RADIUS.md);
    expect(RADIUS.md).toBeLessThan(RADIUS.lg);
    expect(RADIUS.lg).toBeLessThan(RADIUS.xl);
    expect(RADIUS.xl).toBeLessThanOrEqual(16);
  });

  it("references CSS variables for elevation rather than raw values", () => {
    for (const value of Object.values(SHADOW)) {
      expect(value).toMatch(/^var\(--shadow-/);
    }
  });

  it("keeps the spacing grid at 4px", () => {
    expect(SPACE).toBe(4);
  });

  it("keeps breakpoints ordered", () => {
    const b = Object.values(BREAKPOINT);
    for (let i = 1; i < b.length; i += 1) expect(b[i]).toBeGreaterThan(b[i - 1]);
  });

  describe("tag hues", () => {
    it("ships exactly the ten hues the stylesheet defines", () => {
      expect(TAG_PALETTE).toHaveLength(10);
      expect(TAG_PALETTE).toContain("gray");
      expect(TAG_PALETTE).toContain("teal");
    });

    it("guards unknown hues", () => {
      expect(isTagHue("blue")).toBe(true);
      expect(isTagHue("chartreuse")).toBe(false);
      expect(isTagHue(null)).toBe(false);
      expect(isTagHue(7)).toBe(false);
    });

    it("falls back to gray for an unknown hue (never unstyled)", () => {
      expect(tagClass("nope")).toBe("tag tag-gray");
      expect(tagStyle("nope")).toEqual({
        color: "var(--tag-gray-fg)",
        background: "var(--tag-gray-bg)",
        borderColor: "var(--tag-gray-bd)",
      });
    });

    it("builds the class and style for a known hue", () => {
      expect(tagClass("teal")).toBe("tag tag-teal");
      expect(tagStyle("purple").color).toBe("var(--tag-purple-fg)");
    });
  });
});
