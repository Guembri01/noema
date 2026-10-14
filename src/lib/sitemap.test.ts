import { describe, expect, it } from "vitest";
import {
  CHANGEFREQ,
  buildSitemap,
  escapeXml,
  normalizeUrl,
  paginateSitemap,
  type SitemapEntry,
} from "./sitemap";

const BASE = "https://example.com";
const URLSET_OPEN = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';

describe("escapeXml — XML metacharacters", () => {
  it("escapes the five characters that change XML parsing", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("escapes the ampersand first, so entities are not double-escaped", () => {
    expect(escapeXml("a & b")).toBe("a &amp; b");
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves safe URLs and text untouched", () => {
    expect(escapeXml("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(escapeXml("Weekly sync")).toBe("Weekly sync");
    expect(escapeXml("")).toBe("");
  });
});

describe("normalizeUrl — canonical join", () => {
  it("joins a base and a relative path without doubling the slash", () => {
    expect(normalizeUrl(BASE, "/about")).toBe("https://example.com/about");
    expect(normalizeUrl(`${BASE}/`, "about")).toBe("https://example.com/about");
  });

  it("drops trailing slashes from the base but keeps them on the path", () => {
    expect(normalizeUrl(`${BASE}/`, "/about/")).toBe("https://example.com/about/");
  });

  it("returns an absolute URL unchanged", () => {
    expect(normalizeUrl(BASE, "https://other.com/x")).toBe("https://other.com/x");
  });

  it("collapses a bare base and normalises the root to a trailing slash", () => {
    expect(normalizeUrl(`${BASE}/`, "")).toBe(BASE);
    expect(normalizeUrl(BASE, "/")).toBe("https://example.com/");
  });

  it("preserves query strings and fragments", () => {
    expect(normalizeUrl(BASE, "/a?x=1#h")).toBe("https://example.com/a?x=1#h");
  });

  it("trims surrounding whitespace from both sides", () => {
    expect(normalizeUrl(` ${BASE} `, " /a ")).toBe("https://example.com/a");
  });
});

describe("paginateSitemap — sitemap index splitting", () => {
  const entry = (n: number): SitemapEntry => ({ loc: `/p/${n}` });
  const many = (n: number) => Array.from({ length: n }, (_, i) => entry(i));

  it("defaults to a 50000-entry page and keeps a small set in one page", () => {
    const pages = paginateSitemap(many(3));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(3);
    expect(pages[0][0]).toEqual(entry(0));
  });

  it("splits into chunks of `max`, preserving order", () => {
    const pages = paginateSitemap(many(5), { max: 2 });
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(pages[1][0]).toEqual(entry(2));
    expect(pages[2][0]).toEqual(entry(4));
  });

  it("does not emit a trailing empty page when the split is exact", () => {
    expect(paginateSitemap(many(4), { max: 2 })).toHaveLength(2);
  });

  it("yields no pages for an empty list", () => {
    expect(paginateSitemap([])).toEqual([]);
  });

  it("rejects a non-positive or non-integer max", () => {
    expect(() => paginateSitemap(many(1), { max: 0 })).toThrow();
    expect(() => paginateSitemap(many(1), { max: -1 })).toThrow();
    expect(() => paginateSitemap(many(1), { max: 1.5 })).toThrow();
  });
});

describe("buildSitemap — urlset document", () => {
  it("wraps an empty entry list in the XML declaration and urlset envelope", () => {
    const xml = buildSitemap([], { baseUrl: BASE });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml).toContain(URLSET_OPEN);
    expect(xml.endsWith("</urlset>\n")).toBe(true);
    expect(xml).not.toContain("<url>");
  });

  it("resolves each loc against baseUrl and emits the child elements", () => {
    const xml = buildSitemap(
      [{ loc: "/about", lastmod: "2026-01-15", changefreq: "weekly", priority: 0.8 }],
      { baseUrl: BASE },
    );
    expect(xml).toContain("<url>\n");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).toContain("<lastmod>2026-01-15</lastmod>");
    expect(xml).toContain("<changefreq>weekly</changefreq>");
    expect(xml).toContain("<priority>0.8</priority>");
    expect(xml).toContain("</url>");
  });

  it("omits every optional element for a bare entry", () => {
    const xml = buildSitemap([{ loc: "/bare" }], { baseUrl: BASE });
    expect(xml).not.toContain("<lastmod>");
    expect(xml).not.toContain("<changefreq>");
    expect(xml).not.toContain("<priority>");
  });

  it("renders boundary priorities as bare numbers", () => {
    const xml = buildSitemap(
      [
        { loc: "/top", priority: 1 },
        { loc: "/low", priority: 0 },
      ],
      { baseUrl: BASE },
    );
    expect(xml).toContain("<priority>1</priority>");
    expect(xml).toContain("<priority>0</priority>");
  });

  it("rejects a priority outside [0, 1] or not numeric", () => {
    expect(() => buildSitemap([{ loc: "/a", priority: -0.1 }], { baseUrl: BASE })).toThrow();
    expect(() => buildSitemap([{ loc: "/a", priority: 1.1 }], { baseUrl: BASE })).toThrow();
    expect(() => buildSitemap([{ loc: "/a", priority: Number.NaN }], { baseUrl: BASE })).toThrow();
  });

  it("rejects a changefreq outside the enum", () => {
    // @ts-expect-error — the string is intentionally invalid at the type level too.
    expect(() => buildSitemap([{ loc: "/a", changefreq: "sometimes" }], { baseUrl: BASE })).toThrow();
    expect(CHANGEFREQ).toContain("weekly");
    expect(CHANGEFREQ).toHaveLength(7);
  });

  it("XML-escapes loc and lastmod", () => {
    const xml = buildSitemap(
      [{ loc: "/a&b", lastmod: "2026-01-15<bad>" }],
      { baseUrl: BASE },
    );
    expect(xml).toContain("<loc>https://example.com/a&amp;b</loc>");
    expect(xml).toContain("<lastmod>2026-01-15&lt;bad&gt;</lastmod>");
  });

  it("preserves entry order and is byte-identical across calls", () => {
    const entries: SitemapEntry[] = [{ loc: "/b" }, { loc: "/a" }];
    const first = buildSitemap(entries, { baseUrl: BASE });
    expect(first.indexOf("<loc>https://example.com/b</loc>")).toBeLessThan(
      first.indexOf("<loc>https://example.com/a</loc>"),
    );
    expect(buildSitemap(entries, { baseUrl: BASE })).toBe(first);
  });
});
