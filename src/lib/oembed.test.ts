import { describe, expect, it } from "vitest";
import {
  FALLBACK_CARD,
  describeLink,
  discoverEndpoint,
  parseOEmbed,
  parseOpenGraph,
  resolveMetadata,
  sanitizeEmbedHtml,
  type OEmbedData,
  type OEmbedProviderId,
  type ResolvedMetadata,
} from "./oembed";

/** A raw provider response, as it appears on the wire (snake_case fields). */
const YOUTUBE_RAW = {
  type: "video",
  title: "A Video",
  author_name: "A Channel",
  provider_name: "YouTube",
  thumbnail_url: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
  html: '<iframe src="https://www.youtube.com/embed/abc" width="480" height="270"></iframe>',
  width: 480,
  height: 270,
};

/** Shared fixture: a complete, parsed oEmbed payload. */
const YOUTUBE_OEMBED: OEmbedData = {
  type: "video",
  title: "A Video",
  authorName: "A Channel",
  providerName: "YouTube",
  thumbnailUrl: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
  html: '<iframe src="https://www.youtube.com/embed/abc" width="480" height="270"></iframe>',
  width: 480,
  height: 270,
};

const OG_FIXTURE = {
  title: "OG Title",
  description: "OG Description",
  image: "https://cdn.example/og.png",
  siteName: "Example Site",
  favicon: "https://example.com/favicon.ico",
};

describe("discoverEndpoint — provider registry", () => {
  it("maps each known provider host to its oEmbed endpoint", () => {
    const cases: Array<[string, OEmbedProviderId, string]> = [
      ["https://www.youtube.com/watch?v=abc", "youtube", "https://www.youtube.com/oembed"],
      ["https://youtu.be/abc", "youtube", "https://www.youtube.com/oembed"],
      ["https://vimeo.com/12345", "vimeo", "https://vimeo.com/api/oembed.json"],
      ["https://twitter.com/u/status/1", "twitter", "https://publish.twitter.com/oembed"],
      ["https://x.com/u/status/1", "twitter", "https://publish.twitter.com/oembed"],
      ["https://www.figma.com/file/abc", "figma", "https://www.figma.com/api/oembed"],
      ["https://codepen.io/u/pen/abc", "codepen", "https://codepen.io/api/oembed"],
      ["https://soundcloud.com/u/track", "soundcloud", "https://soundcloud.com/oembed"],
    ];
    for (const [url, provider, endpoint] of cases) {
      const found = discoverEndpoint(url);
      expect(found[0]).toMatchObject({ provider, source: "provider" });
      expect(found[0].endpoint.startsWith(endpoint)).toBe(true);
      expect(found[0].endpoint).toContain(encodeURIComponent(url));
    }
  });

  it("returns no endpoint for an unknown host", () => {
    expect(discoverEndpoint("https://example.com/a-post")).toEqual([]);
  });

  it("returns no endpoint for empty or non-http inputs", () => {
    expect(discoverEndpoint("")).toEqual([]);
    expect(discoverEndpoint("javascript:alert(1)")).toEqual([]);
    expect(discoverEndpoint("not a url")).toEqual([]);
  });
});

describe("discoverEndpoint — oEmbed discovery hint", () => {
  it("reads a <link type=application/json+oembed> hint", () => {
    const html =
      '<link rel="alternate" type="application/json+oembed" href="https://example.com/oembed?url=x">';
    const found = discoverEndpoint("https://example.com/post/1", { html });
    expect(found).toEqual([
      {
        provider: "discovery",
        endpoint: "https://example.com/oembed?url=x",
        source: "discovery",
      },
    ]);
  });

  it("resolves a relative hint href against the page URL", () => {
    const found = discoverEndpoint("https://example.com/post/1", {
      html: '<link rel="alternate" type="application/json+oembed" href="/oembed?url=x">',
    });
    expect(found[0].endpoint).toBe("https://example.com/oembed?url=x");
  });

  it("ignores non-JSON hints and unsafe hrefs", () => {
    expect(
      discoverEndpoint("https://example.com/p", {
        html: '<link rel="alternate" type="text/xml+oembed" href="https://example.com/x">',
      }),
    ).toEqual([]);
    expect(
      discoverEndpoint("https://example.com/p", {
        html: '<link rel="alternate" type="application/json+oembed" href="javascript:alert(1)">',
      }),
    ).toEqual([]);
  });

  it("lists the provider endpoint before a discovery hint", () => {
    const found = discoverEndpoint("https://www.youtube.com/watch?v=abc", {
      html: '<link rel="alternate" type="application/json+oembed" href="https://www.youtube.com/oembed?url=fromhtml">',
    });
    expect(found.map((entry) => entry.source)).toEqual(["provider", "discovery"]);
  });
});

describe("parseOEmbed", () => {
  it("parses a JSON string into typed fields", () => {
    const parsed = parseOEmbed(JSON.stringify(YOUTUBE_RAW));
    expect(parsed).toMatchObject({
      type: "video",
      title: "A Video",
      authorName: "A Channel",
      providerName: "YouTube",
      thumbnailUrl: "https://i.ytimg.com/vi/abc/hqdefault.jpg",
      width: 480,
      height: 270,
    });
    expect(parsed?.html).toContain("<iframe");
  });

  it("accepts an already-parsed object payload", () => {
    expect(parseOEmbed({ type: "photo" })?.type).toBe("photo");
  });

  it("returns null for invalid JSON and non-object payloads", () => {
    expect(parseOEmbed("{not json")).toBeNull();
    expect(parseOEmbed(null)).toBeNull();
    expect(parseOEmbed([{ type: "video" }])).toBeNull();
    expect(parseOEmbed(42)).toBeNull();
  });

  it("returns null when the type is missing or unlisted", () => {
    expect(parseOEmbed({ title: "no type" })).toBeNull();
    expect(parseOEmbed({ type: "hologram" })).toBeNull();
  });

  it("decodes and trims the title text", () => {
    expect(parseOEmbed({ type: "link", title: "  A &amp; B  " })?.title).toBe("A & B");
  });

  it("drops non-http thumbnails and floors non-positive dimensions", () => {
    const parsed = parseOEmbed({
      type: "video",
      thumbnail_url: "javascript:alert(1)",
      width: 12.9,
      height: -5,
    });
    expect(parsed?.thumbnailUrl).toBeUndefined();
    expect(parsed?.width).toBe(12);
    expect(parsed?.height).toBeUndefined();
  });

  it("keeps an allow-listed iframe from the provider", () => {
    const parsed = parseOEmbed({ type: "video", html: YOUTUBE_OEMBED.html });
    expect(parsed?.html).toContain('src="https://www.youtube.com/embed/abc"');
  });

  it("rejects an iframe served from a foreign host", () => {
    const parsed = parseOEmbed({
      type: "rich",
      html: '<iframe src="https://evil.example/embed/abc"></iframe>',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.html).toBeUndefined();
  });

  it("rejects a javascript: iframe src", () => {
    const parsed = parseOEmbed({ type: "rich", html: '<iframe src="javascript:alert(1)"></iframe>' });
    expect(parsed?.html).toBeUndefined();
  });

  it("keeps a provider blockquote and strips the trailing widget script", () => {
    const html =
      '<blockquote class="twitter-tweet"><a href="https://twitter.com/u/status/1">a tweet</a></blockquote>' +
      '<script async src="https://platform.twitter.com/widgets.js"></script>';
    const parsed = parseOEmbed({ type: "rich", html });
    expect(parsed?.html).toContain("<blockquote");
    expect(parsed?.html).not.toContain("<script");
  });

  it("honours a caller-supplied allow-list", () => {
    const parsed = parseOEmbed(
      { type: "rich", html: '<iframe src="https://embed.example/abc"></iframe>' },
      { allowedHosts: ["embed.example"] },
    );
    expect(parsed?.html).toContain("embed.example");
  });
});

describe("parseOpenGraph", () => {
  const html = [
    "<html><head>",
    "<title>Document Title</title>",
    '<meta property="og:title" content="OG &amp; Title">',
    '<meta property="og:description" content="Described">',
    '<meta property="og:image" content="https://cdn.example/og.png">',
    '<meta property="og:site_name" content="Example Site">',
    '<link rel="icon" href="/favicon.ico">',
    "</head></html>",
  ].join("");

  it("reads the og:* namespace and the icon link", () => {
    const og = parseOpenGraph(html, { baseUrl: "https://example.com/a/b" });
    expect(og).toEqual({
      title: "OG & Title",
      description: "Described",
      image: "https://cdn.example/og.png",
      siteName: "Example Site",
      favicon: "https://example.com/favicon.ico",
    });
  });

  it("falls back twitter:* then the document <title>", () => {
    expect(
      parseOpenGraph('<meta name="twitter:title" content="Tweet title"><title>Doc</title>').title,
    ).toBe("Tweet title");
    expect(parseOpenGraph("<title>Only Doc</title>").title).toBe("Only Doc");
  });

  it("resolves a relative og:image against the base URL", () => {
    expect(
      parseOpenGraph('<meta property="og:image" content="/img/og.png">', {
        baseUrl: "https://example.com/a",
      }).image,
    ).toBe("https://example.com/img/og.png");
  });

  it("synthesises /favicon.ico when the page omits an icon", () => {
    expect(parseOpenGraph("<title>x</title>", { baseUrl: "https://example.com/a/b" }).favicon).toBe(
      "https://example.com/favicon.ico",
    );
  });

  it("reads reversed attribute order and decodes entities", () => {
    const og = parseOpenGraph('<meta content="Reversed" property="og:title">');
    expect(og.title).toBe("Reversed");
  });

  it("returns an empty object for empty markup", () => {
    expect(parseOpenGraph("")).toEqual({});
  });

  it("never hangs on pathological markup", () => {
    const hostile = `<meta property="og:title" content="${"<".repeat(150_000)}`;
    expect(parseOpenGraph(hostile)).toEqual({});
  });
});

describe("sanitizeEmbedHtml", () => {
  it("keeps an allow-listed iframe and strips trailing markup", () => {
    const out = sanitizeEmbedHtml(
      '<iframe src="https://www.youtube.com/embed/abc" width="560" height="315"></iframe><script>alert(1)</script>',
      { allowedHosts: ["youtube.com"] },
    );
    expect(out).toContain("<iframe");
    expect(out).toContain('src="https://www.youtube.com/embed/abc"');
    expect(out).toContain('width="560"');
    expect(out).not.toContain("<script");
  });

  it("rejects a foreign-host iframe", () => {
    expect(
      sanitizeEmbedHtml('<iframe src="https://evil.example/embed"></iframe>', {
        allowedHosts: ["youtube.com"],
      }),
    ).toBeNull();
  });

  it("rejects event-handler attributes and srcdoc", () => {
    expect(
      sanitizeEmbedHtml('<iframe src="https://www.youtube.com/embed/a" onload="alert(1)"></iframe>', {
        allowedHosts: ["youtube.com"],
      }),
    ).toBeNull();
    expect(
      sanitizeEmbedHtml('<iframe src="https://www.youtube.com/embed/a" srcdoc="<b>x</b>"></iframe>', {
        allowedHosts: ["youtube.com"],
      }),
    ).toBeNull();
  });

  it("rejects non-http(s) src", () => {
    expect(
      sanitizeEmbedHtml('<iframe src="javascript:alert(1)"></iframe>', {
        allowedHosts: ["youtube.com"],
      }),
    ).toBeNull();
  });

  it("keeps a provider blockquote and drops the trailing script", () => {
    const out = sanitizeEmbedHtml(
      '<blockquote class="twitter-tweet"><a href="https://twitter.com/u/status/1">a tweet</a></blockquote>' +
        '<script async src="https://platform.twitter.com/widgets.js"></script>',
      { allowedHosts: ["twitter.com"] },
    );
    expect(out).toContain("blockquote");
    expect(out).toContain("twitter-tweet");
    expect(out).not.toContain("script");
  });

  it("rejects a blockquote without an allow-listed link", () => {
    expect(
      sanitizeEmbedHtml('<blockquote><a href="https://evil.example/">x</a></blockquote>', {
        allowedHosts: ["twitter.com"],
      }),
    ).toBeNull();
  });

  it("rejects anything that is not a single iframe/blockquote root", () => {
    expect(sanitizeEmbedHtml("<div>hi</div>", { allowedHosts: ["youtube.com"] })).toBeNull();
    expect(sanitizeEmbedHtml(null, { allowedHosts: ["youtube.com"] })).toBeNull();
    expect(sanitizeEmbedHtml("", { allowedHosts: ["youtube.com"] })).toBeNull();
  });
});

describe("resolveMetadata", () => {
  it("prefers the oEmbed title over OG and <title>", () => {
    const meta = resolveMetadata({
      oembed: YOUTUBE_OEMBED,
      og: OG_FIXTURE,
      url: "https://www.youtube.com/watch?v=abc",
      title: "Tag Title",
    });
    expect(meta.title).toBe("A Video");
    expect(meta.source).toBe("oembed");
  });

  it("falls back to OG and then to the <title> tag", () => {
    const withOg = resolveMetadata({
      oembed: { type: "link" },
      og: OG_FIXTURE,
      url: "https://example.com/a",
      title: "Tag Title",
    });
    expect(withOg.title).toBe("OG Title");
    expect(withOg.source).toBe("opengraph");

    const titleOnly = resolveMetadata({ og: {}, url: "https://example.com/a", title: "Tag Title" });
    expect(titleOnly.title).toBe("Tag Title");
    expect(titleOnly.source).toBe("title");
  });

  it("reports no source when nothing resolves", () => {
    const meta = resolveMetadata({ url: "https://example.com/a" });
    expect(meta.source).toBe("none");
    expect(meta.title).toBeUndefined();
    expect(meta.type).toBe("link");
  });

  it("prefers the oEmbed thumbnail and keeps OG description and site name", () => {
    const meta = resolveMetadata({ oembed: YOUTUBE_OEMBED, og: OG_FIXTURE, url: "https://x.test" });
    expect(meta.image).toBe(YOUTUBE_OEMBED.thumbnailUrl);
    expect(meta.description).toBe("OG Description");
    expect(meta.siteName).toBe("Example Site");
    expect(meta.providerName).toBe("YouTube");
    expect(meta.authorName).toBe("A Channel");
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(270);
  });

  it("falls back to the OG image when oEmbed has no thumbnail", () => {
    const meta = resolveMetadata({
      oembed: { type: "link" },
      og: OG_FIXTURE,
      url: "https://example.com/a",
    });
    expect(meta.image).toBe("https://cdn.example/og.png");
  });
});

describe("describeLink / FALLBACK_CARD", () => {
  const card = (patch: Partial<ResolvedMetadata>): ResolvedMetadata => ({
    url: "",
    type: "link",
    source: "none",
    ...patch,
  });

  it("prefers the title, then the site name, then the host", () => {
    expect(describeLink(card({ title: "A Title" }))).toBe("A Title");
    expect(describeLink(card({ siteName: "Example Site" }))).toBe("Example Site");
    expect(describeLink(card({ url: "https://www.example.com/a/b" }))).toBe("example.com");
  });

  it("falls back to the fallback label for empty input", () => {
    expect(describeLink(null)).toBe(FALLBACK_CARD.title);
    expect(describeLink(card({ title: "   " }))).toBe(FALLBACK_CARD.title);
  });

  it("exposes a stable FALLBACK_CARD shape", () => {
    expect(FALLBACK_CARD).toEqual({
      url: "",
      title: "Untitled link",
      type: "link",
      source: "none",
    });
  });
});
