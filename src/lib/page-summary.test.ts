import { describe, expect, it } from "vitest";
import {
  extractDescription,
  isLikelyDescriptionWorthy,
  summarizeBlocks,
  truncateAtWord,
} from "./page-summary";

/** Minimal paragraph helper: one text run. */
const para = (text: string) => ({ type: "paragraph", children: [{ type: "text", text }] });

describe("summarizeBlocks", () => {
  it("joins multiple blocks in document order with a single space", () => {
    const teaser = summarizeBlocks([
      para("Hello world"),
      { type: "heading", children: [{ type: "text", text: "A heading" }] },
      para("Goodbye"),
    ]);
    expect(teaser).toBe("Hello world A heading Goodbye");
  });

  it("strips marks and keeps only the text runs", () => {
    const teaser = summarizeBlocks([
      {
        type: "paragraph",
        children: [
          { type: "text", text: "plain " },
          { type: "text", text: "bold", marks: [{ type: "bold" }] },
          { type: "text", text: " and " },
          { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "/x" } }] },
        ],
      },
    ]);
    expect(teaser).toBe("plain bold and link");
    expect(teaser).not.toContain("**");
  });

  it("skips the default block types (code, image, divider)", () => {
    const blocks = [
      para("Visible"),
      { type: "code", text: "const x = 1;" },
      { type: "image", text: "a picture" },
      { type: "divider" },
      para("Also visible"),
    ];
    expect(summarizeBlocks(blocks)).toBe("Visible Also visible");
  });

  it("honours a custom skipTypes list", () => {
    const blocks = [para("Keep"), { type: "heading", children: [{ type: "text", text: "Drop" }] }];
    expect(summarizeBlocks(blocks, { skipTypes: ["heading"] })).toBe("Keep");
  });

  it("normalises app block-type aliases (codeBlock / horizontalRule)", () => {
    const blocks = [
      para("A"),
      { type: "codeBlock", text: "hidden" },
      { type: "horizontalRule" },
      para("B"),
    ];
    expect(summarizeBlocks(blocks)).toBe("A B");
  });

  it("collapses whitespace inside and between blocks", () => {
    expect(summarizeBlocks([para("  one   two\t three \n four  ")])).toBe("one two three four");
  });

  it("returns an empty string for no blocks or only-skipped blocks", () => {
    expect(summarizeBlocks([])).toBe("");
    expect(summarizeBlocks([{ type: "divider" }, { type: "image" }])).toBe("");
  });

  it("ellipsizes only when the text is longer than maxLength", () => {
    const long = summarizeBlocks([para("word ".repeat(60))], { maxLength: 20 });
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(20);
  });

  it("does not ellipsize text that is exactly at the limit", () => {
    const text = "a".repeat(10);
    expect(summarizeBlocks([para(text)], { maxLength: 10 })).toBe(text);
  });

  it("never cuts a word in half", () => {
    const teaser = summarizeBlocks([para("alpha beta gamma delta epsilon")], { maxLength: 16 });
    expect(teaser.replace(/…$/, "").trim()).toBe("alpha beta");
    expect(teaser.endsWith("…")).toBe(true);
  });

  it("defaults to a 160 character teaser", () => {
    const teaser = summarizeBlocks([para("x ".repeat(200))]);
    expect(teaser.length).toBeLessThanOrEqual(160);
    expect(teaser.endsWith("…")).toBe(true);
  });
});

describe("truncateAtWord", () => {
  it("returns short (or exactly-fitting) text untouched", () => {
    expect(truncateAtWord("short", 20)).toBe("short");
    expect(truncateAtWord("exactly10!", 10)).toBe("exactly10!");
  });

  it("truncates at a word boundary and marks the cut", () => {
    expect(truncateAtWord("the quick brown fox", 12)).toBe("the quick…");
  });

  it("hard-cuts when there is no whitespace to break on", () => {
    expect(truncateAtWord("supercalifragilistic", 6)).toBe("super…");
  });

  it("handles empty input and non-positive limits", () => {
    expect(truncateAtWord("", 10)).toBe("");
    expect(truncateAtWord("hello", 0)).toBe("");
    expect(truncateAtWord("hello", -3)).toBe("");
  });
});

describe("extractDescription", () => {
  it("returns the first non-empty paragraph and ignores later ones", () => {
    expect(
      extractDescription([
        { type: "heading", children: [{ type: "text", text: "Title" }] },
        para("First paragraph."),
        para("Second paragraph."),
      ]),
    ).toBe("First paragraph.");
  });

  it("skips empty paragraphs and collapses whitespace", () => {
    expect(extractDescription([para("   "), { type: "paragraph" }, para("  Real   text  ")])).toBe(
      "Real text",
    );
  });

  it("returns null when there is no paragraph", () => {
    expect(extractDescription([])).toBeNull();
    expect(
      extractDescription([{ type: "heading", children: [{ type: "text", text: "Only a title" }] }]),
    ).toBeNull();
    expect(extractDescription([{ type: "code", text: "const x = 1" }])).toBeNull();
  });

  it("finds a paragraph nested inside a container block", () => {
    expect(extractDescription([{ type: "blockquote", children: [para("Quoted intro")] }])).toBe(
      "Quoted intro",
    );
  });
});

describe("isLikelyDescriptionWorthy", () => {
  it("accepts prose", () => {
    expect(isLikelyDescriptionWorthy("A short summary of the page")).toBe(true);
  });

  it("rejects empty, tiny and letter-less text", () => {
    expect(isLikelyDescriptionWorthy("")).toBe(false);
    expect(isLikelyDescriptionWorthy("   ")).toBe(false);
    expect(isLikelyDescriptionWorthy("hi")).toBe(false);
    expect(isLikelyDescriptionWorthy("---")).toBe(false);
    expect(isLikelyDescriptionWorthy("12345678")).toBe(false);
  });

  it("rejects bare URLs", () => {
    expect(isLikelyDescriptionWorthy("https://example.com/very/long/path")).toBe(false);
  });
});
