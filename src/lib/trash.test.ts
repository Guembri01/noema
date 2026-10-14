import { describe, expect, test } from "vitest";
import {
  collectFileUrls,
  DEFAULT_TRASH_RETENTION_DAYS,
  defaultTrashRetentionPolicy,
  fileKeyFromUrl,
  isExpired,
  purgeableError,
  selectPurgeable,
  staleFileUrls,
  subtreeClosure,
} from "@/lib/trash";

/**
 * B42 — purge guards for the trash restore/permanent-delete feature.
 *
 * These are the pure rules behind `deletePageAction` / `emptyTrashAction`:
 * only trashed pages inside the given workspace may be purged, the purge walks
 * the subtree explicitly (children follow their parent), and uploads referenced
 * by the purged pages are dropped only when nothing that survives still points
 * at them.
 */

describe("purgeableError", () => {
  test("rejects a page that does not exist", () => {
    expect(purgeableError(null, "ws_1")).toBe("Page not found.");
  });

  test("rejects a page from another workspace (scoping)", () => {
    const page = { workspaceId: "ws_other", deletedAt: new Date() };
    expect(purgeableError(page, "ws_1")).toBe(
      "That page is not in this workspace's trash.",
    );
  });

  test("rejects a page that is not in the trash", () => {
    const page = { workspaceId: "ws_1", deletedAt: null };
    expect(purgeableError(page, "ws_1")).toBe(
      "Only pages in the trash can be deleted forever.",
    );
  });

  test("accepts a trashed page in the expected workspace", () => {
    const page = { workspaceId: "ws_1", deletedAt: new Date("2026-01-01") };
    expect(purgeableError(page, "ws_1")).toBeNull();
  });
});

describe("subtreeClosure", () => {
  const nodes = [
    { id: "root", parentId: null },
    { id: "child", parentId: "root" },
    { id: "grandchild", parentId: "child" },
    { id: "sibling", parentId: null },
    { id: "sibling-child", parentId: "sibling" },
  ];

  test("collects every descendant of the seed, nothing else", () => {
    expect(subtreeClosure(nodes, ["root"])).toEqual(["root", "child", "grandchild"]);
  });

  test("keeps seeds that have no entry in the node list", () => {
    expect(subtreeClosure(nodes, ["orphan-seed"])).toEqual(["orphan-seed"]);
  });

  test("survives a parent cycle without duplicating or hanging", () => {
    const cyclic = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];
    const result = subtreeClosure(cyclic, ["a"]);
    expect(result).toHaveLength(2);
    expect(new Set(result)).toEqual(new Set(["a", "b"]));
  });

  test("deduplicates overlapping seeds", () => {
    expect(subtreeClosure(nodes, ["root", "child"])).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
  });
});

describe("collectFileUrls", () => {
  test("finds upload urls nested anywhere in page JSON", () => {
    const content = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "/api/files/ws_1/abc.png" } },
        {
          type: "paragraph",
          content: [{ type: "text", text: "see /api/files/ws_1/def.pdf) too" }],
        },
      ],
    };
    expect(collectFileUrls(content).sort()).toEqual([
      "/api/files/ws_1/abc.png",
      "/api/files/ws_1/def.pdf",
    ]);
  });

  test("deduplicates repeated urls and ignores foreign urls", () => {
    const value = [
      { coverUrl: "/api/files/ws_1/abc.png" },
      { src: "/api/files/ws_1/abc.png" },
      { src: "https://example.com/pic.png" },
      { src: "data:image/png;base64,AAAA" },
      null,
    ];
    expect(collectFileUrls(value)).toEqual(["/api/files/ws_1/abc.png"]);
  });
});

describe("fileKeyFromUrl", () => {
  test("maps a file route onto its storage key", () => {
    expect(fileKeyFromUrl("/api/files/ws_1/abc.png")).toBe("ws_1/abc.png");
  });

  test("rejects traversal, partial and foreign urls", () => {
    expect(fileKeyFromUrl("/api/files/ws_1/../evil.png")).toBeNull();
    expect(fileKeyFromUrl("/api/files/ws_1")).toBeNull();
    expect(fileKeyFromUrl("https://example.com/pic.png")).toBeNull();
  });
});

describe("staleFileUrls", () => {
  test("drops urls only the purged pages still referenced", () => {
    const purged = [{ src: "/api/files/ws_1/dead.png" }, { src: "/api/files/ws_1/shared.png" }];
    const kept = [{ src: "/api/files/ws_1/shared.png" }];
    expect(staleFileUrls(purged, kept)).toEqual(["/api/files/ws_1/dead.png"]);
  });

  test("keeps nothing when no upload is referenced at all", () => {
    expect(staleFileUrls([{ text: "hello" }], [])).toEqual([]);
  });
});

/**
 * Trash retention policy (MISSING_FEATURES §9 "Trash retention policy" /
 * §17 "Trash retention"; spec R30.15) — how long a trashed page stays
 * recoverable before an auto-purge ("empty trash") may take it.
 *
 * Everything here is pure and time-injected: `now` is an argument, never
 * `Date.now()`, so boundaries are testable to the millisecond.
 */
describe("trash retention policy", () => {
  const NOW = new Date("2026-03-31T12:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

  describe("defaults", () => {
    test("retains trash for 30 days unless a workspace overrides it", () => {
      expect(DEFAULT_TRASH_RETENTION_DAYS).toBe(30);
      expect(defaultTrashRetentionPolicy).toEqual({ retentionDays: 30 });
    });
  });

  describe("isExpired", () => {
    test("far-past deletions are expired", () => {
      expect(isExpired(daysAgo(3650), 30, NOW)).toBe(true);
      expect(isExpired(daysAgo(31), 30, NOW)).toBe(true);
    });

    test("far-future deletions are not expired", () => {
      // Clock skew: a deletedAt after `now` can never have outlived anything.
      expect(isExpired(new Date(NOW.getTime() + 3650 * DAY_MS), 30, NOW)).toBe(false);
      expect(isExpired(new Date(NOW.getTime() + DAY_MS), 30, NOW)).toBe(false);
    });

    test("deletions inside the window are not expired", () => {
      expect(isExpired(NOW, 30, NOW)).toBe(false);
      expect(isExpired(daysAgo(1), 30, NOW)).toBe(false);
      expect(isExpired(daysAgo(29.999), 30, NOW)).toBe(false);
    });

    test("exactly at the retention boundary the item is still kept", () => {
      // Spec R30.15 purges only `deletedAt < now - window` (strict), so an
      // item deleted exactly `retentionDays` ago is recoverable for one more
      // tick rather than destroyed on a tie.
      expect(isExpired(daysAgo(30), 30, NOW)).toBe(false);
      expect(isExpired(daysAgo(7), 7, NOW)).toBe(false);
    });

    test("one millisecond past the boundary is expired", () => {
      expect(isExpired(new Date(NOW.getTime() - 30 * DAY_MS - 1), 30, NOW)).toBe(true);
      expect(isExpired(new Date(NOW.getTime() - 7 * DAY_MS - 1), 7, NOW)).toBe(true);
    });

    test("a non-positive window disables expiry entirely", () => {
      // Mirrors the repo convention for retention knobs (0 ⇒ no pruning):
      // a misconfigured workspace must keep trash, never purge everything.
      expect(isExpired(daysAgo(1), 0, NOW)).toBe(false);
      expect(isExpired(daysAgo(3650), -1, NOW)).toBe(false);
    });
  });

  describe("selectPurgeable", () => {
    const items = [
      { id: "ancient", deletedAt: daysAgo(400) },
      { id: "expired", deletedAt: daysAgo(31) },
      { id: "boundary", deletedAt: daysAgo(30) },
      { id: "fresh", deletedAt: daysAgo(1) },
      { id: "live", deletedAt: null },
    ];

    test("returns only items older than the default 30-day window", () => {
      expect(selectPurgeable(items, defaultTrashRetentionPolicy, NOW)).toEqual([
        items[0],
        items[1],
      ]);
    });

    test("keeps the boundary item: nothing exactly at the window is purged", () => {
      const ids = selectPurgeable(items, defaultTrashRetentionPolicy, NOW).map((i) => i.id);
      expect(ids).not.toContain("boundary");
      expect(ids).not.toContain("fresh");
      expect(ids).not.toContain("live");
    });

    test("honours a per-workspace custom window", () => {
      const ids = selectPurgeable(items, { retentionDays: 7 }, NOW).map((i) => i.id);
      // 7 days reaches the 30-day boundary item; the 1-day-old one survives.
      expect(ids).toEqual(["ancient", "expired", "boundary"]);

      expect(selectPurgeable(items, { retentionDays: 36500 }, NOW)).toEqual([]);
    });

    test("never selects pages that are not in the trash", () => {
      const selected = selectPurgeable(
        [{ deletedAt: null }],
        { retentionDays: 0 },
        NOW,
      );
      expect(selected).toEqual([]);
    });

    test("returns the original item references and an empty list when trash is empty", () => {
      const selected = selectPurgeable(items, defaultTrashRetentionPolicy, NOW);
      expect(selected[0]).toBe(items[0]);
      expect(selected[1]).toBe(items[1]);
      expect(selectPurgeable([], defaultTrashRetentionPolicy, NOW)).toEqual([]);
    });
  });
});
