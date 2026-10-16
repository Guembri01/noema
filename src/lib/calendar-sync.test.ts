import { describe, expect, it } from "vitest";
import {
  applyPull,
  applyPush,
  computeSyncPlan,
  describeSyncPlan,
  fromIcsEvent,
  mergeRecurrence,
  nextSyncToken,
  toIcsEvent,
  type ExternalEvent,
  type SyncPlan,
  type SyncState,
} from "@/lib/calendar-sync";

/* The planner is clock-free, so every `updatedAt`/`lastSyncAt` is a pinned
   UTC instant and comparisons never depend on the machine's timezone. */

const BASELINE = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const LATEST = "2026-01-03T00:00:00.000Z";

const state = (over: Partial<SyncState> = {}): SyncState => ({
  calendarId: "cal-1",
  lastSyncAt: BASELINE,
  direction: "both",
  ...over,
});

/** An external event with a per-id etag and a baseline timestamp (unchanged). */
const ev = (id: string, over: Partial<ExternalEvent> = {}): ExternalEvent => ({
  id,
  etag: `etag-${id}-1`,
  updatedAt: BASELINE,
  summary: id,
  start: "2026-01-10T09:00:00.000Z",
  end: "2026-01-10T10:00:00.000Z",
  allDay: false,
  ...over,
});

const EMPTY_PLAN: SyncPlan = { push: [], pull: [], conflicts: [] };

describe("computeSyncPlan - push direction (local is authority)", () => {
  it("is a no-op when both sides already agree", () => {
    const plan = computeSyncPlan({
      local: [ev("a")],
      remote: [ev("a")],
      state: state({ direction: "push" }),
    });
    expect(plan).toEqual(EMPTY_PLAN);
  });

  it("creates a remotely missing local event", () => {
    const plan = computeSyncPlan({
      local: [ev("a")],
      remote: [],
      state: state({ direction: "push" }),
    });
    expect(plan.push).toEqual([{ op: "create", eventId: "a", payload: ev("a") }]);
    expect(plan.pull).toEqual([]);
  });

  it("updates a remote event whose etag drifted", () => {
    const local = ev("a", { etag: "etag-a-2", summary: "Renamed", updatedAt: LATER });
    const plan = computeSyncPlan({
      local: [local],
      remote: [ev("a")],
      state: state({ direction: "push" }),
    });
    expect(plan.push).toEqual([{ op: "update", eventId: "a", payload: local }]);
  });

  it("deletes a remote extra that local no longer has", () => {
    const plan = computeSyncPlan({
      local: [],
      remote: [ev("a")],
      state: state({ direction: "push" }),
    });
    expect(plan.push).toEqual([{ op: "delete", eventId: "a", payload: null }]);
  });

  it("never emits pull operations", () => {
    const plan = computeSyncPlan({
      local: [ev("a")],
      remote: [ev("b", { etag: "etag-b-2", updatedAt: LATEST })],
      state: state({ direction: "push" }),
    });
    expect(plan.pull).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });
});

describe("computeSyncPlan - pull direction (remote is authority)", () => {
  it("is a no-op when both sides already agree", () => {
    const plan = computeSyncPlan({
      local: [ev("a")],
      remote: [ev("a")],
      state: state({ direction: "pull" }),
    });
    expect(plan).toEqual(EMPTY_PLAN);
  });

  it("creates a locally missing remote event", () => {
    const plan = computeSyncPlan({
      local: [],
      remote: [ev("a")],
      state: state({ direction: "pull" }),
    });
    expect(plan.pull).toEqual([{ op: "create", eventId: "a", payload: ev("a") }]);
    expect(plan.push).toEqual([]);
  });

  it("updates a local event whose etag drifted", () => {
    const remote = ev("a", { etag: "etag-a-2", summary: "Renamed", updatedAt: LATER });
    const plan = computeSyncPlan({
      local: [ev("a")],
      remote: [remote],
      state: state({ direction: "pull" }),
    });
    expect(plan.pull).toEqual([{ op: "update", eventId: "a", payload: remote }]);
  });

  it("deletes a local extra the remote no longer has", () => {
    const plan = computeSyncPlan({
      local: [ev("a")],
      remote: [],
      state: state({ direction: "pull" }),
    });
    expect(plan.pull).toEqual([{ op: "delete", eventId: "a", payload: null }]);
  });

  it("never emits push operations", () => {
    const plan = computeSyncPlan({
      local: [ev("b", { etag: "etag-b-2", updatedAt: LATEST })],
      remote: [ev("a")],
      state: state({ direction: "pull" }),
    });
    expect(plan.push).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });
});

describe("computeSyncPlan - two-way change detection", () => {
  it("is a no-op when unchanged on both sides", () => {
    const plan = computeSyncPlan({ local: [ev("a")], remote: [ev("a")], state: state() });
    expect(plan).toEqual(EMPTY_PLAN);
  });

  it("pushes a local change (etag drifted, only local moved)", () => {
    const local = ev("a", { etag: "etag-a-2", updatedAt: LATER });
    const plan = computeSyncPlan({ local: [local], remote: [ev("a")], state: state() });
    expect(plan.push).toEqual([{ op: "update", eventId: "a", payload: local }]);
    expect(plan.pull).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("pulls a remote change (etag drifted, only remote moved)", () => {
    const remote = ev("a", { etag: "etag-a-2", updatedAt: LATER });
    const plan = computeSyncPlan({ local: [ev("a")], remote: [remote], state: state() });
    expect(plan.pull).toEqual([{ op: "update", eventId: "a", payload: remote }]);
    expect(plan.push).toEqual([]);
  });

  it("pushes a locally created event (present only locally, newer than baseline)", () => {
    const plan = computeSyncPlan({
      local: [ev("a", { updatedAt: LATER })],
      remote: [],
      state: state(),
    });
    expect(plan.push).toEqual([
      { op: "create", eventId: "a", payload: ev("a", { updatedAt: LATER }) },
    ]);
  });

  it("pulls a remotely created event (present only remotely, newer than baseline)", () => {
    const plan = computeSyncPlan({
      local: [],
      remote: [ev("a", { updatedAt: LATER })],
      state: state(),
    });
    expect(plan.pull).toEqual([
      { op: "create", eventId: "a", payload: ev("a", { updatedAt: LATER }) },
    ]);
  });

  it("propagates a local deletion as a pull delete (remote copy is stale)", () => {
    const plan = computeSyncPlan({ local: [], remote: [ev("a")], state: state() });
    expect(plan.push).toEqual([{ op: "delete", eventId: "a", payload: null }]);
    expect(plan.pull).toEqual([]);
  });

  it("propagates a remote deletion as a pull delete on the local side", () => {
    const plan = computeSyncPlan({ local: [ev("a")], remote: [], state: state() });
    expect(plan.pull).toEqual([{ op: "delete", eventId: "a", payload: null }]);
    expect(plan.push).toEqual([]);
  });

  it("re-creates remotely when a local edit follows a remote deletion", () => {
    const local = ev("a", { updatedAt: LATER });
    const plan = computeSyncPlan({ local: [local], remote: [], state: state() });
    expect(plan.push).toEqual([{ op: "create", eventId: "a", payload: local }]);
  });

  it("orders operations deterministically by event id", () => {
    const plan = computeSyncPlan({
      local: [ev("c", { updatedAt: LATER }), ev("a", { updatedAt: LATER })],
      remote: [],
      state: state(),
    });
    expect(plan.push.map((op) => op.eventId)).toEqual(["a", "c"]);
  });

  it("does not mutate its inputs", () => {
    const local = [ev("a", { updatedAt: LATER })];
    const remote = [ev("b", { etag: "etag-b-2", updatedAt: LATEST })];
    const localSnapshot = JSON.stringify(local);
    const remoteSnapshot = JSON.stringify(remote);
    computeSyncPlan({ local, remote, state: state() });
    expect(JSON.stringify(local)).toBe(localSnapshot);
    expect(JSON.stringify(remote)).toBe(remoteSnapshot);
  });
});

describe("computeSyncPlan - conflict resolution with provenance", () => {
  const localMoved = () => ev("a", { etag: "etag-a-local", updatedAt: LATER });
  const remoteMoved = (updatedAt: string) =>
    ev("a", { etag: "etag-a-remote", updatedAt });

  it("flags a conflict when both sides moved and the remote is newer", () => {
    const local = localMoved();
    const remote = remoteMoved(LATEST);
    const plan = computeSyncPlan({ local: [local], remote: [remote], state: state() });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      eventId: "a",
      local,
      remote,
      resolution: { winner: "remote", reason: "newer-updatedAt", decidedAt: LATEST },
    });
    expect(plan.pull).toEqual([{ op: "update", eventId: "a", payload: remote }]);
    expect(plan.push).toEqual([]);
  });

  it("lets the newer local version win and pushes it", () => {
    const local = ev("a", { etag: "etag-a-local", updatedAt: LATEST });
    const remote = remoteMoved(LATER);
    const plan = computeSyncPlan({ local: [local], remote: [remote], state: state() });
    expect(plan.conflicts[0].resolution).toEqual({
      winner: "local",
      reason: "newer-updatedAt",
      decidedAt: LATEST,
    });
    expect(plan.push).toEqual([{ op: "update", eventId: "a", payload: local }]);
    expect(plan.pull).toEqual([]);
  });

  it("breaks an exact timestamp tie by preferring the remote (deterministic)", () => {
    const local = ev("a", { etag: "etag-a-local", updatedAt: LATER });
    const remote = remoteMoved(LATER);
    const plan = computeSyncPlan({ local: [local], remote: [remote], state: state() });
    expect(plan.conflicts[0].resolution).toEqual({
      winner: "remote",
      reason: "tie-break",
      decidedAt: LATER,
    });
    expect(plan.pull).toHaveLength(1);
  });

  it("keeps both original versions on the conflict record", () => {
    const local = localMoved();
    const remote = remoteMoved(LATEST);
    const [conflict] = computeSyncPlan({
      local: [local],
      remote: [remote],
      state: state(),
    }).conflicts;
    expect(conflict.local).toBe(local);
    expect(conflict.remote).toBe(remote);
  });

  it("reports no conflicts in push-only mode", () => {
    const plan = computeSyncPlan({
      local: [localMoved()],
      remote: [remoteMoved(LATEST)],
      state: state({ direction: "push" }),
    });
    expect(plan.conflicts).toEqual([]);
  });

  it("reports no conflicts in pull-only mode", () => {
    const plan = computeSyncPlan({
      local: [localMoved()],
      remote: [remoteMoved(LATEST)],
      state: state({ direction: "pull" }),
    });
    expect(plan.conflicts).toEqual([]);
  });
});

describe("applyPull / applyPush reducers", () => {
  const plan: SyncPlan = {
    push: [],
    pull: [
      { op: "update", eventId: "stale", payload: ev("stale", { etag: "new", summary: "Updated" }) },
      { op: "create", eventId: "fresh", payload: ev("fresh") },
      { op: "delete", eventId: "gone", payload: null },
    ],
    conflicts: [],
  };

  it("applies create/update/delete onto the local set", () => {
    const local = [ev("keep"), ev("stale", { etag: "old" }), ev("gone")];
    const result = applyPull(local, plan);
    expect(result.map((event) => event.id)).toEqual(["fresh", "keep", "stale"]);
    expect(result.find((event) => event.id === "stale")?.etag).toBe("new");
    expect(result.find((event) => event.id === "gone")).toBeUndefined();
  });

  it("applies the push operations onto the remote set symmetrically", () => {
    const remote = [ev("keep")];
    const pushPlan: SyncPlan = {
      push: [
        { op: "create", eventId: "added", payload: ev("added") },
        { op: "delete", eventId: "keep", payload: null },
      ],
      pull: plan.pull,
      conflicts: [],
    };
    const result = applyPush(remote, pushPlan);
    expect(result.map((event) => event.id)).toEqual(["added"]);
  });

  it("returns a sorted copy for an empty plan", () => {
    const local = [ev("c"), ev("a"), ev("b")];
    const result = applyPull(local, EMPTY_PLAN);
    expect(result.map((event) => event.id)).toEqual(["a", "b", "c"]);
    expect(result).not.toBe(local);
  });

  it("does not mutate the input set", () => {
    const local = [ev("stale", { etag: "old" }), ev("gone")];
    const snapshot = JSON.stringify(local);
    applyPull(local, plan);
    expect(JSON.stringify(local)).toBe(snapshot);
  });
});

describe("mergeRecurrence", () => {
  it("returns undefined when neither side recurs", () => {
    expect(mergeRecurrence(undefined, undefined)).toBeUndefined();
  });

  it("unions EXDATE deterministically, sorted and de-duplicated", () => {
    const merged = mergeRecurrence(
      { rrule: "FREQ=DAILY", exdate: ["20260102T000000Z"] },
      { rrule: "FREQ=DAILY", exdate: ["20260101T000000Z", "20260102T000000Z"] },
    );
    expect(merged).toEqual({
      rrule: "FREQ=DAILY",
      exdate: ["20260101T000000Z", "20260102T000000Z"],
    });
  });

  it("lets the incoming RRULE supersede an existing one", () => {
    expect(mergeRecurrence({ rrule: "FREQ=DAILY" }, { rrule: "FREQ=WEEKLY" })).toEqual({
      rrule: "FREQ=WEEKLY",
    });
  });

  it("keeps the existing RRULE when the incoming side has none", () => {
    expect(mergeRecurrence({ rrule: "FREQ=DAILY" }, { exdate: ["20260101T000000Z"] })).toEqual({
      rrule: "FREQ=DAILY",
      exdate: ["20260101T000000Z"],
    });
  });

  it("carries a rule from whichever single side defines it", () => {
    expect(mergeRecurrence({ rrule: "FREQ=DAILY" }, undefined)).toEqual({ rrule: "FREQ=DAILY" });
    expect(mergeRecurrence(undefined, { rrule: "FREQ=WEEKLY" })).toEqual({ rrule: "FREQ=WEEKLY" });
  });
});

describe("toIcsEvent / fromIcsEvent round-trip", () => {
  it("serialises a VEVENT envelope", () => {
    const ics = toIcsEvent(ev("a"));
    expect(ics.startsWith("BEGIN:VEVENT\r\n")).toBe(true);
    expect(ics.endsWith("END:VEVENT\r\n")).toBe(true);
    expect(ics).toContain("\r\nUID:a\r\n");
    expect(ics).toContain("\r\nSUMMARY:a\r\n");
  });

  it("round-trips a timed event byte-for-byte", () => {
    const event = ev("a", { summary: "Planning" });
    expect(fromIcsEvent(toIcsEvent(event))).toEqual(event);
  });

  it("round-trips an all-day event using VALUE=DATE", () => {
    const event = ev("day", {
      allDay: true,
      start: "2026-01-15T00:00:00.000Z",
      end: "2026-01-16T00:00:00.000Z",
    });
    expect(toIcsEvent(event)).toContain("DTSTART;VALUE=DATE:20260115");
    expect(fromIcsEvent(toIcsEvent(event))).toEqual(event);
  });

  it("escapes and restores TEXT separators and newlines", () => {
    const event = ev("a", { summary: "Standup, notes; Q1\nnext" });
    const restored = fromIcsEvent(toIcsEvent(event));
    expect(restored?.summary).toBe("Standup, notes; Q1\nnext");
  });

  it("round-trips a recurrence rule and its exclusions", () => {
    const event = ev("rec", {
      recurrence: {
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        exdate: ["20260120T090000Z", "20260127T090000Z"],
      },
    });
    const ics = toIcsEvent(event);
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(ics).toContain("EXDATE:20260120T090000Z,20260127T090000Z");
    expect(fromIcsEvent(ics)).toEqual(event);
  });

  it("parses a foreign VEVENT and applies safe defaults", () => {
    const foreign = [
      "BEGIN:VEVENT",
      "UID:foreign-1",
      "DTSTART:20260201T120000Z",
      "DTEND:20260201T130000Z",
      "SUMMARY:Imported",
      "END:VEVENT",
    ].join("\r\n");
    const parsed = fromIcsEvent(foreign);
    expect(parsed).toEqual({
      id: "foreign-1",
      etag: "",
      updatedAt: "2026-02-01T12:00:00.000Z",
      summary: "Imported",
      start: "2026-02-01T12:00:00.000Z",
      end: "2026-02-01T13:00:00.000Z",
      allDay: false,
    });
  });

  it("returns null for a payload without a usable UID and DTSTART", () => {
    expect(fromIcsEvent("")).toBeNull();
    expect(
      fromIcsEvent(["BEGIN:VEVENT", "DTSTART:20260301T080000Z", "END:VEVENT"].join("\r\n")),
    ).toBeNull();
    expect(
      fromIcsEvent(["BEGIN:VEVENT", "UID:x", "END:VEVENT"].join("\r\n")),
    ).toBeNull();
  });

  it("finds the VEVENT inside a full VCALENDAR envelope", () => {
    const calendar = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:x",
      "DTSTART:20260301T080000Z",
      "SUMMARY:Brief",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(fromIcsEvent(calendar)?.id).toBe("x");
  });
});

describe("describeSyncPlan", () => {
  it("reports a no-op plan", () => {
    expect(describeSyncPlan(EMPTY_PLAN)).toBe("no changes");
  });

  it("counts operations and conflicts by kind", () => {
    const plan: SyncPlan = {
      push: [
        { op: "create", eventId: "a", payload: ev("a") },
        { op: "update", eventId: "b", payload: ev("b") },
      ],
      pull: [{ op: "delete", eventId: "c", payload: null }],
      conflicts: [
        {
          eventId: "d",
          local: ev("d"),
          remote: ev("d"),
          resolution: { winner: "remote", reason: "newer-updatedAt", decidedAt: LATER },
        },
      ],
    };
    expect(describeSyncPlan(plan)).toBe(
      "push: 2 (1 create, 1 update); pull: 1 (1 delete); conflicts: 1 (1 remote wins)",
    );
  });

  it("is deterministic for equal plans", () => {
    const plan = computeSyncPlan({
      local: [ev("a", { updatedAt: LATER })],
      remote: [],
      state: state(),
    });
    expect(describeSyncPlan(plan)).toBe(describeSyncPlan(plan));
    expect(describeSyncPlan(plan)).toContain("push: 1 (1 create)");
  });
});

describe("nextSyncToken", () => {
  it("is stable for equal plans and shaped like a token", () => {
    expect(nextSyncToken(EMPTY_PLAN)).toBe(nextSyncToken({ push: [], pull: [], conflicts: [] }));
    expect(nextSyncToken(EMPTY_PLAN)).toMatch(/^sync-[0-9a-f]{8}$/);
  });

  it("changes when the plan content changes", () => {
    const first: SyncPlan = {
      push: [{ op: "create", eventId: "a", payload: ev("a") }],
      pull: [],
      conflicts: [],
    };
    const second: SyncPlan = {
      push: [
        { op: "create", eventId: "a", payload: ev("a", { etag: "other", updatedAt: LATER }) },
      ],
      pull: [],
      conflicts: [],
    };
    expect(nextSyncToken(first)).not.toBe(nextSyncToken(second));
    expect(nextSyncToken(first)).not.toBe(nextSyncToken(EMPTY_PLAN));
  });

  it("returns the same token for a repeated no-op", () => {
    expect(nextSyncToken(EMPTY_PLAN)).toBe(nextSyncToken(EMPTY_PLAN));
  });
});
