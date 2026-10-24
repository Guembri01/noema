import { describe, expect, it } from "vitest";
import {
  buildInbox,
  groupByPage,
  isInDigest,
  markAllRead,
  markRead,
  notificationHref,
  sortRecency,
  unreadCount,
} from "./notification-inbox";
import type { InboxNotification } from "./notification-inbox";
import { DEFAULT_NOTIFICATION_PREFS } from "./notification-prefs";
import type { DigestCadence, NotificationPrefs } from "./notification-prefs";

/**
 * docs/MISSING_FEATURES.md §7 "Notification inbox" (inbox-list half; the
 * delivery half lives in `notification-prefs.test.ts`).
 *
 * Red-first: `src/lib/notification-inbox.ts` does not exist until this lands -
 * the first run fails to resolve the import, then the suite goes green with the
 * implementation. Pure list/grouping logic only: no DB, no routes, no React,
 * and no ambient clock - `buildInbox` is handed a fixed `now`, so every bucket
 * boundary is deterministic. Timestamps are ISO strings, never `new Date()`.
 */

/** A fixed instant for bucket math: 2026-03-10T12:00:00Z (a Tuesday). */
const NOW = "2026-03-10T12:00:00.000Z";

/** Build a notification with sane defaults, overriding only what a test needs. */
function make(
  over: Partial<InboxNotification> & { id: string },
): InboxNotification {
  return {
    type: "page.mention",
    createdAt: "2026-03-10T09:00:00.000Z",
    read: false,
    ...over,
  };
}

/** Prefs helper mirroring the one in the prefs suite. */
function prefsWith(
  digest: DigestCadence,
  events: Partial<NotificationPrefs["events"]> = {},
): NotificationPrefs {
  return {
    events: { ...DEFAULT_NOTIFICATION_PREFS.events, ...events },
    digest,
  };
}

// Fixed sample set spanning every bucket, with a same-page pair (a, b) and an
// un-paged notification (d).
const a = make({ id: "a", createdAt: "2026-03-10T11:00:00.000Z", pageId: "p1" });
const b = make({
  id: "b",
  type: "comment.reply",
  createdAt: "2026-03-10T08:00:00.000Z",
  read: true,
  pageId: "p1",
});
const c = make({
  id: "c",
  type: "page.shared",
  createdAt: "2026-03-09T23:30:00.000Z",
  pageId: "p2",
});
const d = make({
  id: "d",
  type: "page.updated",
  createdAt: "2026-02-01T00:00:00.000Z",
  read: true,
});

describe("sortRecency", () => {
  it("orders newest first", () => {
    const sorted = sortRecency([d, c, a, b]);
    expect(sorted.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("breaks createdAt ties by id descending, deterministically", () => {
    const t1 = make({ id: "alpha", createdAt: "2026-03-10T10:00:00.000Z" });
    const t2 = make({ id: "bravo", createdAt: "2026-03-10T10:00:00.000Z" });
    expect(sortRecency([t1, t2]).map((n) => n.id)).toEqual(["bravo", "alpha"]);
    // Reversing the input must not change the output.
    expect(sortRecency([t2, t1]).map((n) => n.id)).toEqual(["bravo", "alpha"]);
  });

  it("does not mutate the input array", () => {
    const input = [d, c, a, b];
    const before = input.slice();
    sortRecency(input);
    expect(input).toEqual(before);
    expect(input[0]).toBe(d);
  });

  it("returns an empty array for empty input", () => {
    expect(sortRecency([])).toEqual([]);
  });
});

describe("unreadCount", () => {
  it("counts only unread notifications", () => {
    expect(unreadCount([a, b, c, d])).toBe(2);
    expect(unreadCount([b, d])).toBe(0);
    expect(unreadCount([])).toBe(0);
  });
});

describe("buildInbox", () => {
  it("buckets by calendar day relative to the fixed now", () => {
    const groups = buildInbox([d, c, a, b], DEFAULT_NOTIFICATION_PREFS, NOW);
    expect(groups.map((g) => g.bucket)).toEqual(["today", "yesterday", "earlier"]);
  });

  it("places each notification in the right bucket", () => {
    const groups = buildInbox([d, c, a, b], DEFAULT_NOTIFICATION_PREFS, NOW);
    expect(groups[0]?.items.map((n) => n.id)).toEqual(["a", "b"]);
    expect(groups[1]?.items.map((n) => n.id)).toEqual(["c"]);
    expect(groups[2]?.items.map((n) => n.id)).toEqual(["d"]);
  });

  it("sorts items within a bucket recency-first", () => {
    const groups = buildInbox([b, a], DEFAULT_NOTIFICATION_PREFS, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("reports unread counts per bucket and omits empty buckets", () => {
    const groups = buildInbox([a, b, c], DEFAULT_NOTIFICATION_PREFS, NOW);
    expect(groups.map((g) => g.bucket)).toEqual(["today", "yesterday"]);
    expect(groups[0]?.unread).toBe(1);
    expect(groups[1]?.unread).toBe(1);
  });

  it("treats midnight-to-now as a single day at the boundary", () => {
    const justBefore = make({ id: "x", createdAt: "2026-03-09T23:59:59.999Z" });
    const justAfter = make({ id: "y", createdAt: "2026-03-10T00:00:00.000Z" });
    const groups = buildInbox([justBefore, justAfter], DEFAULT_NOTIFICATION_PREFS, NOW);
    expect(groups[0]?.items.map((n) => n.id)).toEqual(["y"]);
    expect(groups[1]?.items.map((n) => n.id)).toEqual(["x"]);
  });

  it("hides notifications suppressed by the level filter", () => {
    const prefs = prefsWith("INSTANT", { "page.mention": "NONE" });
    const groups = buildInbox([a, b, c], prefs, NOW);
    expect(groups[0]?.items.map((n) => n.id)).toEqual(["b"]);
    // The suppressed mention `a` (unread) is gone; only unread `c` remains.
    expect(unreadCount(groups.flatMap((g) => g.items))).toBe(1);
    expect(groups.flatMap((g) => g.items).map((n) => n.id)).not.toContain("a");
  });

  it("returns nothing when delivery is switched off", () => {
    expect(buildInbox([a, b, c], prefsWith("OFF"), NOW)).toEqual([]);
  });

  it("returns nothing for an empty input", () => {
    expect(buildInbox([], DEFAULT_NOTIFICATION_PREFS, NOW)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [a, b, c, d];
    const before = input.slice();
    buildInbox(input, DEFAULT_NOTIFICATION_PREFS, NOW);
    expect(input).toEqual(before);
  });
});

describe("markRead", () => {
  it("marks only the listed ids read, immutably", () => {
    const input = [a, b, c];
    const out = markRead(input, ["a"]);
    expect(out.find((n) => n.id === "a")?.read).toBe(true);
    expect(out.find((n) => n.id === "b")?.read).toBe(true); // already read
    expect(out.find((n) => n.id === "c")?.read).toBe(false);
    // The original array and objects are untouched.
    expect(input[0]).toBe(a);
    expect(input[0]?.read).toBe(false);
    expect(out).not.toBe(input);
  });

  it("creates a fresh object only for matched notifications", () => {
    const out = markRead([a, c], ["a"]);
    expect(out[0]).not.toBe(a);
    expect(out[1]).toBe(c);
  });

  it("ignores unknown ids and empty id lists", () => {
    expect(markRead([a, b], ["missing"]).map((n) => n.read)).toEqual([
      false,
      true,
    ]);
    expect(markRead([a, b], [])).toEqual([a, b]);
  });
});

describe("markAllRead", () => {
  it("scopes to a single page", () => {
    const out = markAllRead([a, b, c, d], { pageId: "p1" });
    expect(out.map((n) => n.read)).toEqual([true, true, false, true]);
    expect(out[2]).toBe(c); // unaffected entries keep identity
  });

  it("scopes to a single type", () => {
    const out = markAllRead([a, b, c, d], { type: "page.shared" });
    expect(out.map((n) => n.read)).toEqual([false, true, true, true]);
  });

  it("marks everything with an empty scope", () => {
    const out = markAllRead([a, b, c, d], {});
    expect(out.every((n) => n.read)).toBe(true);
  });

  it("does not mutate its input", () => {
    const input = [a, b, c, d];
    markAllRead(input, { pageId: "p1" });
    expect(input).toEqual([a, b, c, d]);
    expect(input[0]?.read).toBe(false);
  });
});

describe("groupByPage", () => {
  it("collapses multiple events on the same page into one entry with a count", () => {
    const groups = groupByPage([a, b, c]);
    const p1 = groups.find((g) => g.pageId === "p1");
    expect(p1?.count).toBe(2);
    expect(p1?.items.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("keeps the newest event as the representative", () => {
    const p1 = groupByPage([a, b]).find((g) => g.pageId === "p1");
    expect(p1?.latest.id).toBe("a");
  });

  it("tracks unread per page group", () => {
    const p1 = groupByPage([a, b, c]).find((g) => g.pageId === "p1");
    expect(p1?.unread).toBe(1);
  });

  it("gives un-paged notifications their own count-one entry", () => {
    const groups = groupByPage([a, d]);
    const loose = groups.find((g) => g.pageId === null);
    expect(loose?.count).toBe(1);
    expect(loose?.items[0]?.id).toBe("d");
  });

  it("orders groups recency-first by their latest event", () => {
    expect(groupByPage([d, c, a, b]).map((g) => g.pageId)).toEqual([
      "p1",
      "p2",
      null,
    ]);
  });

  it("returns nothing for an empty input", () => {
    expect(groupByPage([])).toEqual([]);
  });
});

describe("isInDigest", () => {
  it("is false when alerts are instant", () => {
    expect(isInDigest(a, DEFAULT_NOTIFICATION_PREFS)).toBe(false);
  });

  it("is true once delivery is deferred to a digest", () => {
    expect(isInDigest(a, prefsWith("DAILY"))).toBe(true);
    expect(isInDigest(a, prefsWith("WEEKLY"))).toBe(true);
  });

  it("is false for level-suppressed types and when off", () => {
    expect(isInDigest(a, prefsWith("DAILY", { "page.mention": "NONE" }))).toBe(
      false,
    );
    expect(isInDigest(a, prefsWith("OFF"))).toBe(false);
  });

  it("honours an explicit non-mention on a mentions-only type", () => {
    const edit = make({ id: "e", type: "page.updated", mentions: false });
    expect(isInDigest(edit, prefsWith("DAILY"))).toBe(false);
    expect(isInDigest(edit, prefsWith("DAILY", { "page.updated": "ALL" }))).toBe(
      true,
    );
  });
});

describe("notificationHref", () => {
  it("opens a comment thread with its block anchor", () => {
    expect(
      notificationHref(
        { pageId: "p1", commentId: "c1", blockId: "b1" },
        "acme",
      ),
    ).toBe("/w/acme/p1?comment=c1#b1");
  });

  it("encodes ids and keeps a comment without an anchor clean", () => {
    expect(
      notificationHref({ pageId: "p 1", commentId: "c/1" }, "acme team"),
    ).toBe("/w/acme%20team/p%201?comment=c%2F1");
  });

  it("keeps the ticket drawer contract", () => {
    expect(notificationHref({ ticketId: "t1" }, "acme")).toBe(
      "/w/acme/tickets?ticket=t1",
    );
  });

  it("returns null without a page, ticket or slug", () => {
    expect(notificationHref({}, "acme")).toBeNull();
    expect(notificationHref({ pageId: "p1" }, "  ")).toBeNull();
  });
});
