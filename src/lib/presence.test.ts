import { describe, expect, it } from "vitest";
import {
  PRESENCE_PALETTE,
  assignColor,
  cursorLabel,
  evictStale,
  normalizeCursor,
  upsertParticipant,
  visibleParticipants,
  type Participant,
} from "./presence";

/**
 * Presence & live cursors (F4).
 *
 * Red-first: `src/lib/presence.ts` did not exist when this file was written, so
 * the suite fails on the missing module until the helper lands. These are the
 * pure, deterministic pieces behind a live-collaboration surface: who is in the
 * room right now, what colour their caret is, where the caret sits, and how long
 * an idle participant lingers — all provable without a socket or a DOM.
 */

const p = (id: string, over: Partial<Participant> = {}): Participant => ({
  id,
  name: id.toUpperCase(),
  lastSeen: 0,
  ...over,
});

const ids = (list: readonly Participant[]): string[] => list.map((entry) => entry.id);

describe("upsertParticipant", () => {
  it("appends a participant that is not present yet", () => {
    const list = [p("a")];
    expect(ids(upsertParticipant(list, p("b")))).toEqual(["a", "b"]);
  });

  it("replaces an existing participant in place, preserving its position", () => {
    const list = [p("a"), p("b"), p("c")];
    const next = upsertParticipant(list, p("b", { name: "B2", lastSeen: 50 }));
    expect(ids(next)).toEqual(["a", "b", "c"]);
    expect(next[1].name).toBe("B2");
    expect(next[1].lastSeen).toBe(50);
  });

  it("updates across repeated upserts, last write winning", () => {
    const list = upsertParticipant(upsertParticipant([], p("a", { name: "one" })), p("a", { name: "two" }));
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("two");
  });

  it("returns a new array and never mutates the input or its entries", () => {
    const original = p("a", { name: "A" });
    const list = [original, p("b")];
    const snapshot = list.map((entry) => ({ ...entry }));
    const next = upsertParticipant(list, p("a", { name: "A2" }));
    expect(next).not.toBe(list);
    expect(next[0]).not.toBe(original);
    expect(list).toEqual(snapshot);
    expect(original.name).toBe("A");
  });

  it("ignores a participant without an id, still returning an equal copy", () => {
    const list = [p("a")];
    const next = upsertParticipant(list, p(""));
    expect(ids(next)).toEqual(["a"]);
    expect(next).not.toBe(list);
  });
});

describe("evictStale", () => {
  it("keeps fresh participants and drops stale ones", () => {
    const list = [p("live", { lastSeen: 995 }), p("dead", { lastSeen: 100 })];
    expect(ids(evictStale(list, 1000, 100))).toEqual(["live"]);
  });

  it("keeps a participant exactly at the ttl boundary", () => {
    expect(ids(evictStale([p("edge", { lastSeen: 900 })], 1000, 100))).toEqual(["edge"]);
  });

  it("evicts a participant one millisecond past the ttl", () => {
    expect(evictStale([p("gone", { lastSeen: 899 })], 1000, 100)).toEqual([]);
  });

  it("drops participants whose lastSeen is not a finite number", () => {
    const list = [p("ok", { lastSeen: 1000 }), p("nan", { lastSeen: Number.NaN }), p("inf", { lastSeen: Number.POSITIVE_INFINITY })];
    expect(ids(evictStale(list, 1000, 100))).toEqual(["ok"]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const list = [p("a"), p("b", { lastSeen: 1 })];
    const snapshot = [...list];
    const next = evictStale(list, 1000, 100);
    expect(next).not.toBe(list);
    expect(list).toEqual(snapshot);
  });

  it("handles an empty list", () => {
    expect(evictStale([], 1000, 100)).toEqual([]);
  });
});

describe("assignColor", () => {
  it("returns the same colour for the same id every time", () => {
    expect(assignColor("alice")).toBe(assignColor("alice"));
    expect(assignColor("user-42")).toBe(assignColor("user-42"));
  });

  it("always returns a colour from the fixed palette", () => {
    for (const id of ["", "a", "alice", "bob", "user-1234567", "🙂", "z".repeat(200)]) {
      expect(PRESENCE_PALETTE).toContain(assignColor(id));
    }
  });

  it("spreads a sample of ids across more than one palette colour", () => {
    const ids = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"];
    const colors = new Set(ids.map((id) => assignColor(id)));
    expect(colors.size).toBeGreaterThan(1);
  });

  it("is stable for the blank id", () => {
    expect(assignColor("")).toBe(assignColor(""));
  });
});

describe("normalizeCursor", () => {
  it("clamps both ends into [0, docSize]", () => {
    expect(normalizeCursor({ anchor: -5, head: 999 }, 100)).toEqual({ anchor: 0, head: 100 });
  });

  it("orders the endpoints so anchor is never greater than head", () => {
    expect(normalizeCursor({ anchor: 8, head: 3 }, 100)).toEqual({ anchor: 3, head: 8 });
  });

  it("keeps a collapsed cursor as-is", () => {
    expect(normalizeCursor({ anchor: 4, head: 4 }, 100)).toEqual({ anchor: 4, head: 4 });
  });

  it("coerces non-finite and fractional values to safe integers", () => {
    expect(normalizeCursor({ anchor: Number.NaN, head: 2.9 }, 100)).toEqual({ anchor: 0, head: 2 });
  });

  it("collapses everything to zero when the document is empty", () => {
    expect(normalizeCursor({ anchor: 5, head: 9 }, 0)).toEqual({ anchor: 0, head: 0 });
  });

  it("returns a new object and does not mutate the input", () => {
    const cursor = { anchor: 10, head: 2 };
    const snapshot = { ...cursor };
    const normalized = normalizeCursor(cursor, 100);
    expect(normalized).not.toBe(cursor);
    expect(cursor).toEqual(snapshot);
  });
});

describe("visibleParticipants", () => {
  it("excludes stale participants", () => {
    const list = [p("live", { lastSeen: 990 }), p("dead", { lastSeen: 10 })];
    expect(ids(visibleParticipants(list, { now: 1000, ttlMs: 100 }))).toEqual(["live"]);
  });

  it("orders the most recently seen participant first", () => {
    const list = [p("old", { lastSeen: 950 }), p("new", { lastSeen: 999 }), p("mid", { lastSeen: 980 })];
    expect(ids(visibleParticipants(list, { now: 1000, ttlMs: 100 }))).toEqual(["new", "mid", "old"]);
  });

  it("breaks lastSeen ties by id ascending", () => {
    const list = [p("b", { lastSeen: 990 }), p("a", { lastSeen: 990 })];
    expect(ids(visibleParticipants(list, { now: 1000, ttlMs: 100 }))).toEqual(["a", "b"]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const list = [p("b", { lastSeen: 990 }), p("a", { lastSeen: 980 })];
    const snapshot = [...list];
    const visible = visibleParticipants(list, { now: 1000, ttlMs: 100 });
    expect(visible).not.toBe(list);
    expect(list).toEqual(snapshot);
  });

  it("returns an empty list when nobody is active", () => {
    expect(visibleParticipants([], { now: 1000, ttlMs: 100 })).toEqual([]);
  });
});

describe("cursorLabel", () => {
  it("returns the trimmed participant name", () => {
    expect(cursorLabel({ name: "  Ada Lovelace  " })).toBe("Ada Lovelace");
  });

  it("falls back to Anonymous for a blank or missing name", () => {
    expect(cursorLabel({ name: "   " })).toBe("Anonymous");
    expect(cursorLabel({})).toBe("Anonymous");
  });
});
