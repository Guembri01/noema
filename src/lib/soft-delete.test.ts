import { describe, expect, test } from "vitest";
import {
  daysUntilPurge,
  describeTrashAge,
  isDeleted,
  isPurgeable,
  listTrash,
  purgeCandidates,
  restoreConflicts,
  restorePatch,
  softDeletePatch,
  TRASH_RETENTION_DAYS,
} from "@/lib/soft-delete";

/**
 * Soft-delete / trash lifecycle engine (FEATURE_MATRIX §17 "Soft delete",
 * §9 trash rows, §10 "Trash retention" / spec R30.15).
 *
 * Red-first: `src/lib/soft-delete.ts` did not exist when this file was written,
 * so the suite fails on the missing module until the engine lands. Everything
 * is pure and time-injected (`now` is always an argument), so the retention
 * boundary, purge ordering and restore collisions are pinned to the
 * millisecond without mocking `Date.now`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-04-15T12:00:00.000Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
const policy = (retentionDays: number = TRASH_RETENTION_DAYS) => ({
  retentionDays,
  now: NOW,
});

describe("TRASH_RETENTION_DAYS", () => {
  test("defaults to a 30-day recovery window", () => {
    expect(TRASH_RETENTION_DAYS).toBe(30);
  });
});

describe("softDeletePatch", () => {
  test("stamps the delete time and the acting user", () => {
    const patch = softDeletePatch({ userId: "user_1", now: NOW });
    expect(patch).toEqual({ deletedAt: NOW, deletedById: "user_1" });
  });

  test("copies the clock so later mutation cannot rewrite the stamp", () => {
    const now = new Date(NOW.getTime());
    const patch = softDeletePatch({ userId: "user_1", now });
    now.setFullYear(1999);
    expect(patch.deletedAt.getTime()).toBe(NOW.getTime());
  });
});

describe("restorePatch", () => {
  test("clears both trash fields", () => {
    expect(restorePatch()).toEqual({ deletedAt: null, deletedById: null });
  });

  test("returns a fresh object each call", () => {
    expect(restorePatch()).not.toBe(restorePatch());
  });
});

describe("isDeleted", () => {
  test("is true only when a delete stamp is present", () => {
    expect(isDeleted({ deletedAt: NOW })).toBe(true);
    expect(isDeleted({ deletedAt: null })).toBe(false);
  });

  test("tolerates a record whose stamp is missing entirely", () => {
    expect(isDeleted({ deletedAt: undefined })).toBe(false);
  });
});

describe("daysUntilPurge", () => {
  test("a just-deleted item has the whole window left", () => {
    expect(daysUntilPurge({ deletedAt: NOW }, policy())).toBe(30);
  });

  test("counts down whole days, rounding the remainder up", () => {
    expect(daysUntilPurge({ deletedAt: daysAgo(1) }, policy())).toBe(29);
    expect(daysUntilPurge({ deletedAt: daysAgo(29.5) }, policy())).toBe(1);
  });

  test("is exactly zero at the retention boundary", () => {
    expect(daysUntilPurge({ deletedAt: daysAgo(30) }, policy())).toBe(0);
  });

  test("goes negative once the item is overdue", () => {
    expect(daysUntilPurge({ deletedAt: daysAgo(31) }, policy())).toBe(-1);
    expect(daysUntilPurge({ deletedAt: daysAgo(40) }, policy())).toBe(-10);
  });

  test("never reports a purge for a live (non-trashed) record", () => {
    expect(daysUntilPurge({ deletedAt: null }, policy())).toBeNull();
  });

  test("a non-positive window disables purging entirely", () => {
    expect(daysUntilPurge({ deletedAt: daysAgo(3650) }, policy(0))).toBeNull();
    expect(daysUntilPurge({ deletedAt: daysAgo(3650) }, policy(-1))).toBeNull();
  });

  test("honours a custom window", () => {
    expect(daysUntilPurge({ deletedAt: daysAgo(2) }, policy(7))).toBe(5);
  });
});

describe("isPurgeable", () => {
  test("an item older than the window is purgeable", () => {
    expect(isPurgeable({ deletedAt: daysAgo(31) }, policy())).toBe(true);
    expect(isPurgeable({ deletedAt: daysAgo(3650) }, policy())).toBe(true);
  });

  test("exactly at the boundary nothing is destroyed yet", () => {
    expect(isPurgeable({ deletedAt: daysAgo(30) }, policy())).toBe(false);
  });

  test("one millisecond past the boundary becomes purgeable", () => {
    const justPast = new Date(NOW.getTime() - 30 * DAY_MS - 1);
    expect(isPurgeable({ deletedAt: justPast }, policy())).toBe(true);
  });

  test("items inside the window and live records are kept", () => {
    expect(isPurgeable({ deletedAt: daysAgo(1) }, policy())).toBe(false);
    expect(isPurgeable({ deletedAt: null }, policy())).toBe(false);
  });

  test("a future timestamp is never purgeable (clock skew safe)", () => {
    expect(isPurgeable({ deletedAt: new Date(NOW.getTime() + DAY_MS) }, policy())).toBe(false);
  });

  test("a non-positive window keeps even ancient trash", () => {
    expect(isPurgeable({ deletedAt: daysAgo(3650) }, policy(0))).toBe(false);
    expect(isPurgeable({ deletedAt: daysAgo(3650) }, policy(-30))).toBe(false);
  });
});

describe("purgeCandidates", () => {
  const records = [
    { id: "fresh", deletedAt: daysAgo(1) },
    { id: "expired", deletedAt: daysAgo(31) },
    { id: "live", deletedAt: null },
    { id: "ancient", deletedAt: daysAgo(400) },
    { id: "boundary", deletedAt: daysAgo(30) },
  ];

  test("selects only the records past the window", () => {
    const ids = purgeCandidates(records, policy()).map((r) => r.id);
    expect(ids).toEqual(["ancient", "expired"]);
  });

  test("orders candidates oldest-first", () => {
    const ids = purgeCandidates(records, policy()).map((r) => r.id);
    expect(ids[0]).toBe("ancient");
    expect(ids[1]).toBe("expired");
  });

  test("an item exactly at the boundary is not a candidate", () => {
    expect(purgeCandidates(records, policy()).map((r) => r.id)).not.toContain("boundary");
  });

  test("returns the caller's own references", () => {
    const candidates = purgeCandidates(records, policy());
    expect(candidates[0]).toBe(records[3]);
  });

  test("is empty when nothing has outlived the window", () => {
    expect(purgeCandidates([{ id: "a", deletedAt: daysAgo(2) }], policy())).toEqual([]);
    expect(purgeCandidates([], policy())).toEqual([]);
  });

  test("a custom window widens the candidate set", () => {
    const ids = purgeCandidates(records, policy(7)).map((r) => r.id);
    expect(ids).toEqual(["ancient", "expired", "boundary"]);
  });

  test("does not mutate the input order", () => {
    const snapshot = records.map((r) => r.id);
    purgeCandidates(records, policy());
    expect(records.map((r) => r.id)).toEqual(snapshot);
  });
});

describe("restoreConflicts", () => {
  test("reports no conflicts when the destination is free", () => {
    const page = { id: "trashed", name: "Roadmap", path: "team/roadmap", parentId: "p1" };
    const existing = [{ id: "other", name: "Notes", path: "team/notes", parentId: "p1" }];
    expect(restoreConflicts(page, existing)).toEqual([]);
  });

  test("flags a same-name sibling", () => {
    const page = { id: "trashed", name: "Roadmap", parentId: "p1" };
    const existing = [{ id: "live", name: "Roadmap", parentId: "p1" }];
    expect(restoreConflicts(page, existing)).toEqual([
      { kind: "title", existingId: "live", value: "Roadmap" },
    ]);
  });

  test("allows the same name under a different parent", () => {
    const page = { id: "trashed", name: "Roadmap", parentId: "p1" };
    const existing = [{ id: "live", name: "Roadmap", parentId: "p2" }];
    expect(restoreConflicts(page, existing)).toEqual([]);
  });

  test("compares names case-insensitively and trimmed", () => {
    const page = { id: "trashed", name: "  ROAD map ", parentId: "p1" };
    const existing = [{ id: "live", name: "road map", parentId: "p1" }];
    expect(restoreConflicts(page, existing)).toHaveLength(1);
  });

  test("falls back to `title` when `name` is absent", () => {
    const page = { id: "trashed", title: "Roadmap", parentId: null };
    const existing = [{ id: "live", title: "roadmap", parentId: null }];
    expect(restoreConflicts(page, existing)).toEqual([
      { kind: "title", existingId: "live", value: "roadmap" },
    ]);
  });

  test("flags a path collision even under another parent", () => {
    const page = { id: "trashed", name: "Plan", path: "team/plan", parentId: "p1" };
    const existing = [{ id: "live", name: "Plan", path: "team/plan", parentId: "p2" }];
    expect(restoreConflicts(page, existing)).toEqual([
      { kind: "path", existingId: "live", value: "team/plan" },
    ]);
  });

  test("reports both a name and a path conflict for the same record", () => {
    const page = { id: "trashed", name: "Plan", path: "team/plan", parentId: "p1" };
    const existing = [{ id: "live", name: "Plan", path: "team/plan", parentId: "p1" }];
    expect(restoreConflicts(page, existing)).toEqual([
      { kind: "title", existingId: "live", value: "Plan" },
      { kind: "path", existingId: "live", value: "team/plan" },
    ]);
  });

  test("never conflicts with itself", () => {
    const page = { id: "trashed", name: "Plan", path: "team/plan", parentId: "p1" };
    expect(restoreConflicts(page, [page])).toEqual([]);
  });

  test("ignores records that are themselves in the trash", () => {
    const page = { id: "trashed", name: "Plan", parentId: "p1" };
    const existing = [{ id: "live", name: "Plan", parentId: "p1", deletedAt: daysAgo(3) }];
    expect(restoreConflicts(page, existing)).toEqual([]);
  });

  test("an empty name or path never collides", () => {
    const page = { id: "trashed", name: "   ", path: "", parentId: "p1" };
    const existing = [{ id: "live", name: "   ", path: "", parentId: "p1" }];
    expect(restoreConflicts(page, existing)).toEqual([]);
  });
});

describe("listTrash", () => {
  const records = [
    { id: "old", name: "Bravo", deletedAt: daysAgo(10) },
    { id: "new", name: "Alpha", deletedAt: daysAgo(1) },
    { id: "live", name: "Zulu", deletedAt: null as Date | null },
    { id: "mid", name: "Charlie", deletedAt: daysAgo(5) },
  ];

  test("lists only trashed records, newest-deleted first by default", () => {
    expect(listTrash(records).map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  test("sorts oldest-deleted first on request", () => {
    expect(listTrash(records, { sort: "deleted-asc" }).map((r) => r.id)).toEqual([
      "old",
      "mid",
      "new",
    ]);
  });

  test("sorts by name ascending and descending", () => {
    expect(listTrash(records, { sort: "name-asc" }).map((r) => r.id)).toEqual([
      "new",
      "old",
      "mid",
    ]);
    expect(listTrash(records, { sort: "name-desc" }).map((r) => r.id)).toEqual([
      "mid",
      "old",
      "new",
    ]);
  });

  test("returns an empty list when nothing is trashed", () => {
    expect(listTrash([{ id: "live", name: "A", deletedAt: null }])).toEqual([]);
    expect(listTrash([])).toEqual([]);
  });

  test("returns a fresh array and never mutates the input", () => {
    const snapshot = records.map((r) => r.id);
    const out = listTrash(records, { sort: "deleted-asc" });
    expect(out).not.toBe(records);
    expect(records.map((r) => r.id)).toEqual(snapshot);
  });
});

describe("describeTrashAge", () => {
  test("a fresh deletion reads as just now", () => {
    expect(describeTrashAge({ deletedAt: NOW }, NOW)).toBe("just now");
    expect(describeTrashAge({ deletedAt: new Date(NOW.getTime() - 30_000) }, NOW)).toBe(
      "just now",
    );
  });

  test("singular and plural minutes", () => {
    expect(describeTrashAge({ deletedAt: new Date(NOW.getTime() - 60_000) }, NOW)).toBe(
      "1 minute ago",
    );
    expect(describeTrashAge({ deletedAt: new Date(NOW.getTime() - 5 * 60_000) }, NOW)).toBe(
      "5 minutes ago",
    );
  });

  test("hours once past the hour mark", () => {
    expect(describeTrashAge({ deletedAt: new Date(NOW.getTime() - 60 * 60_000) }, NOW)).toBe(
      "1 hour ago",
    );
    expect(describeTrashAge({ deletedAt: new Date(NOW.getTime() - 3 * 60 * 60_000) }, NOW)).toBe(
      "3 hours ago",
    );
  });

  test("days once past the day mark", () => {
    expect(describeTrashAge({ deletedAt: daysAgo(1) }, NOW)).toBe("1 day ago");
    expect(describeTrashAge({ deletedAt: daysAgo(5) }, NOW)).toBe("5 days ago");
    expect(describeTrashAge({ deletedAt: daysAgo(29) }, NOW)).toBe("29 days ago");
  });

  test("months and years for long-abandoned trash", () => {
    expect(describeTrashAge({ deletedAt: daysAgo(30) }, NOW)).toBe("1 month ago");
    expect(describeTrashAge({ deletedAt: daysAgo(60) }, NOW)).toBe("2 months ago");
    expect(describeTrashAge({ deletedAt: daysAgo(365) }, NOW)).toBe("1 year ago");
  });

  test("a future stamp cannot produce a negative age", () => {
    expect(describeTrashAge({ deletedAt: new Date(NOW.getTime() + 60 * 60_000) }, NOW)).toBe(
      "just now",
    );
  });

  test("a live record has no trash age", () => {
    expect(describeTrashAge({ deletedAt: null }, NOW)).toBeNull();
  });
});
