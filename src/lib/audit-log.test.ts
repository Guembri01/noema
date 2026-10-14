import { describe, expect, it } from "vitest";
import {
  SYSTEM_ACTOR_ID,
  describeAuditEvent,
  filterAuditEvents,
  groupAuditByDay,
  normalizeAuditEvent,
  paginateAudit,
  sortAuditEvents,
} from "./audit-log";
import type { AuditEvent } from "./audit-log";

/**
 * docs/MISSING_FEATURES.md top-gap #10 "Audit log UI" - the pure query half of a
 * workspace-wide, filterable audit feed (docs/FEATURE_MATRIX.md "Audit log").
 *
 * No prisma, no routes, no React and no ambient clock: `groupAuditByDay` is
 * handed a fixed `now`, so every day-bucket label is deterministic and every
 * timestamp is an ISO string.
 *
 * Red-first: `src/lib/audit-log.ts` does not exist until this lands - the first
 * run fails to resolve the import, then the suite goes green with the
 * implementation.
 */

/** Fixed instant: 2026-03-10T12:00:00Z (a Tuesday). */
const NOW = "2026-03-10T12:00:00.000Z";

const TODAY = "2026-03-10T11:00:00.000Z";
const TODAY_EARLY = "2026-03-10T08:00:00.000Z";
const YESTERDAY = "2026-03-09T23:00:00.000Z";
const OLDER = "2026-03-08T09:00:00.000Z";

/** Build an event with sane defaults, overriding only what a test needs. */
function make(over: Partial<AuditEvent> & { id: string }): AuditEvent {
  return {
    actorId: "u1",
    type: "page.created",
    entityId: "p1",
    entityType: "page",
    createdAt: TODAY,
    ...over,
  };
}

describe("normalizeAuditEvent", () => {
  it("rejects anything that is not a plain object", () => {
    expect(normalizeAuditEvent(null)).toBeNull();
    expect(normalizeAuditEvent(undefined)).toBeNull();
    expect(normalizeAuditEvent("page.created")).toBeNull();
    expect(normalizeAuditEvent(42)).toBeNull();
    expect(normalizeAuditEvent([{ id: "x" }])).toBeNull();
  });

  it("requires id, type, entityId, entityType and a parseable createdAt", () => {
    expect(
      normalizeAuditEvent({ type: "t", entityId: "e", entityType: "page", createdAt: TODAY }),
    ).toBeNull();
    expect(
      normalizeAuditEvent({ id: "e", entityId: "e", entityType: "page", createdAt: TODAY }),
    ).toBeNull();
    expect(
      normalizeAuditEvent({ id: "e", type: "t", entityType: "page", createdAt: TODAY }),
    ).toBeNull();
    expect(
      normalizeAuditEvent({ id: "e", type: "t", entityId: "x", createdAt: TODAY }),
    ).toBeNull();
    expect(
      normalizeAuditEvent({
        id: "e",
        type: "t",
        entityId: "x",
        entityType: "page",
        createdAt: "not-a-date",
      }),
    ).toBeNull();
  });

  it("keeps a full valid row and copies every field", () => {
    const event = normalizeAuditEvent({
      id: "e1",
      actorId: "ada",
      type: "page.archived",
      entityId: "p9",
      entityType: "page",
      createdAt: OLDER,
      meta: { title: "Old notes" },
    });
    expect(event).toEqual({
      id: "e1",
      actorId: "ada",
      type: "page.archived",
      entityId: "p9",
      entityType: "page",
      createdAt: OLDER,
      meta: { title: "Old notes" },
    });
  });

  it("records a missing actor as the system actor", () => {
    const event = normalizeAuditEvent({
      id: "e2",
      type: "workspace.updated",
      entityId: "w1",
      entityType: "workspace",
      createdAt: TODAY,
    });
    expect(event?.actorId).toBe(SYSTEM_ACTOR_ID);
  });

  it("drops a non-object meta but keeps the event", () => {
    const event = normalizeAuditEvent({
      id: "e3",
      type: "page.created",
      entityId: "p1",
      entityType: "page",
      createdAt: TODAY,
      meta: "nope",
    });
    expect(event).not.toBeNull();
    expect(event?.meta).toBeUndefined();
  });

  it("accepts a Date createdAt and normalises it to ISO", () => {
    const event = normalizeAuditEvent({
      id: "e4",
      type: "page.created",
      entityId: "p1",
      entityType: "page",
      createdAt: new Date(TODAY),
    });
    expect(event?.createdAt).toBe(TODAY);
  });
});

describe("filterAuditEvents", () => {
  const ada = make({ id: "a", actorId: "ada", type: "page.created" });
  const bob = make({ id: "b", actorId: "bob", type: "page.archived" });
  const adaLater = make({
    id: "c",
    actorId: "ada",
    type: "comment.created",
    createdAt: OLDER,
  });
  const all = [ada, bob, adaLater];

  it("returns a fresh copy of everything for an empty filter", () => {
    const out = filterAuditEvents(all, {});
    expect(out).toEqual(all);
    expect(out).not.toBe(all);
  });

  it("filters by actorIds and types", () => {
    expect(filterAuditEvents(all, { actorIds: ["ada"] }).map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterAuditEvents(all, { types: ["page.archived"] }).map((e) => e.id)).toEqual(["b"]);
    expect(
      filterAuditEvents(all, { actorIds: ["ada"], types: ["page.created"] }).map((e) => e.id),
    ).toEqual(["a"]);
  });

  it("treats an explicitly empty list filter as match-none", () => {
    expect(filterAuditEvents(all, { actorIds: [] })).toEqual([]);
  });

  it("filters by entityId", () => {
    const other = make({ id: "d", entityId: "p2" });
    expect(filterAuditEvents([ada, other], { entityId: "p2" }).map((e) => e.id)).toEqual(["d"]);
  });

  it("applies an inclusive from/to window", () => {
    expect(filterAuditEvents(all, { from: TODAY_EARLY, to: TODAY }).map((e) => e.id)).toEqual([
      "a",
      "b",
    ]);
    expect(filterAuditEvents(all, { from: OLDER, to: OLDER }).map((e) => e.id)).toEqual(["c"]);
  });
});

describe("sortAuditEvents", () => {
  it("orders newest first and breaks createdAt ties by id descending", () => {
    const older = make({ id: "a", createdAt: OLDER });
    const tieOne = make({ id: "b", createdAt: TODAY });
    const tieTwo = make({ id: "c", createdAt: TODAY });
    expect(sortAuditEvents([older, tieOne, tieTwo]).map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [make({ id: "a", createdAt: OLDER }), make({ id: "b", createdAt: TODAY })];
    const snapshot = [...input];
    sortAuditEvents(input);
    expect(input).toEqual(snapshot);
  });
});

describe("groupAuditByDay", () => {
  const events = [
    make({ id: "a", createdAt: TODAY }),
    make({ id: "b", createdAt: TODAY_EARLY }),
    make({ id: "c", createdAt: YESTERDAY }),
    make({ id: "d", createdAt: OLDER }),
  ];

  it("buckets by UTC day, newest day first, with Today/Yesterday labels", () => {
    const groups = groupAuditByDay(events, NOW);
    expect(groups.map((g) => g.day)).toEqual(["2026-03-10", "2026-03-09", "2026-03-08"]);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "2026-03-08"]);
    expect(groups.map((g) => g.count)).toEqual([2, 1, 1]);
    expect(groups[0]?.events.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for no events", () => {
    expect(groupAuditByDay([], NOW)).toEqual([]);
  });
});

describe("paginateAudit", () => {
  // Deliberately unsorted: pagination must order the feed itself.
  const events = [
    make({ id: "d", createdAt: OLDER }),
    make({ id: "a", createdAt: TODAY }),
    make({ id: "c", createdAt: YESTERDAY }),
    make({ id: "b", createdAt: TODAY_EARLY }),
  ];

  it("sorts internally and returns the newest page", () => {
    const page = paginateAudit(events, { limit: 2 });
    expect(page.items.map((e) => e.id)).toEqual(["a", "b"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("walks to the next page from the returned cursor without overlap", () => {
    const first = paginateAudit(events, { limit: 2 });
    const second = paginateAudit(events, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((e) => e.id)).toEqual(["c", "d"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("fails closed on a malformed cursor", () => {
    const page = paginateAudit(events, { limit: 2, cursor: "not-a-cursor" });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("clamps a non-positive limit up to one row", () => {
    expect(paginateAudit(events, { limit: 0 }).items.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("describeAuditEvent", () => {
  it("summarises a known verb with the actor, entity and id", () => {
    expect(
      describeAuditEvent(
        make({ id: "e", actorId: "ada", type: "page.created", entityId: "p1", entityType: "page" }),
      ),
    ).toBe("ada created page p1");
    expect(
      describeAuditEvent(
        make({
          id: "e",
          actorId: "ada",
          type: "page.archived",
          entityId: "p9",
          entityType: "page",
        }),
      ),
    ).toBe("ada archived page p9");
    expect(
      describeAuditEvent(
        make({
          id: "e",
          actorId: "ada",
          type: "comment.resolved",
          entityId: "c3",
          entityType: "comment",
        }),
      ),
    ).toBe("ada resolved comment c3");
  });

  it("expands the multi-word verbs in the activity vocabulary", () => {
    expect(
      describeAuditEvent(
        make({
          id: "e",
          actorId: "ada",
          type: "member.role_changed",
          entityId: "m2",
          entityType: "member",
        }),
      ),
    ).toBe("ada changed the role of member m2");
  });

  it("falls back to the raw verb segment for an unknown type", () => {
    expect(
      describeAuditEvent(
        make({
          id: "e",
          actorId: "ada",
          type: "widget.frobnicated",
          entityId: "w1",
          entityType: "widget",
        }),
      ),
    ).toBe("ada frobnicated widget w1");
  });

  it("appends a meta title when present", () => {
    expect(
      describeAuditEvent(
        make({
          id: "e",
          actorId: "ada",
          type: "page.created",
          entityId: "p1",
          entityType: "page",
          meta: { title: "Home" },
        }),
      ),
    ).toBe("ada created page p1 (Home)");
  });

  it("renders the system actor for an actorless event", () => {
    const event = normalizeAuditEvent({
      id: "e5",
      type: "workspace.updated",
      entityId: "w1",
      entityType: "workspace",
      createdAt: TODAY,
    });
    expect(event).not.toBeNull();
    expect(describeAuditEvent(event as AuditEvent)).toBe("system updated workspace w1");
  });
});
