import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COVER_GRADIENT_TOKENS,
  CustomizePanel,
  FONT_LABELS,
  FONT_OPTIONS,
  FONT_SELECT_OPTIONS,
  POSITION_PRESETS,
  coverPreviewCss,
  readCover,
  resolveToggleAction,
  splitCoverCss,
  writeCover,
  type CustomizePanelProps,
} from "./actions-menu";
import {
  DEFAULT_COVER_POSITION,
  formatObjectPosition,
} from "@/lib/cover-position";
import { GRADIENTS, coverCss, type GradientId } from "@/lib/page-cover";
import { PAGE_FONTS } from "@/lib/page-appearance";

/**
 * DS06 — Actions (⋯) menu.
 *
 * The pure bits (cover codec, option maps, toggle → payload) are driven
 * directly; the Customize panel is snapshotted with `renderToStaticMarkup` in
 * its default and cover-present states so the primitive wiring, the focus
 * contract and the hex-free token palette are pinned without a browser.
 */

const IMAGE = "https://images.example.com/cover.png";

/* --------------------------------------------------------------- codec ---- */

describe("cover codec (round-trips with page-title.tsx)", () => {
  it("omits the centred focal point so a plain preset round-trips byte-for-byte", () => {
    const written = writeCover(
      { type: "gradient", gradientId: "ocean" },
      DEFAULT_COVER_POSITION,
    );
    expect(written).toBe(GRADIENTS.ocean);
    expect(readCover(written)).toEqual({
      value: { type: "gradient", gradientId: "ocean" },
      position: { ...DEFAULT_COVER_POSITION },
    });
  });

  it("round-trips a positioned gradient", () => {
    const written = writeCover(
      { type: "gradient", gradientId: "sunset" },
      { x: 20, y: 80 },
    );
    expect(written).toBe(`${GRADIENTS.sunset} 20% 80%`);
    expect(readCover(written)).toEqual({
      value: { type: "gradient", gradientId: "sunset" },
      position: { x: 20, y: 80 },
    });
  });

  it("decodes the url(\"…\") form the encoder writes (the fixed codec bug)", () => {
    const written = writeCover({ type: "image", url: IMAGE }, { x: 20, y: 80 });
    expect(written).toBe(`url("${IMAGE}") 20% 80%`);
    // Before the fix `readCover` compared the whole `url(…)` string against
    // `isImageIcon` and returned null, so every image cover was dropped.
    expect(readCover(written)).toEqual({
      value: { type: "image", url: IMAGE },
      position: { x: 20, y: 80 },
    });
  });

  it("decodes exactly what page-title.tsx's encoder emits", () => {
    const asPageTitleWritesIt = `${coverCss({ type: "image", url: IMAGE })} ${formatObjectPosition({ x: 15, y: 65 })}`;
    expect(readCover(asPageTitleWritesIt)).toEqual({
      value: { type: "image", url: IMAGE },
      position: { x: 15, y: 65 },
    });
  });

  it("accepts the unquoted url(…) form as well", () => {
    expect(readCover(`url(${IMAGE}) 10% 90%`)).toEqual({
      value: { type: "image", url: IMAGE },
      position: { x: 10, y: 90 },
    });
  });

  it("splits css from an absent focal point as the centred default", () => {
    expect(splitCoverCss(GRADIENTS.sky)).toEqual({
      css: GRADIENTS.sky,
      position: { ...DEFAULT_COVER_POSITION },
    });
  });

  it("fails closed on absent, unknown or hostile values", () => {
    expect(readCover(null)).toBeNull();
    expect(readCover("")).toBeNull();
    expect(readCover("not a cover")).toBeNull();
    expect(readCover('url("javascript:alert(1)") 0% 0%')).toBeNull();
    expect(readCover("linear-gradient(120deg, #000 0%, #fff 100%)")).toBeNull();
  });
});

/* --------------------------------------------------------- option maps ---- */

describe("option maps", () => {
  it("font options mirror PAGE_FONTS in order, with labels", () => {
    expect(FONT_OPTIONS.map((option) => option.id)).toEqual([...PAGE_FONTS]);
    for (const option of FONT_OPTIONS) {
      expect(option.label).toBe(FONT_LABELS[option.id]);
    }
    expect(FONT_SELECT_OPTIONS).toEqual(
      FONT_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
    );
  });

  it("position presets cover the 3×3 grid, labels unique, centre present", () => {
    expect(POSITION_PRESETS).toHaveLength(9);
    const labels = POSITION_PRESETS.map((preset) => preset.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(POSITION_PRESETS).toContainEqual({
      label: "Center",
      position: { x: 50, y: 50 },
    });
  });

  it("every gradient preset has a token-only preview (no raw hex)", () => {
    const ids = Object.keys(GRADIENTS) as GradientId[];
    expect(Object.keys(COVER_GRADIENT_TOKENS).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const css = coverPreviewCss(id);
      expect(css).toContain("var(--tag-");
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });
});

/* ------------------------------------------------- toggle → payload ------- */

describe("resolveToggleAction", () => {
  it("flips small text through the appearance engine", () => {
    expect(
      resolveToggleAction("small-text", {
        smallText: true,
        hasAppearance: true,
      }),
    ).toEqual({ kind: "appearance", patch: { fontSize: "default" } });
    expect(
      resolveToggleAction("small-text", {
        smallText: false,
        hasAppearance: true,
      }),
    ).toEqual({ kind: "appearance", patch: { fontSize: "small" } });
  });

  it("falls back to the legacy key without the appearance engine", () => {
    expect(
      resolveToggleAction("small-text", {
        smallText: false,
        hasAppearance: false,
      }),
    ).toEqual({ kind: "toggle", key: "smallText" });
  });

  it("maps full-width and lock to their legacy keys", () => {
    expect(
      resolveToggleAction("full-width", {
        smallText: false,
        hasAppearance: true,
      }),
    ).toEqual({ kind: "toggle", key: "fullWidth" });
    expect(
      resolveToggleAction("lock", { smallText: false, hasAppearance: true }),
    ).toEqual({ kind: "toggle", key: "locked" });
  });

  it("returns null for a non-toggle row", () => {
    expect(
      resolveToggleAction("duplicate", {
        smallText: false,
        hasAppearance: true,
      }),
    ).toBeNull();
  });
});

/* --------------------------------------------------------------- render ---- */

const baseProps: CustomizePanelProps = {
  theme: "system",
  onThemeChange: () => {},
  highContrast: false,
  onHighContrastChange: () => {},
  contrastLabel: "14.0:1 body text",
  cover: null,
  position: { ...DEFAULT_COVER_POSITION },
  workspaceId: "ws_test",
  canEdit: true,
  onPickIcon: () => {},
  onPickCover: () => {},
  onPickPosition: () => {},
};

const render = (over: Partial<CustomizePanelProps> = {}): string =>
  renderToStaticMarkup(createElement(CustomizePanel, { ...baseProps, ...over }));

describe("CustomizePanel render", () => {
  it("default state: primitives, Section grouping, focus contract, no raw hex", () => {
    const html = render();
    expect(html).toContain('role="switch"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("High contrast");
    expect(html).toContain("<section");
    expect(html).toContain("focus-ring");
    expect(html).toContain("u-colors");
    expect(html).toContain("u-interactive");
    // Gradient swatches preview through the tag token palette, never the hex catalog.
    expect(html).toContain("var(--tag-blue-bg)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    // No cover → no position grid / remove action.
    expect(html).not.toContain("Remove cover");
    expect(html).not.toContain(">Position<");
    expect((html.match(/aria-label="Set cover /g) ?? []).length).toBe(8);
  });

  it("default state selects the resolved theme radio", () => {
    const html = render();
    expect(html).toMatch(/data-value="system"[^>]*aria-checked="true"/);
  });

  it("cover-present state: position grid + remove cover, still token-only", () => {
    const cover = readCover(`url("${IMAGE}") 20% 80%`);
    expect(cover).not.toBeNull();
    const html = render({ cover, position: { x: 20, y: 80 } });
    expect(html).toContain(">Position<");
    expect(html).toContain("Remove cover");
    expect((html.match(/aria-label="Cover position /g) ?? []).length).toBe(9);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("renders the high-contrast switch in the on state", () => {
    const html = render({ highContrast: true });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("data-state=\"checked\"");
  });

  /**
   * The `<button …>` that owns a label. The panel nests no buttons, so the
   * nearest opening tag before the label is the one that wraps it.
   *
   * Assertions below look for `disabled=""`, not the bare word: every control's
   * class list ends in `disabled:opacity-50`, so a substring test would say yes
   * to all of them.
   */
  const buttonFor = (html: string, label: string): string => {
    const at = html.indexOf(label);
    expect(at).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf("<button", at), at);
  };

  it("offers an image cover, not only gradients", () => {
    // `{ type: "image", url }` has always been in the model — and this menu could
    // already read and write it — but the grid of gradients was the whole cover
    // story, so an image cover was unreachable here. The link field and the
    // upload button are the route to it; both end at `validateCover`.
    const html = render();
    expect(html).toContain('type="url"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain('aria-label="Paste an image URL"');
    expect(buttonFor(html, "Upload")).toContain("focus-ring");
    expect(html).toContain("Use image");
  });

  it("keeps the Set button inert until there is a link to use", () => {
    expect(buttonFor(render(), "Use image")).toContain('disabled=""');
  });

  it("lets a read-only page look at covers, but not upload one", () => {
    expect(buttonFor(render(), "Upload")).not.toContain('disabled=""');
    expect(buttonFor(render({ canEdit: false }), "Upload")).toContain('disabled=""');
  });
});
