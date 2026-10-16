import { describe, expect, it } from "vitest";
import {
  AUDIT_PAGE_SIZE,
  auditSearchParams,
  buildAuditView,
  isAuditAdmin,
  parseAuditQuery,
  selectAuditEvents,
} from "./audit-engine-query";
import type { ActivityRecord } from "./audit-engine-mapping";

/**
 * Query/view wiring for the audit page. Pins the URL parsing (untrusted input
 * → validated engine selector), the filter/sort pass, the keyset page +
 * day-grouping + summary composed from the engine, and the re-exported
 * link builder used by pagination and the CSV route.
 */

/** Fixed "now": 2026-05-01T12:00:00Z. */
const NOW = "2026-05-01T12:00:00.000Z";
const T3 = "2026-05-01T11:00:00.000Z";
const T2 = "2026-05-01T10:00:00.000Z";
const T1 = "2026-05-01T09:00:00.000Z";
const YESTERDAY = "2026-04-30T09:00:00.000Z";
const OLDER = "2026-04-29T09:00:00.000Z";

/** A raw `Activity` row with sane defaults, overriding only what a test needs. */
function row(over: Partial<ActivityRecord> & { id: string }): ActivityRecord {
  return {
    workspaceId: "w1",
    actorId: "ada",
    action: "page.created",
    targetType: "page",
    targetId: "p1",
    meta: null,
    createdAt: T2,
    ...over,
  };
}

describe("parseAuditQuery", () => {
  it("defaults to an unconstrained newest-first feed", () => {
    const query = parseAuditQuery();
    expect(query.filter).toEqual({});
    expect(query.sort).toEqual({ by: "at", dir: "desc" });
    expect(query.limit).toBe(AUDIT_PAGE_SIZE);
    expect(query.cursor).toBeNull();
    expect(query.grouped).toBe(false);
    expect(query.raw.view).toBe("list");
  });

  it("maps every known filter axis, expanding days to inclusive instants", () => {
    const query = parseAuditQuery({
      actor: "ada",
      action: "page.created",
      category: "content",
      target: "page",
      q: "road",
      from: "2026-05-01",
      to: "2026-05-02",
    });
    expect(query.filter).toEqual({
      actorId: "ada",
      action: "page.created",
      category: "content",
      targetType: "page",
      query: "road",
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-05-02T23:59:59.999Z",
    });
    expect(query.raw.from).toBe("2026-05-01");
    expect(query.raw.to).toBe("2026-05-02");
  });

  it("drops unknown actions, categories and malformed days", () => {
    const query = parseAuditQuery({
      action: "widget.frobnicated",
      category: "not-a-category",
      from: "yesterday",
      to: "2026-13-40",
    });
    expect(query.filter).toEqual({});
    expect(query.raw.from).toBeUndefined();
  });

  it("validates sort, direction and view", () => {
    const grouped = parseAuditQuery({ sort: "actor", dir: "asc", view: "grouped" });
    expect(grouped.sort).toEqual({ by: "actor", dir: "asc" });
    expect(grouped.grouped).toBe(true);

    const fallback = parseAuditQuery({ sort: "bogus", dir: "sideways", view: "nope" });
    expect(fallback.sort).toEqual({ by: "at", dir: "desc" });
    expect(fallback.grouped).toBe(false);
  });

  it("clamps the page size and falls back on garbage", () => {
    expect(parseAuditQuery({ limit: "200" }).limit).toBe(100);
    expect(parseAuditQuery({ limit: "0" }).limit).toBe(1);
    expect(parseAuditQuery({ limit: "abc" }).limit).toBe(AUDIT_PAGE_SIZE);
    expect(parseAuditQuery({ limit: "12" }).limit).toBe(12);
  });

  it("takes the first value of a repeated key and keeps a cursor", () => {
    const query = parseAuditQuery({ actor: ["ada", "bob"], cursor: "opaque" });
    expect(query.filter.actorId).toBe("ada");
    expect(query.cursor).toBe("opaque");
  });
});

describe("selectAuditEvents", () => {
  const records = [
    row({ id: "a", actorId: "ada", action: "page.created", createdAt: T2 }),
    row({ id: "b", actorId: "bob", action: "member.invited", createdAt: T1 }),
    row({ id: "c", actorId: "ada", action: "page.deleted", createdAt: YESTERDAY }),
  ];

  it("filters by actor and keeps newest-first order", () => {
    const events = selectAuditEvents(records, parseAuditQuery({ actor: "ada" }));
    expect(events.map((event) => event.id)).toEqual(["a", "c"]);
  });

  it("filters by catalogue category", () => {
    const events = selectAuditEvents(records, parseAuditQuery({ category: "content" }));
    expect(events.map((event) => event.id)).toEqual(["a", "c"]);
  });

  it("filters by free-text query over the mapped fields", () => {
    const events = selectAuditEvents(records, parseAuditQuery({ q: "bob" }));
    expect(events.map((event) => event.id)).toEqual(["b"]);
  });

  it("applies the requested sort to the whole match", () => {
    const events = selectAuditEvents(records, parseAuditQuery({ sort: "actor", dir: "asc" }));
    expect(events.map((event) => event.id)).toEqual(["a", "c", "b"]);
  });
});

describe("buildAuditView", () => {
  const records = [
    row({ id: "a", createdAt: T3 }),
    row({ id: "b", createdAt: T2 }),
    row({ id: "c", createdAt: T1 }),
  ];

  it("summarizes the whole match but pages the feed", () => {
    const view = buildAuditView(records, parseAuditQuery({ limit: "2" }), NOW);
    expect(view.total).toBe(3);
    expect(view.summary.total).toBe(3);
    expect(view.summary.byCategory.content).toBe(3);
    expect(view.summary.byActor).toEqual({ ada: 3 });
    expect(view.page.items.map((event) => event.id)).toEqual(["a", "b"]);
    expect(view.items.map((event) => event.id)).toEqual(["a", "b"]);
    expect(view.page.hasMore).toBe(true);
  });

  it("continues a keyset page without repeating the boundary row", () => {
    const first = buildAuditView(records, parseAuditQuery({ limit: "2" }), NOW);
    const cursor = first.page.nextCursor;
    expect(cursor).not.toBeNull();

    const second = buildAuditView(records, parseAuditQuery({ limit: "2", cursor: cursor ?? "" }), NOW);
    expect(second.page.items.map((event) => event.id)).toEqual(["c"]);
    expect(second.page.hasMore).toBe(false);
    expect(second.page.nextCursor).toBeNull();
  });

  it("fails closed on a malformed cursor but still reports the match", () => {
    const view = buildAuditView(records, parseAuditQuery({ cursor: "not-a-cursor" }), NOW);
    expect(view.page.items).toEqual([]);
    expect(view.page.hasMore).toBe(false);
    expect(view.total).toBe(3);
  });

  it("sections the page into labelled UTC day buckets", () => {
    const view = buildAuditView(
      [
        row({ id: "a", createdAt: T1 }),
        row({ id: "b", createdAt: YESTERDAY }),
        row({ id: "c", createdAt: OLDER }),
      ],
      parseAuditQuery(),
      NOW,
    );
    expect(view.groups.map((group) => group.label)).toEqual([
      "Today",
      "Yesterday",
      "2026-04-29",
    ]);
    expect(view.groups.map((group) => group.count)).toEqual([1, 1, 1]);
  });
});

describe("auditSearchParams", () => {
  it("is empty for a default query", () => {
    expect(auditSearchParams(parseAuditQuery()).toString()).toBe("");
  });

  it("round-trips the active filters and non-default display options", () => {
    const query = parseAuditQuery({
      actor: "ada",
      action: "page.created",
      category: "content",
      target: "page",
      q: "road",
      from: "2026-05-01",
      to: "2026-05-02",
      sort: "actor",
      dir: "asc",
      view: "grouped",
      limit: "25",
    });
    const params = auditSearchParams(query);
    expect(params.get("actor")).toBe("ada");
    expect(params.get("action")).toBe("page.created");
    expect(params.get("category")).toBe("content");
    expect(params.get("target")).toBe("page");
    expect(params.get("q")).toBe("road");
    expect(params.get("from")).toBe("2026-05-01");
    expect(params.get("to")).toBe("2026-05-02");
    expect(params.get("sort")).toBe("actor");
    expect(params.get("dir")).toBe("asc");
    expect(params.get("view")).toBe("grouped");
    expect(params.get("limit")).toBe("25");
  });

  it("drops the cursor on request and accepts a new one", () => {
    const query = parseAuditQuery({ cursor: "old" });
    expect(auditSearchParams(query, { cursor: null }).get("cursor")).toBeNull();
    expect(auditSearchParams(query, { cursor: "new" }).get("cursor")).toBe("new");
    expect(auditSearchParams(query).get("cursor")).toBe("old");
  });
});

describe("isAuditAdmin", () => {
  it("grants unredacted access to the owner only", () => {
    expect(isAuditAdmin("OWNER")).toBe(true);
    expect(isAuditAdmin("ADMIN")).toBe(false);
    expect(isAuditAdmin("MEMBER")).toBe(false);
    expect(isAuditAdmin(null)).toBe(false);
    expect(isAuditAdmin(undefined)).toBe(false);
  });
});
