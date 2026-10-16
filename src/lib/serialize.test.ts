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
});

describe("csv", () => {
  it("escapes quotes, commas and newlines", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });

  it("builds a CRLF CSV with a header row", () => {
    const csv = matrixToCsv(["Name", "Status"], [["Alpha", "Done"], ["Beta, Inc", 'x"y']]);
    expect(csv).toBe('Name,Status\r\nAlpha,Done\r\n"Beta, Inc","x""y"\r\n');
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
