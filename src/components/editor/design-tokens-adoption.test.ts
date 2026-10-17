import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Design-system source guard for the editor's two largest surfaces.
 *
 * `scripts/check-design-system.mjs` flags raw hex, legacy Tailwind palette
 * classes, magic z-index and ad-hoc durations across `src/components`, but it
 * is a *report* (always exit 0) with a tolerated baseline — so nothing stops
 * `page-editor.tsx` or `extensions/custom-blocks.tsx` from sliding back onto
 * the legacy palette. This test pins the same rules for those two files at
 * zero tolerance: they must stay on the design tokens.
 *
 * The regexes mirror `scripts/check-design-system.mjs` so the guard and the
 * report cannot disagree about what counts as a violation. Whitespace inside
 * the source is irrelevant, so this is a whole-file scan (the report skips
 * comment lines; these files carry no hex even there).
 */

/** Legacy Tailwind palette: `text-red-500`, `bg-blue-500/10`, … */
const LEGACY_PALETTE =
  /\b(?:bg|text|border|ring)-(?:red|blue|green|amber|orange|yellow|purple|pink|teal|emerald|slate|gray|zinc|neutral)-\d{2,3}\b/;
/** Raw colour literal (`#eee`, `#2383e2`) — comments included. */
const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/;
/** Magic z-index: `z-20`, `z-[999]`. */
const MAGIC_Z = /\bz-\[?\d/;
/** Ad-hoc motion: an inline `180ms`, a `duration-150` class. */
const AD_HOC_DURATION = /\b\d+ms\b|\bduration-\d/;

const FILES = ["page-editor.tsx", "extensions/custom-blocks.tsx"] as const;

describe("editor design-token adoption", () => {
  const source = (file: string) =>
    readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

  it.each(FILES)("%s carries no raw hex colour", (file) => {
    expect(source(file)).not.toMatch(RAW_HEX);
  });

  it.each(FILES)("%s carries no legacy Tailwind palette class", (file) => {
    expect(source(file)).not.toMatch(LEGACY_PALETTE);
  });

  it.each(FILES)("%s carries no magic z-index, ad-hoc duration or `transition: all`", (file) => {
    const src = source(file);
    expect(src).not.toMatch(MAGIC_Z);
    expect(src).not.toMatch(AD_HOC_DURATION);
    expect(src).not.toMatch(/\btransition[-:]?all\b/);
  });

  it("colours callouts through the shared tag palette, not Notion's pastels", () => {
    const src = source("extensions/custom-blocks.tsx");
    // The palette map resolves every hue to a `--tag-*-bg` token.
    expect(src).toMatch(/CALLOUT_COLORS[\s\S]*--tag-/);
    expect(src).toContain("var(--tag-blue-bg)");
  });

  it("resolves the presence cursor colour from the accent token", () => {
    const src = source("page-editor.tsx");
    // The caret needs a concrete `#rrggbb`, so the token is read at runtime
    // instead of being hard-coded.
    expect(src).toContain("presenceCursorColor");
    expect(src).toContain('getPropertyValue("--accent")');
  });
});
