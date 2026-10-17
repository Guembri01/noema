import { describe, expect, it } from "vitest";
import { parseGoogleDoc } from "@/lib/import-gdocs";

/**
 * Google Docs HTML export (and the docx-to-html output) -> Noema blocks.
 *
 * These tests pin the pure, dependency-free parse: block structure first, then
 * inline marks, links, lists, tables, the "image as link" rule, the metadata
 * counters and finally the tolerance guarantees (malformed / hostile HTML must
 * never throw). Inputs are deliberately Google-Docs-shaped (class-only styling,
 * a real `<head>`, wrapper `<span>`s) because the export carries no semantic
 * markup beyond tag names.
 */

const parse = (html: string) => parseGoogleDoc({ html });

describe("parseGoogleDoc — block structure", () => {
  it("maps h1-h6 to heading blocks with their levels", () => {
    const { blocks, meta } = parse(
      "<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>",
    );
    expect(blocks).toEqual([
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "One" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Two" }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Three" }] },
      { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "Four" }] },
      { type: "heading", attrs: { level: 5 }, content: [{ type: "text", text: "Five" }] },
      { type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "Six" }] },
    ]);
    expect(meta.headings).toBe(6);
  });

  it("maps paragraphs and preserves their order", () => {
    const { blocks, meta } = parse("<p>First</p><p>Second</p>");
    expect(blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "First" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second" }] },
    ]);
    expect(meta.paragraphs).toBe(2);
  });

  it("decodes HTML entities in text", () => {
    const { blocks } = parse("<p>Tom &amp; Jerry &#39;quoted&#39; &lt;3</p>");
    expect(blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Tom & Jerry 'quoted' <3" }] },
    ]);
  });

  it("ignores whitespace-only nodes between blocks", () => {
    const { blocks } = parse("<p>A</p>\n   \n<p>B</p>");
    expect(blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "A" }] },
      { type: "paragraph", content: [{ type: "text", text: "B" }] },
    ]);
  });

  it("turns <br> into a hard break", () => {
    const { blocks } = parse("<p>line1<br>line2</p>");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "line1" }, { type: "hardBreak" }, { type: "text", text: "line2" }],
      },
    ]);
  });

  it("captures the <title> and skips the rest of the head", () => {
    const html =
      '<!doctype html><html><head><title>My Doc</title>' +
      '<meta charset="utf-8"><style>p{color:red}</style></head>' +
      "<body><p>Body</p></body></html>";
    const { blocks, meta } = parse(html);
    expect(blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "Body" }] }]);
    expect(meta.title).toBe("My Doc");
  });

  it("reports a null title when the document has none", () => {
    expect(parse("<p>x</p>").meta.title).toBeNull();
  });

  it("returns an empty result for empty html", () => {
    expect(parse("")).toEqual({
      blocks: [],
      meta: {
        title: null,
        headings: 0,
        paragraphs: 0,
        lists: 0,
        listItems: 0,
        tables: 0,
        images: 0,
        links: 0,
        dropped: [],
      },
    });
  });
});

describe("parseGoogleDoc — inline formatting", () => {
  it("maps bold, italic, underline, strike and code marks", () => {
    const { blocks } = parse(
      "<p><strong>bold</strong><em>ital</em><u>under</u><s>strike</s><code>code</code></p>",
    );
    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "bold", marks: [{ type: "bold" }] },
          { type: "text", text: "ital", marks: [{ type: "italic" }] },
          { type: "text", text: "under", marks: [{ type: "underline" }] },
          { type: "text", text: "strike", marks: [{ type: "strike" }] },
          { type: "text", text: "code", marks: [{ type: "code" }] },
        ],
      },
    ]);
  });

  it("merges marks from nested emphasis", () => {
    const { blocks } = parse("<p><strong><em>both</em></strong></p>");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [{ type: "text", text: "both", marks: [{ type: "bold" }, { type: "italic" }] }],
      },
    ]);
  });

  it("keeps a link mark and counts it", () => {
    const { blocks, meta } = parse('<p>see <a href="https://example.com/x">the site</a></p>');
    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "see " },
          {
            type: "text",
            text: "the site",
            marks: [{ type: "link", attrs: { href: "https://example.com/x" } }],
          },
        ],
      },
    ]);
    expect(meta.links).toBe(1);
  });

  it("unwraps an unsafe link instead of trusting it", () => {
    const { blocks, meta } = parse('<p><a href="javascript:alert(1)">x</a></p>');
    expect(blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "x" }] }]);
    expect(meta.links).toBe(0);
  });

  it("normalises a bare-domain link to https", () => {
    const { blocks } = parse('<p><a href="example.com">x</a></p>');
    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
        ],
      },
    ]);
  });
});

describe("parseGoogleDoc — lists", () => {
  it("maps bullet and ordered lists to their Noema shapes", () => {
    const { blocks, meta } = parse("<ul><li>alpha</li><li>beta</li></ul><ol><li>first</li></ol>");
    expect(blocks).toEqual([
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "alpha" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "beta" }] }] },
        ],
      },
      {
        type: "orderedList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
        ],
      },
    ]);
    expect(meta.lists).toBe(2);
    expect(meta.listItems).toBe(3);
  });

  it("carries an ordered list's start attribute", () => {
    const { blocks } = parse('<ol start="3"><li>x</li></ol>');
    expect(blocks).toEqual([
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }],
      },
    ]);
  });

  it("nests a child list inside its parent item", () => {
    const { blocks, meta } = parse("<ul><li>parent<ul><li>child</li></ul></li></ul>");
    expect(blocks).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "parent" }] },
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "child" }] }] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    expect(meta.listItems).toBe(2);
  });

  it("keeps inline marks on a list item", () => {
    const { blocks } = parse("<ul><li><strong>hi</strong></li></ul>");
    expect(blocks).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "hi", marks: [{ type: "bold" }] }] },
            ],
          },
        ],
      },
    ]);
  });
});

describe("parseGoogleDoc — tables", () => {
  it("maps rows and cells to table blocks", () => {
    const { blocks, meta } = parse(
      "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>",
    );
    const cell = (text: string) => ({
      type: "tableCell",
      attrs: { colspan: 1, rowspan: 1 },
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    expect(blocks).toEqual([
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell("A"), cell("B")] },
          { type: "tableRow", content: [cell("C")] },
        ],
      },
    ]);
    expect(meta.tables).toBe(1);
  });

  it("keeps a <th> as a table header cell", () => {
    const { blocks } = parse("<table><tr><th>H</th></tr><tr><td>V</td></tr></table>");
    const table = blocks[0];
    expect(table.type).toBe("table");
    const [head, body] = table.content ?? [];
    expect(head.content?.[0].type).toBe("tableHeader");
    expect(body.content?.[0].type).toBe("tableCell");
  });

  it("preserves cell spans", () => {
    const { blocks } = parse('<table><tr><td colspan="2" rowspan="3">wide</td></tr></table>');
    const table = blocks[0];
    expect(table.content?.[0].content?.[0].attrs).toEqual({ colspan: 2, rowspan: 3 });
  });
});

describe("parseGoogleDoc — images as links", () => {
  it("converts an image to a link paragraph labelled by its alt text", () => {
    const { blocks, meta } = parse('<img src="https://lh3.googleusercontent.com/abc" alt="Chart">');
    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Chart",
            marks: [{ type: "link", attrs: { href: "https://lh3.googleusercontent.com/abc" } }],
          },
        ],
      },
    ]);
    expect(meta.images).toBe(1);
  });

  it("falls back to the src as the link label when there is no alt", () => {
    const { blocks } = parse('<img src="https://x.test/pic.png">');
    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "https://x.test/pic.png",
            marks: [{ type: "link", attrs: { href: "https://x.test/pic.png" } }],
          },
        ],
      },
    ]);
  });

  it("converts an image inside a paragraph in place", () => {
    const { blocks } = parse('<p>Before <img src="https://x.test/p.png" alt="pic"> after</p>');
    expect(blocks).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Before " },
          {
            type: "text",
            text: "pic",
            marks: [{ type: "link", attrs: { href: "https://x.test/p.png" } }],
          },
          { type: "text", text: " after" },
        ],
      },
    ]);
  });

  it("degrades an unmappable image (data: src) to its alt text and records it", () => {
    const { blocks, meta } = parse('<img src="data:image/png;base64,AAAA" alt="pic">');
    expect(blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "pic" }] }]);
    expect(meta.images).toBe(0);
    expect(meta.dropped).toEqual(["img"]);
  });
});

describe("parseGoogleDoc — other blocks and safety", () => {
  it("maps blockquotes, horizontal rules and preformatted code", () => {
    const { blocks } = parse("<blockquote><p>Quoted</p></blockquote><hr><pre>x = 1\ny = 2</pre>");
    expect(blocks).toEqual([
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted" }] }] },
      { type: "horizontalRule" },
      { type: "codeBlock", content: [{ type: "text", text: "x = 1\ny = 2" }] },
    ]);
  });

  it("strips script/style content and ignores event-handler attributes", () => {
    const { blocks } = parse('<p onclick="evil()">ok</p><script>alert(1)</script><style>p{}</style>');
    expect(blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "ok" }] }]);
  });

  it("aggregates the metadata counters over a full export", () => {
    const html = [
      "<!DOCTYPE html>",
      "<html><head><title>Roadmap &amp; Notes</title><style>.c1{color:#000}</style></head>",
      "<body>",
      '<h1 class="c1"><span>Roadmap</span></h1>',
      '<p class="c2">Intro <strong>bold</strong> <a href="https://noema.example.com/x">link</a></p>',
      '<ul class="c3"><li class="c4"><span>one</span><ul><li>two</li></ul></li></ul>',
      "<ol><li>first</li></ol>",
      "<table><tr><td>A</td></tr></table>",
      '<img src="https://x.test/i.png" alt="pic">',
      "</body></html>",
    ].join("");
    const { blocks, meta } = parse(html);
    expect(meta).toEqual({
      title: "Roadmap & Notes",
      headings: 1,
      paragraphs: 2,
      lists: 2,
      listItems: 3,
      tables: 1,
      images: 1,
      links: 1,
      dropped: [],
    });
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
      "table",
      "paragraph",
    ]);
  });

  it("never throws on malformed or hostile input", () => {
    const inputs = [
      "<",
      "<<<>>",
      "<!-- unclosed",
      "<div><span></div>",
      "&amp;",
      "<table></table>",
      "<ul></ul>",
      "<p></p>",
      "<img>",
      "text <b",
      "<h7>x</h7>",
      "<a href><p>",
    ];
    for (const html of inputs) {
      expect(() => parse(html)).not.toThrow();
    }
  });

  it("tolerates unbalanced tags without losing content", () => {
    const { blocks } = parse("<p>unclosed<span>text</p><h2>Head");
    expect(blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "unclosedtext" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Head" }] },
    ]);
  });

  it("returns an empty result for missing or non-string html", () => {
    const empty = {
      blocks: [],
      meta: {
        title: null,
        headings: 0,
        paragraphs: 0,
        lists: 0,
        listItems: 0,
        tables: 0,
        images: 0,
        links: 0,
        dropped: [],
      },
    };
    expect(parseGoogleDoc({})).toEqual(empty);
    expect(parseGoogleDoc({ html: undefined })).toEqual(empty);
    expect(parseGoogleDoc({ html: 42 as unknown as string })).toEqual(empty);
    expect(parseGoogleDoc(undefined as unknown as { html: string })).toEqual(empty);
  });
});
