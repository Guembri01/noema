import { describe, expect, it } from "vitest";
import { blankClickPlan } from "./blank-click";

describe("blankClickPlan", () => {
  it("reuses a trailing empty paragraph (the common case: an empty page)", () => {
    expect(blankClickPlan({ lastBlockType: "paragraph", lastBlockEmpty: true })).toEqual({
      kind: "use-tail",
    });
  });

  it("appends one when the last block holds text", () => {
    expect(blankClickPlan({ lastBlockType: "paragraph", lastBlockEmpty: false })).toEqual({
      kind: "append",
    });
  });

  it("appends one after any non-paragraph block", () => {
    for (const lastBlockType of ["heading", "bulletList", "codeBlock", "table", "blockquote", "horizontalRule"]) {
      expect(blankClickPlan({ lastBlockType, lastBlockEmpty: false })).toEqual({ kind: "append" });
      // Even an empty one: a code block or a list is not somewhere to start a
      // sentence, so the click still gets its own paragraph.
      expect(blankClickPlan({ lastBlockType, lastBlockEmpty: true })).toEqual({ kind: "append" });
    }
  });

  it("appends into a document with no block at all", () => {
    expect(blankClickPlan({ lastBlockEmpty: false })).toEqual({ kind: "append" });
  });
});
