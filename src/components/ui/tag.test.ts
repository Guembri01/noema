import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TAG_HUES } from "@/lib/design-tokens";
import {
  TAG_REMOVAL_IDLE,
  Tag,
  nextTagRemoval,
  tagDotClass,
  tagSizeClass,
} from "./tag";

/**
 * Tag / Chip (§9). Node tests pin the pure hue fallback, the size map and the
 * undo window state machine, then statically render every hue and every variant
 * so the palette can never drift from `--tag-<hue>-*`.
 */

const render = (props: Parameters<typeof Tag>[0]) =>
  renderToStaticMarkup(createElement(Tag, props));

describe("hue palette via tagStyle/tagClass", () => {
  it("renders every one of the ten hues with its CSS variables", () => {
    expect(TAG_HUES).toHaveLength(10);
    for (const hue of TAG_HUES) {
      const html = render({ hue, children: hue });
      expect(html).toContain(`--tag-${hue}-fg`);
      expect(html).toContain(`--tag-${hue}-bg`);
      expect(html).toContain(`--tag-${hue}-bd`);
      expect(html).toContain(`tag-${hue}`);
    }
  });

  it("falls back to gray for an unknown hue instead of rendering unstyled", () => {
    const html = render({ hue: "chartreuse", children: "x" });
    expect(html).toContain("--tag-gray-fg");
    expect(html).toContain("tag-gray");
    expect(html).not.toContain("chartreuse");
  });

  it("treats a missing hue as gray", () => {
    const html = render({ children: "x" });
    expect(html).toContain("--tag-gray-bg");
  });
});

describe("size map", () => {
  it("defaults to md and switches for sm", () => {
    expect(tagSizeClass(undefined)).toBe(tagSizeClass("md"));
    expect(tagSizeClass("sm")).not.toBe(tagSizeClass("md"));
    expect(tagSizeClass("sm")).toContain("text-[11px]");
  });

  it("tints the dot with currentColor at both sizes", () => {
    expect(tagDotClass("sm")).toContain("bg-current");
    expect(tagDotClass("md")).toContain("size-1.5");
    expect(render({ dot: true, children: "x" })).toContain("data-dot");
  });
});

describe("removable-with-undo state machine", () => {
  it("walks idle → pending → removed → idle", () => {
    const pending = nextTagRemoval(TAG_REMOVAL_IDLE, "remove");
    expect(pending.status).toBe("pending");
    const removed = nextTagRemoval(pending, "commit");
    expect(removed.status).toBe("removed");
    expect(nextTagRemoval(removed, "reset").status).toBe("idle");
  });

  it("undoes a pending removal back to idle", () => {
    const pending = nextTagRemoval(TAG_REMOVAL_IDLE, "remove");
    expect(nextTagRemoval(pending, "undo").status).toBe("idle");
  });

  it("ignores impossible transitions", () => {
    expect(nextTagRemoval(TAG_REMOVAL_IDLE, "commit").status).toBe("idle");
    expect(nextTagRemoval(TAG_REMOVAL_IDLE, "undo").status).toBe("idle");
    expect(nextTagRemoval(TAG_REMOVAL_IDLE, "remove").status).toBe("pending");
  });
});

describe("interactive variants render without layout shift", () => {
  it("marks a selectable chip pressed and focusable", () => {
    const html = render({
      selected: true,
      onSelectedChange: () => {},
      children: "Filter",
    });
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("focus-ring");
  });

  it("renders a labelled close control when closable", () => {
    const html = render({ closable: true, children: "x" });
    expect(html).toContain("data-tag-close");
    expect(html).toContain('aria-label="Remove"');
    expect(html).toContain("×");
  });

  it("swaps the close control for an undo control while a removal pends", () => {
    const html = render({ pendingRemoval: true, onUndo: () => {}, children: "x" });
    expect(html).toContain("data-tag-undo");
    expect(html).toContain('aria-label="Undo"');
    expect(html).not.toContain("data-tag-close");
  });
});
