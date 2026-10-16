import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PropertyType } from "@prisma/client";
import {
  Cell,
  TABLE_CELL_PADDING_PX,
  TABLE_FONT_PX,
  autoFitColumnWidth,
} from "./view-parts";
import type { DBProperty } from "@/components/database/database-types";

/**
 * fix07 — `@/lib/text-measure` (column auto-fit) and
 * `@/components/ui/emoji-picker` (which reaches `@/lib/emoji-frecency`) had no
 * production importer; both are now behind `view-parts.tsx`. These node tests
 * pin the measurement → width mapping (with a synthetic font fed in) and the
 * emoji-cell ⇄ picker wiring via static renders.
 */

const property = (
  type: string,
  config: unknown,
  name = "Field",
  id = "p1",
): DBProperty =>
  ({
    id,
    name,
    type: type as PropertyType,
    config: config as DBProperty["config"],
  }) as DBProperty;

const render = (props: Parameters<typeof Cell>[0]) =>
  renderToStaticMarkup(createElement(Cell, props));

describe("autoFitColumnWidth — em measurement → clamped pixel width", () => {
  // Every class 10 em, so the mapping is exact and independent of the model.
  const synthetic = {
    charWidths: { narrow: 10, wide: 10, cjk: 10, emoji: 10 },
    fontPx: 1,
    paddingPx: 0,
    min: 0,
    max: 1000,
  } as const;

  it("scales the measured width by the font size", () => {
    expect(autoFitColumnWidth(["abc"], synthetic)).toBe(30);
  });

  it("measures the widest line of a multi-line sample", () => {
    expect(autoFitColumnWidth(["ab\nabcdef"], synthetic)).toBe(60);
  });

  it("takes the widest across samples", () => {
    expect(autoFitColumnWidth(["a", "abcd", "ab"], { ...synthetic, fontPx: 2 })).toBe(
      80,
    );
  });

  it("adds the cell chrome and applies the default bounds", () => {
    // No samples → just the padding, floored by the default 80px minimum.
    expect(autoFitColumnWidth([])).toBe(80);
    // 8 ordinary (wide) glyphs * 14px + 32px = 144px, inside the default bounds.
    expect(autoFitColumnWidth(["ABCDEFGH"])).toBe(
      8 * TABLE_FONT_PX + TABLE_CELL_PADDING_PX,
    );
    // 3 glyphs * 14px + 32px = 74px, raised to the default 80px floor.
    expect(autoFitColumnWidth(["abc"])).toBe(80);
  });

  it("honours explicit bounds (the shared column-layout clamp)", () => {
    expect(
      autoFitColumnWidth(["abc"], { fontPx: 1, paddingPx: 0, min: 100, max: 1000 }),
    ).toBe(100);
    expect(
      autoFitColumnWidth(["abc"], { fontPx: 1000, paddingPx: 0, min: 0, max: 300 }),
    ).toBe(300);
  });
});

describe("ICON cell ⇄ emoji picker", () => {
  it("renders the stored glyph read-only", () => {
    const html = render({
      property: property("ICON", null, "Icon"),
      value: { emoji: "🎉" },
      editable: false,
      onChange: () => {},
      locale: "en",
    });
    expect(html).toContain("🎉");
    expect(html).not.toContain("emoji-picker-trigger");
  });

  it("falls back to a legacy { text } glyph", () => {
    const html = render({
      property: property("ICON", null, "Icon"),
      value: { text: "🚀" },
      editable: false,
      onChange: () => {},
      locale: "en",
    });
    expect(html).toContain("🚀");
  });

  it("renders the real picker trigger when editable", () => {
    const html = render({
      property: property("ICON", null, "Icon"),
      value: { emoji: "🎉" },
      editable: true,
      onChange: () => {},
      locale: "en",
      actingUserId: "u1",
    });
    expect(html).toContain('data-testid="emoji-picker-trigger"');
    expect(html).toContain("🎉");
  });

  it("shows an em dash for an empty read-only icon", () => {
    const html = render({
      property: property("ICON", null, "Icon"),
      value: {},
      editable: false,
      onChange: () => {},
      locale: "en",
    });
    expect(html).toContain("—");
  });
});
