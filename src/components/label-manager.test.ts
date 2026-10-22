import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * dz09 — labels manager: the pure colour-token mapping and the delete-impact
 * copy, plus a live render of the label list (chips, usage badges, inline
 * rename, delete affordance) and its empty/loading states.
 *
 * Client component: the Next router, the toast layer and the Server Actions it
 * calls are mocked; rendering goes through `react-dom/server`.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/server/actions/tickets", () => ({
  createLabelAction: vi.fn(),
  deleteLabelAction: vi.fn(),
  updateLabelAction: vi.fn(),
}));

import { TAG_PALETTE } from "@/lib/design-tokens";
import { LABEL_STYLES } from "@/lib/tickets";
import {
  LABEL_HUE_TOKENS,
  LabelManager,
  labelDeleteCopy,
  labelHue,
  labelSwatchStyle,
  type LabelManagerRow,
} from "./label-manager";

const h = createElement;

const labels: LabelManagerRow[] = [
  { id: "l1", name: "Bug", color: "red", description: "Something is broken", count: 3 },
  { id: "l2", name: "Design", color: "purple", description: null, count: 0 },
];

const render = (over: Partial<Parameters<typeof LabelManager>[0]> = {}) =>
  renderToStaticMarkup(
    h(LabelManager, { workspaceId: "w1", locale: "en", labels, ...over }),
  );

describe("labelHue", () => {
  it("maps every token hue to itself", () => {
    for (const hue of TAG_PALETTE) expect(labelHue(hue)).toBe(hue);
  });

  it("fails closed to gray for unknown colours", () => {
    expect(labelHue("chartreuse")).toBe("gray");
    expect(labelHue(null)).toBe("gray");
    expect(labelHue(undefined)).toBe("gray");
    expect(labelHue(7)).toBe("gray");
  });
});

describe("LABEL_HUE_TOKENS", () => {
  it("exposes all ten token hues and covers the persisted colour domain", () => {
    expect(LABEL_HUE_TOKENS).toHaveLength(10);
    expect([...LABEL_HUE_TOKENS]).toEqual([...TAG_PALETTE]);
    for (const color of LABEL_STYLES) {
      expect(LABEL_HUE_TOKENS).toContain(labelHue(color));
    }
  });
});

describe("labelSwatchStyle", () => {
  it("paints from the tag tokens, never a raw hex", () => {
    const style = labelSwatchStyle("red");
    expect(style.backgroundColor).toBe("var(--tag-red-fg)");
    expect(style.borderColor).toBe("var(--tag-red-bd)");
    expect(JSON.stringify(style)).not.toContain("#");
  });

  it("falls back to the gray tokens for an unknown colour", () => {
    expect(labelSwatchStyle("nope").backgroundColor).toBe("var(--tag-gray-fg)");
  });
});

describe("labelDeleteCopy", () => {
  it("names how many items use the label", () => {
    expect(labelDeleteCopy("Bug", 1).description).toContain("1 item uses");
    expect(labelDeleteCopy("Bug", 3).description).toContain("3 items use");
    expect(labelDeleteCopy("Bug", 3).title).toContain("Bug");
  });

  it("explains an unused label and clamps junk counts", () => {
    expect(labelDeleteCopy("Bug", 0).description).toContain("not attached to any items");
    expect(labelDeleteCopy("Bug", -4).description).toContain("not attached to any items");
    expect(labelDeleteCopy("Bug", Number.NaN).description).toContain("not attached");
  });
});

describe("LabelManager render", () => {
  it("lists labels as tag chips with usage badges and inline controls", () => {
    const html = render();
    expect(html).toContain("Bug");
    expect(html).toContain("Design");
    expect(html).toContain(">3<"); // the usage badge
    expect(html).toContain('aria-label="Rename Bug"');
    expect(html).toContain('aria-label="Delete Bug"');
    // The chip paints from the token palette.
    expect(html).toContain("--tag-red-");
  });

  it("renders an actionable empty state when there are no labels", () => {
    const html = render({ labels: [] });
    expect(html).toContain('data-empty-state="compact"');
    expect(html).toContain("No labels yet.");
  });

  it("renders a skeleton instead of the list while loading", () => {
    const html = render({ loading: true });
    expect(html).toContain("notion-skeleton");
    expect(html).not.toContain("No labels yet.");
  });
});
