import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  SYSTEM_ACTOR_ID,
  describeAuditAction,
  filterEvents,
  groupByDay,
  paginateEvents,
  parseAuditEvent,
  redactEvent,
  sortEvents,
  summarizeEvents,
  toCsv,
} from "./audit-log-engine";
import type { AuditEvent } from "./audit-log-engine";

/**
 * Workspace audit log engine (docs/MISSING_FEATURES.md top-gap #10 "Audit log
 * UI", docs/FEATURE_MATRIX.md "Audit log").
 *
 * `audit-log.ts` is the older query feed over Prisma `Activity` rows; this is a
 * distinct, self-contained engine over a richer `AuditEvent` shape (workspace,
 * target, category/severity catalogue, CSV export, redaction). Everything is
 * pure: no prisma, no routes, no React, no ambient clock — `groupByDay` is
 * handed a fixed `now` so every bucket label is deterministic.
 *
 * Red-first: `src/lib/audit-log-engine.ts` does not exist until this lands, so
 * the first run fails to resolve the import; the suite goes green with the
 * implementation.
 */

/** Fixed instant: 2026-05-01T12:00:00Z (a Friday). */
const NOW = "2026-05-01T12:00:00.000Z";
const T2 = "2026-05-01T11:00:00.000Z";
const T1 = "2026-05-01T10:00:00.000Z";
const YESTERDAY = "2026-04-30T09:00:00.000Z";
const OLDER = "2026-04-29T09:00:00.000Z";

/** Build an event with sane defaults, overriding only what a test needs. */
function make(over: Partial<AuditEvent> & { id: string }): AuditEvent {
  return {
    workspaceId: "w1",
    actorId: "ada",
    action: "page.created",
    targetType: "page",
    targetId: "p1",
    at: T2,
    ...over,
  };
}

describe("AUDIT_ACTIONS / describeAuditAction", () => {
  it("exposes a non-empty catalogue with unique actions", () => {
    const actions = AUDIT_ACTIONS.map((entry) => entry.action);
    expect(actions.length).toBeGreaterThan(10);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toContain("page.created");
    expect(actions).toContain("member.role_changed");
  });

  it("gives every catalogue entry a label, category and severity", () => {
    for (const entry of AUDIT_ACTIONS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.action.length).toBeGreaterThan(0);
      expect(["content", "membership", "permissions", "workspace", "security", "integration", "billing"]).toContain(
        entry.category,
      );
      expect(["info", "notice", "warning", "critical"]).toContain(entry.severity);
    }
  });

  it("describes a catalogued action by its human label", () => {
    expect(describeAuditAction("page.created")).toBe("Created a page");
    expect(describeAuditAction("member.role_changed")).toBe("Changed a member's role");
  });

  it("falls back to the raw action for an unknown one", () => {
    expect(describeAuditAction("widget.frobnicated")).toBe("widget.frobnicated");
  });
});

describe("parseAuditEvent", () => {
  it("rejects anything that is not a plain object", () => {
    expect(parseAuditEvent(null)).toBeNull();
    expect(parseAuditEvent(undefined)).toBeNull();
    expect(parseAuditEvent("page.created")).toBeNull();
    expect(parseAuditEvent(7)).toBeNull();
    expect(parseAuditEvent([{ id: "x" }])).toBeNull();
  });

  it("requires id, workspaceId, action, targetType, targetId and a parseable at", () => {
    const full = { id: "e", workspaceId: "w1", action: "a", targetType: "t", targetId: "x", at: T1 };
    expect(parseAuditEvent({ ...full, id: undefined })).toBeNull();
    expect(parseAuditEvent({ ...full, workspaceId: undefined })).toBeNull();
    expect(parseAuditEvent({ ...full, action: undefined })).toBeNull();
    expect(parseAuditEvent({ ...full, targetType: undefined })).toBeNull();
    expect(parseAuditEvent({ ...full, targetId: undefined })).toBeNull();
    expect(parseAuditEvent({ ...full, at: "not-a-date" })).toBeNull();
  });

  it("keeps a full valid row and copies every optional field", () => {
    const event = parseAuditEvent({
      id: "e1",
      workspaceId: "w1",
      actorId: "ada",
      action: "page.deleted",
      targetType: "page",
      targetId: "p9",
      targetName: "Old notes",
      meta: { before: "live" },
      at: T1,
      ip: "203.0.113.7",
    });
    expect(event).toEqual({
      id: "e1",
      workspaceId: "w1",
      actorId: "ada",
      action: "page.deleted",
      targetType: "page",
      targetId: "p9",
      targetName: "Old notes",
      meta: { before: "live" },
      at: T1,
      ip: "203.0.113.7",
    });
  });

  it("defaults a missing actor to the system actor", () => {
    const event = parseAuditEvent({
      id: "e2",
      workspaceId: "w1",
      action: "workspace.updated",
      targetType: "workspace",
      targetId: "w1",
      at: T1,
    });
    expect(event?.actorId).toBe(SYSTEM_ACTOR_ID);
  });

  it("drops a non-object meta and blank optional strings but keeps the event", () => {
    const event = parseAuditEvent({
      id: "e3",
      workspaceId: "w1",
      action: "page.created",
      targetType: "page",
      targetId: "p1",
      targetName: "   ",
      meta: "nope",
      ip: "",
      at: T1,
    });
    expect(event).not.toBeNull();
    expect(event?.meta).toBeUndefined();
    expect(event?.targetName).toBeUndefined();
    expect(event?.ip).toBeUndefined();
  });

  it("accepts a Date at and normalises it to ISO", () => {
    const event = parseAuditEvent({
      id: "e4",
      workspaceId: "w1",
      action: "page.created",
      targetType: "page",
      targetId: "p1",
      at: new Date(T1),
    });
    expect(event?.at).toBe(T1);
  });
});

describe("filterEvents", () => {
  const adaPage = make({ id: "a", actorId: "ada", action: "page.created", targetName: "Home page" });
  const bobMember = make({
    id: "b",
    actorId: "bob",
    action: "member.invited",
    targetType: "member",
    targetId: "m1",
    at: T1,
  });
  const adaOlder = make({ id: "c", actorId: "ada", action: "page.updated", at: OLDER });
  const unknown = make({ id: "d", actorId: "cleo", action: "widget.frobnicated", at: YESTERDAY });
  const all = [adaPage, bobMember, adaOlder, unknown];

  it("returns a fresh copy of everything for an empty filter", () => {
    const out = filterEvents(all, {});
    expect(out).toEqual(all);
    expect(out).not.toBe(all);
  });

  it("filters by actorId, action and targetType", () => {
    expect(filterEvents(all, { actorId: "ada" }).map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterEvents(all, { action: "page.created" }).map((e) => e.id)).toEqual(["a"]);
    expect(filterEvents(all, { targetType: "member" }).map((e) => e.id)).toEqual(["b"]);
  });

  it("filters by category resolved through the catalogue", () => {
    expect(filterEvents(all, { category: "content" }).map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterEvents(all, { category: "membership" }).map((e) => e.id)).toEqual(["b"]);
    // An action absent from the catalogue belongs to no category.
    expect(filterEvents(all, { category: "security" }).map((e) => e.id)).toEqual([]);
  });

  it("applies an inclusive from/to window over `at`", () => {
    expect(filterEvents(all, { from: T1, to: T2 }).map((e) => e.id)).toEqual(["a", "b"]);
    expect(filterEvents(all, { from: OLDER, to: OLDER }).map((e) => e.id)).toEqual(["c"]);
    expect(filterEvents(all, { to: YESTERDAY }).map((e) => e.id)).toEqual(["c", "d"]);
  });

  it("matches a case-insensitive query across the searchable fields", () => {
    expect(filterEvents(all, { query: "home" }).map((e) => e.id)).toEqual(["a"]);
    expect(filterEvents(all, { query: "ADA" }).map((e) => e.id)).toEqual(["a", "c"]);
    expect(filterEvents(all, { query: "page.created" }).map((e) => e.id)).toEqual(["a"]);
    expect(filterEvents(all, { query: "m1" }).map((e) => e.id)).toEqual(["b"]);
    expect(filterEvents(all, { query: "  home  " }).map((e) => e.id)).toEqual(["a"]);
    expect(filterEvents(all, { query: "zzz" })).toEqual([]);
  });

  it("applies every supplied constraint together", () => {
    expect(
      filterEvents(all, { actorId: "ada", category: "content", from: T2 }).map((e) => e.id),
    ).toEqual(["a"]);
    expect(filterEvents(all, { actorId: "ada", category: "membership" })).toEqual([]);
  });
});

describe("sortEvents", () => {
  const a = make({ id: "a", actorId: "bob", action: "page.updated", at: T1 });
  const b = make({ id: "b", actorId: "ada", action: "page.created", at: T2 });
  const c = make({ id: "c", actorId: "ada", action: "member.invited", at: T1 });
  const input = [c, a, b];

  it("defaults to newest first, ties broken by id ascending", () => {
    expect(sortEvents(input).map((e) => e.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts by actor in either direction", () => {
    expect(sortEvents(input, { by: "actor", dir: "asc" }).map((e) => e.id)).toEqual(["b", "c", "a"]);
    expect(sortEvents(input, { by: "actor", dir: "desc" }).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts by action and by ascending time", () => {
    expect(sortEvents(input, { by: "action", dir: "asc" }).map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(sortEvents(input, { by: "at", dir: "asc" }).map((e) => e.id)).toEqual(["a", "c", "b"]);
  });

  it("does not mutate the input array", () => {
    const snapshot = [...input];
    sortEvents(input, { by: "action" });
    expect(input).toEqual(snapshot);
  });
});

describe("paginateEvents", () => {
  // Deliberately unsorted: pagination orders the feed itself.
  const events = [
    make({ id: "d", at: OLDER }),
    make({ id: "a", at: T2 }),
    make({ id: "c", at: T1 }),
    make({ id: "b", at: T1 }),
  ];

  it("orders internally and returns the newest page with a keyset cursor", () => {
    const page = paginateEvents(events, { limit: 2 });
    expect(page.items.map((e) => e.id)).toEqual(["a", "c"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("walks pages from the cursor without overlap or gaps, even at `at` ties", () => {
    const first = paginateEvents(events, { limit: 2 });
    const second = paginateEvents(events, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((e) => e.id)).toEqual(["b", "d"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("fails closed on a malformed cursor", () => {
    const page = paginateEvents(events, { limit: 2, cursor: "not-a-cursor" });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("clamps a non-positive limit up to one row", () => {
    expect(paginateEvents(events, { limit: 0 }).items.map((e) => e.id)).toEqual(["a"]);
  });

  it("is stable across a re-ordered input array", () => {
    const shuffled = [events[3], events[0], events[2], events[1]];
    expect(paginateEvents(shuffled, { limit: 3 }).items.map((e) => e.id)).toEqual(["a", "c", "b"]);
  });
});

describe("groupByDay", () => {
  const events = [
    make({ id: "a", at: T2 }),
    make({ id: "b", at: T1 }),
    make({ id: "c", at: YESTERDAY }),
    make({ id: "d", at: OLDER }),
  ];

  it("buckets by UTC day, newest day first, with Today/Yesterday labels", () => {
    const groups = groupByDay(events, NOW);
    expect(groups.map((g) => g.day)).toEqual(["2026-05-01", "2026-04-30", "2026-04-29"]);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "2026-04-29"]);
    expect(groups.map((g) => g.count)).toEqual([2, 1, 1]);
  });

  it("orders events newest first within each day", () => {
    const groups = groupByDay(events, NOW);
    expect(groups[0]?.events.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for no events", () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe("summarizeEvents", () => {
  const events = [
    make({ id: "1", actorId: "ada", action: "page.created" }),
    make({ id: "2", actorId: "ada", action: "page.created" }),
    make({ id: "3", actorId: "bob", action: "member.invited" }),
    make({ id: "4", actorId: "ada", action: "widget.frobnicated" }),
  ];

  it("counts the total, per category, per actor and per action", () => {
    const summary = summarizeEvents(events);
    expect(summary.total).toBe(4);
    expect(summary.byCategory.content).toBe(2);
    expect(summary.byCategory.membership).toBe(1);
    expect(summary.byActor).toEqual({ ada: 3, bob: 1 });
    expect(summary.byAction).toEqual({
      "member.invited": 1,
      "page.created": 2,
      "widget.frobnicated": 1,
    });
  });

  it("never counts an unknown action toward a category", () => {
    const summary = summarizeEvents(events);
    const categorised = Object.values(summary.byCategory).reduce((sum, count) => sum + count, 0);
    expect(categorised).toBe(3);
  });

  it("returns zeroed totals for no events", () => {
    const summary = summarizeEvents([]);
    expect(summary.total).toBe(0);
    expect(summary.byActor).toEqual({});
    expect(summary.byAction).toEqual({});
    expect(Object.values(summary.byCategory).every((count) => count === 0)).toBe(true);
  });
});

describe("toCsv", () => {
  const HEADER = "id,at,workspaceId,actorId,action,category,targetType,targetId,targetName,ip";

  it("writes a header row and escapes a comma/quote-bearing field", () => {
    const csv = toCsv([make({ id: "e1", targetName: 'Home, "sweet" home', ip: "1.2.3.4" })]);
    const [header, row] = csv.split("\r\n");
    expect(header).toBe(HEADER);
    expect(row).toBe(`e1,${T2},w1,ada,page.created,content,page,p1,"Home, ""sweet"" home",1.2.3.4`);
  });

  it("blanks the category column for an uncatalogued action", () => {
    const csv = toCsv([make({ id: "e2", actorId: "bob", action: "widget.frobnicated" })]);
    expect(csv.split("\r\n")[1]).toBe(`e2,${T2},w1,bob,widget.frobnicated,,page,p1,,`);
  });

  it("quotes a field containing a newline rather than breaking the row", () => {
    const csv = toCsv([make({ id: "e3", targetName: "line1\nline2" })]);
    expect(csv.split("\r\n")[1]).toBe(`e3,${T2},w1,ada,page.created,content,page,p1,"line1\nline2",`);
  });

  it("keeps the caller's event order", () => {
    const csv = toCsv([make({ id: "z", at: OLDER }), make({ id: "a", at: T2 })]);
    const rows = csv.split("\r\n");
    expect(rows[1]?.startsWith("z,")).toBe(true);
    expect(rows[2]?.startsWith("a,")).toBe(true);
  });

  it("emits only the header for no events", () => {
    expect(toCsv([])).toBe(`${HEADER}\r\n`);
  });
});

describe("redactEvent", () => {
  const full = make({ id: "e1", meta: { before: "live" }, ip: "203.0.113.7" });

  it("drops ip and meta for a non-admin viewer", () => {
    const redacted = redactEvent(full);
    expect(redacted.ip).toBeUndefined();
    expect(redacted.meta).toBeUndefined();
    expect(redacted.id).toBe("e1");
    expect(redacted.action).toBe("page.created");
  });

  it("keeps ip and meta for an admin viewer", () => {
    expect(redactEvent(full, true)).toEqual(full);
  });

  it("does not mutate the original event", () => {
    redactEvent(full);
    expect(full.ip).toBe("203.0.113.7");
    expect(full.meta).toEqual({ before: "live" });
  });

  it("leaves an event without ip/meta structurally unchanged", () => {
    const bare = make({ id: "e2" });
    expect(redactEvent(bare)).toEqual(bare);
    expect(redactEvent(bare, true)).toEqual(bare);
  });
});
