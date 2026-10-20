import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring lock (spec R78.8 / Dec5): `searchPages` must run its full-text path
 * through the pure builder in `src/lib/fts.ts` — `buildSearchSql` for the exact
 * pass, the same SQL with an all-prefix tsquery for the type-ahead pass blended
 * by `mergeRanked`, and `trigramFallback` for the typo tier when both passes are
 * empty. These assertions pin the exact SQL shape and bound parameters so the
 * builder cannot silently drift back to inline `ts_rank_cd` SQL.
 *
 * Red-first: written against `queries.ts` before the builder was adopted there.
 */

const db = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  pageFindMany: vi.fn(),
  pageCount: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: db.queryRaw,
    $queryRawUnsafe: db.queryRawUnsafe,
    page: { findMany: db.pageFindMany, count: db.pageCount },
  },
}));

import { searchPages } from "./queries";

/** A `Page` row shaped like the final `findMany` projection. */
function page(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    title: "Roadmap",
    icon: null,
    type: "PAGE",
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The GIN index probe resolves to "present" so the plan stays on the FTS tier.
  db.queryRaw.mockResolvedValue([{ indexname: "Page_searchText_idx" }]);
  db.pageCount.mockResolvedValue(0);
});

describe("searchPages — FTS builder adoption (R78.8)", () => {
  it("composes both passes with buildSearchSql and blends via mergeRanked", async () => {
    db.queryRawUnsafe.mockImplementation(async (text: string, ...params: unknown[]) => {
      if (text.includes("similarity(")) return [];
      // The type-ahead pass widens every lexeme to a prefix (`roadmap:* & …`).
      if (String(params[0]).startsWith("roadmap:*")) {
        return [
          { id: "p2", snippet: "<b>roadmaps</b> ship", rank: 3 },
          { id: "p1", snippet: "hit <b>roadmap</b> here", rank: 4 },
        ];
      }
      return [{ id: "p1", snippet: "hit <b>roadmap</b> here", rank: 4 }];
    });
    db.pageFindMany.mockResolvedValue([
      page({ id: "p1", title: "Roadmap" }),
      page({ id: "p2", title: "Roadmaps" }),
    ]);

    const results = await searchPages("ws1", "Roadmap Release", null, { take: 10 });

    expect(db.queryRawUnsafe).toHaveBeenCalledTimes(2);

    const [exactText, ...exactParams] = db.queryRawUnsafe.mock.calls[0];
    expect(exactText).toContain(
      `to_tsvector('english', coalesce(p."searchText", p."title")) @@ to_tsquery('english', $1)`,
    );
    expect(exactText).toContain("ts_rank_cd(");
    expect(exactText).toContain("ts_headline(");
    expect(exactText).toContain(`ORDER BY "rank" DESC, p."updatedAt" DESC, p."id" ASC`);
    expect(exactText).toContain("LIMIT $3");
    // The builder's sanitised tsquery (final term prefixed) + workspace + window.
    expect(exactParams).toEqual(["roadmap & release:*", "ws1", 11]);

    const [, ...prefixParams] = db.queryRawUnsafe.mock.calls[1];
    expect(prefixParams).toEqual(["roadmap:* & release:*", "ws1", 11]);

    // Exact hit first, prefix-only next, and the `<b>` markers are stripped.
    expect(results.map((row) => row.id)).toEqual(["p1", "p2"]);
    expect(results[0].snippet).toBe("hit roadmap here");
  });

  it("binds the guest scope as an ANY() predicate before LIMIT", async () => {
    db.queryRawUnsafe.mockResolvedValue([{ id: "p1", snippet: "s", rank: 1 }]);
    db.pageFindMany.mockResolvedValue([page({ id: "p1" })]);

    await searchPages("ws1", "roadmap", new Set(["p1", "p2"]), { take: 4 });

    const [text, ...params] = db.queryRawUnsafe.mock.calls[0];
    expect(text).toContain(`AND p."id" = ANY($3)`);
    expect(text).toContain("LIMIT $4");
    expect(params).toEqual(["roadmap:*", "ws1", ["p1", "p2"], 5]);
  });

  it("ranks a misspelling with the local typo tier, without touching SQL for it", async () => {
    // Both FTS passes come back empty; the typo tier is now computed in
    // TypeScript over a bounded candidate window (no `pg_trgm`, so the embedded
    // desktop database can support it too).
    db.queryRawUnsafe.mockResolvedValue([]);
    db.pageFindMany.mockResolvedValue([page({ id: "p9", title: "Notebook" })]);

    const results = await searchPages("ws1", "noetbook", null, { take: 5 });

    // Exactly the two FTS passes hit the database as SQL; the typo tier did not.
    expect(db.queryRawUnsafe).toHaveBeenCalledTimes(2);
    for (const [text] of db.queryRawUnsafe.mock.calls) {
      expect(text).not.toContain("similarity(");
    }
    expect(results.map((row) => row.id)).toEqual(["p9"]);
  });
});

/**
 * A blank query lists the workspace's most recent pages instead of matching
 * anything — the UI shows them as the "recent pages" window. That branch used
 * to ignore the guest scope, so a guest could enumerate the id, title, icon
 * and type of every page of the workspace with `query: ""`.
 */
describe("searchPages — a blank query is drawn from the visible set (B88)", () => {
  /** The `where` the blank-query branch binds. */
  type BlankWhere = {
    workspaceId?: string;
    deletedAt?: null;
    id?: { in: string[] };
  };

  const WORKSPACE_PAGES = [
    page({ id: "p1", title: "Shared notes" }),
    page({ id: "p2", title: "CONFIDENTIAL revenue" }),
    page({ id: "p3", title: "Salary plan" }),
  ];

  let seenWhere: BlankWhere | null = null;

  beforeEach(() => {
    seenWhere = null;
    // The scope predicate is applied by the database, so the mock has to apply
    // it too — otherwise the mock would be stricter than the shipped query
    // (which is exactly how F1 slipped through).
    db.pageFindMany.mockImplementation(async ({ where }: { where: BlankWhere }) => {
      seenWhere = where;
      const ids = where.id?.in;
      return WORKSPACE_PAGES.filter((row) => !ids || ids.includes(row.id));
    });
  });

  it("returns only the visible pages for an empty query", async () => {
    const results = await searchPages("ws1", "", new Set(["p1"]), { take: 10 });

    expect(results.map((row) => row.id)).toEqual(["p1"]);
    // The scope is bound as an `id in (…)` predicate, not filtered afterwards.
    expect(seenWhere).toMatchObject({
      workspaceId: "ws1",
      deletedAt: null,
      id: { in: ["p1"] },
    });
  });

  it("returns only the visible pages for a whitespace-only query", async () => {
    const results = await searchPages("ws1", "   ", new Set(["p1"]), { take: 10 });

    expect(results.map((row) => row.id)).toEqual(["p1"]);
    expect(seenWhere?.id).toEqual({ in: ["p1"] });
  });

  it("still returns the whole workspace for a blank query when nothing is scoped", async () => {
    const results = await searchPages("ws1", "", null, { take: 10 });

    expect(results.map((row) => row.id)).toEqual(["p1", "p2", "p3"]);
    // No scope, no `id` predicate — the unscoped behaviour is unchanged.
    expect(seenWhere?.id).toBeUndefined();
  });
});
