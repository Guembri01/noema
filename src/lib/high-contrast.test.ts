import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HIGH_CONTRAST_TOKENS,
  contrastRatio,
  meetsContrast,
  relativeLuminance,
} from "./high-contrast";
import type { ContrastTheme, ContrastToken } from "./high-contrast";

const THEMES: ContrastTheme[] = ["light", "dark"];

/** Pairs where text must clear WCAG AA (4.5:1) in a high-contrast theme. */
const TEXT_PAIRS: Array<[ContrastToken, ContrastToken]> = [
  ["fg", "bg"],
  ["fg", "sidebar"],
  ["fg", "surface"],
  ["fg", "surface-2"],
  ["muted", "bg"],
  ["muted", "sidebar"],
  ["muted", "surface"],
  ["muted", "surface-2"],
  ["accent", "bg"],
  ["accent", "sidebar"],
  ["accent", "surface"],
  ["accent", "surface-2"],
  ["accent-fg", "accent"],
  ["fg", "selection"],
  ["muted", "selection"],
];

/** Pairs where UI boundaries must clear WCAG 1.4.11 non-text contrast (3:1). */
const NON_TEXT_PAIRS: Array<[ContrastToken, ContrastToken]> = [
  ["border", "bg"],
  ["border", "sidebar"],
  ["border", "surface"],
  ["border", "surface-2"],
];

describe("contrastRatio", () => {
  it("is 21:1 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("is 1:1 for identical colours", () => {
    expect(contrastRatio("#1a75d2", "#1a75d2")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#0b57d0", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#0b57d0"),
      10,
    );
  });

  it("supports shorthand hex", () => {
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 5);
  });

  it("rejects values that are not hex colours", () => {
    expect(() => contrastRatio("red", "#ffffff")).toThrow(/hex/i);
    expect(() => relativeLuminance("#12345")).toThrow(/hex/i);
  });
});

describe("meetsContrast", () => {
  it("defaults to the AA text threshold of 4.5:1", () => {
    expect(meetsContrast("#000000", "#ffffff")).toBe(true);
    expect(meetsContrast("#767676", "#ffffff")).toBe(true); // 4.54:1
    expect(meetsContrast("#777777", "#ffffff")).toBe(false); // 4.48:1
  });

  it("accepts a custom threshold for non-text contrast", () => {
    expect(meetsContrast("#767676", "#ffffff", 3)).toBe(true);
  });
});

describe.each(THEMES)("%s high-contrast tokens", (theme) => {
  const tokens = HIGH_CONTRAST_TOKENS[theme];

  it("defines every colour token as an opaque hex value", () => {
    for (const value of Object.values(tokens)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("meets WCAG AA (>= 4.5:1) for every text pair", () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      expect(
        contrastRatio(tokens[fg], tokens[bg]),
        `${fg} on ${bg} (${tokens[fg]} / ${tokens[bg]})`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("meets WCAG 1.4.11 (>= 3:1) for borders against every surface", () => {
    for (const [a, b] of NON_TEXT_PAIRS) {
      expect(
        contrastRatio(tokens[a], tokens[b]),
        `${a} on ${b} (${tokens[a]} / ${tokens[b]})`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("beats the default theme's border contrast", () => {
    // The stock theme borders sit near 1.2:1; high contrast must do better.
    expect(contrastRatio(tokens.border, tokens.bg)).toBeGreaterThanOrEqual(3);
  });
});

describe("high-contrast tokens beat the default tokens on body text", () => {
  it("light theme body text contrast improves", () => {
    expect(contrastRatio("#1b1b1b", "#ffffff")).toBeGreaterThan(
      contrastRatio("#37352f", "#ffffff"),
    );
  });

  it("dark theme body text contrast improves", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeGreaterThan(
      contrastRatio("#cfcfcf", "#191919"),
    );
  });
});

describe("globals.css wiring", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

  /** Body of the first `selector { ... }` rule (no nested braces expected). */
  function ruleBody(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} rule missing from globals.css`).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  }

  /** Balanced-brace body of the `@media (...) { ... }` block starting at `marker`. */
  function mediaBody(marker: string): string {
    const start = css.indexOf(`${marker} {`);
    expect(start, `${marker} block missing from globals.css`).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let body = "";
    for (let i = start + marker.length; i < css.length; i++) {
      const ch = css[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        if (depth === 0) break;
        depth--;
      }
      body += ch;
    }
    return body;
  }

  it("mirrors the light tokens in the .high-contrast root override", () => {
    const body = ruleBody(".high-contrast");
    for (const [token, value] of Object.entries(HIGH_CONTRAST_TOKENS.light)) {
      expect(body, `--${token}`).toContain(`--${token}: ${value};`);
    }
  });

  it("mirrors the dark tokens in the .high-contrast.dark override", () => {
    const body = ruleBody(".high-contrast.dark");
    for (const [token, value] of Object.entries(HIGH_CONTRAST_TOKENS.dark)) {
      expect(body, `--${token}`).toContain(`--${token}: ${value};`);
    }
  });

  it("ships the same tokens behind the prefers-contrast media query", () => {
    const body = mediaBody("@media (prefers-contrast: more)");
    for (const theme of THEMES) {
      for (const [token, value] of Object.entries(HIGH_CONTRAST_TOKENS[theme])) {
        expect(body, `${theme} --${token}`).toContain(`--${token}: ${value};`);
      }
    }
  });

  it("neutralises motion under prefers-reduced-motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation-duration: 0.01ms !important");
    expect(css).toContain("animation-iteration-count: 1 !important");
    expect(css).toContain("transition-duration: 0.01ms !important");
    expect(css).toContain("scroll-behavior: auto !important");
  });
});
