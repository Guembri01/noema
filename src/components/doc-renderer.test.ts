import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocRenderer } from "./doc-renderer";

/**
 * B59 / audit H2 - defence in depth at the read path.
 *
 * Whatever lands in stored page content (old rows, imports, API writes), the
 * read-only renderer must only ever emit hrefs on the allowlist
 * (http|https|mailto|tel or same-document relative targets); every other
 * scheme collapses to "#". Red-first: these assertions fail while the raw
 * `mark.attrs.href` / `attrs.url` values are rendered verbatim
 * (doc-renderer.tsx link mark ~:61, bookmark ~:235, embed fallback ~:274).
 */

const render = (doc: unknown): string =>
  renderToStaticMarkup(createElement(DocRenderer, { doc }));

const hrefsOf = (html: string): string[] =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);

const linkDoc = (href: string) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "click me", marks: [{ type: "link", attrs: { href } }] },
      ],
    },
  ],
});

const bookmarkDoc = (url: string) => ({
  type: "doc",
  content: [{ type: "bookmark", attrs: { url, host: "example.com", title: "Card" } }],
});

const embedDoc = (url: string) => ({
  type: "doc",
  content: [{ type: "embed", attrs: { url } }],
});

describe("DocRenderer href scheme gate (H2)", () => {
  it("renders allowlisted and relative link marks untouched", () => {
    expect(hrefsOf(render(linkDoc("https://example.com/x")))).toEqual(["https://example.com/x"]);
    expect(hrefsOf(render(linkDoc("mailto:a@b.co")))).toEqual(["mailto:a@b.co"]);
    expect(hrefsOf(render(linkDoc("tel:+33123456789")))).toEqual(["tel:+33123456789"]);
    expect(hrefsOf(render(linkDoc("/w/demo/page")))).toEqual(["/w/demo/page"]);
    expect(hrefsOf(render(linkDoc("#section")))).toEqual(["#section"]);
  });

  it("neutralises javascript:/data:/vbscript: link marks to '#'", () => {
    const payloads = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(document.cookie)",
      " javascript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html;base64,PHN2Zz4=",
      "vbscript:msgbox(1)",
    ];
    for (const href of payloads) {
      const html = render(linkDoc(href));
      expect(hrefsOf(html), href).toEqual(["#"]);
      expect(html).not.toMatch(/href="[^"]*javascript/i);
    }
  });

  it("neutralises protocol-relative link marks", () => {
    expect(hrefsOf(render(linkDoc("//evil.example/x")))).toEqual(["#"]);
    expect(hrefsOf(render(linkDoc("\\\\evil.example/x")))).toEqual(["#"]);
  });

  it("leaves a text node with no href unlinked", () => {
    const html = render({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    });
    expect(hrefsOf(html)).toEqual([]);
  });

  it("gates bookmark hrefs", () => {
    expect(hrefsOf(render(bookmarkDoc("https://example.com/x")))).toEqual([
      "https://example.com/x",
    ]);
    expect(hrefsOf(render(bookmarkDoc("javascript:alert(1)")))).toEqual(["#"]);
    expect(hrefsOf(render(bookmarkDoc("data:text/html;base64,PHN2Zz4=")))).toEqual(["#"]);
    expect(hrefsOf(render(bookmarkDoc("")))).toEqual(["#"]);
  });

  it("gates the embed fallback link", () => {
    expect(hrefsOf(render(embedDoc("vbscript:msgbox(1)")))).toEqual(["#"]);
    const html = render(embedDoc("javascript:alert(1)"));
    expect(hrefsOf(html)).toEqual(["#"]);
    expect(html).not.toMatch(/href="[^"]*javascript/i);
  });
});
