import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DOC_PRINT_CSS, DOC_PRINT_CLASS } from "./doc-renderer";
import { MARKDOWN_COPY_FEEDBACK_MS, Markdown, markdownBlockClass } from "./markdown";

/**
 * Design-system adoption for the Markdown read surface (§1–§3).
 *
 * The pure map is pinned directly; a `renderToStaticMarkup` pass proves the
 * tokens (never a raw hex) reach headings, paragraphs, lists, tables, code,
 * quotes and the print block. `next/link` is stubbed — there is no Next runtime
 * in the node test environment.
 */

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      h("a", { href }, children as never),
  };
});

describe("markdown block → class map", () => {
  it("maps each kind to token classes", () => {
    expect(markdownBlockClass("heading")).toContain("tracking-[-0.01em]");
    expect(markdownBlockClass("link")).toContain("text-accent");
    expect(markdownBlockClass("inlineCode")).toContain("bg-surface-2");
    expect(markdownBlockClass("tableHeader")).toContain("bg-surface-2");
    expect(markdownBlockClass("blockquote")).toContain("text-muted");
    expect(markdownBlockClass("rule")).toContain("border-border");
    expect(markdownBlockClass("image")).toContain("rounded-md");
  });

  it("keeps the copy feedback window as a named token", () => {
    expect(MARKDOWN_COPY_FEEDBACK_MS).toBe(1500);
  });
});

describe("renderToStaticMarkup — a markdown answer", () => {
  const text = [
    "## Heading",
    "",
    "A paragraph with `inline` code and a [link](https://example.com).",
    "",
    "- one",
    "- two",
    "",
    "> a quote",
    "",
    "| H1 | H2 |",
    "| --- | --- |",
    "| a | b |",
    "",
    "```ts",
    "const x = 1;",
    "```",
  ].join("\n");

  const html = renderToStaticMarkup(createElement(Markdown, { text }));

  it("wraps the answer in the read container with the print block", () => {
    expect(html).toContain("notion-markdown");
    expect(html).toContain("print:max-w-none");
    expect(html).toContain("@media print");
    expect(DOC_PRINT_CSS).toContain("@media print");
  });

  it("paints every block from tokens", () => {
    expect(html).toContain("font-semibold"); // heading
    expect(html).toContain("ps-6"); // list
    expect(html).toContain("var(--border-strong)"); // blockquote accent
    expect(html).toContain("var(--surface-2)"); // table header + code
    expect(html).toContain("text-danger"); // inline code ink
    expect(html).toContain("var(--accent)"); // link ink
    expect(html).toContain("print:break-inside-avoid");
  });

  it("hides the code copy chrome when printing", () => {
    expect(html).toContain(DOC_PRINT_CLASS.hide);
  });

  it("renders nothing for empty text", () => {
    expect(renderToStaticMarkup(createElement(Markdown, { text: "" }))).toBe("");
  });
});
