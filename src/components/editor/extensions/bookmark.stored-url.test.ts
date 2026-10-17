import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeViewProps } from "@tiptap/react";
import { BookmarkCardSurface, BookmarkView } from "./bookmark";

/**
 * B92 — stored XSS: the editor's bookmark card renders the stored `attrs.url`
 * as an anchor `href` without a scheme check.
 *
 * The write-time gate (`parsePageContent` → `sanitizeHrefAttributes`) only
 * covers the documents saved from now on. A document stored before that audit
 * — or written through the MCP `append_blocks` tool, which does not run the
 * document sanitiser — keeps its hostile `attrs.url`, and there is no data
 * migration. The read-only renderer gates the same attribute
 * (`src/components/doc-renderer.tsx`), the editor's own node view did not.
 *
 * These are render-level tests: the editor's bookmark node view is rendered
 * with a hostile stored `attrs.url` and the produced markup is inspected.
 */

/** Every `href` the rendered markup carries. */
const hrefsOf = (html: string): string[] =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

/** Render the editor's bookmark node view with a stored `attrs.url`. */
const renderView = (attrs: Record<string, unknown>): string =>
  renderToStaticMarkup(
    createElement(BookmarkView, {
      node: { attrs },
      editor: { isEditable: false },
      updateAttributes: () => {},
      deleteNode: () => {},
      selected: false,
      locale: "en",
    } as unknown as NodeViewProps & { locale: string }),
  );

/** Render the presentational bookmark card. */
const renderCard = (props: Parameters<typeof BookmarkCardSurface>[0]): string =>
  renderToStaticMarkup(createElement(BookmarkCardSurface, props));

/** Stored URLs that must never reach an `href`. */
const HOSTILE_URLS = [
  "javascript:alert(document.domain)",
  "JaVaScRiPt:alert(document.domain)",
  "data:text/html;base64,PHN2Zz4=",
  "vbscript:msgbox(1)",
  "//evil.example/payload",
];

describe("bookmark card — a stored url never becomes a live link", () => {
  it("renders a stored https bookmark as a link", () => {
    const html = renderView({ url: "https://example.com/article" });
    expect(hrefsOf(html)).toEqual(["https://example.com/article"]);
  });

  it("drops the payload of the finding", () => {
    const html = renderView({ url: "data:text/html;base64,PHN2Zz4=" });
    // The card is still drawn, but its link carries no live target.
    expect(hrefsOf(html)).toEqual(["#"]);
    expect(html).not.toContain("data:text/html");
  });

  it("never lets a hostile scheme reach an href", () => {
    for (const url of HOSTILE_URLS) {
      const html = renderView({ url });
      expect(hrefsOf(html), url).toEqual(["#"]);
    }
  });

  it("keeps the card surface inert as well", () => {
    const html = renderCard({ url: "javascript:alert(1)", title: "Example" });
    expect(hrefsOf(html)).toEqual(["#"]);
  });

  it("keeps an app-relative bookmark target working", () => {
    const html = renderView({ url: "/w/example/page-1" });
    expect(hrefsOf(html)).toEqual(["/w/example/page-1"]);
  });
});
