import { describe, expect, it } from "vitest";
import {
  hasMarkdown,
  markdownToText,
  markdownToTipTap,
  parseInline,
  parseMarkdown,
  safeHref,
} from "./markdown";

const text = (nodes: unknown[]): string =>
  JSON.stringify(nodes).replace(/\\"/g, '"');

describe("safeHref", () => {
  it("keeps safe schemes and blocks script-ish ones", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(safeHref("/w/demo/page")).toBe("/w/demo/page");
    expect(safeHref("#section")).toBe("#section");
    expect(safeHref("example.com/x")).toBe("https://example.com/x");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html;base64,PHN2Zz4=")).toBeNull();
    expect(safeHref("  ")).toBeNull();
  });
});

describe("parseInline", () => {
  it("parses emphasis, code and strikethrough", () => {
    const nodes = parseInline("a **bold** and *italic* and `code` and ~~gone~~");
    const types = nodes.map((node) => node.type);
    expect(types).toEqual(["text", "strong", "text", "em", "text", "code", "text", "del"]);
    expect(text(nodes.filter((node) => node.type === "strong"))).toContain("bold");
  });

  it("nests emphasis inside strong", () => {
    const [strong] = parseInline("**bold with *inner* text**");
    expect(strong.type).toBe("strong");
    if (strong.type !== "strong") return;
    expect(strong.children.some((child) => child.type === "em")).toBe(true);
  });

  it("turns note references into ref nodes", () => {
    const nodes = parseInline("see [[page:abc123|Design doc]] now");
    const ref = nodes.find((node) => node.type === "ref");
    expect(ref).toEqual({ type: "ref", pageId: "abc123", title: "Design doc" });
  });

  it("links only safe URLs and leaves unsafe ones as text", () => {
    const safe = parseInline("[x](https://a.co)");
    expect(safe[0]).toMatchObject({ type: "link", href: "https://a.co" });
    const unsafe = parseInline("[x](javascript:alert(1))");
    expect(unsafe.every((node) => node.type !== "link")).toBe(true);
  });

  it("treats embedded HTML as plain text (no markup can be injected)", () => {
    const nodes = parseInline('<img src=x onerror="alert(1)">');
    expect(nodes.every((node) => node.type === "text")).toBe(true);
    expect(JSON.stringify(nodes)).not.toContain('"html"');
  });

  it("honours escapes and hard breaks", () => {
    const nodes = parseInline("not \\*italic\\* here\nnext line");
    expect(nodes.some((node) => node.type === "br")).toBe(true);
    expect(nodes.filter((node) => node.type === "text").map((node) => (node as { value: string }).value).join("")).toContain("*italic*");
  });
});

describe("parseMarkdown blocks", () => {
  it("parses headings, paragraphs and rules", () => {
    const blocks = parseMarkdown("# Title\n\nBody text.\n\n---");
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "hr"]);
    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
  });

  it("parses fenced code with a language", () => {
    const [block] = parseMarkdown("```ts\nconst a = 1;\n```");
    expect(block).toEqual({ type: "code", lang: "ts", value: "const a = 1;" });
  });

  it("parses unordered, ordered and nested lists", () => {
    const blocks = parseMarkdown("- one\n- two\n  - nested\n\n1. first\n2. second");
    const [list, ordered] = blocks;
    expect(list.type).toBe("list");
    if (list.type !== "list") return;
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    expect(list.items[1].children[0].items[0].content[0]).toMatchObject({ value: "nested" });
    expect(ordered).toMatchObject({ type: "list", ordered: true });
  });

  it("parses task lists with checked state", () => {
    const [list] = parseMarkdown("- [x] done\n- [ ] todo");
    if (list.type !== "list") throw new Error("expected a list");
    expect(list.items.map((item) => item.checked)).toEqual([true, false]);
  });

  it("parses GFM tables with alignment", () => {
    const [table] = parseMarkdown("| A | B |\n| :--- | ---: |\n| 1 | 2 |\n| 3 | 4 |");
    expect(table.type).toBe("table");
    if (table.type !== "table") return;
    expect(table.align).toEqual(["left", "right"]);
    expect(table.header).toHaveLength(2);
    expect(table.rows).toHaveLength(2);
  });

  it("parses blockquotes recursively", () => {
    const [quote] = parseMarkdown("> **note**\n> second line");
    expect(quote.type).toBe("quote");
    if (quote.type !== "quote") return;
    expect(quote.blocks[0].type).toBe("paragraph");
  });

  it("keeps a realistic assistant answer intact", () => {
    const answer = [
      "Here are your projects:",
      "",
      "- **Demo** — active, due 12 Mar",
      "  - milestone: Ship the beta",
      "- **Internal** — planned",
      "",
      "| Project | Status |",
      "| --- | --- |",
      "| Demo | active |",
      "",
      "Next: review [[page:abc|Roadmap]].",
    ].join("\n");
    const blocks = parseMarkdown(answer);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "list", "table", "paragraph"]);
    const list = blocks[1];
    if (list.type !== "list") throw new Error("expected a list");
    expect(list.items).toHaveLength(2);
    // The indented milestone nests inside "Demo" rather than starting a new list.
    expect(list.items[0].children).toHaveLength(1);
    expect(list.items[0].children[0].items[0].content.map((node) => (node.type === "text" ? node.value : ""))).toEqual([
      "milestone: Ship the beta",
    ]);
  });
});

describe("conversions", () => {
  it("converts Markdown to TipTap JSON", () => {
    const nodes = markdownToTipTap("# H\n\n- a\n- b\n\n```js\nx\n```\n\n> q");
    expect(nodes[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
    expect(nodes.some((node) => node.type === "bulletList")).toBe(true);
    expect(nodes.some((node) => node.type === "codeBlock")).toBe(true);
    expect(nodes.some((node) => node.type === "paragraph")).toBe(true);
  });

  it("marks task lists as taskItem", () => {
    const [list] = markdownToTipTap("- [x] one");
    expect(list.type).toBe("taskList");
    expect(list.content?.[0]).toMatchObject({ type: "taskItem", attrs: { checked: true } });
  });

  it("flattens Markdown to plain text", () => {
    expect(markdownToText("# Title\n\n**bold** text")).toBe("Title\n\nbold text");
  });

  it("detects markdown-ish text", () => {
    expect(hasMarkdown("plain sentence")).toBe(false);
    expect(hasMarkdown("**bold**")).toBe(true);
    expect(hasMarkdown("- a list")).toBe(true);
  });
});
