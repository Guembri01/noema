import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BADGE_TONES,
  Badge,
  badgeSizeClass,
  badgeTone,
  badgeToneClass,
  formatCount,
  isBadgeTone,
} from "./badge";

/**
 * Badge (§9). Node tests pin count truncation and the tone map, then statically
 * render every tone/size and the `99+` case so the `--*-soft` backgrounds stay
 * wired to the token layer.
 */

const render = (props: Parameters<typeof Badge>[0]) =>
  renderToStaticMarkup(createElement(Badge, props));

describe("formatCount", () => {
  it("passes counts through at or below the ceiling", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1)).toBe("1");
    expect(formatCount(99)).toBe("99");
  });

  it("truncates above the ceiling to N+", () => {
    expect(formatCount(100)).toBe("99+");
    expect(formatCount(1000)).toBe("99+");
    expect(formatCount(10, 9)).toBe("9+");
    expect(formatCount(9, 9)).toBe("9");
  });

  it("degrades bad input to 0 and keeps the ceiling sane", () => {
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatCount(-5)).toBe("0");
    expect(formatCount(5.9)).toBe("5");
    expect(formatCount(100, 0)).toBe("1+");
  });
});

describe("tone map", () => {
  it("guards unknown tones", () => {
    expect(isBadgeTone("danger")).toBe(true);
    expect(isBadgeTone("chartreuse")).toBe(false);
    expect(badgeTone("chartreuse")).toBe("neutral");
    expect(badgeTone(null)).toBe("neutral");
  });

  it("uses --*-soft backgrounds with solid token ink", () => {
    expect(badgeToneClass("success")).toContain("bg-success-soft");
    expect(badgeToneClass("success")).toContain("text-success");
    expect(badgeToneClass("warning")).toContain("bg-warning-soft");
    expect(badgeToneClass("danger")).toContain("bg-danger-soft");
    expect(badgeToneClass("accent")).toContain("bg-accent-soft");
    expect(badgeToneClass("neutral")).toContain("bg-surface-2");
  });
});

describe("size map", () => {
  it("defaults to md and shrinks for sm", () => {
    expect(badgeSizeClass(undefined)).toBe(badgeSizeClass("md"));
    expect(badgeSizeClass("sm")).not.toBe(badgeSizeClass("md"));
  });
});

describe("render", () => {
  it("renders every tone with its soft background", () => {
    for (const tone of BADGE_TONES) {
      const html = render({ tone, children: tone });
      expect(html).toContain(`data-tone="${tone}"`);
    }
    expect(render({ tone: "success", children: "ok" })).toContain("bg-success-soft");
  });

  it("truncates the visible count but keeps the exact value in the title", () => {
    const html = render({ count: 1234 });
    expect(html).toContain("99+");
    expect(html).toContain('title="1234"');
    expect(html).toContain('data-truncated="true"');
  });

  it("does not truncate a count under the ceiling", () => {
    const html = render({ count: 7 });
    expect(html).toContain(">7<");
    expect(html).not.toContain("data-truncated");
  });

  it("renders an icon slot ahead of the text", () => {
    const html = render({ icon: createElement("span", null, "•"), children: "New" });
    expect(html).toContain("New");
    expect(html).toContain("•");
  });

  it("renders both sizes", () => {
    expect(render({ size: "sm", children: "x" })).toContain('data-size="sm"');
    expect(render({ size: "md", children: "x" })).toContain('data-size="md"');
  });
});
