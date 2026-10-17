import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring coverage for `app/sitemap.ts`: the public entries are generated from
 * indexable share links and resolved through `src/lib/sitemap.ts`'s
 * `normalizeUrl`/`SITEMAP_LIMIT`. Prisma is mocked; the mapping runs for real.
 */

const db = vi.hoisted(() => ({ shareLinkFindMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: { shareLink: { findMany: db.shareLinkFindMany } },
}));

import sitemap from "./sitemap";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = "https://noema.example.com";
});

afterEach(() => {
  delete process.env.APP_URL;
});

describe("sitemap()", () => {
  it("maps indexable share links to absolute, normalized entries", async () => {
    const updatedAt = new Date("2026-01-02T03:04:05.000Z");
    db.shareLinkFindMany.mockResolvedValue([
      { token: "tok-1", page: { updatedAt } },
      { token: "tok-2", page: { updatedAt } },
    ]);

    const entries = await sitemap();

    expect(entries).toEqual([
      {
        url: "https://noema.example.com/s/tok-1",
        lastModified: updatedAt,
        changeFrequency: "weekly",
        priority: 0.6,
      },
      {
        url: "https://noema.example.com/s/tok-2",
        lastModified: updatedAt,
        changeFrequency: "weekly",
        priority: 0.6,
      },
    ]);
  });

  it("queries only indexable, unprotected, live links and caps at SITEMAP_LIMIT", async () => {
    db.shareLinkFindMany.mockResolvedValue([]);
    await sitemap();

    const args = db.shareLinkFindMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      indexing: true,
      passwordHash: null,
      page: { deletedAt: null },
    });
    expect(args.take).toBe(50000);
    expect(args.orderBy).toEqual({ page: { updatedAt: "desc" } });
  });

  it("strips a trailing slash from the configured origin", async () => {
    process.env.APP_URL = "https://noema.example.com/";
    db.shareLinkFindMany.mockResolvedValue([{ token: "tok-3", page: { updatedAt: new Date(0) } }]);

    await expect(sitemap()).resolves.toEqual([
      expect.objectContaining({ url: "https://noema.example.com/s/tok-3" }),
    ]);
  });

  it("answers with an empty sitemap when the database is unreachable", async () => {
    // The route is prerendered, so an unreachable database used to fail
    // `next build` — a database blip could block a deploy, and the desktop
    // payload build died on a placeholder `DATABASE_URL`.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db.shareLinkFindMany.mockRejectedValue(new Error("Can't reach database server"));

    await expect(sitemap()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[sitemap]"));
    warn.mockRestore();
  });
});
