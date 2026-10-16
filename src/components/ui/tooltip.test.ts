import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Z } from "@/lib/design-tokens";
import {
  TOOLTIP_CONTENT_BASE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_DELAY_MS,
  TOOLTIP_SKIP_DELAY_MS,
  Tooltip,
  TooltipProvider,
  TooltipSurface,
} from "./tooltip";

/**
 * Node tests for the Tooltip contract: the motion + layering tokens, the
 * 500ms / instant-on-repeat delays, the `role="tooltip"` surface and a static
 * render of the convenience wrapper's trigger.
 */

describe("tooltip timing", () => {
  it("waits 500ms on first open and skips the delay on repeat", () => {
    expect(TOOLTIP_DELAY_MS).toBe(500);
    expect(TOOLTIP_SKIP_DELAY_MS).toBeGreaterThan(0);
    // Instant on repeat: the skip window is a fraction of the first-open wait.
    expect(TOOLTIP_SKIP_DELAY_MS).toBeLessThan(TOOLTIP_DELAY_MS);
  });
});

describe("tooltip motion + layering tokens", () => {
  it("uses the named rise/fade animations", () => {
    expect(TOOLTIP_CONTENT_BASE).toContain("animate-rise");
    expect(TOOLTIP_CONTENT_BASE).toContain("animate-fade");
    // No ad-hoc duration leaks into the class string.
    expect(TOOLTIP_CONTENT_BASE).not.toMatch(/\d+ms/);
  });

  it("layers at Z.tooltip, not a magic number", () => {
    expect(TOOLTIP_CONTENT_STYLE.zIndex).toBe(Z.tooltip);
    expect(Z.tooltip).toBe(80);
  });
});

describe("renderToStaticMarkup", () => {
  it("renders the surface with role=tooltip and the tooltip z-index", () => {
    const html = renderToStaticMarkup(
      createElement(TooltipSurface, null, "Bold"),
    );
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("z-index:80");
    expect(html).toContain("animate-rise");
    expect(html).toContain(">Bold<");
  });

  it("renders the wrapper's trigger and names it from a string label", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(
          Tooltip,
          { label: "Bold" },
          createElement("button", null, "B"),
        ),
      ),
    );
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Bold"');
  });

  it("renders each side without throwing", () => {
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const html = renderToStaticMarkup(
        createElement(
          TooltipProvider,
          null,
          createElement(
            Tooltip,
            { label: "tip", side },
            createElement("button", null, "x"),
          ),
        ),
      );
      expect(html).toContain("<button");
    }
  });
});
