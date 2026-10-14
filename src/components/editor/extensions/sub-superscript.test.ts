import { describe, expect, it } from "vitest";
import { matchScriptShortcut } from "./sub-superscript";

/**
 * Markdown-style triggers for the subscript / superscript marks
 * (`H~2~O`, `x^2^`).
 *
 * The matcher is what the input rule in `input-rules.ts` runs against the
 * text in front of the cursor, so it must:
 *   • only fire when the closing delimiter was just typed (end-anchored),
 *   • never steal `~~strike~~` from the stock strike rule,
 *   • leave an opening-only delimiter (`~2`) alone.
 */
describe("matchScriptShortcut", () => {
  it("matches a just-closed subscript pair", () => {
    expect(matchScriptShortcut("H~2~")).toEqual({
      kind: "subscript",
      full: "~2~",
      inner: "2",
      index: 1,
    });
  });

  it("matches a just-closed superscript pair", () => {
    expect(matchScriptShortcut("x^2^")).toEqual({
      kind: "superscript",
      full: "^2^",
      inner: "2",
      index: 1,
    });
  });

  it("keeps the delimiters out of `inner` and reports where the pair starts", () => {
    expect(matchScriptShortcut("the value is H~20~ percent")).toBeNull();
    expect(matchScriptShortcut("H~20~")).toEqual({
      kind: "subscript",
      full: "~20~",
      inner: "20",
      index: 1,
    });
    expect(matchScriptShortcut("~two words~")).toEqual({
      kind: "subscript",
      full: "~two words~",
      inner: "two words",
      index: 0,
    });
  });

  it("does not match an opening delimiter that was not closed yet", () => {
    expect(matchScriptShortcut("~")).toBeNull();
    expect(matchScriptShortcut("H~2")).toBeNull();
    expect(matchScriptShortcut("x^2")).toBeNull();
  });

  it("leaves the stock `~~strike~~` shortcut to the strike rule", () => {
    expect(matchScriptShortcut("~~bold~~")).toBeNull();
    expect(matchScriptShortcut("~~")).toBeNull();
  });

  it("only matches at the very end of the typed text", () => {
    expect(matchScriptShortcut("~a~ tail")).toBeNull();
    expect(matchScriptShortcut("H~20~ ")).toBeNull();
    expect(matchScriptShortcut("no delimiters here")).toBeNull();
  });
});
