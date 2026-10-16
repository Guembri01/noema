import { describe, expect, it } from "vitest";
import { SYSTEM_ACTOR_ID, parseAuditEvent, type AuditEvent } from "./audit-log-engine";
import {
  activityToAuditEvent,
  auditEventToActivityRecord,
  mapActivityRecords,
  type ActivityRecord,
} from "./audit-engine-mapping";

/**
 * Adapter between Prisma `Activity` rows and the audit engine's `AuditEvent`.
 * The page and CSV export share it, so both halves (forward + reverse) are
 * pinned here, including the nullable columns (`actorId`, `targetId`) and the
 * presentation fields folded into `meta.json` (`title`/`name`, `ip`).
 */

const AT = "2026-05-01T11:00:00.000Z";

/** A raw `Activity` row with sane defaults, overriding only what a test needs. */
function row(over: Partial<ActivityRecord> & { id: string }): ActivityRecord {
  return {
    workspaceId: "w1",
    actorId: "ada",
    action: "page.created",
    targetType: "page",
    targetId: "p1",
    meta: null,
    createdAt: AT,
    ...over,
  };
}

describe("activityToAuditEvent", () => {
  it("maps a full row field-for-field", () => {
    const event = activityToAuditEvent(
      row({
        id: "a1",
        meta: { title: "Roadmap", before: "draft" },
        createdAt: new Date(AT),
      }),
    );
    expect(event).toEqual({
      id: "a1",
      workspaceId: "w1",
      actorId: "ada",
      action: "page.created",
      targetType: "page",
      targetId: "p1",
      targetName: "Roadmap",
      meta: { title: "Roadmap", before: "draft" },
      at: AT,
    });
  });

  it("defaults a null actor to the system actor", () => {
    expect(activityToAuditEvent(row({ id: "a2", actorId: null })).actorId).toBe(SYSTEM_ACTOR_ID);
  });

  it("falls back to the row id when the target is gone", () => {
    expect(activityToAuditEvent(row({ id: "a3", targetId: null })).targetId).toBe("a3");
  });

  it("coerces a Date timestamp to ISO and keeps a string verbatim", () => {
    expect(activityToAuditEvent(row({ id: "a4", createdAt: new Date(AT) })).at).toBe(AT);
    expect(activityToAuditEvent(row({ id: "a5", createdAt: AT })).at).toBe(AT);
  });

  it("reads targetName from meta.name when there is no title", () => {
    expect(activityToAuditEvent(row({ id: "a6", meta: { name: "Notes" } })).targetName).toBe(
      "Notes",
    );
  });

  it("reads the ip out of meta and keeps it in the payload", () => {
    const event = activityToAuditEvent(row({ id: "a7", meta: { ip: "203.0.113.7" } }));
    expect(event.ip).toBe("203.0.113.7");
    expect(event.meta).toEqual({ ip: "203.0.113.7" });
  });

  it("drops blank and non-object meta rather than failing the row", () => {
    expect(activityToAuditEvent(row({ id: "a8", meta: "nope" })).meta).toBeUndefined();
    expect(activityToAuditEvent(row({ id: "a9", meta: ["x"] })).meta).toBeUndefined();
    expect(activityToAuditEvent(row({ id: "a10", meta: { title: "   " } })).targetName).toBeUndefined();
  });

  it("does not mutate the input row", () => {
    const input = row({ id: "a11", meta: { title: "Stable" } });
    const snapshot = structuredClone(input);
    activityToAuditEvent(input);
    expect(input).toEqual(snapshot);
  });
});

describe("auditEventToActivityRecord", () => {
  it("turns the system actor back into a null author and folds name/ip into meta", () => {
    const event: AuditEvent = {
      id: "e1",
      workspaceId: "w1",
      actorId: SYSTEM_ACTOR_ID,
      action: "workspace.updated",
      targetType: "workspace",
      targetId: "w1",
      targetName: "Acme",
      at: AT,
      ip: "203.0.113.7",
      meta: { before: "x" },
    };
    expect(auditEventToActivityRecord(event)).toEqual({
      id: "e1",
      workspaceId: "w1",
      actorId: null,
      action: "workspace.updated",
      targetType: "workspace",
      targetId: "w1",
      meta: { before: "x", title: "Acme", ip: "203.0.113.7" },
      createdAt: AT,
    });
  });

  it("records an empty meta as null", () => {
    const event: AuditEvent = {
      id: "e2",
      workspaceId: "w1",
      actorId: "ada",
      action: "page.created",
      targetType: "page",
      targetId: "p1",
      at: AT,
    };
    expect(auditEventToActivityRecord(event).meta).toBeNull();
  });

  it("does not clobber meta keys that already exist", () => {
    const event: AuditEvent = {
      id: "e3",
      workspaceId: "w1",
      actorId: "ada",
      action: "page.created",
      targetType: "page",
      targetId: "p1",
      targetName: "New",
      at: AT,
      ip: "1.2.3.4",
      meta: { title: "Old", ip: "5.6.7.8" },
    };
    expect(auditEventToActivityRecord(event).meta).toEqual({ title: "Old", ip: "5.6.7.8" });
  });
});

describe("round trip", () => {
  it("recovers every engine-visible field through both halves", () => {
    const event = parseAuditEvent({
      id: "e4",
      workspaceId: "w1",
      actorId: "ada",
      action: "page.deleted",
      targetType: "page",
      targetId: "p9",
      targetName: "Old notes",
      meta: { before: "live" },
      at: AT,
      ip: "203.0.113.7",
    }) as AuditEvent;

    const back = activityToAuditEvent(auditEventToActivityRecord(event));
    expect(back.id).toBe(event.id);
    expect(back.workspaceId).toBe(event.workspaceId);
    expect(back.actorId).toBe(event.actorId);
    expect(back.action).toBe(event.action);
    expect(back.targetType).toBe(event.targetType);
    expect(back.targetId).toBe(event.targetId);
    expect(back.at).toBe(event.at);
    expect(back.targetName).toBe(event.targetName);
    expect(back.ip).toBe(event.ip);
  });
});

describe("mapActivityRecords", () => {
  it("maps every row, preserving order", () => {
    const events = mapActivityRecords([row({ id: "a" }), row({ id: "b", actorId: null })]);
    expect(events.map((event) => event.id)).toEqual(["a", "b"]);
    expect(events[1]?.actorId).toBe(SYSTEM_ACTOR_ID);
  });
});
