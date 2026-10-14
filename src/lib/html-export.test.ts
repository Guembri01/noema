import { describe, expect, it } from "vitest";
import { blocksToHtml, documentToHtml, escapeHtml } from "./html-export";
import type { RichBlock } from "./markdown";

/**
 * §12 Export HTML — the pure, hardened sibling of the Markdown exporter.
 *
 * `markdown.ts` already has `blocksToMarkdown`; this file pins the same block
 * set rendered to semantic HTML, plus the escaping/sanitisation that a
 * document export must never lose. XSS-ish inputs (`<script>`, `onerror=`,
 * `javascript:`) are first-class cases here: text is escaped, attributes are
 * escaped, and every link href goes through `sanitizeHref`.
 *
 * Red-first: this file failed to import before `html-export.ts` existed.
 */

const para = (text: string): RichBlock => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const text = (value: string, marks?: RichBlock["marks"]): RichBlock =>
  marks ? { type: "text", text: value, marks } : { type: "text", text: value };

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml('A & B <tag> "q" \'s\'')).toBe(
      "A &amp; B &lt;tag&gt; &quot;q&quot; &#39;s&#39;",
    );
  });

  it("leaves plain text and empty strings alone", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
    expect(escapeHtml("")).toBe("");
  });
});

describe("blocksToHtml — block types", () => {
  it("renders a paragraph", () => {
    expect(blocksToHtml([para("Hello")])).toBe("<p>Hello</p>");
  });

  it("renders headings and clamps the level to 1..6", () => {
    expect(
      blocksToHtml([{ type: "heading", attrs: { level: 2 }, content: [text("T")] }]),
    ).toBe("<h2>T</h2>");
    expect(
      blocksToHtml([{ type: "heading", attrs: { level: 9 }, content: [text("High")] }]),
    ).toBe("<h6>High</h6>");
    expect(
      blocksToHtml([{ type: "heading", attrs: { level: 0 }, content: [text("Low")] }]),
    ).toBe("<h1>Low</h1>");
  });

  it("renders a bullet list of list items", () => {
    const list: RichBlock = {
      type: "bulletList",
      content: [
        { type: "listItem", content: [para("one")] },
        { type: "listItem", content: [para("two")] },
      ],
    };
    expect(blocksToHtml([list])).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  it("nests a list inside its parent item", () => {
    const list: RichBlock = {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            para("outer"),
            { type: "bulletList", content: [{ type: "listItem", content: [para("inner")] }] },
          ],
        },
      ],
    };
    expect(blocksToHtml([list])).toBe("<ul><li>outer<ul><li>inner</li></ul></li></ul>");
  });

  it("carries an ordered list's start number", () => {
    const list: RichBlock = {
      type: "orderedList",
      attrs: { start: 3 },
      content: [{ type: "listItem", content: [para("three")] }],
    };
    expect(blocksToHtml([list])).toBe('<ol start="3"><li>three</li></ol>');
    expect(
      blocksToHtml([
        { type: "orderedList", content: [{ type: "listItem", content: [para("one")] }] },
      ]),
    ).toBe("<ol><li>one</li></ol>");
  });

  it("renders a todo list with disabled checkboxes", () => {
    const list: RichBlock = {
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [para("done")] },
        { type: "taskItem", attrs: { checked: false }, content: [para("todo")] },
      ],
    };
    expect(blocksToHtml([list])).toBe(
      '<ul class="todo-list"><li><input type="checkbox" disabled checked /> done</li><li><input type="checkbox" disabled /> todo</li></ul>',
    );
  });

  it("renders a quote and a pull-quote", () => {
    expect(blocksToHtml([{ type: "blockquote", content: [para("quoted")] }])).toBe(
      "<blockquote><p>quoted</p></blockquote>",
    );
    expect(
      blocksToHtml([
        { type: "blockquote", attrs: { size: "large" }, content: [para("Big")] },
      ]),
    ).toBe('<blockquote class="pull-quote"><p>Big</p></blockquote>');
  });

  it("renders a code block with its language", () => {
    const code: RichBlock = {
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1;" }],
    };
    expect(blocksToHtml([code])).toBe(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
  });

  it("escapes code contents instead of rendering them", () => {
    const code: RichBlock = {
      type: "codeBlock",
      content: [{ type: "text", text: "<script>alert(1)</script>" }],
    };
    expect(blocksToHtml([code])).toBe(
      "<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>",
    );
  });

  it("renders a divider (and its horizontalRule alias)", () => {
    expect(blocksToHtml([{ type: "horizontalRule" }])).toBe("<hr />");
    expect(blocksToHtml([{ type: "divider" }])).toBe("<hr />");
  });

  it("renders a callout with its emoji", () => {
    const callout: RichBlock = {
      type: "callout",
      attrs: { emoji: "💡" },
      content: [para("Note")],
    };
    expect(blocksToHtml([callout])).toBe(
      '<aside class="callout"><span class="callout-emoji">💡</span><p>Note</p></aside>',
    );
  });

  it("renders a table with a header row and body rows", () => {
    const cell = (type: string, value: string): RichBlock => ({
      type,
      content: [{ type: "paragraph", content: [{ type: "text", text: value }] }],
    });
    const table: RichBlock = {
      type: "table",
      content: [
        { type: "tableRow", content: [cell("tableHeader", "A"), cell("tableHeader", "B")] },
        { type: "tableRow", content: [cell("tableCell", "1"), cell("tableCell", "2")] },
      ],
    };
    expect(blocksToHtml([table])).toBe(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
  });

  it("joins multiple blocks with newlines and drops empty ones", () => {
    expect(blocksToHtml([para("a"), { type: "horizontalRule" }, para("b")])).toBe(
      "<p>a</p>\n<hr />\n<p>b</p>",
    );
    expect(blocksToHtml([])).toBe("");
  });
});

describe("blocksToHtml — inline marks", () => {
  it("renders strong, em, code and strike", () => {
    const p: RichBlock = {
      type: "paragraph",
      content: [
        text("b", [{ type: "bold" }]),
        text(" "),
        text("i", [{ type: "italic" }]),
        text(" "),
        text("c", [{ type: "code" }]),
        text(" "),
        text("x", [{ type: "strike" }]),
      ],
    };
    expect(blocksToHtml([p])).toBe(
      "<p><strong>b</strong> <em>i</em> <code>c</code> <s>x</s></p>",
    );
  });

  it("nests combined marks with emphasis outside strong", () => {
    const p: RichBlock = {
      type: "paragraph",
      content: [text("both", [{ type: "bold" }, { type: "italic" }])],
    };
    expect(blocksToHtml([p])).toBe("<p><em><strong>both</strong></em></p>");
  });

  it("renders a safe link", () => {
    const p: RichBlock = {
      type: "paragraph",
      content: [text("x", [{ type: "link", attrs: { href: "https://x.co" } }])],
    };
    expect(blocksToHtml([p])).toBe('<p><a href="https://x.co">x</a></p>');
  });

  it("keeps a same-document link", () => {
    const p: RichBlock = {
      type: "paragraph",
      content: [text("top", [{ type: "link", attrs: { href: "#top" } }])],
    };
    expect(blocksToHtml([p])).toBe('<p><a href="#top">top</a></p>');
  });
});

describe("blocksToHtml — XSS-ish inputs", () => {
  it("escapes script tags in text", () => {
    expect(blocksToHtml([para("<script>alert('x')</script>")])).toBe(
      "<p>&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;</p>",
    );
  });

  it("drops javascript: link hrefs but keeps the label", () => {
    const p: RichBlock = {
      type: "paragraph",
      content: [text("click", [{ type: "link", attrs: { href: "javascript:alert(1)" } }])],
    };
    expect(blocksToHtml([p])).toBe("<p>click</p>");
  });

  it("drops control-character and encoded-colon link bypasses", () => {
    const trick = (href: string): RichBlock => ({
      type: "paragraph",
      content: [text("x", [{ type: "link", attrs: { href } }])],
    });
    expect(blocksToHtml([trick("java\nscript:alert(1)")])).toBe("<p>x</p>");
    expect(blocksToHtml([trick("javascript%3Aalert(1)")])).toBe("<p>x</p>");
    expect(blocksToHtml([trick("//evil.example/x")])).toBe("<p>x</p>");
  });

  it("escapes attribute values (image alt injection)", () => {
    const img: RichBlock = {
      type: "image",
      attrs: { src: "/a.png", alt: '"><img onerror=alert(1)>' },
    };
    expect(blocksToHtml([img])).toBe(
      '<img src="/a.png" alt="&quot;&gt;&lt;img onerror=alert(1)&gt;" />',
    );
  });

  it("still sanitises hrefs when escaping is switched off", () => {
    const p: RichBlock = {
      type: "paragraph",
      content: [
        text("<b>raw</b>"),
        text("bad", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
      ],
    };
    expect(blocksToHtml([p], { escape: false })).toBe("<p><b>raw</b>bad</p>");
  });

  it("accepts a custom text escaper", () => {
    expect(blocksToHtml([para("hi")], { escape: (value) => value.toUpperCase() })).toBe(
      "<p>HI</p>",
    );
  });

  it("degrades unknown blocks and junk without throwing", () => {
    const blocks: RichBlock[] = [
      { type: "futureWidget", content: [para("kept")] },
      { type: "mysteryLeaf", text: "stray", marks: [{ type: "bold" }] },
      null as unknown as RichBlock,
      { type: "wrapper", content: [para("ok")] },
    ];
    expect(blocksToHtml(blocks)).toBe("<p>kept</p>\n<strong>stray</strong>\n<p>ok</p>");
  });
});

describe("documentToHtml", () => {
  const blocks: RichBlock[] = [para("Body")];

  it("wraps blocks in a complete standalone document", () => {
    const html = documentToHtml(blocks, { title: "Doc" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Doc</title>");
    expect(html).toContain("<style>");
    expect(html).toContain("<h1>Doc</h1>");
    expect(html).toContain("<p>Body</p>");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("falls back to an Untitled title", () => {
    const html = documentToHtml(blocks);
    expect(html).toContain("<title>Untitled</title>");
    expect(html).toContain("<h1>Untitled</h1>");
  });

  it("escapes the document title", () => {
    const html = documentToHtml([], { title: "<script>x</script>" });
    expect(html).toContain("<title>&lt;script&gt;x&lt;/script&gt;</title>");
    expect(html).not.toContain("<title><script>");
  });
});
