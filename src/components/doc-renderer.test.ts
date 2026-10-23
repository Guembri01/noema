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

const imageDoc = (src: string) => ({
  type: "doc",
  content: [{ type: "image", attrs: { src, alt: "a picture" } }],
});

const srcsOf = (html: string): string[] =>
  [...html.matchAll(/<img[^>]+src="([^"]*)"/g)].map((match) => match[1]);

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

/**
 * B69 - the read path never points a browser at a third party.
 *
 * The renderer used to emit the stored `src` verbatim, so opening a shared
 * page made the VISITOR's browser fetch the picture from the host it lives on
 * - handing that host the visitor's IP address and the `Referer` of the share
 * page.
 *
 * Every external picture now points at the server's own proxy route, so the
 * third party is contacted by the server, not by the visitor.
 */
describe("DocRenderer external images (B69)", () => {
  it("never renders a direct third-party image src", () => {
    const html = render(imageDoc("https://images.example.com/a.png"));
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
    // React preloads an <img> it renders: the preload link must not name the
    // third party either.
    expect(html).not.toMatch(/<link[^>]*as="image"[^>]*href="https?:/);
    // The rendered document does not carry the third-party URL at all.
    expect(html).not.toContain("https://images.example.com");
    expect(srcsOf(html)).toEqual([
      "/api/external-image?url=https%3A%2F%2Fimages.example.com%2Fa.png",
    ]);
  });

  it("leaves an upload, a data URL and a blob URL alone", () => {
    expect(srcsOf(render(imageDoc("/api/files/ws-1/a.png")))).toEqual(["/api/files/ws-1/a.png"]);
    expect(srcsOf(render(imageDoc("data:image/png;base64,AAAA")))).toEqual([
      "data:image/png;base64,AAAA",
    ]);
    expect(srcsOf(render(imageDoc("blob:http://localhost/abc")))).toEqual([
      "blob:http://localhost/abc",
    ]);
  });

  it("drops a picture reference that cannot be served at all", () => {
    expect(srcsOf(render(imageDoc("javascript:alert(1)")))).toEqual([]);
  });

  it("proxies the favicon and the og:image of a bookmark card", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "bookmark",
          attrs: {
            url: "https://example.com/x",
            host: "example.com",
            title: "Card",
            icon: "https://images.example.com/favicon.ico",
            image: "https://images.example.com/og.png",
          },
        },
      ],
    });
    expect(html).not.toMatch(/<img[^>]+src="https?:/);
    expect(srcsOf(html)).toEqual([
      "/api/external-image?url=https%3A%2F%2Fimages.example.com%2Ffavicon.ico",
      "/api/external-image?url=https%3A%2F%2Fimages.example.com%2Fog.png",
    ]);
  });
});


describe("DocRenderer Mermaid blocks", () => {
  it("routes Mermaid code to the client diagram renderer", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: "flowchart TD\n  A --> B" }],
        },
      ],
    });
    expect(html).toContain('data-mermaid-diagram="ready"');
    expect(html).toContain("Rendering diagram");
  });
});
