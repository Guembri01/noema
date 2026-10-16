import { describe, expect, it } from "vitest";
import {
  docToMarkdownFidelity,
  escapeInline,
  fidelityReport,
  indentNested,
  roundTripCheck,
} from "@/lib/markdown-fidelity";

/**
 * Nested-content Markdown export fidelity (§12 "Export Markdown — nested
 * content partial"). Red-first coverage for `markdown-fidelity.ts`:
 * nested lists / blockquotes, GFM tables, code-fence metadata, callouts,
 * toggles, columns, embeds, equations and images, plus the fidelity report,
 * the structural round-trip check and the two text helpers.
 */

type Node = {
  type?: string;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
  content?: Node[];
};

const para = (text: string): Node => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...content: Node[]): { type: "doc"; content: Node[] } => ({ type: "doc", content });

describe("escapeInline", () => {
  it("escapes markdown punctuation", () => {
    expect(escapeInline("a*b_c")).toBe("a\\*b\\_c");
  });

  it("escapes backticks, brackets and angle brackets", () => {
    expect(escapeInline("`x` [y] <z>")).toBe("\\`x\\` \\[y\\] \\<z\\>");
  });

  it("escapes a literal backslash", () => {
    expect(escapeInline("a\\b")).toBe("a\\\\b");
  });

  it("leaves plain prose untouched", () => {
    expect(escapeInline("Hello, world! (fine)")).toBe("Hello, world! (fine)");
  });
});

describe("indentNested", () => {
  it("is a no-op at depth zero", () => {
    expect(indentNested("a\nb", 0)).toBe("a\nb");
  });

  it("indents every non-empty line by two spaces per level", () => {
    expect(indentNested("a\nb", 1)).toBe("  a\n  b");
    expect(indentNested("a\nb", 2)).toBe("    a\n    b");
  });

  it("never pads blank lines", () => {
    expect(indentNested("a\n\nb", 2)).toBe("    a\n\n    b");
  });

  it("ignores non-positive and fractional depths sensibly", () => {
    expect(indentNested("x", -1)).toBe("x");
    expect(indentNested("x", 1.9)).toBe("  x");
  });
});

describe("nested lists", () => {
  const nested = doc({
    type: "bulletList",
    content: [
      {
        type: "listItem",
        content: [
          para("one"),
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [para("one-a")] },
              { type: "listItem", content: [para("one-b")] },
            ],
          },
        ],
      },
      { type: "listItem", content: [para("two")] },
    ],
  });

  it("indents a nested list one step under its parent", () => {
    expect(docToMarkdownFidelity(nested)).toContain("- one\n  - one-a\n  - one-b\n- two");
  });

  it("keeps a three-level nest aligned", () => {
    const deep = doc({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            para("L1"),
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    para("L2"),
                    { type: "bulletList", content: [{ type: "listItem", content: [para("L3")] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(docToMarkdownFidelity(deep)).toContain("- L1\n  - L2\n    - L3");
  });

  it("numbers nested ordered lists and honours attrs.start", () => {
    const ordered = doc({
      type: "orderedList",
      attrs: { start: 3 },
      content: [
        {
          type: "listItem",
          content: [
            para("first"),
            {
              type: "orderedList",
              content: [{ type: "listItem", content: [para("nested")] }],
            },
          ],
        },
        { type: "listItem", content: [para("second")] },
      ],
    });
    expect(docToMarkdownFidelity(ordered)).toContain("3. first\n  1. nested\n4. second");
  });

  it("renders task checkboxes under GFM (default)", () => {
    const tasks = doc({
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [para("done")] },
        { type: "taskItem", attrs: { checked: false }, content: [para("todo")] },
      ],
    });
    expect(docToMarkdownFidelity(tasks)).toContain("- [x] done\n- [ ] todo");
  });

  it("drops checkbox syntax when gfm is disabled", () => {
    const tasks = doc({
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { checked: true }, content: [para("done")] },
        { type: "taskItem", attrs: { checked: false }, content: [para("todo")] },
      ],
    });
    const md = docToMarkdownFidelity(tasks, { gfm: false });
    expect(md).toContain("- done\n- todo");
    expect(md).not.toContain("[x]");
  });

  it("indents a nested blockquote inside a list item", () => {
    const item = doc({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [para("head"), { type: "blockquote", content: [para("quoted")] }],
        },
      ],
    });
    expect(docToMarkdownFidelity(item)).toContain("- head\n  > quoted");
  });
});

describe("nested blockquotes", () => {
  it("prefixes every line of a multi-line quote", () => {
    const md = docToMarkdownFidelity(doc({ type: "blockquote", content: [para("a"), para("b")] }));
    expect(md).toContain("> a\n>\n> b");
  });

  it("nests a quote inside a quote", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "blockquote", content: [para("outer"), { type: "blockquote", content: [para("inner")] }] }),
    );
    expect(md).toContain("> outer\n>\n> > inner");
  });

  it("marks a large pull quote with the [!large] marker", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "blockquote", attrs: { size: "large" }, content: [para("big")] }),
    );
    expect(md).toContain("> [!large]\n> big");
  });
});

describe("tables", () => {
  const table = doc({
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          { type: "tableHeader", content: [para("a | b")] },
          { type: "tableHeader", content: [para("c")] },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: [para("1")] },
          { type: "tableCell", content: [para("2")] },
        ],
      },
    ],
  });

  it("emits a GFM header, separator and rows", () => {
    expect(docToMarkdownFidelity(table)).toContain("| a \\| b | c |\n| --- | --- |\n| 1 | 2 |");
  });

  it("escapes a pipe inside a cell exactly once", () => {
    const md = docToMarkdownFidelity(table);
    expect(md).toContain("a \\| b");
    expect(md).not.toContain("a \\\\| b");
  });

  it("pads a short row so every row has the header's column count", () => {
    const ragged = doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [para("a")] },
            { type: "tableHeader", content: [para("b")] },
          ],
        },
        { type: "tableRow", content: [{ type: "tableCell", content: [para("only")] }] },
      ],
    });
    expect(docToMarkdownFidelity(ragged)).toContain("| only |  |");
  });

  it("keeps inline marks inside cells", () => {
    const marked = doc({
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [para("h")] }] },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }] },
              ],
            },
          ],
        },
      ],
    });
    expect(docToMarkdownFidelity(marked)).toContain("| **x** |");
  });
});

describe("code fences", () => {
  it("carries the language after the fence", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const x = 1;" }] }),
    );
    expect(md).toBe("```ts\nconst x = 1;\n```");
  });

  it("mirrors the importer's {lineNumbers} suffix", () => {
    const md = docToMarkdownFidelity(
      doc({
        type: "codeBlock",
        attrs: { language: "ts", lineNumbers: true },
        content: [{ type: "text", text: "x" }],
      }),
    );
    expect(md).toContain("```ts {lineNumbers}");
  });

  it("mirrors the importer's caption suffix and normalises the caption", () => {
    const md = docToMarkdownFidelity(
      doc({
        type: "codeBlock",
        attrs: { language: "js", caption: "  hello   world " },
        content: [{ type: "text", text: "x" }],
      }),
    );
    expect(md).toContain('```js {caption="hello world"}');
  });

  it("combines both options", () => {
    const md = docToMarkdownFidelity(
      doc({
        type: "codeBlock",
        attrs: { language: "py", lineNumbers: true, caption: "demo" },
        content: [{ type: "text", text: "x" }],
      }),
    );
    expect(md).toContain('```py {lineNumbers caption="demo"}');
  });

  it("uses a longer fence than any backtick run inside the code", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "codeBlock", content: [{ type: "text", text: "```" }] }),
    );
    expect(md).toContain("````\n```\n````");
  });

  it("omits the language when there is none", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "codeBlock", content: [{ type: "text", text: "plain" }] }),
    );
    expect(md).toBe("```\nplain\n```");
  });
});

describe("callouts", () => {
  it("emits a GFM-alert marker with the emoji", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "callout", attrs: { emoji: "🔥" }, content: [para("hot")] }),
    );
    expect(md).toContain("> [!note] 🔥");
    expect(md).toContain("> hot");
  });

  it("uses the variant when one is present", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "callout", attrs: { emoji: "⚠️", variant: "warning" }, content: [para("careful")] }),
    );
    expect(md).toContain("> [!warning] ⚠️");
  });

  it("quotes every nested block of the callout body", () => {
    const md = docToMarkdownFidelity(
      doc({
        type: "callout",
        attrs: { emoji: "💡" },
        content: [para("one"), { type: "bulletList", content: [{ type: "listItem", content: [para("item")] }] }],
      }),
    );
    expect(md).toContain("> one");
    expect(md).toContain("> - item");
  });
});

describe("toggles", () => {
  it("emits <details>/<summary> around the nested content", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "toggle", attrs: { summary: "More" }, content: [para("hidden")] }),
    );
    expect(md).toContain("<details>");
    expect(md).toContain("<summary>More</summary>");
    expect(md).toContain("hidden");
    expect(md).toContain("</details>");
  });

  it("escapes the summary text", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "toggle", attrs: { summary: "a *b*" }, content: [para("x")] }),
    );
    expect(md).toContain("<summary>a \\*b\\*</summary>");
  });

  it("emits <details open> when the node is open", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "toggle", attrs: { summary: "s", open: true }, content: [para("x")] }),
    );
    expect(md).toContain("<details open>");
  });
});

describe("columns", () => {
  const columns = doc({
    type: "columns",
    content: [
      { type: "column", content: [para("left")] },
      { type: "column", content: [para("right")] },
    ],
  });

  it("wraps columns in documented :::columns / :::column fences", () => {
    const md = docToMarkdownFidelity(columns);
    expect(md).toContain(":::columns");
    expect(md.match(/:::column\b/g)?.length).toBe(2);
    expect(md).toContain("left");
    expect(md).toContain("right");
    expect(md.trimEnd().endsWith(":::")).toBe(true);
  });

  it("round-trips its own column marker structure", () => {
    expect(roundTripCheck(docToMarkdownFidelity(columns)).ok).toBe(true);
  });

  it("nests a list inside a column", () => {
    const md = docToMarkdownFidelity(
      doc({
        type: "columns",
        content: [
          { type: "column", content: [{ type: "bulletList", content: [{ type: "listItem", content: [para("a")] }] }] },
        ],
      }),
    );
    expect(md).toContain("- a");
  });
});

describe("embeds, bookmarks and equations", () => {
  it("renders a bookmark as a titled link", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "bookmark", attrs: { url: "https://example.com/x", title: "Example" } }),
    );
    expect(md).toBe("[Example](https://example.com/x)");
  });

  it("falls back to the url when an embed has no title", () => {
    const md = docToMarkdownFidelity(doc({ type: "embed", attrs: { url: "https://e.co" } }));
    expect(md).toBe("[https://e.co](https://e.co)");
  });

  it("renders a page embed as a titled /w/ link", () => {
    const md = docToMarkdownFidelity(doc({ type: "pageEmbed", attrs: { pageId: "abc", title: "Roadmap" } }));
    expect(md).toBe("[Roadmap](/w/…/abc)");
  });

  it("renders block math as $$ fences", () => {
    const md = docToMarkdownFidelity(doc({ type: "blockMath", attrs: { latex: "x = 1" } }));
    expect(md).toBe("$$\nx = 1\n$$");
  });

  it("renders inline math as single dollars", () => {
    const md = docToMarkdownFidelity(
      doc({ type: "paragraph", content: [{ type: "text", text: "y = " }, { type: "inlineMath", attrs: { latex: "x^2" } }] }),
    );
    expect(md).toBe("y = $x^2$");
  });
});

describe("images", () => {
  it("keeps alt text and src", () => {
    expect(docToMarkdownFidelity(doc({ type: "image", attrs: { alt: "pic", src: "img.png" } }))).toBe(
      "![pic](img.png)",
    );
  });

  it("appends a caption", () => {
    expect(
      docToMarkdownFidelity(doc({ type: "image", attrs: { alt: "pic", src: "img.png", caption: "cap" } })),
    ).toBe('![pic](img.png "cap")');
  });

  it("encodes a numeric width as a {width=…} suffix", () => {
    expect(
      docToMarkdownFidelity(doc({ type: "image", attrs: { alt: "pic", src: "img.png", width: 320 } })),
    ).toBe("![pic](img.png){width=320}");
  });

  it("encodes a string width verbatim", () => {
    expect(
      docToMarkdownFidelity(doc({ type: "image", attrs: { alt: "pic", src: "img.png", width: "50%" } })),
    ).toBe('![pic](img.png){width="50%"}');
  });

  it("prefixes a relative src with imageBase and leaves absolute srcs alone", () => {
    expect(
      docToMarkdownFidelity(doc({ type: "image", attrs: { alt: "p", src: "img.png" } }), {
        imageBase: "assets",
      }),
    ).toBe("![p](assets/img.png)");
    expect(
      docToMarkdownFidelity(doc({ type: "image", attrs: { alt: "p", src: "https://cdn/x.png" } }), {
        imageBase: "assets",
      }),
    ).toBe("![p](https://cdn/x.png)");
  });
});

describe("frontMatter", () => {
  it("emits a YAML frontmatter block", () => {
    const md = docToMarkdownFidelity(doc(para("body")), {
      frontMatter: { title: "Hello", tags: ["a", "b"], draft: true },
    });
    expect(md).toContain("---\ntitle: Hello\ntags: [a, b]\ndraft: true\n---");
    expect(md).toContain("body");
  });

  it("quotes values that would otherwise break the YAML-ish parse", () => {
    const md = docToMarkdownFidelity(doc(para("body")), { frontMatter: { title: "hello: world" } });
    expect(md).toContain('title: "hello: world"');
  });

  it("emits no frontmatter by default and none for an empty object", () => {
    expect(docToMarkdownFidelity(doc(para("body")))).toBe("body");
    expect(docToMarkdownFidelity(doc(para("body")), { frontMatter: {} })).toBe("body");
  });
});

describe("fidelityReport", () => {
  it("reports a lossy mark", () => {
    const report = fidelityReport(
      doc({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "color" }] }] }),
    );
    expect(report.lost.some((entry) => entry.kind === "color")).toBe(true);
  });

  it("reports a mention as losing its target id", () => {
    const report = fidelityReport(
      doc({ type: "paragraph", content: [{ type: "mention", attrs: { label: "Ann" } }] }),
    );
    expect(report.lost.map((entry) => entry.kind)).toContain("mention");
  });

  it("reports an unknown block type as lost", () => {
    const report = fidelityReport(doc({ type: "weirdBlock", content: [para("x")] }));
    expect(report.lost.map((entry) => entry.kind)).toContain("weirdBlock");
  });

  it("lists columns and toggles as approximations", () => {
    const report = fidelityReport(
      doc(
        { type: "columns", content: [{ type: "column", content: [para("a")] }] },
        { type: "toggle", attrs: { summary: "s" }, content: [para("b")] },
      ),
    );
    const joined = report.approximated.join(" ");
    expect(joined).toContain(":::columns");
    expect(joined).toContain("<details>");
  });

  it("returns an empty loss list for a plain document", () => {
    expect(fidelityReport(doc(para("plain"))).lost).toHaveLength(0);
  });
});

describe("roundTripCheck", () => {
  it("accepts a structurally sound document", () => {
    const md = docToMarkdownFidelity(
      doc(
        para("intro"),
        { type: "bulletList", content: [{ type: "listItem", content: [para("one")] }] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
        { type: "table", content: [
          { type: "tableRow", content: [{ type: "tableHeader", content: [para("h")] }] },
          { type: "tableRow", content: [{ type: "tableCell", content: [para("c")] }] },
        ] },
      ),
    );
    const result = roundTripCheck(md);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("flags an unclosed code fence", () => {
    const result = roundTripCheck("```ts\nconst x = 1;\n");
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("fence");
  });

  it("flags an unclosed :::columns block", () => {
    const result = roundTripCheck(":::columns\n\n:::column\n\nx\n\n:::\n");
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain(":::");
  });

  it("flags unbalanced <details> tags", () => {
    const result = roundTripCheck("<details>\n<summary>x</summary>\n\nbody\n");
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("<details>");
  });

  it("flags a table whose rows disagree with the header", () => {
    const result = roundTripCheck("| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n");
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("cells");
  });

  it("flags an unclosed frontmatter block", () => {
    const result = roundTripCheck("---\ntitle: x\n\nbody\n");
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("frontmatter");
  });

  it("accepts a closed frontmatter block", () => {
    expect(roundTripCheck("---\ntitle: x\n---\n\nbody\n").ok).toBe(true);
  });
});

describe("docToMarkdownFidelity integration", () => {
  it("returns an empty string for an empty document", () => {
    expect(docToMarkdownFidelity(doc())).toBe("");
  });

  it("produces markdown that passes its own round-trip check", () => {
    const rich = doc(
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              para("one"),
              { type: "bulletList", content: [{ type: "listItem", content: [para("one-a")] }] },
            ],
          },
        ],
      },
      { type: "blockquote", content: [para("quoted")] },
      { type: "callout", attrs: { emoji: "💡" }, content: [para("note")] },
      { type: "toggle", attrs: { summary: "More" }, content: [para("hidden")] },
      {
        type: "columns",
        content: [
          { type: "column", content: [para("left")] },
          { type: "column", content: [para("right")] },
        ],
      },
      { type: "table", content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [para("k | v")] }] },
        { type: "tableRow", content: [{ type: "tableCell", content: [para("a")] }] },
      ] },
      { type: "codeBlock", attrs: { language: "ts", lineNumbers: true }, content: [{ type: "text", text: "x" }] },
      { type: "blockMath", attrs: { latex: "e = mc^2" } },
      { type: "image", attrs: { alt: "pic", src: "img.png" } },
      { type: "bookmark", attrs: { url: "https://example.com", title: "Example" } },
    );
    const md = docToMarkdownFidelity(rich, { frontMatter: { title: "Title" } });
    expect(roundTripCheck(md).ok).toBe(true);
  });
});
