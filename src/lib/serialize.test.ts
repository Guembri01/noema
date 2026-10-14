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
