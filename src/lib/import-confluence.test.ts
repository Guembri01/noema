import { describe, expect, it } from "vitest";
import { parseConfluenceExport, type ConfluencePage } from "./import-confluence";

/**
 * Confluence HTML export → Noema page tree (pure parser).
 *
 * Red-first: this file was written BEFORE `src/lib/import-confluence.ts`
 * existed, so every import resolved to module-not-found and the suite failed
 * to collect. It pins the tolerant, DOM-free contract: Confluence block markup
 * (headings, paragraphs, lists, tables, links, macros) becomes editor
 * (`RichBlock`) JSON, page wrappers become a `{ pages, meta }` tree, and
 * malformed markup never throws.
 */

function firstPage(html: string, spaceKey?: string): ConfluencePage {
  const result = parseConfluenceExport(spaceKey === undefined ? { html } : { html, spaceKey });
  const page = result.pages[0];
  if (!page) throw new Error("expected at least one page");
  return page;
}

describe("parseConfluenceExport — guards and empty input", () => {
  it("returns an empty page list and zeroed meta for empty html", () => {
    const result = parseConfluenceExport({ html: "" });
    expect(result.pages).toEqual([]);
    expect(result.meta).toEqual({
      spaceKey: null,
      pages: 0,
      blocks: 0,
      headings: 0,
      paragraphs: 0,
      lists: 0,
      tables: 0,
      codeBlocks: 0,
      images: 0,
      links: 0,
      pageRefs: 0,
      skippedElements: 0,
      warnings: [],
    });
  });

  it("never throws on non-string html", () => {
    const result = parseConfluenceExport({ html: null as unknown as string });
    expect(result.pages).toEqual([]);
  });

  it("tolerates unclosed and malformed markup", () => {
    const page = firstPage("<div><p>unclosed <b>bold");
    expect(page.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "unclosed " }, { type: "text", text: "bold", marks: [{ type: "bold" }] }] },
    ]);
  });
});

describe("parseConfluenceExport — headings and paragraphs", () => {
  it("uses the first h1 as the single page title and maps section headings", () => {
    const page = firstPage("<h1>Doc</h1><h2>Section</h2><p>Hello</p>");
    expect(page.props.title).toBe("Doc");
    expect(page.blocks).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Section" }] },
      { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
    ]);
  });

  it("maps h1–h6 inside content to heading blocks with the right level", () => {
    const page = firstPage(
      '<h1 class="pagetitle">Doc</h1><h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4>',
    );
    expect(page.blocks).toEqual([
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "One" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Two" }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Three" }] },
      { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "Four" }] },
    ]);
  });

  it("ignores whitespace-only paragraphs", () => {
    const page = firstPage("<h1>T</h1><p>   </p><p>real</p>");
    expect(page.blocks).toHaveLength(1);
  });
});

describe("parseConfluenceExport — inline content", () => {
  it("maps emphasis, code and strike marks", () => {
    const page = firstPage(
      "<h1>T</h1><p><strong>b</strong> <em>i</em> <code>c</code> <del>d</del></p>",
    );
    expect(page.blocks[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "b", marks: [{ type: "bold" }] },
        { type: "text", text: " " },
        { type: "text", text: "i", marks: [{ type: "italic" }] },
        { type: "text", text: " " },
        { type: "text", text: "c", marks: [{ type: "code" }] },
        { type: "text", text: " " },
        { type: "text", text: "d", marks: [{ type: "strike" }] },
      ],
    });
  });

  it("maps <br> to a hard break and decodes entities", () => {
    const page = firstPage("<h1>T</h1><p>a &amp; b<br>c &lt; d</p>");
    expect(page.blocks[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "a & b" },
        { type: "hardBreak" },
        { type: "text", text: "c < d" },
      ],
    });
  });

  it("maps anchors to link marks with a sanitized href", () => {
    const page = firstPage('<h1>T</h1><p>See <a href="https://example.com/x">the docs</a>.</p>');
    expect(page.blocks[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "See " },
        { type: "text", text: "the docs", marks: [{ type: "link", attrs: { href: "https://example.com/x" } }] },
        { type: "text", text: "." },
      ],
    });
  });

  it("drops javascript: links but keeps their label text", () => {
    const result = parseConfluenceExport({ html: '<h1>T</h1><p><a href="javascript:alert(1)">x</a></p>' });
    expect(result.pages[0].blocks[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "x" }],
    });
    expect(result.meta.links).toBe(0);
  });
});

describe("parseConfluenceExport — lists", () => {
  it("maps unordered lists to bulletList / listItem", () => {
    const page = firstPage("<h1>T</h1><ul><li>a</li><li>b</li></ul>");
    expect(page.blocks[0]).toEqual({
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
      ],
    });
  });

  it("maps ordered lists and records a non-default start", () => {
    const page = firstPage('<h1>T</h1><ol start="3"><li>x</li></ol>');
    expect(page.blocks[0]).toEqual({
      type: "orderedList",
      attrs: { start: 3 },
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }],
    });
  });

  it("nests a list inside a list item", () => {
    const page = firstPage("<h1>T</h1><ul><li>a<ul><li>a1</li></ul></li></ul>");
    expect(page.blocks[0]).toEqual({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "a" }] },
            {
              type: "bulletList",
              content: [
                { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a1" }] }] },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe("parseConfluenceExport — tables", () => {
  it("maps th to tableHeader and td to tableCell", () => {
    const page = firstPage("<h1>T</h1><table><tr><th>H</th></tr><tr><td>c</td></tr></table>");
    expect(page.blocks[0]).toEqual({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "H" }] }] }],
        },
        {
          type: "tableRow",
          content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] }],
        },
      ],
    });
  });

  it("reads rows through thead / tbody wrappers", () => {
    const page = firstPage(
      "<h1>T</h1><table><thead><tr><th>H</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>",
    );
    expect(page.blocks[0]).toMatchObject({ type: "table" });
    expect((page.blocks[0].content ?? []).length).toBe(2);
  });
});

describe("parseConfluenceExport — code, quote, rule, images", () => {
  it("maps <pre><code class=language-x> to a codeBlock with language", () => {
    const page = firstPage('<h1>T</h1><pre><code class="language-ts">const x = 1;</code></pre>');
    expect(page.blocks[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const x = 1;" }],
    });
  });

  it("maps a bare <pre> to a language-less codeBlock", () => {
    const page = firstPage("<h1>T</h1><pre>plain text</pre>");
    expect(page.blocks[0]).toEqual({ type: "codeBlock", content: [{ type: "text", text: "plain text" }] });
  });

  it("maps blockquote and hr", () => {
    const page = firstPage("<h1>T</h1><blockquote><p>q</p></blockquote><hr>");
    expect(page.blocks).toEqual([
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }] },
      { type: "horizontalRule" },
    ]);
  });

  it("maps img to an image block and drops unsafe src schemes", () => {
    const page = firstPage('<h1>T</h1><img src="/media/a.png" alt="A"><img src="javascript:evil()">');
    expect(page.blocks).toEqual([
      { type: "image", attrs: { src: "/media/a.png", alt: "A" } },
      { type: "image", attrs: { src: "", alt: "" } },
    ]);
  });
});

describe("parseConfluenceExport — Confluence macros and references", () => {
  it("maps a code macro to a codeBlock using ac:parameter language", () => {
    const html =
      '<h1>T</h1><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body>let y = 2;</ac:plain-text-body></ac:structured-macro>';
    expect(firstPage(html).blocks[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "js" },
      content: [{ type: "text", text: "let y = 2;" }],
    });
  });

  it("strips CDATA wrappers from macro bodies", () => {
    const html =
      '<h1>T</h1><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[let z = 3;]]></ac:plain-text-body></ac:structured-macro>';
    expect(firstPage(html).blocks[0]).toEqual({
      type: "codeBlock",
      content: [{ type: "text", text: "let z = 3;" }],
    });
  });

  it("maps info/note/warning/tip macros to a callout", () => {
    const html =
      '<h1>T</h1><ac:structured-macro ac:name="info"><ac:rich-text-body><p>Heads up</p></ac:rich-text-body></ac:structured-macro>';
    expect(firstPage(html).blocks[0]).toEqual({
      type: "callout",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Heads up" }] }],
    });
  });

  it("maps ri:page references to pageRef-marked text and counts them", () => {
    const result = parseConfluenceExport({
      html: '<h1>T</h1><p>See <ac:link><ri:page ri:content-title="Child Page"/></ac:link></p>',
    });
    expect(result.pages[0].blocks[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "See " },
        { type: "text", text: "Child Page", marks: [{ type: "pageRef", attrs: { title: "Child Page" } }] },
      ],
    });
    expect(result.meta.pageRefs).toBe(1);
  });

  it("maps ac:image with ri:url to an image block", () => {
    const html = '<h1>T</h1><ac:image ac:alt="Diagram"><ri:url ri:value="https://x.com/d.png"/></ac:image>';
    expect(firstPage(html).blocks[0]).toEqual({
      type: "image",
      attrs: { src: "https://x.com/d.png", alt: "Diagram" },
    });
  });

  it("skips an unknown macro, counts it and records one warning", () => {
    const result = parseConfluenceExport({
      html: '<h1>T</h1><ac:structured-macro ac:name="mystery"></ac:structured-macro>',
    });
    expect(result.pages[0].blocks).toEqual([]);
    expect(result.meta.skippedElements).toBe(1);
    expect(result.meta.warnings).toContain("unsupported macro: mystery");
  });

  it("drops script and style content entirely", () => {
    const page = firstPage("<h1>T</h1><p>keep</p><script>alert(1)</script><style>p{}</style>");
    expect(page.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "keep" }] }]);
  });
});

describe("parseConfluenceExport — page tree", () => {
  it("builds one page from a single pagetitle marker", () => {
    const page = firstPage('<h1 class="pagetitle">Doc</h1><p>body</p>');
    expect(page.props).toEqual({ title: "Doc", icon: null, coverUrl: null, spaceKey: null, labels: [] });
    expect(page.parentId).toBeNull();
    expect(page.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "body" }] }]);
  });

  it("splits sibling pagetitle markers into flat pages", () => {
    const result = parseConfluenceExport({
      html: '<h1 class="pagetitle">One</h1><p>a</p><h1 class="pagetitle">Two</h1><p>b</p>',
    });
    expect(result.pages.map((page) => page.props.title)).toEqual(["One", "Two"]);
    expect(result.pages[0].blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "a" }] }]);
    expect(result.pages[1].blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "b" }] }]);
  });

  it("nests pageSection containers and carries props", () => {
    const html = [
      '<div class="pageSection" data-page-id="p1" data-title="Home" data-space-key="DOC" data-icon="🏠">',
      "<h1>Home</h1><p>Welcome</p>",
      '<div class="pageSection" data-page-id="p2" data-title="Child"><p>Nested</p></div>',
      "</div>",
    ].join("");
    const result = parseConfluenceExport({ html, spaceKey: "SP" });

    expect(result.pages).toHaveLength(1);
    const home = result.pages[0];
    expect(home.id).toBe("p1");
    expect(home.parentId).toBeNull();
    expect(home.props).toEqual({ title: "Home", icon: "🏠", coverUrl: null, spaceKey: "DOC", labels: [] });
    expect(home.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "Welcome" }] }]);

    expect(home.children).toHaveLength(1);
    expect(home.children[0].id).toBe("p2");
    expect(home.children[0].parentId).toBe("p1");
    expect(home.children[0].props.title).toBe("Child");
    expect(result.meta.pages).toBe(2);
  });

  it("links flat page containers via data-parent", () => {
    const html = [
      '<div data-page-id="a" data-title="Alpha"><p>A</p></div>',
      '<div data-page-id="b" data-title="Beta" data-parent="a"><p>B</p></div>',
    ].join("");
    const result = parseConfluenceExport({ html });
    expect(result.pages.map((page) => page.props.title)).toEqual(["Alpha"]);
    expect(result.pages[0].children.map((page) => page.props.title)).toEqual(["Beta"]);
    expect(result.pages[0].children[0].parentId).toBe("a");
  });

  it("collects deduped labels and defaults the space key from the input", () => {
    const html =
      '<div data-page-id="p" data-title="T"><span data-label="alpha"></span><span data-label="beta"></span><span data-label="alpha"></span><p>x</p></div>';
    const result = parseConfluenceExport({ html, spaceKey: "SP" });
    expect(result.pages[0].props.labels).toEqual(["alpha", "beta"]);
    expect(result.pages[0].props.spaceKey).toBe("SP");
    expect(result.meta.spaceKey).toBe("SP");
  });

  it("treats a data-parent pointing at an unknown id as a root", () => {
    const result = parseConfluenceExport({
      html: '<div data-page-id="b" data-title="B" data-parent="missing"><p>b</p></div>',
    });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].parentId).toBeNull();
  });
});

describe("parseConfluenceExport — meta counters", () => {
  it("counts headings, paragraphs, code blocks and images", () => {
    const result = parseConfluenceExport({
      html: '<h1>T</h1><h2>H</h2><p>p</p><hr><img src="/i.png" alt=""><pre>x</pre>',
    });
    expect(result.meta.headings).toBe(1);
    expect(result.meta.paragraphs).toBe(1);
    expect(result.meta.codeBlocks).toBe(1);
    expect(result.meta.images).toBe(1);
    expect(result.meta.blocks).toBe(5);
  });

  it("counts lists and tables as single container blocks", () => {
    const result = parseConfluenceExport({
      html: "<h1>T</h1><ul><li>l</li></ul><table><tr><td>c</td></tr></table>",
    });
    expect(result.meta.lists).toBe(1);
    expect(result.meta.tables).toBe(1);
  });

  it("counts valid links across the document", () => {
    const result = parseConfluenceExport({
      html: '<h1>T</h1><p><a href="https://a.com">a</a> <a href="/b">b</a></p>',
    });
    expect(result.meta.links).toBe(2);
  });
});
