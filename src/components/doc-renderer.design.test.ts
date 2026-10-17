import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DOC_BLOCK_CLASS,
  DOC_PRINT_CSS,
  DOC_PRINT_CLASS,
  DOC_PROSE_MEASURE,
  DOC_WIDE_MEASURE,
  DocRenderer,
  DocRendererError,
  DocRendererSkeleton,
  MENTION_HUE,
  docBlockClass,
  docClasses,
  docHasDatabase,
  docPrintClass,
  docReadingMeasure,
  mentionClass,
  mentionStyle,
} from "./doc-renderer";

/**
 * Design-system adoption (docs/DESIGN_SYSTEM.md §1–§3, §8).
 *
 * Two layers of proof:
 *  - node tests pin the pure mappings (block → class map, reading measure from
 *    the document, mention → tag palette, the print class set + the @media
 *    print block);
 *  - renderToStaticMarkup renders a real document (heading, paragraph, list,
 *    table, code, quote, mention) and both non-ready states, asserting the
 *    tokens — never a raw hex — reach the markup.
 */

const render = (doc: unknown): string =>
  renderToStaticMarkup(createElement(DocRenderer, { doc }));

const fullDoc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Body with " },
        { type: "text", text: "inline", marks: [{ type: "code" }] },
        { type: "text", text: " and a " },
        {
          type: "text",
          text: "link",
          marks: [{ type: "link", attrs: { href: "https://example.com/x" } }],
        },
        { type: "mention", attrs: { type: "user", label: "Ada" } },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
        },
      ],
    },
    {
      type: "blockquote",
      content: [{ type: "paragraph", content: [{ type: "text", text: "a quote" }] }],
    },
    {
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const x = 1;" }],
    },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "H1" }] }],
            },
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "H2" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
            },
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }],
            },
          ],
        },
      ],
    },
  ],
};

describe("reading measure from the document", () => {
  it("defaults to the prose measure and widens for an embedded database", () => {
    expect(docReadingMeasure({ type: "doc", content: [] })).toBe(DOC_PROSE_MEASURE);
    expect(DOC_PROSE_MEASURE).toBe("max-w-[720px]");
    expect(DOC_WIDE_MEASURE).toBe("max-w-[1100px]");

    const withDatabase = {
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "columns", content: [{ type: "column", content: [{ type: "linkedDatabase" }] }] },
      ],
    };
    expect(docReadingMeasure(withDatabase)).toBe(DOC_WIDE_MEASURE);
  });

  it("is cycle-safe and rejects malformed content", () => {
    expect(docHasDatabase(null)).toBe(false);
    expect(docHasDatabase("nope")).toBe(false);
    expect(docHasDatabase({ type: "doc", content: [{ type: "paragraph" }] })).toBe(false);
  });
});

describe("block → class map", () => {
  it("maps every kind to token classes, never a raw value", () => {
    expect(docBlockClass("heading")).toContain("font-semibold");
    expect(docBlockClass("heading")).toContain("tracking-[-0.01em]");
    expect(docBlockClass("codeBlock")).toContain("bg-surface-2");
    expect(docBlockClass("codeBlock")).toContain("font-mono");
    expect(docBlockClass("inlineCode")).toContain("text-danger");
    expect(docBlockClass("tableHeader")).toContain("bg-surface-2");
    expect(docBlockClass("blockquote")).toContain("text-muted");
    expect(docBlockClass("divider")).toContain("border-border");
    expect(docBlockClass("link")).toContain("text-accent");
    expect(docBlockClass("link")).toContain("decoration-accent-soft");
  });

  it("falls back to the paragraph rhythm for an unknown kind", () => {
    expect(docBlockClass("mystery")).toBe(DOC_BLOCK_CLASS.paragraph);
  });
});

describe("print class set + @media print block", () => {
  it("keeps blocks/code/tables whole and hides chrome", () => {
    expect(DOC_PRINT_CLASS.hide).toBe("print:hidden");
    expect(docPrintClass("codeBlock")).toContain("print:break-inside-avoid");
    expect(docPrintClass("codeBlock")).toContain("print:border-border");
    expect(docPrintClass("table")).toContain("print:break-inside-avoid");
    expect(docPrintClass("heading")).toContain("print:break-after-avoid");
    expect(docClasses("paragraph")).toContain("print:break-inside-avoid");
  });

  it("ships a print block with margins, hairlines and break control", () => {
    expect(DOC_PRINT_CSS).toContain("@media print");
    expect(DOC_PRINT_CSS).toContain("@page { margin:");
    expect(DOC_PRINT_CSS).toContain("break-inside: avoid");
    expect(DOC_PRINT_CSS).toContain("border-color: var(--border)");
    expect(DOC_PRINT_CSS).toContain("box-shadow: none");
    expect(DOC_PRINT_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("mention → tag palette", () => {
  it("maps kinds to a safe hue and a token style", () => {
    expect(MENTION_HUE.user).toBe("blue");
    expect(mentionClass("date")).toBe("tag tag-orange");
    expect(mentionClass("nonsense")).toBe("tag tag-gray");
    expect(mentionStyle("page").background).toBe("var(--tag-gray-bg)");
  });
});

describe("renderToStaticMarkup — a full document", () => {
  const html = render(fullDoc);

  it("centres the prose to the reading measure and tags the state", () => {
    expect(html).toContain("noema-doc-renderer");
    expect(html).toContain("max-w-[720px]");
    expect(html).toContain('data-doc-state="ready"');
  });

  it("paints headings, lists, quotes, tables and code from tokens", () => {
    expect(html).toContain("font-semibold"); // heading
    expect(html).toContain("list-disc"); // bullet list
    expect(html).toContain("var(--border-strong)"); // blockquote accent
    expect(html).toContain("var(--surface-2)"); // code + table header
    expect(html).toContain("--radius-md"); // code radius
    expect(html).toContain("text-danger"); // inline-code ink
    expect(html).toContain("text-accent"); // link
  });

  it("renders the mention as a tag-palette chip", () => {
    expect(html).toContain("tag tag-blue");
    expect(html).toContain("var(--tag-blue-bg)");
  });

  it("paints a block colour from the tag palette, never a raw hex", () => {
    const html = render({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockColor: "yellow" }, content: [{ type: "text", text: "hi" }] },
      ],
    });
    expect(html).toContain("var(--tag-yellow-bg)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("embeds the print block exactly once", () => {
    expect(html).toContain("break-inside: avoid");
    expect(html.match(/@media print/g)?.length).toBe(1);
  });

  it("widens the measure for a document that embeds a database", () => {
    const wide = render({
      type: "doc",
      content: [{ type: "inlineDatabase" }],
    });
    expect(wide).toContain("max-w-[1100px]");
  });
});

describe("document states (§8)", () => {
  it("renders a matching skeleton while loading", () => {
    const html = renderToStaticMarkup(createElement(DocRendererSkeleton));
    expect(html).toContain('data-doc-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("max-w-[720px]");
    expect(html).toContain('data-skeleton="text"');
    expect(html).toContain('data-skeleton="table"');
    // A loading skeleton never announces itself as content.
    expect(html).toContain("notion-skeleton");
  });

  it("routes the state prop to the loading and error surfaces", () => {
    expect(renderToStaticMarkup(createElement(DocRenderer, { doc: null, state: "loading" }))).toContain(
      'data-doc-state="loading"',
    );
    expect(renderToStaticMarkup(createElement(DocRenderer, { doc: null, state: "error" }))).toContain(
      'data-doc-state="error"',
    );
  });

  it("shows a message and an optional retry on error", () => {
    const plain = renderToStaticMarkup(createElement(DocRendererError, { message: "Boom" }));
    expect(plain).toContain('role="alert"');
    expect(plain).toContain("Boom");
    expect(plain).not.toContain("Try again");

    const retry = renderToStaticMarkup(
      createElement(DocRendererError, { onRetry: () => {} }),
    );
    expect(retry).toContain("Try again");
  });

  it("errors on a malformed document but renders nothing for a missing one", () => {
    expect(render(null)).toBe("");
    expect(render({ type: "doc" })).toContain('data-doc-state="error"');
  });
});

describe("tokens-only guard", () => {
  const source = (file: string) =>
    readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

  it.each(["doc-renderer.tsx", "markdown.tsx"])(
    "%s carries no raw hex, magic z-index or ad-hoc duration",
    (file) => {
      const src = source(file);
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/\bz-\[?\d/);
      expect(src).not.toMatch(/\b\d+ms\b/);
    },
  );
});
