import { describe, expect, it } from "vitest";
import { normalizePasteHtml, pastePlan } from "@/lib/paste";

/**
 * Paste normalisation: clipboard HTML (from another Noema page, or a foreign
 * app) -> TipTap JSON. Every block type the editor can hold must round-trip,
 * only unsafe markup may be stripped.
 */

const parse = (html: string) => normalizePasteHtml(html);

describe("normalizePasteHtml", () => {
  it("keeps headings 1-6 with their levels", () => {
    const html = "<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>";
    expect(parse(html).blocks).toEqual([
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "One" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Two" }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Three" }] },
      { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "Four" }] },
      { type: "heading", attrs: { level: 5 }, content: [{ type: "text", text: "Five" }] },
      { type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "Six" }] },
    ]);
  });

  it("keeps bullet and ordered lists including nesting", () => {
    const html =
      "<ul><li>alpha</li><li>beta<ul><li>deep</li></ul></li></ul><ol><li>first</li></ol>";
    expect(parse(html).blocks).toEqual([
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "alpha" }] }] },
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "beta" }] },
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "deep" }] }] },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "orderedList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
        ],
      },
    ]);
  });

  it("keeps task list checked state and drops the label/checkbox chrome", () => {
    const html =
      '<ul data-type="taskList"><li data-checked="true" data-type="taskItem">' +
      '<label><input type="checkbox" checked="checked"><span></span></label>' +
      "<div><p>ship it</p></div></li></ul>";
    expect(parse(html).blocks).toEqual([
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [{ type: "paragraph", content: [{ type: "text", text: "ship it" }] }],
          },
        ],
      },
    ]);
  });

  it("keeps unchecked task items unchecked", () => {
    const html =
      '<ul data-type="taskList"><li data-checked="false" data-type="taskItem">' +
      "<div><p>later</p></div></li></ul>";
    const [list] = parse(html).blocks;
    expect(list?.content?.[0]?.attrs).toEqual({ checked: false });
  });

  it("keeps toggle summary and collapsed state", () => {
    const html = '<div summary="Details" open="false" data-toggle=""><p>hidden</p></div>';
    expect(parse(html).blocks).toEqual([
      {
        type: "toggle",
        attrs: { summary: "Details", open: false },
        content: [{ type: "paragraph", content: [{ type: "text", text: "hidden" }] }],
      },
    ]);
  });

  it("keeps callout emoji and background colour", () => {
    const html = '<div emoji="🚀" color="blue" data-callout=""><p>launch</p></div>';
    expect(parse(html).blocks).toEqual([
      {
        type: "callout",
        attrs: { emoji: "🚀", color: "blue" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "launch" }] }],
      },
    ]);
  });

  it("keeps code block language from the language-x class", () => {
    const html = "<pre><code class=\"language-python\">print(1)</code></pre>";
    expect(parse(html).blocks).toEqual([
      { type: "codeBlock", attrs: { language: "python" }, content: [{ type: "text", text: "print(1)" }] },
    ]);
  });

  it("keeps code block language from data-language and block colour", () => {
    const html =
      '<pre data-block-color="gray"><code data-language="ts">const x = 1;</code></pre>';
    expect(parse(html).blocks).toEqual([
      {
        type: "codeBlock",
        attrs: { language: "ts", blockColor: "gray" },
        content: [{ type: "text", text: "const x = 1;" }],
      },
    ]);
  });

  it("keeps image alt text and caption", () => {
    const html = '<img src="/uploads/pixel.png" alt="a pixel" data-caption="One pixel">';
    expect(parse(html).blocks).toEqual([
      {
        type: "image",
        attrs: { src: "/uploads/pixel.png", alt: "a pixel", caption: "One pixel" },
      },
    ]);
  });

  it("keeps data-block-color on paragraphs and headings", () => {
    const html =
      '<p data-block-color="gray">tinted</p><h2 data-block-color="red">loud</h2>';
    expect(parse(html).blocks).toEqual([
      {
        type: "paragraph",
        attrs: { blockColor: "gray" },
        content: [{ type: "text", text: "tinted" }],
      },
      {
        type: "heading",
        attrs: { level: 2, blockColor: "red" },
        content: [{ type: "text", text: "loud" }],
      },
    ]);
  });

  it("inherits data-block-color from a transparent wrapper", () => {
    const html = '<div data-block-color="blue"><p>inside</p></div>';
    expect(parse(html).blocks).toEqual([
      {
        type: "paragraph",
        attrs: { blockColor: "blue" },
        content: [{ type: "text", text: "inside" }],
      },
    ]);
  });

  it("keeps tables with header and cell structure", () => {
    const html =
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>";
    const cell = (type: string, text: string) => ({
      type,
      attrs: { colspan: 1, rowspan: 1 },
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    expect(parse(html).blocks).toEqual([
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell("tableHeader", "A"), cell("tableHeader", "B")] },
          { type: "tableRow", content: [cell("tableCell", "1"), cell("tableCell", "2")] },
        ],
      },
    ]);
  });

  it("keeps inline marks (bold, italic, underline, strike, code, link, highlight, colour)", () => {
    const html =
      "<p><b>b</b><i>i</i><u>u</u><s>s</s><code>c</code>" +
      '<a href="https://example.test">l</a>' +
      '<mark style="background-color: #fdecc8">h</mark>' +
      '<span style="color: #d44c47">r</span></p>';
    const marks = (node: { marks?: { type: string; attrs?: Record<string, unknown> }[] }) =>
      node.marks;
    const [para] = parse(html).blocks;
    const texts = para?.content ?? [];
    expect(texts.map((t) => marks(t as never)?.[0]?.type)).toEqual([
      "bold",
      "italic",
      "underline",
      "strike",
      "code",
      "link",
      "highlight",
      "textStyle",
    ]);
    expect(marks(texts[5] as never)?.[0]?.attrs).toEqual({ href: "https://example.test" });
    expect(marks(texts[6] as never)?.[0]?.attrs).toEqual({ color: "#fdecc8" });
    expect(marks(texts[7] as never)?.[0]?.attrs).toEqual({ color: "#d44c47" });
  });

  it("strips script/style content, on* handlers and javascript: urls", () => {
    const html =
      '<p onclick="steal()">safe<script>alert("x")</script></p>' +
      "<style>p{display:none}</style>" +
      '<a href="javascript:evil()">click</a>';
    const blocks = parse(html).blocks;
    expect(blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "safe" }] },
      { type: "paragraph", content: [{ type: "text", text: "click" }] },
    ]);
    expect(JSON.stringify(blocks)).not.toMatch(/onclick|alert|display|javascript/);
  });

  it("decodes entities and drops inter-block whitespace", () => {
    const html = "<p>A &amp; B &lt;C&gt;</p>\n  <p>D&nbsp;E</p>";
    const parsed = parse(html);
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[0]?.content).toEqual([
      { type: "text", text: "A & B <C>" },
    ]);
    expect(parsed.blocks[1]?.content).toEqual([{ type: "text", text: "D\u00a0E" }]);
  });

  it("flags a partial copy from data-pm-slice open depths", () => {
    expect(parse('<h2 data-pm-slice="1 1 []">Half</h2>').partial).toBe(true);
    expect(parse('<h2 data-pm-slice="0 0 []">Whole</h2>').partial).toBe(false);
    expect(parse("<h2>Whole</h2>").partial).toBe(false);
  });

  it("flattens a single block to inline content with marks for inline insertion", () => {
    const parsed = parse("<p>Hello <b>world</b></p>");
    expect(parsed.inline).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world", marks: [{ type: "bold" }] },
    ]);
  });

  it("wraps loose inline fragments in a paragraph", () => {
    expect(parse("bare <b>text</b>").blocks).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "bare " },
          { type: "text", text: "text", marks: [{ type: "bold" }] },
        ],
      },
    ]);
  });

  it("keeps blockquotes, dividers and hard breaks", () => {
    const parsed = parse("<blockquote><p>quoted</p></blockquote><hr>");
    expect(parsed.blocks).toEqual([
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
      { type: "horizontalRule" },
    ]);
    expect(parse("<p>a<br>b</p>").blocks[0]?.content).toEqual([
      { type: "text", text: "a" },
      { type: "hardBreak" },
      { type: "text", text: "b" },
    ]);
  });
});

describe("pastePlan", () => {
  const heading = parse('<h2 data-pm-slice="1 1 []">Title</h2>');
  const wholeHeading = parse('<h2 data-pm-slice="0 0 []">Title</h2>');
  const paragraph = parse("<p>sentence</p>");
  const many = parse("<h2>A</h2><p>B</p>");

  it("replaces an empty target block with typed blocks", () => {
    expect(pastePlan(heading, { empty: true })).toBe("blocks");
    expect(pastePlan(many, { empty: true })).toBe("blocks");
  });

  it("merges a single paragraph into a non-empty target", () => {
    expect(pastePlan(paragraph, { empty: false })).toBe("inline");
  });

  it("merges a partial single block (selection copy) into a non-empty target", () => {
    expect(pastePlan(heading, { empty: false })).toBe("inline");
  });

  it("keeps a whole copied block as a block in a non-empty target", () => {
    expect(pastePlan(wholeHeading, { empty: false })).toBe("blocks");
    expect(pastePlan(many, { empty: false })).toBe("blocks");
  });
});
