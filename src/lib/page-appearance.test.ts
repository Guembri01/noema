import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  PAGE_FONTS,
  appearanceClasses,
  deserializeAppearance,
  isDefaultAppearance,
  parseAppearance,
  patchAppearance,
  serializeAppearance,
} from "./page-appearance";
import type { PageAppearance } from "./page-appearance";

/**
 * docs/MISSING_FEATURES.md §1 "Small text" / "Page fonts" / "Line spacing".
 *
 * Red-first: `src/lib/page-appearance.ts` does not exist until this lands - the
 * first run fails to resolve the import, then the suite goes green with the
 * implementation. Pure logic only: no DB, no routes, no React.
 *
 * The class names are pinned to the ones `src/app/globals.css` (and the page
 * route) already use, so a rename there must trip this suite.
 */

/** A complete appearance with one field overridden, for table-ish tests. */
function withAppearance(patch: Partial<PageAppearance>): PageAppearance {
  return { ...DEFAULT_APPEARANCE, ...patch };
}

describe("DEFAULT_APPEARANCE", () => {
  it("is the neutral every-page baseline", () => {
    expect(DEFAULT_APPEARANCE.fontSize).toBe("default");
    expect(DEFAULT_APPEARANCE.font).toBe("default");
    expect(DEFAULT_APPEARANCE.lineSpacing).toBe("normal");
  });
});

describe("parseAppearance", () => {
  it("returns the defaults for missing or non-object input", () => {
    expect(parseAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance("serif")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance(42)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance([])).toEqual(DEFAULT_APPEARANCE);
  });

  it("keeps every valid enum member verbatim", () => {
    expect(
      parseAppearance({ fontSize: "small", font: "mono", lineSpacing: "loose" }),
    ).toEqual({ fontSize: "small", font: "mono", lineSpacing: "loose" });
    expect(
      parseAppearance({ fontSize: "default", font: "serif", lineSpacing: "tight" }),
    ).toEqual({ fontSize: "default", font: "serif", lineSpacing: "tight" });
  });

  it("falls back per-field for unknown enum members", () => {
    const parsed = parseAppearance({
      fontSize: "huge",
      font: "comic-sans",
      lineSpacing: 1.5,
    });
    expect(parsed).toEqual(DEFAULT_APPEARANCE);
  });

  it("fills the gaps of a partial object without throwing", () => {
    expect(parseAppearance({})).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance({ fontSize: "small" })).toEqual(
      withAppearance({ fontSize: "small" }),
    );
    expect(parseAppearance({ font: "serif" })).toEqual(
      withAppearance({ font: "serif" }),
    );
  });

  it("ignores junk nested values and never throws", () => {
    expect(() => parseAppearance({ fontSize: {}, font: [], lineSpacing: "  " })).not.toThrow();
    expect(parseAppearance({ fontSize: {}, font: [], lineSpacing: "  " })).toEqual(
      DEFAULT_APPEARANCE,
    );
  });

  it("does not mutate its input", () => {
    const input = { fontSize: "small", font: "serif", lineSpacing: "loose" };
    const before = { ...input };
    parseAppearance(input);
    expect(input).toEqual(before);
  });
});

describe("appearanceClasses", () => {
  it("emits no classes for the default appearance", () => {
    expect(appearanceClasses(DEFAULT_APPEARANCE)).toEqual([]);
    expect(appearanceClasses(withAppearance({ fontSize: "default" }))).toEqual([]);
  });

  it("maps the small text size to the editor class", () => {
    expect(appearanceClasses(withAppearance({ fontSize: "small" }))).toEqual([
      "noema-page-small",
    ]);
  });

  it("maps each font preset to its class", () => {
    expect(appearanceClasses(withAppearance({ font: "serif" }))).toEqual([
      "noema-font-serif",
    ]);
    expect(appearanceClasses(withAppearance({ font: "mono" }))).toEqual([
      "noema-font-mono",
    ]);
  });

  it("maps each line spacing to its class", () => {
    expect(appearanceClasses(withAppearance({ lineSpacing: "tight" }))).toEqual([
      "noema-line-tight",
    ]);
    expect(appearanceClasses(withAppearance({ lineSpacing: "loose" }))).toEqual([
      "noema-line-loose",
    ]);
  });

  it("combines every non-default option in a stable order", () => {
    expect(
      appearanceClasses({
        fontSize: "small",
        font: "mono",
        lineSpacing: "tight",
      }),
    ).toEqual(["noema-page-small", "noema-font-mono", "noema-line-tight"]);
    expect(
      appearanceClasses({
        fontSize: "small",
        font: "serif",
        lineSpacing: "loose",
      }),
    ).toEqual(["noema-page-small", "noema-font-serif", "noema-line-loose"]);
  });
});

describe("patchAppearance", () => {
  it("merges the patch onto the current value", () => {
    const current = withAppearance({ fontSize: "small", font: "serif" });
    expect(patchAppearance(current, { lineSpacing: "loose" })).toEqual({
      fontSize: "small",
      font: "serif",
      lineSpacing: "loose",
    });
    expect(patchAppearance(current, { font: "mono" }).font).toBe("mono");
  });

  it("leaves the current value untouched (immutable input)", () => {
    const current = withAppearance({ fontSize: "small" });
    const before = { ...current };
    const next = patchAppearance(current, { fontSize: "default" });
    expect(current).toEqual(before);
    expect(next).not.toBe(current);
    expect(next.fontSize).toBe("default");
  });

  it("ignores unknown or missing patch members", () => {
    const current = withAppearance({ font: "serif", lineSpacing: "tight" });
    expect(
      patchAppearance(current, { font: "wingdings" as PageAppearance["font"] }),
    ).toEqual(current);
    expect(patchAppearance(current, {})).toEqual(current);
    expect(patchAppearance(current, { lineSpacing: undefined })).toEqual(current);
  });

  it("tolerates a garbage current value by starting from the defaults", () => {
    expect(patchAppearance(undefined as unknown as PageAppearance, { font: "mono" })).toEqual(
      withAppearance({ font: "mono" }),
    );
  });
});

describe("serializeAppearance / deserializeAppearance", () => {
  it("round-trips every appearance through JSON", () => {
    const samples: PageAppearance[] = [
      DEFAULT_APPEARANCE,
      withAppearance({ fontSize: "small" }),
      withAppearance({ font: "serif" }),
      withAppearance({ font: "mono", lineSpacing: "tight" }),
      { fontSize: "small", font: "serif", lineSpacing: "loose" },
    ];
    for (const sample of samples) {
      expect(deserializeAppearance(serializeAppearance(sample))).toEqual(sample);
    }
  });

  it("serializes to a stable, sanitized JSON string", () => {
    expect(serializeAppearance(DEFAULT_APPEARANCE)).toBe(
      '{"fontSize":"default","font":"default","lineSpacing":"normal"}',
    );
    expect(
      serializeAppearance({ fontSize: "small", font: "mono", lineSpacing: "loose" }),
    ).toBe('{"fontSize":"small","font":"mono","lineSpacing":"loose"}');
  });

  it("sanitizes garbage before serializing", () => {
    expect(serializeAppearance(null)).toBe(serializeAppearance(DEFAULT_APPEARANCE));
    expect(serializeAppearance({ font: "comic-sans" })).toBe(
      serializeAppearance(DEFAULT_APPEARANCE),
    );
  });

  it("deserializes null, garbage and malformed JSON to the defaults", () => {
    expect(deserializeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(deserializeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(deserializeAppearance("")).toEqual(DEFAULT_APPEARANCE);
    expect(deserializeAppearance("not json")).toEqual(DEFAULT_APPEARANCE);
    expect(deserializeAppearance("{")).toEqual(DEFAULT_APPEARANCE);
    expect(deserializeAppearance(7)).toEqual(DEFAULT_APPEARANCE);
  });

  it("drops unknown enum members while deserializing", () => {
    expect(
      deserializeAppearance('{"fontSize":"huge","font":"serif","lineSpacing":"loose"}'),
    ).toEqual(withAppearance({ font: "serif", lineSpacing: "loose" }));
  });
});

describe("isDefaultAppearance", () => {
  it("is true only for the neutral appearance", () => {
    expect(isDefaultAppearance(DEFAULT_APPEARANCE)).toBe(true);
    expect(isDefaultAppearance(withAppearance({}))).toBe(true);
    expect(isDefaultAppearance({ fontSize: "small" })).toBe(false);
    expect(isDefaultAppearance(withAppearance({ font: "serif" }))).toBe(false);
    expect(isDefaultAppearance(withAppearance({ lineSpacing: "loose" }))).toBe(false);
  });

  it("treats unparseable input as the default (nothing to store)", () => {
    expect(isDefaultAppearance(null)).toBe(true);
    expect(isDefaultAppearance(undefined)).toBe(true);
    expect(isDefaultAppearance("junk")).toBe(true);
  });
});

describe("extended font presets", () => {
  it("lists every supported preset, default first", () => {
    expect(PAGE_FONTS[0]).toBe("default");
    expect(PAGE_FONTS).toContain("serif");
    expect(PAGE_FONTS).toContain("sans");
    expect(PAGE_FONTS).toContain("mono");
    expect(PAGE_FONTS).toContain("literata");
    expect(PAGE_FONTS).toContain("newsreader");
    expect(new Set(PAGE_FONTS).size).toBe(PAGE_FONTS.length);
  });

  it("keeps every known preset verbatim through parseAppearance", () => {
    for (const font of PAGE_FONTS) {
      expect(parseAppearance({ font })).toEqual(withAppearance({ font }));
    }
  });

  it("falls back to the default for unknown or mistyped presets", () => {
    expect(parseAppearance({ font: "wingdings" })).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance({ font: "SANS" })).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearance({ font: "comic-sans" })).toEqual(DEFAULT_APPEARANCE);
  });

  it("maps each non-default preset to its own class", () => {
    expect(appearanceClasses(withAppearance({ font: "sans" }))).toEqual([
      "noema-font-sans",
    ]);
    expect(appearanceClasses(withAppearance({ font: "literata" }))).toEqual([
      "noema-font-literata",
    ]);
    expect(appearanceClasses(withAppearance({ font: "newsreader" }))).toEqual([
      "noema-font-newsreader",
    ]);
  });

  it("emits no font class for the default preset", () => {
    expect(appearanceClasses(withAppearance({ font: "default" }))).toEqual([]);
  });

  it("round-trips every preset through serialize/deserialize", () => {
    for (const font of PAGE_FONTS) {
      const appearance = withAppearance({ font });
      expect(deserializeAppearance(serializeAppearance(appearance))).toEqual(
        appearance,
      );
    }
  });

  it("normalizes an unknown stored preset to the default per field", () => {
    expect(
      deserializeAppearance(
        '{"fontSize":"small","font":"papyrus","lineSpacing":"loose"}',
      ),
    ).toEqual({ fontSize: "small", font: "default", lineSpacing: "loose" });
  });

  it("accepts the new presets through patchAppearance", () => {
    expect(patchAppearance(DEFAULT_APPEARANCE, { font: "literata" })).toEqual(
      withAppearance({ font: "literata" }),
    );
  });
});
