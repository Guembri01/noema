import { describe, expect, it } from "vitest";
import {
  buildAnchorSlug,
  buildBlockDeepLink,
  isSamePageLink,
  normalizePageId,
  parseBlockDeepLink,
  slugWithDedup,
} from "./deep-links";

/**
 * B96 — "Copy block link" / deep links (docs/MISSING_FEATURES.md §1, row 131).
 *
 * The real page route in `src/app/` is `/w/[slug]/[pageId]`, so the canonical
 * page path is `/w/<workspaceSlug>/<pageId>` (the workspace slug is optional
 * here — without it the link is the workspace-relative short form). A block
 * anchor is the `#<blockId>` fragment, replacing the old unstable `#block-<pos>`.
 *
 * Everything is pure string work: build a link, parse one back, derive stable
 * unicode-aware heading/anchor slugs plus `-1`/`-2` dedupe suffixes.
 */
describe("buildBlockDeepLink", () => {
  it("returns the page path alone when there is no block id", () => {
    expect(buildBlockDeepLink("page-1")).toBe("/w/page-1");
  });

  it("appends the block anchor as a hash fragment", () => {
    expect(buildBlockDeepLink("page-1", "block-1")).toBe("/w/page-1#block-1");
  });

  it("uses the real /w/<slug>/<pageId> route when a workspace slug is given", () => {
    expect(buildBlockDeepLink("page-1", undefined, { workspaceSlug: "acme" })).toBe(
      "/w/acme/page-1",
    );
    expect(buildBlockDeepLink("page-1", "block-1", { workspaceSlug: "acme" })).toBe(
      "/w/acme/page-1#block-1",
    );
  });

  it("prefixes the origin for an absolute link, trimming a trailing slash", () => {
    expect(buildBlockDeepLink("page-1", "block-1", { origin: "https://noema.app" })).toBe(
      "https://noema.app/w/page-1#block-1",
    );
    expect(buildBlockDeepLink("page-1", "block-1", { origin: "https://noema.app/" })).toBe(
      "https://noema.app/w/page-1#block-1",
    );
  });

  it("percent-encodes page id, block id and workspace slug", () => {
    expect(
      buildBlockDeepLink("page 1/2", "block 1#2", { workspaceSlug: "my ws" }),
    ).toBe("/w/my%20ws/page%201%2F2#block%201%232");
  });

  it("treats an empty block id as no anchor", () => {
    expect(buildBlockDeepLink("page-1", "")).toBe("/w/page-1");
  });
});

describe("parseBlockDeepLink", () => {
  it("parses a relative page-only link", () => {
    const parsed = parseBlockDeepLink("/w/page-1");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.pageId).toBe("page-1");
    expect(parsed.blockId).toBeUndefined();
  });

  it("parses a relative link with a block anchor", () => {
    const parsed = parseBlockDeepLink("/w/page-1#block-1");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.pageId).toBe("page-1");
    expect(parsed.blockId).toBe("block-1");
  });

  it("tolerates absolute URLs of any origin", () => {
    for (const link of [
      "https://noema.app/w/acme/page-1#block-1",
      "http://localhost:3200/w/acme/page-1#block-1",
      "https://evil.example/w/acme/page-1#block-1",
    ]) {
      const parsed = parseBlockDeepLink(link);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.pageId).toBe("page-1");
      expect(parsed.blockId).toBe("block-1");
    }
  });

  it("ignores query strings and trailing slashes", () => {
    const parsed = parseBlockDeepLink("/w/acme/page-1/?utm=1#block-1");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.pageId).toBe("page-1");
    expect(parsed.blockId).toBe("block-1");
  });

  it("percent-decodes the ids it returns", () => {
    const parsed = parseBlockDeepLink("/w/acme/page%201#block%202");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.pageId).toBe("page 1");
    expect(parsed.blockId).toBe("block 2");
  });

  it("rejects foreign page-path prefixes", () => {
    expect(parseBlockDeepLink("/p/abc").ok).toBe(false);
    expect(parseBlockDeepLink("/page/abc").ok).toBe(false);
    expect(parseBlockDeepLink("https://noema.app/other/abc").ok).toBe(false);
  });

  it("rejects links without a page id", () => {
    expect(parseBlockDeepLink("/w").ok).toBe(false);
    expect(parseBlockDeepLink("/w/").ok).toBe(false);
    expect(parseBlockDeepLink("").ok).toBe(false);
  });

  it("rejects malformed or empty hashes", () => {
    expect(parseBlockDeepLink("/w/page-1#").ok).toBe(false);
    expect(parseBlockDeepLink("/w/page-1#%20").ok).toBe(false);
  });
});

describe("normalizePageId", () => {
  it("trims and lowercases", () => {
    expect(normalizePageId("  Page-1  ")).toBe("page-1");
  });

  it("percent-decodes when it round-trips safely", () => {
    expect(normalizePageId("page%201")).toBe("page 1");
    expect(normalizePageId("PAGE%2D1")).toBe("page-1");
  });

  it("keeps a malformed percent escape instead of throwing", () => {
    expect(normalizePageId("100%")).toBe("100%");
  });
});

describe("isSamePageLink", () => {
  it("is true for links to the same page across origins, slugs and anchors", () => {
    expect(
      isSamePageLink("/w/acme/page-1#block-1", "https://evil.example/w/z/page-1?q=2#other"),
    ).toBe(true);
    expect(isSamePageLink("/w/PAGE-1", "/w/page-1")).toBe(true);
  });

  it("is false for different pages or unparseable links", () => {
    expect(isSamePageLink("/w/page-1", "/w/page-2")).toBe(false);
    expect(isSamePageLink("/p/page-1", "/w/page-1")).toBe(false);
  });
});

describe("buildAnchorSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(buildAnchorSlug("Hello World")).toBe("hello-world");
  });

  it("collapses whitespace runs", () => {
    expect(buildAnchorSlug("  Multiple   Spaces\tHere  ")).toBe("multiple-spaces-here");
  });

  it("strips punctuation but keeps hyphens", () => {
    expect(buildAnchorSlug("Section 1: Intro!")).toBe("section-1-intro");
    expect(buildAnchorSlug("Well-known Thing")).toBe("well-known-thing");
  });

  it("keeps unicode letters and digits", () => {
    expect(buildAnchorSlug("Café — Übung #3!")).toBe("café-übung-3");
    expect(buildAnchorSlug("第 1 章")).toBe("第-1-章");
  });

  it("documents emoji behaviour: stripped, so emoji-only text yields no slug", () => {
    expect(buildAnchorSlug("Hello 👋 World")).toBe("hello-world");
    expect(buildAnchorSlug("🎉🎉")).toBe("");
    expect(buildAnchorSlug("---")).toBe("");
  });
});

describe("slugWithDedup", () => {
  it("suffixes collisions -1, -2, … and registers each result", () => {
    const seen = new Set<string>();
    expect(slugWithDedup("intro", seen)).toBe("intro");
    expect(slugWithDedup("intro", seen)).toBe("intro-1");
    expect(slugWithDedup("intro", seen)).toBe("intro-2");
    expect(seen).toEqual(new Set(["intro", "intro-1", "intro-2"]));
  });

  it("skips suffixes already claimed in a pre-seeded set", () => {
    const seen = new Set(["intro", "intro-1"]);
    expect(slugWithDedup("intro", seen)).toBe("intro-2");
  });

  it("keeps distinct slugs distinct", () => {
    const seen = new Set<string>();
    expect(slugWithDedup("a", seen)).toBe("a");
    expect(slugWithDedup("b", seen)).toBe("b");
  });
});

describe("build → parse round-trip", () => {
  const cases: Array<[string, string | undefined, string | undefined]> = [
    ["page-1", undefined, undefined],
    ["page-1", "block-1", undefined],
    ["page 1/2", "block 1", "my ws"],
    ["Page-9", "B-2", "acme"],
    ["pg", "🎉", "w"],
  ];

  it("preserves pageId and blockId through a full round-trip", () => {
    for (const [pageId, blockId, workspaceSlug] of cases) {
      const link = buildBlockDeepLink(pageId, blockId, { workspaceSlug });
      const parsed = parseBlockDeepLink(link);
      expect(parsed.ok, link).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.pageId).toBe(pageId);
      expect(parsed.blockId).toBe(blockId);
    }
  });
});
