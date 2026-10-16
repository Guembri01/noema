import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring coverage for the `/rss.xml` route: recent published pages are
 * serialised through `src/lib/rss.ts`'s `buildRssFeed`. Prisma is mocked; the
 * feed shape, escaping and content type run for real.
 */

const db = vi.hoisted(() => ({ shareLinkFindMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { shareLink: { findMany: db.shareLinkFindMany } },
}));

import { GET } from "./route";

const URL = "http://localhost/rss.xml";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = "https://noema.example.com";
});

afterEach(() => {
  delete process.env.APP_URL;
});

describe("GET /rss.xml", () => {
  it("renders an RSS 2.0 channel of published pages", async () => {
    db.shareLinkFindMany.mockResolvedValue([
      {
        token: "tok-1",
        page: {
          title: "Weekly sync",
          updatedAt: new Date("2026-01-15T12:00:00.000Z"),
          searchText: "First line of the page\nsecond line",
        },
      },
    ]);

    const res = await GET(new Request(URL));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");

    const xml = await res.text();
    expect(xml).toContain('<rss version="2.0">');
    expect(xml).toContain("<title>Weekly sync</title>");
    expect(xml).toContain("<link>https://noema.example.com/s/tok-1</link>");
    expect(xml).toContain("<pubDate>Thu, 15 Jan 2026 12:00:00 GMT</pubDate>");
    expect(xml).toContain("<description>First line of the page</description>");
  });

  it("scopes the query to a workspace when ?workspace= is given", async () => {
    db.shareLinkFindMany.mockResolvedValue([]);
    await GET(new Request(`${URL}?workspace=acme`));

    const args = db.shareLinkFindMany.mock.calls[0][0];
    expect(args.where.page).toMatchObject({
      deletedAt: null,
      workspace: { slug: "acme" },
    });
    expect(args.where).toMatchObject({ indexing: true, passwordHash: null });
  });

  it("falls back to an 'Untitled' title and omits an empty description", async () => {
    db.shareLinkFindMany.mockResolvedValue([
      {
        token: "tok-2",
        page: { title: "   ", updatedAt: new Date("2026-01-01T00:00:00.000Z"), searchText: "  " },
      },
    ]);

    const xml = await (await GET(new Request(URL))).text();
    expect(xml).toContain("<title>Untitled</title>");
    expect(xml).not.toContain("<description></description>");
  });
});
