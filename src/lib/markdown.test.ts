import { describe, expect, it } from "vitest";
import {
  CODE_LANGUAGES,
  codeLanguageLabel,
  findCodeLanguage,
  lowlightNameFor,
} from "./code-languages";
import {
  hasMarkdown,
  markdownToText,
  markdownToTipTap,
  matchMarkdownShortcut,
  parseInline,
  parseMarkdown,
  safeHref,
  splitTableRow,
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

  // B59 / audit H2 - protocol-relative and control-character bypasses.
  it("rejects protocol-relative and control-character tricks", () => {
    expect(safeHref("//evil.example/x")).toBeNull();
    expect(safeHref("\\\\evil.example/x")).toBeNull();
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("javascript%3Aalert(1)")).toBeNull();
    expect(safeHref("\u0001javascript:alert(1)")).toBeNull();
  });

  it("normalises control characters out of otherwise safe hrefs", () => {
    expect(safeHref("\u0001https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("https://example.com/a\n")).toBe("https://example.com/a");
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

/**
 * B18 — markdown shortcut long tail.
 *
 * `matchMarkdownShortcut` is the pure spec for the editor's input rules: it
 * receives the text of a block up to the cursor (plus the just-typed
 * character) and reports which shortcut fired, where, and with what payload.
 * Every rule is asserted here as a pure parse/transform before any editor
 * wiring exists (red-first).
 */
describe("matchMarkdownShortcut", () => {
  it("matches heading triggers with the level and consumed range", () => {
    expect(matchMarkdownShortcut("# ")).toMatchObject({
      kind: "heading",
      level: 1,
      trigger: "# ",
      from: 0,
      to: 2,
    });
    expect(matchMarkdownShortcut("###### ")).toMatchObject({ kind: "heading", level: 6 });
    expect(matchMarkdownShortcut("####### ")).toBeNull(); // seven levels is not a heading
    expect(matchMarkdownShortcut("##nope")).toBeNull(); // marker needs the space
    expect(matchMarkdownShortcut("intro # ")).toBeNull(); // only at the block start
  });

  it("matches unordered-list triggers for -, * and +", () => {
    expect(matchMarkdownShortcut("- ")).toMatchObject({ kind: "bullet", trigger: "- " });
    expect(matchMarkdownShortcut("* ")).toMatchObject({ kind: "bullet" });
    expect(matchMarkdownShortcut("+ ")).toMatchObject({ kind: "bullet" });
    expect(matchMarkdownShortcut("- item")).toBeNull();
    expect(matchMarkdownShortcut("and - ")).toBeNull();
  });

  it("matches ordered-list triggers with dot AND paren markers", () => {
    expect(matchMarkdownShortcut("1. ")).toMatchObject({ kind: "ordered", start: 1, value: "1" });
    expect(matchMarkdownShortcut("1) ")).toMatchObject({ kind: "ordered", start: 1, value: "1" });
    expect(matchMarkdownShortcut("12. ")).toMatchObject({ kind: "ordered", start: 12, value: "12" });
    expect(matchMarkdownShortcut("1)")).toBeNull(); // terminator not typed yet
  });

  it("matches blockquotes and fenced code with an optional language", () => {
    expect(matchMarkdownShortcut("> ")).toMatchObject({ kind: "quote", trigger: "> " });
    expect(matchMarkdownShortcut("``` ")).toMatchObject({ kind: "code", lang: null });
    expect(matchMarkdownShortcut("```ts ")).toMatchObject({ kind: "code", lang: "ts" });
    expect(matchMarkdownShortcut("~~~py ")).toMatchObject({ kind: "code", lang: "py" });
    expect(matchMarkdownShortcut("```ts")).toBeNull();
  });

  it("matches checkbox triggers with their checked state", () => {
    expect(matchMarkdownShortcut("[ ] ")).toMatchObject({ kind: "task", checked: false });
    expect(matchMarkdownShortcut("[] ")).toMatchObject({ kind: "task", checked: false });
    expect(matchMarkdownShortcut("[x] ")).toMatchObject({ kind: "task", checked: true });
    expect(matchMarkdownShortcut("[X] ")).toMatchObject({ kind: "task", checked: true });
    expect(matchMarkdownShortcut("- [ ] ")).toBeNull(); // "- " converts first, then "[ ] "
  });

  it("matches horizontal rules without stealing single markers", () => {
    expect(matchMarkdownShortcut("--- ")).toMatchObject({ kind: "hr" });
    expect(matchMarkdownShortcut("*** ")).toMatchObject({ kind: "hr" });
    expect(matchMarkdownShortcut("___ ")).toMatchObject({ kind: "hr" });
    expect(matchMarkdownShortcut("-- ")).toBeNull(); // two dashes is not a rule
    expect(matchMarkdownShortcut("- ")).toMatchObject({ kind: "bullet" });
  });

  it("matches inline strikethrough and highlight at the cursor", () => {
    expect(matchMarkdownShortcut("say ~~gone~~")).toMatchObject({
      kind: "strike",
      value: "gone",
      from: 4,
      to: 12,
    });
    expect(matchMarkdownShortcut("==mark==")).toMatchObject({
      kind: "highlight",
      value: "mark",
      from: 0,
      to: 8,
    });
    expect(matchMarkdownShortcut("say ~~gon")).toBeNull(); // unterminated
    expect(matchMarkdownShortcut("run =mark=")).toBeNull();
  });

  it("matches a pipe row as a table only when Enter is pressed", () => {
    expect(matchMarkdownShortcut("| Name | Qty |\n")).toMatchObject({
      kind: "table",
      cells: ["Name", "Qty"],
      from: 0,
      to: "| Name | Qty |\n".length,
    });
    expect(matchMarkdownShortcut("| A |\n")).toMatchObject({ kind: "table", cells: ["A"] });
    expect(matchMarkdownShortcut("| A | B | ")).toBeNull(); // space must not convert
    expect(matchMarkdownShortcut("| A | B |")).toBeNull(); // still typing
    expect(matchMarkdownShortcut("x | A | B |\n")).toBeNull(); // block must start with |
    expect(matchMarkdownShortcut("| a \\| b | c |\n")).toMatchObject({
      kind: "table",
      cells: ["a | b", "c"], // escaped pipes stay inside their cell
    });
  });

  it("turns the matched shortcut into TipTap structure (transform half)", () => {
    const row = matchMarkdownShortcut("| Name | Qty |\n");
    expect(row?.cells).toEqual(["Name", "Qty"]);
    const task = matchMarkdownShortcut("[x] ");
    expect(task).toMatchObject({ kind: "task", checked: true });
    // A heading trigger consumed exactly the marker plus its space.
    const heading = matchMarkdownShortcut("# ");
    expect(heading && heading.to - heading.from).toBe(heading?.trigger.length);
  });
});

/**
 * B37 — regression net for the parser/converter paths the existing suites do
 * not reach: GFM tables (parsing, JSON conversion, text flattening), nested
 * list mixes through `markdownToTipTap`, code-fence languages OUTSIDE B01's
 * picker registry (must degrade gracefully, never drop the block), and the
 * `splitTableRow` export B18 landed for the table input rule.
 */
describe("parseMarkdown tables (B37)", () => {
  it("keeps escaped pipes and inline formatting inside cells", () => {
    const [table] = parseMarkdown("| **A** | a \\| b |\n| :---: | --- |\n| `x` | y |");
    expect(table.type).toBe("table");
    if (table.type !== "table") return;
    expect(table.align).toEqual(["center", null]);
    expect(table.header).toEqual([
      [{ type: "strong", children: [{ type: "text", value: "A" }] }],
      [{ type: "text", value: "a | b" }],
    ]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toEqual([
      [{ type: "code", value: "x" }],
      [{ type: "text", value: "y" }],
    ]);
  });

  it("ends the table at the first non-row line instead of swallowing it", () => {
    const blocks = parseMarkdown("| A |\n| --- |\n| 1 |\nafter the table");
    expect(blocks.map((block) => block.type)).toEqual(["table", "paragraph"]);
    expect(JSON.stringify(blocks[1])).toContain("after the table");
    // ...while consecutive pipe rows keep being consumed as table rows.
    const [table] = parseMarkdown("| A |\n| --- |\n| 1 |\n| 2 |");
    expect(table.type).toBe("table");
    if (table.type !== "table") return;
    expect(table.rows).toHaveLength(2);
  });

  it("converts a table to TipTap JSON (header row + cell rows)", () => {
    const [node] = markdownToTipTap("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(node).toEqual({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] },
          ],
        },
      ],
    });
  });

  it("flattens a table to pipe-joined text for previews", () => {
    expect(markdownToText("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe("A | B\n1 | 2");
  });
});

describe("markdownToTipTap nested lists (B37)", () => {
  it("nests an ordered list (and a deeper bullet) inside a bullet item", () => {
    const nodes = markdownToTipTap("- outer\n  1. one\n  2. two\n     - deep\n- second");
    expect(nodes).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "outer" }] },
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
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }] },
        ],
      },
    ]);
  });

  it("nests a task item under a plain bullet as a taskList", () => {
    const [list] = markdownToTipTap("- outer\n  - [ ] inner");
    expect(list).toEqual({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "outer" }] },
            {
              type: "taskList",
              content: [
                {
                  type: "taskItem",
                  attrs: { checked: false },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }],
                },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe("code fences outside the language registry (B37)", () => {
  const OUTSIDE = ["haskell", "elixir", "zig", "vue", "svelte", "dockerfile", "objective-c", "f#"];

  it("none of these fence languages is in B01's picker registry", () => {
    for (const lang of OUTSIDE) {
      expect(findCodeLanguage(lang), `${lang} should be outside CODE_LANGUAGES`).toBeUndefined();
    }
    expect(CODE_LANGUAGES.length).toBeGreaterThanOrEqual(25); // B01 contract still holds
  });

  it("keeps unregistered fence languages verbatim instead of dropping them", () => {
    for (const lang of OUTSIDE) {
      const [block] = parseMarkdown("```" + lang + "\ncode line\n```");
      expect(block).toEqual({ type: "code", lang, value: "code line" });
    }
    const [tilde] = parseMarkdown("~~~prolog\nlikes(alice, bob).\n~~~");
    expect(tilde).toEqual({ type: "code", lang: "prolog", value: "likes(alice, bob)." });
  });

  it("converts unregistered fence languages to the codeBlock language attr", () => {
    const [node] = markdownToTipTap("```zig\nfn main() {}\n```");
    expect(node).toEqual({
      type: "codeBlock",
      attrs: { language: "zig" },
      content: [{ type: "text", text: "fn main() {}" }],
    });
  });

  it("falls back gracefully for unregistered languages (raw label, no grammar)", () => {
    expect(codeLanguageLabel("zig")).toBe("zig"); // raw value, no crash
    expect(lowlightNameFor("zig")).toBeNull(); // no grammar -> no highlight
    expect(codeLanguageLabel("")).toBe("Plain text");
  });

  it("keeps a language-less fence as lang null with no language attr", () => {
    const [block] = parseMarkdown("```\nplain\n```");
    expect(block).toEqual({ type: "code", lang: null, value: "plain" });
    const [node] = markdownToTipTap("```\nplain\n```");
    expect(node).toEqual({ type: "codeBlock", content: [{ type: "text", text: "plain" }] });
  });
});

describe("splitTableRow (B37)", () => {
  it("splits a pipe row into trimmed cells with or without outer pipes", () => {
    expect(splitTableRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitTableRow("a | b")).toEqual(["a", "b"]);
    expect(splitTableRow("| a  | b |")).toEqual(["a", "b"]);
  });

  it("keeps escaped pipes inside their cell and preserves empty cells", () => {
    expect(splitTableRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
    expect(splitTableRow("| | b |")).toEqual(["", "b"]);
  });
});
