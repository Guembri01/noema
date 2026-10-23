import { describe, expect, it } from "vitest";
import { csvEscape, csvToMatrix, docToHtml, markdownToDoc, matrixToCsv, pageToHtml, pageToMarkdown } from "@/lib/serialize";
import { docToMarkdown } from "@/lib/blocks";

describe("markdownToDoc", () => {
  it("parses headings, lists, tasks, quotes and code", () => {
    const doc = markdownToDoc(
      [
        "# Title",
        "",
        "A **bold** and *italic* line with `code`.",
        "",
        "- one",
        "- two",
        "",
        "- [ ] todo",
        "- [x] done",
        "",
        "> quoted",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    );
    const types = doc.content.map((n) => n.type);
    expect(types).toContain("heading");
    expect(types).toContain("bulletList");
    expect(types).toContain("taskList");
    expect(types).toContain("blockquote");
    expect(types).toContain("codeBlock");

    const taskList = doc.content.find((n) => n.type === "taskList")!;
    expect(taskList.content?.[0]?.attrs?.checked).toBe(false);
    expect(taskList.content?.[1]?.attrs?.checked).toBe(true);

    const para = doc.content.find(
      (n) => n.type === "paragraph" && (n.content ?? []).some((c) => c.marks?.length),
    )!;
    expect(para.content!.some((c) => c.marks?.[0]?.type === "bold")).toBe(true);
  });

  it("always returns at least one block", () => {
    expect(markdownToDoc("").content).toHaveLength(1);
  });
});

describe("pageToMarkdown", () => {
  it("adds the title as an H1", () => {
    const md = pageToMarkdown("My page", {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
    });
    expect(md.startsWith("# My page")).toBe(true);
    expect(md).toContain("Body");
  });

  /**
   * B109 — the output side applies the same href allowlist the input side
   * applies (`markdown.ts#safeHref`): a stored target the allowlist refuses
   * is written as plain text, never as a link.
   */
  it("writes a refused link target as plain text, without the target", () => {
    const md = pageToMarkdown("My page", {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
          ],
        },
      ],
    });
    expect(md).toBe("# My page\n\nclick\n");
  });
});

describe("csv", () => {
  it("escapes quotes, commas and newlines", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });

  it("prefixes spreadsheet formula-like values, including after whitespace/control characters", () => {
    for (const formula of ["=1+1", "+cmd", "-1+2", "@SUM(A1)", "  =1+1", "\t@SUM(A1)"]) {
      expect(csvEscape(formula)).toBe(`'${formula}`);
    }
    expect(csvEscape("\r\n+1")).toBe("\"'\r\n+1\"");
    expect(csvEscape(" ordinary = text")).toBe(" ordinary = text");
  });

  it("builds a CRLF CSV with a header row", () => {
    const csv = matrixToCsv(["Name", "Status"], [["Alpha", "Done"], ["Beta, Inc", 'x"y']]);
    expect(csv).toBe('Name,Status\r\nAlpha,Done\r\n"Beta, Inc","x""y"\r\n');
  });

  it("neutralizes formula-like cells when building CSV", () => {
    expect(matrixToCsv(["Name"], [["=1+1"]])).toBe("Name\r\n'=1+1\r\n");
  });
});

describe("round trip", () => {
  it("markdown → doc → markdown keeps structure", () => {
    const md = "# Title\n\n- one\n- two";
    expect(docToMarkdown(markdownToDoc(md))).toContain("# Title");
    expect(docToMarkdown(markdownToDoc(md))).toContain("- one");
  });
});

describe("csvToMatrix", () => {
  it("parses quoted fields, escaped quotes and newlines", () => {
    const csv = 'Name,Status\r\nAlpha,Done\r\n"Beta, Inc","x""y"\r\n"multi\nline",z';
    const matrix = csvToMatrix(csv);
    expect(matrix[0]).toEqual(["Name", "Status"]);
    expect(matrix[1]).toEqual(["Alpha", "Done"]);
    expect(matrix[2]).toEqual(["Beta, Inc", 'x"y']);
    expect(matrix[3]).toEqual(["multi\nline", "z"]);
  });
});

describe("html export", () => {
  it("renders blocks and escapes text", () => {
    const html = docToHtml({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Hi & bye" }] },
        { type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "b" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }] },
      ],
    });
    expect(html).toContain("<h1>Hi &amp; bye</h1>");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<ul><li><p>item</p></li></ul>");
  });

  it("produces a standalone document", () => {
    const doc = pageToHtml("My page", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] });
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<title>My page</title>");
  });
});

/**
 * The HTML serializer builds `<a href>` and `style` attributes out of stored
 * document JSON, so both need the hardening the live export (`html-export.ts`)
 * already has: `sanitizeHref` for every href-shaped value, an allowlist for
 * the colour a `style` attribute may carry.
 *
 * Before the fix `docToHtml` emitted
 *   `<p><a href="javascript:alert(1)" target="_blank" rel="noreferrer noopener">click</a></p>`
 * (the same string inside `pageToHtml`'s body) and wrote a stored colour
 * verbatim, so `color:red; position: fixed; …` reached the output.
 */
describe("html export - href scheme and style allowlist", () => {
  const linkDoc = (href: string) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href } }] }],
      },
    ],
  });

  const colourDoc = (color: string) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "coloured", marks: [{ type: "textStyle", attrs: { color } }] }],
      },
    ],
  });

  it("drops a javascript: link href but keeps the label", () => {
    const html = docToHtml(linkDoc("javascript:alert(1)"));
    expect(html).not.toContain("javascript:");
    expect(html).toBe("<p>click</p>");
  });

  it("drops a javascript: link href from the standalone page too", () => {
    const html = pageToHtml("My page", linkDoc("javascript:alert(1)"));
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<p>click</p>");
  });

  it("drops a mixed-case, a control-character and a data: target", () => {
    expect(docToHtml(linkDoc("JavaScript:alert(1)"))).toBe("<p>click</p>");
    expect(docToHtml(linkDoc("java\tscript:alert(1)"))).toBe("<p>click</p>");
    expect(docToHtml(linkDoc("data:text/html,<script>alert(1)</script>"))).toBe("<p>click</p>");
  });

  it("keeps the allowlisted schemes and safe relative targets", () => {
    for (const href of [
      "https://example.test/a?b=1#c",
      "http://example.test",
      "mailto:a@b.test",
      "tel:+1234",
      "/docs/page",
      "#section",
    ]) {
      expect(docToHtml(linkDoc(href))).toBe(
        `<p><a href="${href}" target="_blank" rel="noreferrer noopener">click</a></p>`,
      );
    }
  });

  it("drops a javascript: bookmark/embed url but keeps the title", () => {
    const html = docToHtml({
      type: "doc",
      content: [{ type: "embed", attrs: { url: "javascript:alert(1)", title: "A link" } }],
    });
    expect(html).not.toContain("javascript:");
    expect(html).toBe("<p>A link</p>");
  });

  it("keeps an allowlisted tag colour token and a legacy hex colour", () => {
    expect(docToHtml(colourDoc("var(--tag-blue-fg)"))).toBe(
      '<p><span style="color:var(--tag-blue-fg)">coloured</span></p>',
    );
    expect(docToHtml(colourDoc("#d44c47"))).toBe(
      '<p><span style="color:#d44c47">coloured</span></p>',
    );
  });

  it("drops a colour outside the allowlist so it cannot inject CSS", () => {
    const injected = docToHtml(
      colourDoc("red; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh"),
    );
    expect(injected).not.toContain("style=");
    expect(injected).not.toContain("position: fixed");
    expect(injected).toBe("<p>coloured</p>");
    expect(docToHtml(colourDoc("url(javascript:alert(1))"))).toBe("<p>coloured</p>");
  });
});

/**
 * Optional block variants (MISSING_FEATURES §1 "Code block line numbers" /
 * "Code block caption" / "Pull quote / large quote"). The editor stores these
 * on the node and reads them back through `data-line-numbers` / `data-caption`
 * on `<pre>` (code-block.tsx addAttributes) and `data-size` on `<blockquote>`
 * (custom-blocks.tsx PullQuote global attr). serialize must carry the same
 * attrs from stored JSON to HTML, and read the canonical markdown forms
 * (fence `{lineNumbers caption="…"}`, leading `> [!large]`) back into stored
 * JSON, so the two ends round-trip. Conventions reuse `code-block.ts`'s
 * `formatCaption` and `pull-quote.ts`'s `isPullQuoteSize` rather than forking.
 */
describe("code block + pull quote variant round-trip", () => {
  it("imports fence {lineNumbers caption} options into codeBlock attrs", () => {
    const doc = markdownToDoc('```ts {lineNumbers caption="Run it"}\nconst a = 1;\n```');
    expect(doc.content[0]).toMatchObject({
      type: "codeBlock",
      attrs: { language: "ts", lineNumbers: true, caption: "Run it" },
    });
    expect(doc.content[0].content?.[0].text).toBe("const a = 1;");
  });

  it("imports a leading [!large] marker into a blockquote size attr", () => {
    const doc = markdownToDoc("> [!large]\n> Stay hungry.");
    expect(doc.content[0]).toMatchObject({ type: "blockquote", attrs: { size: "large" } });
    expect(doc.content[0].content?.[0].content?.[0].text).toBe("Stay hungry.");
  });

  it("leaves plain fences and quotes byte-for-byte unchanged", () => {
    const doc = markdownToDoc("```ts\nplain\n```\n\n> ordinary");
    expect(doc.content[0].attrs).toEqual({ language: "ts" });
    expect(doc.content[0].content?.[0].text).toBe("plain");
    expect(doc.content[1].type).toBe("blockquote");
    expect(doc.content[1].attrs).toBeUndefined();
    expect(doc.content[1].content?.[0].content?.[0].text).toBe("ordinary");
  });

  it("renders code-block lineNumbers and caption into HTML", () => {
    const html = docToHtml({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts", lineNumbers: true, caption: "Run it" },
          content: [{ type: "text", text: "const a = 1;" }],
        },
      ],
    });
    expect(html).toBe(
      '<pre data-line-numbers="true" data-caption="Run it"><code>const a = 1;</code></pre>',
    );
  });

  it("normalises the caption and escapes it as an attribute value", () => {
    const html = docToHtml({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { caption: 'He said "hi"   twice' },
          content: [{ type: "text", text: "x" }],
        },
      ],
    });
    expect(html).toBe('<pre data-caption="He said &quot;hi&quot; twice"><code>x</code></pre>');
  });

  it("keeps a bare code block unchanged and drops an empty caption", () => {
    const html = docToHtml({
      type: "doc",
      content: [
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
        { type: "codeBlock", attrs: { caption: "   " }, content: [{ type: "text", text: "y" }] },
      ],
    });
    expect(html).toBe("<pre><code>x</code></pre>\n<pre><code>y</code></pre>");
  });

  it("renders only a large quote with data-size, never the default", () => {
    const large = docToHtml({
      type: "doc",
      content: [
        {
          type: "blockquote",
          attrs: { size: "large" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Big" }] }],
        },
      ],
    });
    expect(large).toBe('<blockquote data-size="large"><p>Big</p></blockquote>');

    const plain = docToHtml({
      type: "doc",
      content: [
        {
          type: "blockquote",
          attrs: { size: "default" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Small" }] }],
        },
      ],
    });
    expect(plain).toBe("<blockquote><p>Small</p></blockquote>");
  });

  it("carries both variants from markdown through stored JSON into HTML", () => {
    const doc = markdownToDoc(
      '```ts {lineNumbers caption="Run it"}\nconst a = 1;\n```\n\n> [!large]\n> Stay hungry.',
    );
    const html = docToHtml(doc);
    expect(html).toContain(
      '<pre data-line-numbers="true" data-caption="Run it"><code>const a = 1;</code></pre>',
    );
    expect(html).toContain('<blockquote data-size="large"><p>Stay hungry.</p></blockquote>');
  });
});
