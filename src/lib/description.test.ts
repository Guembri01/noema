import { describe, expect, it } from "vitest";
import { DESCRIPTION_DOC_MAX, DESCRIPTION_MAX, descriptionDoc, descriptionEntryDoc, descriptionToText, sanitizeDescription } from "./description";

describe("sanitizeDescription", () => {
  it("trims surrounding whitespace and normalises line endings", () => {
    expect(sanitizeDescription("  hello world  ")).toBe("hello world");
    expect(sanitizeDescription("line one\r\nline two")).toBe("line one\nline two");
    expect(sanitizeDescription("\rlegacy carriage\rreturn")).toBe("legacy carriage\nreturn");
  });

  it("strips control characters but keeps tabs and newlines", () => {
    expect(sanitizeDescription("a\u0000b\u0007c\u009fd")).toBe("abcd");
    expect(sanitizeDescription("keep\tthis\nand\nthose")).toBe("keep\tthis\nand\nthose");
  });

  it("empties all-whitespace (or all-control) input", () => {
    expect(sanitizeDescription("")).toBe("");
    expect(sanitizeDescription("   \n\t  \r\n ")).toBe("");
    expect(sanitizeDescription("\u0000\u0001\u0002")).toBe("");
  });

  it("enforces the cap", () => {
    expect(sanitizeDescription("x".repeat(DESCRIPTION_MAX + 500))).toHaveLength(DESCRIPTION_MAX);
    const exact = "y".repeat(DESCRIPTION_MAX);
    expect(sanitizeDescription(exact)).toBe(exact);
    expect(sanitizeDescription("way too long", 8)).toBe("way too");
  });

  it("exposes a ~10k default cap", () => {
    expect(DESCRIPTION_MAX).toBeGreaterThanOrEqual(10_000);
    expect(DESCRIPTION_MAX).toBeLessThanOrEqual(10_000);
  });
});

describe("descriptionToText", () => {
  it("flattens a stored description doc back to plain text", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "World" }] },
      ],
    };
    expect(descriptionToText(doc)).toBe("Hello\nWorld");
  });

  it("keeps marks inline (bold text contributes its text only)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "plain " },
            { type: "text", marks: [{ type: "bold" }], text: "bold" },
          ],
        },
      ],
    };
    expect(descriptionToText(doc)).toBe("plain bold");
  });

  it("returns an empty string for null, undefined and unknown shapes", () => {
    expect(descriptionToText(null)).toBe("");
    expect(descriptionToText(undefined)).toBe("");
    expect(descriptionToText("just a string")).toBe("");
    expect(descriptionToText({ type: "doc" })).toBe("");
    expect(descriptionToText({ type: "doc", content: [] })).toBe("");
  });
});

describe("descriptionDoc", () => {
  it("round-trips multi-line text through the stored doc shape", () => {
    const text = "first line\nsecond line";
    expect(descriptionToText(descriptionDoc(text))).toBe(text);
  });

  it("stores an empty doc for empty input", () => {
    expect(descriptionDoc("")).toEqual({ type: "doc", content: [] });
    expect(descriptionToText(descriptionDoc("   "))).toBe("");
  });

  it("sanitises before storing (control chars never reach the database)", () => {
    const doc = descriptionDoc("bad\u0000input");
    expect(descriptionToText(doc)).toBe("badinput");
  });
});

describe("descriptionEntryDoc", () => {
  it("opens a stored doc as-is (rich text keeps its blocks and marks)", () => {
    const stored = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "one" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(descriptionEntryDoc(stored, "stale plain text")).toBe(stored);
  });

  it("falls back to the plain-text doc when nothing is stored", () => {
    expect(descriptionEntryDoc(null, "hello")).toEqual(descriptionDoc("hello"));
    expect(descriptionEntryDoc(undefined, "hello")).toEqual(descriptionDoc("hello"));
  });

  it("ignores a value that is not a doc (a legacy string never reaches the editor)", () => {
    expect(descriptionEntryDoc("just a string", "from the column")).toEqual(
      descriptionDoc("from the column"),
    );
    expect(descriptionEntryDoc({ type: "doc" }, "no content array")).toEqual(
      descriptionDoc("no content array"),
    );
  });

  it("yields one empty paragraph for an empty description (the placeholder shows)", () => {
    const empty = { type: "doc", content: [] };
    expect(descriptionEntryDoc(null, "")).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    // A stored empty doc is normalised on entry too: `content: []` renders as a
    // zero-height surface, so neither the hint nor the caret would be visible.
    expect(descriptionEntryDoc(empty, "")).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });
});

describe("DESCRIPTION_DOC_MAX", () => {
  it("caps rich docs above the plain-text ceiling", () => {
    expect(DESCRIPTION_DOC_MAX).toBeGreaterThan(DESCRIPTION_MAX);
  });
});
