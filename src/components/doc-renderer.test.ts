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

const mathDoc = (type: "inlineMath" | "blockMath", latex: string) => ({
  type: "doc",
  content: [
    type === "inlineMath"
      ? { type: "paragraph", content: [{ type, attrs: { latex } }] }
      : { type, attrs: { latex } },
  ],
});

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
 * User-authored prose (the read side of the editor) carries the same bidi
 * treatment as the editing surface: each block resolves its own direction and
 * mixed runs are isolated, so an Arabic fragment inside an English paragraph
 * never reorders the punctuation around it.
 */
describe("DocRenderer bidi isolation", () => {
  const arabic = "\u0645\u0631\u062D\u0628\u0627"; // مرحبا
  const hebrew = "\u05D0\u05D1\u05D2"; // אבג

  const blockDoc = (type: "paragraph" | "heading", text: string) => ({
    type: "doc",
    content: [
      {
        type,
        ...(type === "heading" ? { attrs: { level: 2 } } : {}),
        content: [{ type: "text", text }],
      },
    ],
  });

  it("resolves a paragraph's base direction from its own first strong character", () => {
    expect(render(blockDoc("paragraph", "hello"))).toMatch(
      /<p dir="ltr"[^>]*class="[^"]*dir-ltr/,
    );
    expect(render(blockDoc("paragraph", arabic))).toMatch(
      /<p dir="rtl"[^>]*class="[^"]*dir-rtl/,
    );
    // No strong character: defer to the surrounding document direction.
    expect(render(blockDoc("paragraph", "123"))).toMatch(
      /<p dir="auto"[^>]*class="[^"]*dir-auto/,
    );
  });

  it("isolates mixed prose without flipping its base direction", () => {
    expect(render(blockDoc("paragraph", `hello ${arabic}`))).toMatch(
      /<p dir="ltr"[^>]*class="[^"]*dir-mixed/,
    );
    expect(render(blockDoc("heading", `${arabic} hello`))).toMatch(
      /<h2 dir="rtl"[^>]*class="[^"]*dir-rtl dir-mixed/,
    );
  });

  it("carries the same treatment to a blockquote", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: hebrew }] },
          ],
        },
      ],
    });
    expect(html).toMatch(/<blockquote[^>]*dir="rtl"/);
    // The quote rail is logical (border-inline-start), so it mirrors in RTL.
    expect(html).toContain("border-inline-start");
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


describe("DocRenderer template button / Button atoms", () => {
  it("renders a template button as a labelled, read-only card", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "templateButton",
          attrs: { id: "tb1", templateId: "meeting", label: "Meeting notes" },
        },
      ],
    });
    expect(html).toContain('data-template-button=""');
    expect(html).toContain('data-template-id="meeting"');
    expect(html).toContain("Meeting notes");
  });

  it("renders a Button block as a disabled labelled action summary", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "button",
          attrs: {
            id: "b1",
            label: "Open report",
            style: "primary",
            action: { kind: "open_url", url: "https://example.com/report" },
          },
        },
      ],
    });
    expect(html).toContain('data-button-block=""');
    expect(html).toContain("Open report");
    expect(html).toContain("disabled");
    expect(html).toContain("Open &quot;https://example.com/report&quot;");
  });

  it("renders an unconfigured Button honestly instead of a silent no-op", () => {
    const html = render({
      type: "doc",
      content: [{ type: "button", attrs: { id: "b2", label: "" } }],
    });
    expect(html).toContain("Button");
    expect(html).toContain("disabled");
    expect(html).toContain("Configure the button first");
  });
});

describe("DocRenderer Ask AI block", () => {
  it("renders the prompt and the stored answer, with no interactive control", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "askAi",
          attrs: {
            id: "ask1",
            prompt: "What changed this week?",
            mode: "ask",
            answer: "Two releases shipped.",
            status: "done",
          },
        },
      ],
    });
    expect(html).toContain('data-ask-ai=""');
    expect(html).toContain('data-ask-ai-read=""');
    expect(html).toContain("What changed this week?");
    expect(html).toContain("Two releases shipped.");
    expect(html).not.toContain("<button");
  });

  it("renders the error honestly and remains readable when AI failed", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "askAi",
          attrs: {
            id: "ask2",
            prompt: "Summarize this page",
            mode: "summarize",
            status: "error",
            error: "AI is not configured.",
          },
        },
      ],
    });
    expect(html).toContain('data-mode="summarize"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("AI is not configured.");
    expect(html).not.toContain("<button");
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


describe("DocRenderer UML blocks", () => {
  it("renders the visual UML client surface with a loading fallback", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "umlDiagram",
          attrs: { data: { nodes: [{ id: "a", kind: "class", label: "Page" }], edges: [] } },
        },
      ],
    });
    expect(html).toContain('data-uml-diagram="loading"');
    expect(html).toContain("UML diagram");
  });
});

describe("DocRenderer attachments and PDF previews", () => {
  it("renders a media file node as a download link, not a broken image", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "/api/files/ws-1/report.docx",
            alt: "report.docx",
            mediaType: "file",
          },
        },
      ],
    });
    expect(html).not.toMatch(/<img\b/);
    expect(hrefsOf(html)).toContain("/api/files/ws-1/report.docx");
    expect(html).toContain("report.docx");
  });

  it("renders an authenticated PDF preview", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "pdfPreview",
          attrs: { url: "/api/files/ws-1/report.pdf", title: "Report" },
        },
      ],
    });
    expect(html).toContain('data-pdf-preview=""');
    expect(html).toContain('src="/api/files/ws-1/report.pdf"');
    expect(html).toContain('title="Report"');
  });
});

describe("DocRenderer animated media / device previews", () => {
  const animatedDoc = (attrs: Record<string, unknown>) => ({
    type: "doc",
    content: [{ type: "animatedImage", attrs }],
  });

  it("renders an animated GIF from its original bytes, never a lossy transform", () => {
    const html = render(
      animatedDoc({
        src: "/api/files/ws-1/token.gif?w=320&format=webp&q=40&v=2",
        alt: "loop",
        mediaType: "image",
        animated: true,
        staticFallback: false,
      }),
    );
    expect(html).toContain('data-animated-image=""');
    expect(html).toContain('data-animated="true"');
    expect(srcsOf(html)).toEqual(["/api/files/ws-1/token.gif?v=2"]);
    expect(html).not.toContain("format=webp");
    expect(html).not.toContain("w=320");
  });

  it("keeps a GIF visible even when its stored playback policy is a static fallback", () => {
    const html = render(
      animatedDoc({
        src: "/api/files/ws-1/still.gif",
        alt: "still",
        animated: true,
        staticFallback: true,
      }),
    );
    expect(html).toContain('data-static-fallback="true"');
    expect(srcsOf(html)).toEqual(["/api/files/ws-1/still.gif"]);
  });

  it("proxies an external animated GIF and still renders an image", () => {
    const html = render(
      animatedDoc({
        src: "https://images.example.com/loop.gif?format=webp",
        alt: "loop",
        animated: true,
      }),
    );
    expect(srcsOf(html)).toEqual([
      "/api/external-image?url=https%3A%2F%2Fimages.example.com%2Floop.gif",
    ]);
    expect(html).toContain('data-animated-image=""');
  });

  it("wraps an animated media block in a device frame", () => {
    const html = render(
      animatedDoc({
        src: "/api/files/ws-1/loop.gif",
        alt: "loop",
        animated: true,
        device: "phone",
      }),
    );
    expect(html).toContain('data-device-preview="phone"');
    expect(html).toContain("max-width:390px");
    expect(srcsOf(html)).toEqual(["/api/files/ws-1/loop.gif"]);
  });

  it("wraps a provider embed in a device frame without weakening sandbox policy", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "embed",
          attrs: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", device: "phone" },
        },
      ],
    });
    expect(html).toContain('data-device-preview="phone"');
    expect(html).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
    expect(html).toContain("sandbox=");
    expect(html).toContain("allow-scripts");
  });

  it("unwraps an unknown device id but keeps the provider iframe live", () => {
    const html = render({
      type: "doc",
      content: [
        {
          type: "embed",
          attrs: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", device: "toaster" },
        },
      ],
    });
    expect(html).not.toContain("data-device-preview");
    expect(html).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
  });
});

describe("DocRenderer equations", () => {
  it("keeps valid LaTeX as escaped source without injecting HTML", () => {
    const html = render(mathDoc("inlineMath", "x^2 < y"));
    expect(html).toContain('data-latex="x^2 &lt; y"');
    expect(html).toContain("x^2 &lt; y");
    expect(html).not.toContain('data-math-error');
    expect(html).not.toContain("<script");
  });

  it("shows a structural error inline for broken LaTeX", () => {
    const inline = render(mathDoc("inlineMath", "\\frac{1}{"));
    expect(inline).toContain("data-math-error");
    expect(inline).toContain('role="alert"');
    expect(inline).toContain("Unclosed");

    const block = render(mathDoc("blockMath", "\\begin{matrix} a & b"));
    expect(block).toContain("data-math-error");
    expect(block).toContain('role="alert"');
    expect(block).toContain("Unclosed environment");
  });

  it("rejects banned commands inline instead of rendering them as valid math", () => {
    const html = render(mathDoc("blockMath", "\\input{secret}"));
    expect(html).toContain("data-math-error");
    expect(html).toContain("not allowed");
    expect(html).toContain("\\input{secret}");
  });
});
