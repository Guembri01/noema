import { describe, expect, it } from "vitest";
import { DUR, EASE } from "@/lib/design-tokens";
import {
  checkboxTickMotion,
  columnControlStyle,
  columnsToolbarClass,
  toggleExpandMotion,
} from "./custom-blocks";

/**
 * Pure motion mappings for the custom blocks: toggle expand, the to-do tick and
 * the columns hover chrome. They are the single source of truth the node views
 * read, so pinning them here keeps the presentation and its proof in step.
 */

describe("toggle expand motion", () => {
  it("animates over the base duration with the smooth easing", () => {
    const open = toggleExpandMotion(true);
    expect(open.duration).toBe(DUR.base);
    expect(open.easing).toBe(EASE.smooth);
  });

  it("rotates the chevron a quarter turn when open, and back when closed", () => {
    expect(toggleExpandMotion(true).chevronTransform).toBe("rotate(90deg)");
    expect(toggleExpandMotion(false).chevronTransform).toBe("rotate(0deg)");
  });

  it("maps the open and closed classes distinctly", () => {
    expect(toggleExpandMotion(true).className).not.toBe(toggleExpandMotion(false).className);
  });
});

describe("checkbox tick motion", () => {
  it("draws the check faster than it fades the strikethrough", () => {
    const motion = checkboxTickMotion(true);
    expect(motion.draw).toBeLessThanOrEqual(motion.strike);
    expect(motion.draw).toBe(DUR.fast);
    expect(motion.strike).toBe(DUR.base);
    expect(motion.easing).toBe(EASE.smooth);
  });

  it("maps checked and unchecked states distinctly", () => {
    expect(checkboxTickMotion(true).className).not.toBe(
      checkboxTickMotion(false).className,
    );
  });
});

describe("columns hover chrome", () => {
  it("fades the toolbar in on hover and while focused", () => {
    const cls = columnsToolbarClass();
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("group-hover:opacity-100");
    expect(cls).toContain("focus-within:opacity-100");
    expect(cls).toContain("u-colors");
  });

  it("paints the add/remove controls with the accent token", () => {
    const enabled = columnControlStyle(false);
    expect(enabled.color).toBe("var(--accent)");
    expect(enabled.background).toBe("var(--accent-soft)");
    expect(String(enabled.border)).toContain("var(--accent)");
    expect(enabled.cursor).toBe("pointer");
  });

  it("dims a disabled control and blocks the cursor", () => {
    const disabled = columnControlStyle(true);
    expect(disabled.opacity).toBe(0.5);
    expect(disabled.cursor).toBe("not-allowed");
    expect(disabled.color).toBe("var(--muted)");
  });
});
