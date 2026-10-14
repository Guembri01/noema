import { describe, expect, it } from "vitest";
import {
  isPreviewable,
  parseLinkMeta,
  resolveUrl,
  truncateMeta,
  type LinkPreviewMeta,
} from "@/lib/link-preview-meta";

/**
 * F6 — link preview metadata extraction.
 *
 * `link-preview-meta` parses a raw HTML string (NO network, no DOM) into the
 * shape the bookmark/link-preview card consumes: `{ title, description, image,
 * favicon, siteName, url }`. Resolution of relative URLs, HTML entity decoding
 * and malformed-markup tolerance are all pure string work, and nothing here may
 * ever throw — a hostile page can hand us any bytes.
 */

const webpage = `<!doctype html>
<html><head>
  <title>Fallback &amp; Title</title>
  <meta name="description" content="HTML description">
  <meta property="og:title" content="OG &amp; Title">
  <meta property="og:description" content="OG description">
  <meta property="og:site_name" content="Example Site">
  <meta property="og:image" content="/images/hero.png">
  <meta property="og:url" content="/posts/1">
  <link rel="icon" href="/favicon.ico">
</head><body></body></html>`;

describe("parseLinkMeta / OpenGraph priority", () => {
  it("reads og:* first and resolves relative URLs against the base", () => {
    const meta = parseLinkMeta(webpage, { baseUrl: "https://example.com/posts/1" });
    expect(meta).toEqual({
      title: "OG & Title",
      description: "OG description",
      image: "https://example.com/images/hero.png",
      favicon: "https://example.com/favicon.ico",
      siteName: "Example Site",
      url: "https://example.com/posts/1",
    });
  });

  it("falls back to twitter:* then plain HTML when OpenGraph is absent", () => {
    const html = `<head>
      <title>Plain Title</title>
      <meta name="description" content="Plain description">
      <meta name="twitter:title" content="Tweet title">
    </head>`;
    const meta = parseLinkMeta(html, { baseUrl: "https://example.com" });
    // twitter:title beats <title>; twitter has no description so the
    // meta[name=description] tag wins.
    expect(meta.title).toBe("Tweet title");
    expect(meta.description).toBe("Plain description");
  });

  it("prefers og:image over twitter:image and decodes entities in URLs", () => {
    const html = `<head>
      <meta name="twitter:image" content="https://t.co/twitter.png">
      <meta property="og:image" content="/img?a=1&amp;b=2">
    </head>`;
    expect(parseLinkMeta(html, { baseUrl: "https://example.com" }).image).toBe(
      "https://example.com/img?a=1&b=2",
    );
  });

  it("uses og:url, then <link rel=canonical>, then the base URL", () => {
    const canonical = `<head><link rel="canonical" href="https://canonical.example/x"></head>`;
    expect(parseLinkMeta(canonical).url).toBe("https://canonical.example/x");
    expect(parseLinkMeta("<head></head>", { baseUrl: "https://base.example/y" }).url).toBe(
      "https://base.example/y",
    );
  });

  it("accepts attributes in any order and mixed case", () => {
    const html = `<HEAD>
      <META CONTENT="Reversed" PROPERTY="og:title">
      <META name='twitter:description' content='From twitter'>
    </HEAD>`;
    const meta = parseLinkMeta(html);
    expect(meta.title).toBe("Reversed");
    expect(meta.description).toBe("From twitter");
  });
});

describe("parseLinkMeta / favicon + siteName", () => {
  it("recognises shortcut icon and apple-touch-icon rel values", () => {
    expect(
      parseLinkMeta(`<link rel="shortcut icon" href="/s.ico">`, { baseUrl: "https://a.com/x" })
        .favicon,
    ).toBe("https://a.com/s.ico");
    expect(
      parseLinkMeta(`<link rel="apple-touch-icon" href="/a.png">`, {
        baseUrl: "https://a.com/x",
      }).favicon,
    ).toBe("https://a.com/a.png");
  });

  it("leaves favicon/siteName undefined when the markup omits them", () => {
    const meta = parseLinkMeta("<head><title>Only</title></head>");
    expect(meta.favicon).toBeUndefined();
    expect(meta.siteName).toBeUndefined();
  });

  it("reads application-name as a siteName fallback", () => {
    expect(parseLinkMeta(`<meta name="application-name" content="My App">`).siteName).toBe(
      "My App",
    );
  });
});

describe("parseLinkMeta / entities + malformed markup", () => {
  it("decodes named, decimal and hex entities in text", () => {
    const html = `<title>It&#39;s &quot;fine&quot; &#x2713;</title>`;
    expect(parseLinkMeta(html).title).toBe('It\'s "fine" \u2713');
  });

  it("collapses whitespace runs in text fields", () => {
    expect(parseLinkMeta("<title>\n  Multi\n  Line \n</title>").title).toBe("Multi Line");
  });

  it("does not double-decode escaped entities (&amp;lt; stays literal)", () => {
    expect(parseLinkMeta(`<meta property="og:title" content="&amp;lt;">`).title).toBe("&lt;");
  });

  it("never throws on malformed entities, unterminated tags or garbage", () => {
    expect(parseLinkMeta(`<meta property="og:title" content="bad &#x110000; ref">`).title).toBe(
      "bad \uFFFD ref",
    );
    // Unterminated tag (no closing ">") is ignored, the valid <title> survives.
    expect(parseLinkMeta(`<title>Safe</title><meta property="og:title" content="Oops"`).title).toBe(
      "Safe",
    );
    expect(() => parseLinkMeta("<div><p>no head here")).not.toThrow();
    expect(parseLinkMeta("")).toEqual({});
    expect(parseLinkMeta("<")).toEqual({});
  });

  it("ignores a non-http(s) og:image instead of leaking a javascript: URL", () => {
    const html = `<meta property="og:image" content="javascript:alert(1)">`;
    expect(parseLinkMeta(html, { baseUrl: "https://example.com" }).image).toBeUndefined();
  });
});

describe("resolveUrl", () => {
  it("resolves root-relative, path-relative and protocol-relative hrefs", () => {
    expect(resolveUrl("https://a.com/dir/page", "/img.png")).toBe("https://a.com/img.png");
    expect(resolveUrl("https://a.com/dir/page", "img.png")).toBe("https://a.com/dir/img.png");
    expect(resolveUrl("https://a.com/dir/page", "//cdn.a.com/i.png")).toBe(
      "https://cdn.a.com/i.png",
    );
  });

  it("returns an absolute href unchanged even without a base", () => {
    expect(resolveUrl(undefined, "https://x.io/a")).toBe("https://x.io/a");
  });

  it("refuses non-http(s) schemes and unresolvable relative hrefs", () => {
    expect(resolveUrl("https://a.com", "javascript:alert(1)")).toBeNull();
    expect(resolveUrl("https://a.com", "mailto:x@y.com")).toBeNull();
    expect(resolveUrl("https://a.com", "data:image/png;base64,AAAA")).toBeNull();
    expect(resolveUrl("", "img.png")).toBeNull();
    expect(resolveUrl("not a url", "/x")).toBeNull();
    expect(resolveUrl("https://a.com", "   ")).toBeNull();
  });
});

describe("isPreviewable", () => {
  it("accepts public http(s) URLs (whitespace tolerated)", () => {
    expect(isPreviewable("https://example.com/a")).toBe(true);
    expect(isPreviewable("http://example.com")).toBe(true);
    expect(isPreviewable("  https://example.com/x  ")).toBe(true);
  });

  it("rejects scheme-less, non-http and SSRF-adjacent hosts", () => {
    expect(isPreviewable("example.com/a")).toBe(false);
    expect(isPreviewable("mailto:a@b.com")).toBe(false);
    expect(isPreviewable("javascript:alert(1)")).toBe(false);
    expect(isPreviewable("https://localhost/x")).toBe(false);
    expect(isPreviewable("http://127.0.0.1")).toBe(false);
    expect(isPreviewable("http://10.0.0.5/admin")).toBe(false);
    expect(isPreviewable("")).toBe(false);
  });
});

describe("truncateMeta", () => {
  const long = "x".repeat(40);

  it("leaves text within the limit untouched", () => {
    const meta = truncateMeta({ title: "Hello" }, { max: 20 });
    expect(meta.title).toBe("Hello");
  });

  it("caps title/description/siteName with an ellipsis and never exceeds max", () => {
    const meta = truncateMeta(
      { title: long, description: long, siteName: long },
      { max: 10 },
    );
    expect(meta.title).toBe(`${"x".repeat(9)}\u2026`);
    expect(meta.title?.length).toBe(10);
    expect(meta.description?.endsWith("\u2026")).toBe(true);
    expect(meta.siteName?.length).toBeLessThanOrEqual(10);
  });

  it("trims a trailing space before appending the ellipsis", () => {
    expect(truncateMeta({ title: "hello  world" }, { max: 8 }).title).toBe("hello\u2026");
  });

  it("drops text fields when max is zero and keeps URL-valued fields", () => {
    const meta = truncateMeta(
      { title: "Hello", description: "World", image: "https://a.com/i.png", url: "https://a.com" },
      { max: 0 },
    );
    expect(meta.title).toBeUndefined();
    expect(meta.description).toBeUndefined();
    expect(meta.image).toBe("https://a.com/i.png");
    expect(meta.url).toBe("https://a.com");
  });

  it("returns a new object and does not mutate the input", () => {
    const input: LinkPreviewMeta = { title: long, image: "https://a.com/i.png" };
    const out = truncateMeta(input, { max: 5 });
    expect(input.title).toBe(long);
    expect(out).not.toBe(input);
    expect(out.title).toBe(`${"x".repeat(4)}\u2026`);
  });
});
