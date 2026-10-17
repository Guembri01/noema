import { describe, expect, it } from "vitest";
import { blockChoice, DESCRIPTION_AUTOSAVE_MS } from "./ticket-description";

/**
 * The ticket description's block picker (pure part) plus its autosave cadence.
 *
 * The editor itself is exercised by the drawer's markup test and, end to end,
 * by `e2e/descriptions.spec.ts`; what is pinned here is the mapping from a
 * caret's flags to the picker entry, and that the debounce stays inside the
 * design system's "standard" motion band (150-220 ms is *animation*; this is a
 * network cadence, and the old textarea used the same 800 ms).
 */
describe("blockChoice", () => {
  it("reads a heading level when the caret is in one", () => {
    expect(blockChoice({ heading: 1 })).toBe("h1");
    expect(blockChoice({ heading: 2 })).toBe("h2");
    expect(blockChoice({ heading: 3 })).toBe("h3");
  });

  it("reads a quote, then falls back to plain text", () => {
    expect(blockChoice({ blockquote: true })).toBe("quote");
    expect(blockChoice({})).toBe("paragraph");
  });

  it("prefers the heading when a heading sits inside a quote", () => {
    expect(blockChoice({ heading: 2, blockquote: true })).toBe("h2");
  });

  it("ignores a heading level outside the picker (4-6 render as text)", () => {
    expect(blockChoice({ heading: 4 })).toBe("paragraph");
  });
});

describe("autosave cadence", () => {
  it("keeps the drawer's 800 ms quiet period", () => {
    expect(DESCRIPTION_AUTOSAVE_MS).toBe(800);
  });
});
