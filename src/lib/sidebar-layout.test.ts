import { describe, expect, it } from "vitest";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_HIDDEN_STORAGE_KEY,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  dragSidebarWidth,
  nudgeSidebarWidth,
  parseStoredSidebarWidth,
} from "@/lib/sidebar-layout";

describe("sidebar layout model", () => {
  it("keeps the documented defaults consistent", () => {
    expect(SIDEBAR_MIN_WIDTH).toBeLessThan(SIDEBAR_DEFAULT_WIDTH);
    expect(SIDEBAR_DEFAULT_WIDTH).toBeLessThan(SIDEBAR_MAX_WIDTH);
    expect(SIDEBAR_WIDTH_STORAGE_KEY).toBe("noema:sidebar-width");
    expect(SIDEBAR_HIDDEN_STORAGE_KEY).toBe("noema:sidebar-hidden");
  });

  describe("clampSidebarWidth", () => {
    it("passes through a width inside the range", () => {
      expect(clampSidebarWidth(300)).toBe(300);
    });

    it("clamps below the minimum and above the maximum", () => {
      expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
      expect(clampSidebarWidth(9000)).toBe(SIDEBAR_MAX_WIDTH);
    });

    it("rounds fractional widths", () => {
      expect(clampSidebarWidth(300.6)).toBe(301);
    });

    it("falls back to the default for unusable input", () => {
      expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
      expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
      expect(clampSidebarWidth(Number.NEGATIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
    });
  });

  describe("dragSidebarWidth", () => {
    it("adds the horizontal delta", () => {
      expect(dragSidebarWidth(240, 60)).toBe(300);
      expect(dragSidebarWidth(240, -60)).toBe(200);
    });

    it("clamps at both ends", () => {
      expect(dragSidebarWidth(240, -500)).toBe(SIDEBAR_MIN_WIDTH);
      expect(dragSidebarWidth(240, 500)).toBe(SIDEBAR_MAX_WIDTH);
    });

    it("ignores a non-finite delta / start", () => {
      expect(dragSidebarWidth(240, Number.NaN)).toBe(240);
      expect(dragSidebarWidth(Number.NaN, 40)).toBe(SIDEBAR_DEFAULT_WIDTH + 40);
    });
  });

  describe("nudgeSidebarWidth", () => {
    it("nudges by the base step", () => {
      expect(nudgeSidebarWidth(240, 12)).toBe(252);
      expect(nudgeSidebarWidth(240, -12)).toBe(228);
    });

    it("uses the large step with Shift", () => {
      expect(nudgeSidebarWidth(240, 12, true)).toBe(280);
    });

    it("clamps at the bounds", () => {
      expect(nudgeSidebarWidth(SIDEBAR_MIN_WIDTH, -40)).toBe(SIDEBAR_MIN_WIDTH);
      expect(nudgeSidebarWidth(SIDEBAR_MAX_WIDTH, 40)).toBe(SIDEBAR_MAX_WIDTH);
    });
  });

  describe("parseStoredSidebarWidth", () => {
    it("parses a stored number", () => {
      expect(parseStoredSidebarWidth("310")).toBe(310);
    });

    it("defaults on absent/blank/corrupt values", () => {
      expect(parseStoredSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
      expect(parseStoredSidebarWidth("")).toBe(SIDEBAR_DEFAULT_WIDTH);
      expect(parseStoredSidebarWidth("   ")).toBe(SIDEBAR_DEFAULT_WIDTH);
      expect(parseStoredSidebarWidth("wide")).toBe(SIDEBAR_DEFAULT_WIDTH);
    });

    it("clamps an out-of-range stored value", () => {
      expect(parseStoredSidebarWidth("5")).toBe(SIDEBAR_MIN_WIDTH);
      expect(parseStoredSidebarWidth("100000")).toBe(SIDEBAR_MAX_WIDTH);
    });
  });
});
