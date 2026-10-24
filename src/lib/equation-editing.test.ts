import { describe, expect, it } from "vitest";
import {
  beginEquationDraft,
  equationCommitValue,
  equationDismissFromScrim,
  equationDismissOnBlur,
  equationDraftIsDirty,
  equationDraftReducer,
  equationNodeMatches,
  planBlockEquationInsertion,
} from "./equation-editing";

/**
 * The dialog's edit state machine. These are the behaviours the UI must not
 * regress: cancel/blur preserve the original source, the view switch is not
 * destructive, and blank drafts never create empty nodes.
 */

const editing = () =>
  beginEquationDraft({
    kind: "inline",
    latex: "x^2",
    pos: 12,
  });

describe("beginEquationDraft", () => {
  it("captures the original source and node position", () => {
    const draft = editing();
    expect(draft).toMatchObject({
      kind: "inline",
      latex: "x^2",
      original: "x^2",
      view: "source",
      pos: 12,
      range: null,
    });
  });

  it("captures a replacement range for toolbar insertions", () => {
    const draft = beginEquationDraft({ kind: "inline", from: 4, to: 9 });
    expect(draft.range).toEqual({ from: 4, to: 9 });
    expect(draft.latex).toBe("");
    expect(draft.original).toBe("");
  });

  it("ignores an inverted or partial range", () => {
    expect(beginEquationDraft({ kind: "inline", from: 9, to: 4 }).range).toBeNull();
    expect(beginEquationDraft({ kind: "inline", from: 4 }).range).toBeNull();
  });
});

describe("equationDraftReducer", () => {
  it("edits without mutating the original", () => {
    const draft = equationDraftReducer(editing(), { type: "edit", latex: "y^2" });
    expect(draft.latex).toBe("y^2");
    expect(draft.original).toBe("x^2");
    expect(equationDraftIsDirty(draft)).toBe(true);
  });

  it("switches panes without touching the source or caret-bearing value", () => {
    const draft = equationDraftReducer(
      equationDraftReducer(editing(), { type: "edit", latex: "y^2" }),
      { type: "view", view: "preview" },
    );
    expect(draft.latex).toBe("y^2");
    expect(draft.view).toBe("preview");
    // Switching back is a no-op for the source, so the textarea value/caret
    // are still there when it becomes visible again.
    expect(equationDraftReducer(draft, { type: "view", view: "source" }).latex).toBe("y^2");
  });

  it("restores the original source on cancel", () => {
    const draft = equationDraftReducer(editing(), { type: "edit", latex: "broken \\frac{1}{" });
    const cancelled = equationDraftReducer(draft, { type: "cancel" });
    expect(cancelled.latex).toBe("x^2");
    expect(cancelled.view).toBe("source");
  });

  it("treats blur/dismiss exactly like cancel", () => {
    const dirty = equationDraftReducer(editing(), { type: "edit", latex: "y^2" });
    expect(equationDraftReducer(dirty, { type: "dismiss" })).toEqual(
      equationDraftReducer(dirty, { type: "cancel" }),
    );
  });
});

describe("equationCommitValue", () => {
  it("returns the trimmed source for a non-empty draft", () => {
    expect(equationCommitValue({ ...editing(), latex: "  y = mx + b  " })).toBe("y = mx + b");
  });

  it("returns null for a blank draft so no empty node is created", () => {
    expect(equationCommitValue({ ...editing(), latex: "   " })).toBeNull();
  });
});

describe("equationNodeMatches", () => {
  it("only accepts the expected kind, guarding a stale pos", () => {
    expect(equationNodeMatches("inline", { type: { name: "inlineMath" } })).toBe(true);
    expect(equationNodeMatches("block", { type: { name: "blockMath" } })).toBe(true);
    expect(equationNodeMatches("inline", { type: { name: "blockMath" } })).toBe(false);
    expect(equationNodeMatches("inline", { type: { name: "paragraph" } })).toBe(false);
    expect(equationNodeMatches("inline", null)).toBe(false);
  });
});

describe("planBlockEquationInsertion", () => {
  it("replaces the empty paragraph opened by /equation", () => {
    expect(
      planBlockEquationInsertion({
        hasTextblock: true,
        emptyTextblock: true,
        before: 10,
        after: 12,
        pos: 11,
      }),
    ).toEqual({ type: "replace", from: 10, to: 12 });
  });

  it("inserts after a non-empty paragraph instead of nesting a block node", () => {
    expect(
      planBlockEquationInsertion({
        hasTextblock: true,
        emptyTextblock: false,
        before: 10,
        after: 24,
        pos: 20,
      }),
    ).toEqual({ type: "insert", at: 24 });
  });

  it("falls back to the raw selection position outside a textblock", () => {
    expect(
      planBlockEquationInsertion({
        hasTextblock: false,
        emptyTextblock: false,
        before: 0,
        after: 0,
        pos: 7,
      }),
    ).toEqual({ type: "insert", at: 7 });
  });
});

describe("dismissal helpers", () => {
  it("closes on scrim clicks but not panel clicks", () => {
    const scrim = {};
    const panel = {};
    expect(equationDismissFromScrim(scrim, scrim)).toBe(true);
    expect(equationDismissFromScrim(panel, scrim)).toBe(false);
    expect(equationDismissFromScrim(null, scrim)).toBe(false);
  });

  it("dismisses when focus leaves the dialog", () => {
    const inside = {};
    const outside = {};
    const panel = { contains: (target: never) => target === (inside as never) };
    expect(equationDismissOnBlur(inside, panel)).toBe(false);
    expect(equationDismissOnBlur(outside, panel)).toBe(true);
    // Clicking non-focusable panel content reports null; keep the dialog open.
    expect(equationDismissOnBlur(null, panel)).toBe(false);
  });
});
