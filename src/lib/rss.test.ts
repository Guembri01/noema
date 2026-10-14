import { describe, expect, it } from "vitest";
import {
  buildAtomFeed,
  buildRssFeed,
  escapeXml,
  formatIso8601Date,
  formatRfc822Date,
} from "./rss";

/**
 * RSS/Atom export — the outbound half of public-page syndication, a sibling of
 * src/lib/ics.ts. Written RED-first: `buildRssFeed`, `buildAtomFeed`,
 * `escapeXml`, `formatRfc822Date` and `formatIso8601Date` did not exist, so this
 * block failed at compile time (TS2305) and at runtime before the builder
 * landed. The contract pinned here:
 *
 * - XML entity escaping in both text nodes and attribute values;
 * - RFC 822/1123 (`Thu, 15 Jan 2026 12:00:00 GMT`) for RSS `pubDate` and
 *   ISO 8601 (`2026-01-15T12:00:00.000Z`) for Atom `published`/`updated`;
 * - dates come from injected values — the builder never reads the clock, so
 *   identical input yields byte-identical output.
 */

const NOW = "2026-01-15T12:00:00.000Z";

describe("escapeXml — XML entity escaping", () => {
  it("escapes the five predefined XML entities", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("escapes ampersands first so entities are never double-escaped", () => {
    expect(escapeXml("AT&T <you>")).toBe("AT&amp;T &lt;you&gt;");
  });

  it("leaves safe text untouched", () => {
    expect(escapeXml("Weekly sync")).toBe("Weekly sync");
  });
});

describe("formatRfc822Date — RFC 822/1123 in GMT", () => {
  it("formats an instant as an English, GMT-stamped date", () => {
    expect(formatRfc822Date(new Date(NOW))).toBe("Thu, 15 Jan 2026 12:00:00 GMT");
  });

  it("accepts ISO 8601 strings and zero-pads every field", () => {
    expect(formatRfc822Date("2026-03-04T05:06:07.000Z")).toBe(
      "Wed, 04 Mar 2026 05:06:07 GMT",
    );
  });

  it("rejects unparseable values", () => {
    expect(() => formatRfc822Date("not-a-date")).toThrow(RangeError);
  });
});

describe("formatIso8601Date — UTC ISO 8601", () => {
  it("emits millisecond precision with a trailing Z", () => {
    expect(formatIso8601Date(new Date(NOW))).toBe("2026-01-15T12:00:00.000Z");
    expect(formatIso8601Date("2030-06-01T08:30:00.000Z")).toBe(
      "2030-06-01T08:30:00.000Z",
    );
  });

  it("rejects unparseable values", () => {
    expect(() => formatIso8601Date("not-a-date")).toThrow(RangeError);
  });
});

const RSS_INPUT = {
  title: "Noema Updates",
  link: "https://noema.example/blog",
  description: "Latest posts",
  items: [
    {
      title: "Hello",
      link: "https://noema.example/p/1",
      guid: "post-1",
      pubDate: NOW,
      description: "First post",
    },
    { title: "World", link: "https://noema.example/p/2", pubDate: new Date(NOW) },
  ],
};

describe("buildRssFeed — RSS 2.0", () => {
  it("opens with an XML declaration and an rss 2.0 root, and closes it", () => {
    const xml = buildRssFeed(RSS_INPUT);
    expect(
      xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">'),
    ).toBe(true);
    expect(xml.trimEnd().endsWith("</rss>")).toBe(true);
  });

  it("writes the channel title, link and description", () => {
    const xml = buildRssFeed(RSS_INPUT);
    expect(xml).toContain("<title>Noema Updates</title>");
    expect(xml).toContain("<link>https://noema.example/blog</link>");
    expect(xml).toContain("<description>Latest posts</description>");
  });

  it("serialises items with an RFC 822 pubDate and preserves order", () => {
    const xml = buildRssFeed(RSS_INPUT);
    expect((xml.match(/<item>/g) ?? []).length).toBe(2);
    expect(xml).toContain("<guid>post-1</guid>");
    expect(xml).toContain("<pubDate>Thu, 15 Jan 2026 12:00:00 GMT</pubDate>");
    expect(xml.indexOf("Hello")).toBeLessThan(xml.indexOf("World"));
  });

  it("falls back to the link for a missing guid and omits optionals", () => {
    const xml = buildRssFeed(RSS_INPUT);
    expect(xml).toContain("<guid>https://noema.example/p/2</guid>");
    const second = xml.slice(xml.indexOf("<title>World</title>"));
    expect(second).not.toContain("<description>");
  });

  it("escapes XML in every text field", () => {
    const xml = buildRssFeed({
      title: "A & B",
      link: "https://noema.example/?a=1&b=2",
      description: "<b>bold</b>",
      items: [
        { title: "x < y", link: "https://e.example/1", pubDate: NOW, description: "5 > 3" },
      ],
    });
    expect(xml).toContain("<title>A &amp; B</title>");
    expect(xml).toContain("<link>https://noema.example/?a=1&amp;b=2</link>");
    expect(xml).toContain("<description>&lt;b&gt;bold&lt;/b&gt;</description>");
  });

  it("omits the channel description and emits no items for an empty feed", () => {
    const xml = buildRssFeed({ title: "T", link: "https://e.example", items: [] });
    expect(xml).not.toContain("<description>");
    expect(xml).not.toContain("<item>");
  });

  it("is byte-identical across calls (no clock reads)", () => {
    expect(buildRssFeed(RSS_INPUT)).toBe(buildRssFeed(RSS_INPUT));
  });
});

const ATOM_INPUT = {
  title: "Noema Updates",
  link: "https://noema.example/blog",
  description: "Latest posts",
  id: "https://noema.example/blog/feed",
  updated: NOW,
  items: [
    {
      title: "Hello",
      link: "https://noema.example/p/1",
      id: "post-1",
      published: NOW,
      description: "First post",
    },
    { title: "World", link: "https://noema.example/p/2", published: new Date(NOW) },
  ],
};

describe("buildAtomFeed — Atom 1.0", () => {
  it("declares the Atom namespace and the feed identity", () => {
    const xml = buildAtomFeed(ATOM_INPUT);
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain("<title>Noema Updates</title>");
    expect(xml).toContain('<link href="https://noema.example/blog"/>');
    expect(xml).toContain("<id>https://noema.example/blog/feed</id>");
    expect(xml).toContain("<updated>2026-01-15T12:00:00.000Z</updated>");
    expect(xml).toContain("<subtitle>Latest posts</subtitle>");
  });

  it("writes entries with ISO 8601 dates, ids and summaries", () => {
    const xml = buildAtomFeed(ATOM_INPUT);
    expect((xml.match(/<entry>/g) ?? []).length).toBe(2);
    expect(xml).toContain("<id>post-1</id>");
    expect((xml.match(/<published>2026-01-15T12:00:00.000Z<\/published>/g) ?? []).length).toBe(2);
    expect(xml).toContain("<summary>First post</summary>");
  });

  it("defaults the entry id to the link and omits a missing summary", () => {
    const xml = buildAtomFeed(ATOM_INPUT);
    expect(xml).toContain("<id>https://noema.example/p/2</id>");
    const second = xml.slice(xml.indexOf("<title>World</title>"));
    expect(second).not.toContain("<summary>");
  });

  it("defaults the feed id to the link and updated to the newest item", () => {
    const xml = buildAtomFeed({
      title: "T",
      link: "https://e.example",
      items: [
        { title: "old", link: "https://e.example/1", published: "2026-01-01T00:00:00.000Z" },
        { title: "new", link: "https://e.example/2", published: "2026-02-01T00:00:00.000Z" },
      ],
    });
    expect(xml).toContain("<id>https://e.example</id>");
    expect(xml).toContain("<updated>2026-02-01T00:00:00.000Z</updated>");
  });

  it("escapes XML in attribute values and text", () => {
    const xml = buildAtomFeed({
      title: "A & B",
      link: "https://e.example/?a=1&b=2",
      updated: NOW,
      items: [
        {
          title: "x < y",
          link: 'https://e.example/1?q="v"&x=1',
          published: NOW,
          description: "5 > 3",
        },
      ],
    });
    expect(xml).toContain('<link href="https://e.example/?a=1&amp;b=2"/>');
    expect(xml).toContain('<link href="https://e.example/1?q=&quot;v&quot;&amp;x=1"/>');
    expect(xml).toContain("<summary>5 &gt; 3</summary>");
  });

  it("is deterministic and defaults an empty feed to the epoch", () => {
    const empty = buildAtomFeed({ title: "T", link: "https://e.example", items: [] });
    expect(empty).toContain("<updated>1970-01-01T00:00:00.000Z</updated>");
    expect(empty).not.toContain("<entry>");
    expect(buildAtomFeed(ATOM_INPUT)).toBe(buildAtomFeed(ATOM_INPUT));
  });
});
