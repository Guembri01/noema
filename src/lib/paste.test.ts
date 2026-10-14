import { describe, expect, it } from "vitest";
import { normalizePasteHtml, pastePlan, sanitizePastedHtml, stripToPlainText } from "@/lib/paste";

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

/**
 * B37 — deeper HTML paste fidelity: nested bulleted+ordered mixes, callout
 * toggle JSON round-trip (paste -> JSON -> clipboard HTML -> paste), heading
 * block colours beyond the paragraph case, and tables wrapped in thead/tbody
 * with colspan/rowspan spans.
 */

type PasteBlock = ReturnType<typeof parse>["blocks"][number];

const attr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const esc = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Re-emit clipboard HTML for the block shapes this round-trip covers. */
const blockToHtml = (node: PasteBlock): string => {
  const kids = () => (node.content ?? []).map(blockToHtml).join("");
  switch (node.type) {
    case "callout":
      return `<div data-callout="" emoji="${attr(String(node.attrs?.emoji ?? "💡"))}" color="${attr(String(node.attrs?.color ?? "gray"))}">${kids()}</div>`;
    case "toggle":
      return `<div data-toggle="" summary="${attr(String(node.attrs?.summary ?? ""))}" open="${node.attrs?.open ? "true" : "false"}">${kids()}</div>`;
    case "paragraph":
      return `<p>${inlineToHtml(node.content ?? [])}</p>`;
    case "bulletList":
      return `<ul>${kids()}</ul>`;
    case "orderedList":
      return `<ol>${kids()}</ol>`;
    case "listItem":
      return `<li>${kids()}</li>`;
    default:
      throw new Error(`round-trip helper does not serialise ${node.type}`);
  }
};

const inlineToHtml = (nodes: PasteBlock[]): string =>
  nodes
    .map((node) => {
      if (node.type === "hardBreak") return "<br>";
      if (node.type !== "text") return blockToHtml(node);
      let out = esc(node.text ?? "");
      for (const mark of node.marks ?? []) {
        const color = String(mark.attrs?.color ?? "");
        if (mark.type === "bold") out = `<strong>${out}</strong>`;
        else if (mark.type === "italic") out = `<em>${out}</em>`;
        else if (mark.type === "underline") out = `<u>${out}</u>`;
        else if (mark.type === "strike") out = `<s>${out}</s>`;
        else if (mark.type === "code") out = `<code>${out}</code>`;
        else if (mark.type === "link") out = `<a href="${attr(String(mark.attrs?.href ?? ""))}">${out}</a>`;
        else if (mark.type === "highlight") out = `<mark style="background-color: ${attr(color)}">${out}</mark>`;
        else if (mark.type === "textStyle") out = `<span style="color: ${attr(color)}">${out}</span>`;
      }
      return out;
    })
    .join("");

describe("normalizePasteHtml nested list mixes (B37)", () => {
  it("nests an ordered list (with a deeper bullet) inside a bullet item", () => {
    const html =
      "<ul><li>alpha<ol><li>one</li><li>two<ul><li>deep</li></ul></li></ol></li><li>beta</li></ul>";
    expect(parse(html).blocks).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "alpha" }] },
              {
                type: "orderedList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "two" }] },
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
            ],
          },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "beta" }] }] },
        ],
      },
    ]);
  });

  it("nests a bullet list inside the first ordered item", () => {
    const html = "<ol><li>first<ul><li>sub one</li><li>sub two</li></ul></li><li>second</li></ol>";
    expect(parse(html).blocks).toEqual([
      {
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "first" }] },
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "sub one" }] }] },
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "sub two" }] }] },
                ],
              },
            ],
          },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] },
        ],
      },
    ]);
  });
});

describe("callout/toggle JSON round-trip (B37)", () => {
  it("round-trips a callout (marks included) back through clipboard HTML", () => {
    const html =
      '<div data-callout="" emoji="🚀" color="blue"><p><strong>ship</strong> today</p></div>';
    const first = parse(html).blocks;
    expect(first).toEqual([
      {
        type: "callout",
        attrs: { emoji: "🚀", color: "blue" },
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "ship", marks: [{ type: "bold" }] },
              { type: "text", text: " today" },
            ],
          },
        ],
      },
    ]);
    expect(parse(blockToHtml(first[0])).blocks).toEqual(first);
  });

  it("round-trips a collapsed toggle with a nested list through clipboard HTML", () => {
    const html =
      '<div data-toggle="" summary="Details" open="false">' +
      "<p>hidden <code>bit</code></p><ul><li>one</li></ul></div>";
    const first = parse(html).blocks;
    expect(first).toEqual([
      {
        type: "toggle",
        attrs: { summary: "Details", open: false },
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "hidden " },
              { type: "text", text: "bit", marks: [{ type: "code" }] },
            ],
          },
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            ],
          },
        ],
      },
    ]);
    expect(parse(blockToHtml(first[0])).blocks).toEqual(first);
  });

  it("inserts callouts and toggles as blocks even into a non-empty target", () => {
    const callout = parse('<div data-callout="" emoji="🚀" color="blue"><p>x</p></div>');
    const toggle = parse('<div data-toggle="" summary="D"><p>y</p></div>');
    expect(pastePlan(callout, { empty: false })).toBe("blocks");
    expect(pastePlan(toggle, { empty: false })).toBe("blocks");
    expect(pastePlan(callout, { empty: true })).toBe("blocks");
  });
});

describe("data-block-color on headings (B37)", () => {
  it("keeps the colour on every heading level, not just paragraphs", () => {
    const levels = [1, 2, 3, 4, 5, 6];
    const html = levels
      .map((level) => `<h${level} data-block-color="gray">t${level}</h${level}>`)
      .join("");
    expect(parse(html).blocks).toEqual(
      levels.map((level) => ({
        type: "heading",
        attrs: { level, blockColor: "gray" },
        content: [{ type: "text", text: `t${level}` }],
      })),
    );
  });

  it("inherits the wrapper colour on a heading", () => {
    expect(parse('<div data-block-color="blue"><h3>deep</h3></div>').blocks).toEqual([
      {
        type: "heading",
        attrs: { level: 3, blockColor: "blue" },
        content: [{ type: "text", text: "deep" }],
      },
    ]);
  });

  it("keeps heading colour and text alignment together", () => {
    expect(parse('<h2 data-block-color="red" style="text-align: center">loud</h2>').blocks).toEqual([
      {
        type: "heading",
        attrs: { level: 2, blockColor: "red", textAlign: "center" },
        content: [{ type: "text", text: "loud" }],
      },
    ]);
  });

  it("keeps a coloured heading inside a blockquote", () => {
    expect(parse('<blockquote><h4 data-block-color="red">q</h4></blockquote>').blocks).toEqual([
      {
        type: "blockquote",
        content: [
          { type: "heading", attrs: { level: 4, blockColor: "red" }, content: [{ type: "text", text: "q" }] },
        ],
      },
    ]);
  });
});

/**
 * Paste sanitisation surface (MISSING_FEATURES §2 "Paste with formatting" /
 * "Paste without formatting"): pure HTML-string in -> clean HTML string
 * (`sanitizePastedHtml`) or clean text (`stripToPlainText`) out.
 */

describe("sanitizePastedHtml", () => {
  it("strips script/style/meta/iframe with their content, and comments", () => {
    const html =
      "<!-- exported from somewhere -->" +
      '<meta charset="utf-8">' +
      "<style>p{display:none}</style>" +
      '<iframe src="https://evil.test"></iframe>' +
      '<script>alert("x")</script>' +
      "<p>keep</p>";
    expect(sanitizePastedHtml(html)).toBe("<p>keep</p>");
  });

  it("removes on* handlers but keeps the element and its attributes", () => {
    expect(sanitizePastedHtml('<p onclick="steal()" class="keep">x</p>')).toBe(
      '<p class="keep">x</p>',
    );
    expect(sanitizePastedHtml('<img src="/a.png" onerror="x()" alt="a">')).toBe(
      '<img src="/a.png" alt="a">',
    );
  });

  it("neutralizes javascript: and vbscript: urls, keeping safe ones", () => {
    const html =
      '<a href="javascript:evil()">click</a>' +
      '<a href="  VBScript:boom()">legacy</a>' +
      '<a href="https://ok.test">ok</a>';
    expect(sanitizePastedHtml(html)).toBe(
      '<a>click</a><a>legacy</a><a href="https://ok.test">ok</a>',
    );
  });

  it("strips inline style noise but keeps the small allowlist", () => {
    expect(
      sanitizePastedHtml(
        '<p style="color: #d44c47; margin: 0; display: none; font-weight: 700">t</p>',
      ),
    ).toBe('<p style="color: #d44c47; font-weight: 700">t</p>');
    expect(sanitizePastedHtml('<span style="mso-margin-top: 0">n</span>')).toBe("<span>n</span>");
    expect(sanitizePastedHtml('<p style="color: expression(alert(1))">x</p>')).toBe("<p>x</p>");
  });

  it("preserves semantic formatting tags and safe attributes verbatim", () => {
    const html =
      "<h2>Title</h2>" +
      "<p><b>b</b><i>i</i><u>u</u><s>s</s><code>c</code></p>" +
      "<blockquote><p>q</p></blockquote>" +
      '<ul><li data-checked="true">l</li></ul>' +
      '<a href="https://ok.test" target="_blank" rel="noopener">link</a>' +
      "<table><tr><th>A</th></tr></table>";
    expect(sanitizePastedHtml(html)).toBe(html);
  });

  it("keeps entities intact for round-trip fidelity", () => {
    expect(sanitizePastedHtml("<p>A &amp; B &mdash; C</p>")).toBe("<p>A &amp; B &mdash; C</p>");
  });

  it("keeps dangerous tags and extra CSS only when explicitly allowed", () => {
    expect(
      sanitizePastedHtml("<style>p{color:red}</style><p>x</p>", { allowTags: ["style"] }),
    ).toBe("<style>p{color:red}</style><p>x</p>");
    expect(
      sanitizePastedHtml('<p style="color: red; letter-spacing: 2px">x</p>', {
        allowStyles: ["letter-spacing"],
      }),
    ).toBe('<p style="color: red; letter-spacing: 2px">x</p>');
  });

  it("fully cleans a nested span-style/font wrapper (leak regression)", () => {
    const html =
      '<span style="mso-margin-top: 0; font-size: 13px" onmouseover="x()">' +
      '<font color="#ff0000" face="Arial">t</font></span>';
    const clean = sanitizePastedHtml(html);
    expect(clean).toBe('<span><font color="#ff0000" face="Arial">t</font></span>');
    expect(clean).not.toMatch(/style=|onmouseover|mso-|font-size/);
  });
});

describe("stripToPlainText", () => {
  it("decodes entities", () => {
    expect(stripToPlainText("<p>A &amp; B &lt;C&gt; &copy;&nbsp;D</p>")).toBe(
      "A & B <C> ©\u00a0D",
    );
  });

  it("turns block boundaries and <br> into single newlines", () => {
    const html =
      "<h2>Title</h2><p>Hello <b>world</b><br>again</p>" +
      "<ul><li>one</li><li>two</li></ul><blockquote><p>q</p></blockquote>";
    expect(stripToPlainText(html)).toBe("Title\nHello world\nagain\none\ntwo\nq");
  });

  it("removes all markup, attributes and wrapper noise", () => {
    expect(stripToPlainText('<div class="x" style="color:red" lang="en"><span>t</span></div>')).toBe(
      "t",
    );
    expect(stripToPlainText("<p>  a\n   b  </p>")).toBe("a b");
  });

  it("drops script/style content outright", () => {
    expect(stripToPlainText('<p>safe<script>alert("x")</script><style>p{}</style></p>')).toBe(
      "safe",
    );
  });

  it("never leaks a nested span-style/font wrapper (leak regression)", () => {
    const html =
      '<span style="mso-x: 1" onmouseover="x()">' +
      '<font color="#ff0000" face="Arial">wrapped <b>text</b></font></span>';
    const text = stripToPlainText(html);
    expect(text).toBe("wrapped text");
    expect(text).not.toMatch(/[<>]|style|mso-/i);
  });

  it("returns an empty string for markup-only input", () => {
    expect(stripToPlainText('<div></div><img src="/a.png">')).toBe("");
  });
});

describe("HTML table parsing fidelity (B37)", () => {
  it("keeps tables through thead/tbody wrappers with colspan and rowspan", () => {
    const html =
      '<table><thead><tr><th colspan="2">Wide</th></tr></thead>' +
      '<tbody><tr><td rowspan="2">Tall</td><td>x</td></tr></tbody></table>';
    const cell = (type: string, text: string, colspan: number, rowspan: number) => ({
      type,
      attrs: { colspan, rowspan },
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    expect(parse(html).blocks).toEqual([
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell("tableHeader", "Wide", 2, 1)] },
          {
            type: "tableRow",
            content: [cell("tableCell", "Tall", 1, 2), cell("tableCell", "x", 1, 1)],
          },
        ],
      },
    ]);
  });
});
