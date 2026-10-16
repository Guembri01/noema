import { describe, expect, it } from "vitest";
import {
  DEFAULT_COALESCE_WINDOW_MS,
  describeLastEdited,
  editorHistory,
  isStale,
  lastEditor,
  mergeActorMaps,
  recordEdit,
  resolveDisplayName,
  type EditEvent,
  type EditMember,
} from "@/lib/last-edited";

/**
 * "Last edited by" tracking engine (docs/MISSING_FEATURES.md §4 "Last edited
 * by", docs/FEATURE_MATRIX.md "Last edited by").
 *
 * The workspace records edits from the property/table view, so the existing
 * "last editor" only ever reflects a `property` write: a title or body change
 * outside the database view is silently ignored. This engine treats every
 * {@link EditEvent} kind (`title`/`content`/`property`/`structure`/`comment`)
 * as a first-class edit, collapses rapid same-author bursts for a readable
 * history, and degrades to the entity creator (then "Unknown") once an author
 * has been deleted.
 *
 * Everything is pure and clock-injected: no prisma, no React, no ambient
 * `Date.now()`, so every relative label is deterministic.
 *
 * Red-first: `src/lib/last-edited.ts` does not exist until this slice lands, so
 * the first run fails to resolve the import; the suite goes green with the
 * implementation.
 */

/** Fixed instant: 2026-05-01T12:00:00Z. */
const BASE = Date.parse("2026-05-01T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** ISO timestamp `offsetMs` away from {@link BASE}. */
const iso = (offsetMs: number): string => new Date(BASE + offsetMs).toISOString();

/** Build an event with sane defaults, overriding only what a test needs. */
function makeEdit(over: Partial<EditEvent> & { id: string }): EditEvent {
  return {
    entityType: "page",
    entityId: "p1",
    actorId: "ada",
    kind: "content",
    at: iso(0),
    ...over,
  };
}

describe("recordEdit", () => {
  it("appends an edit without mutating the input log", () => {
    const before = [makeEdit({ id: "e1" })];
    const after = recordEdit(before, makeEdit({ id: "e2" }));
    expect(after.map((event) => event.id)).toEqual(["e1", "e2"]);
    expect(before.map((event) => event.id)).toEqual(["e1"]);
  });

  it("records the first edit onto an empty log", () => {
    expect(recordEdit([], makeEdit({ id: "e1" }))).toHaveLength(1);
  });

  it("preserves insertion order across chained records", () => {
    const log = recordEdit(
      recordEdit([], makeEdit({ id: "a" })),
      makeEdit({ id: "b" }),
    );
    expect(recordEdit(log, makeEdit({ id: "c" })).map((event) => event.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("lastEditor", () => {
  it("returns null when the log is empty", () => {
    expect(lastEditor([], { entityId: "p1" })).toBeNull();
  });

  it("returns null when the entity has no edits", () => {
    expect(lastEditor([makeEdit({ id: "e1", entityId: "other" })], { entityId: "p1" })).toBeNull();
  });

  it("returns the most recent edit for the entity", () => {
    const events = [
      makeEdit({ id: "old", actorId: "ada", at: iso(-10 * MIN) }),
      makeEdit({ id: "new", actorId: "bob", at: iso(-2 * MIN) }),
    ];
    expect(lastEditor(events, { entityId: "p1" })).toMatchObject({
      actorId: "bob",
      at: iso(-2 * MIN),
    });
  });

  it("counts content edits, not only property edits (the recorded gap)", () => {
    const events = [
      makeEdit({ id: "prop", actorId: "ada", kind: "property", at: iso(-20 * MIN) }),
      makeEdit({ id: "body", actorId: "bob", kind: "content", at: iso(-1 * MIN) }),
    ];
    expect(lastEditor(events, { entityId: "p1" })?.actorId).toBe("bob");
  });

  it("counts title edits", () => {
    const events = [
      makeEdit({ id: "body", actorId: "ada", kind: "content", at: iso(-30 * MIN) }),
      makeEdit({ id: "title", actorId: "grace", kind: "title", at: iso(-3 * MIN) }),
    ];
    expect(lastEditor(events, { entityId: "p1" })).toMatchObject({
      actorId: "grace",
      kind: "title",
    });
  });

  it("counts comment and structure edits", () => {
    const events = [
      makeEdit({ id: "structure", actorId: "ada", kind: "structure", at: iso(-9 * MIN) }),
      makeEdit({ id: "comment", actorId: "bob", kind: "comment", at: iso(-4 * MIN) }),
    ];
    expect(lastEditor(events, { entityId: "p1" })).toMatchObject({
      actorId: "bob",
      kind: "comment",
    });
  });

  it("ignores edits belonging to another entity", () => {
    const events = [
      makeEdit({ id: "mine", entityId: "p1", at: iso(-10 * MIN) }),
      makeEdit({ id: "theirs", entityId: "p2", at: iso(0) }),
    ];
    expect(lastEditor(events, { entityId: "p1" })?.at).toBe(iso(-10 * MIN));
  });

  it("returns the last-recorded event on a timestamp tie", () => {
    const events = [
      makeEdit({ id: "first", actorId: "ada", at: iso(0) }),
      makeEdit({ id: "second", actorId: "bob", at: iso(0) }),
    ];
    expect(lastEditor(events, { entityId: "p1" })?.actorId).toBe("bob");
  });

  it("carries the kind and summary through, and omits an absent summary", () => {
    const withSummary = lastEditor(
      [makeEdit({ id: "e1", kind: "title", summary: "Renamed the page" })],
      { entityId: "p1" },
    );
    expect(withSummary).toEqual({
      actorId: "ada",
      at: iso(0),
      kind: "title",
      summary: "Renamed the page",
    });
    const withoutSummary = lastEditor([makeEdit({ id: "e2" })], { entityId: "p1" });
    expect(withoutSummary && "summary" in withoutSummary).toBe(false);
  });
});

describe("editorHistory", () => {
  it("returns an empty history for an unknown entity", () => {
    expect(editorHistory([makeEdit({ id: "e1", entityId: "p2" })], { entityId: "p1" })).toEqual([]);
  });

  it("returns an empty history when the limit is zero", () => {
    expect(editorHistory([makeEdit({ id: "e1" })], { entityId: "p1", limit: 0 })).toEqual([]);
  });

  it("orders entries newest first", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", at: iso(-10 * MIN) }),
      makeEdit({ id: "b", actorId: "bob", at: iso(-2 * MIN) }),
    ];
    const history = editorHistory(events, { entityId: "p1" });
    expect(history.map((entry) => entry.actorId)).toEqual(["bob", "ada"]);
  });

  it("collapses consecutive same-author edits within the window", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", at: iso(-6 * MIN) }),
      makeEdit({ id: "b", actorId: "ada", at: iso(-3 * MIN) }),
    ];
    const history = editorHistory(events, { entityId: "p1" });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ actorId: "ada", count: 2, at: iso(-3 * MIN) });
  });

  it("collapses a chained run whose consecutive gaps each fit the window", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", at: iso(-12 * MIN) }),
      makeEdit({ id: "b", actorId: "ada", at: iso(-8 * MIN) }),
      makeEdit({ id: "c", actorId: "ada", at: iso(-4 * MIN) }),
    ];
    const history = editorHistory(events, { entityId: "p1" });
    expect(history).toHaveLength(1);
    expect(history[0].count).toBe(3);
  });

  it("keeps same-author edits separate once a gap exceeds the window", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", at: iso(-20 * MIN) }),
      makeEdit({ id: "b", actorId: "ada", at: iso(-1 * MIN) }),
    ];
    const history = editorHistory(events, { entityId: "p1" });
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.count)).toEqual([1, 1]);
  });

  it("collapses exactly at the window boundary (inclusive)", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", at: iso(-DEFAULT_COALESCE_WINDOW_MS) }),
      makeEdit({ id: "b", actorId: "ada", at: iso(0) }),
    ];
    expect(editorHistory(events, { entityId: "p1" })).toHaveLength(1);
  });

  it("does not collapse just past the window boundary", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", at: iso(-DEFAULT_COALESCE_WINDOW_MS - 1) }),
      makeEdit({ id: "b", actorId: "ada", at: iso(0) }),
    ];
    expect(editorHistory(events, { entityId: "p1" })).toHaveLength(2);
  });

  it("breaks the run when the author changes", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", at: iso(0) }),
      makeEdit({ id: "b", actorId: "bob", at: iso(-1 * MIN) }),
      makeEdit({ id: "c", actorId: "ada", at: iso(-2 * MIN) }),
    ];
    expect(editorHistory(events, { entityId: "p1" }).map((entry) => entry.actorId)).toEqual([
      "ada",
      "bob",
      "ada",
    ]);
  });

  it("applies the limit after collapsing", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", at: iso(-10 * MIN) }),
      makeEdit({ id: "b", actorId: "bob", at: iso(-5 * MIN) }),
      makeEdit({ id: "c", actorId: "cara", at: iso(-1 * MIN) }),
    ];
    const history = editorHistory(events, { entityId: "p1", limit: 2 });
    expect(history.map((entry) => entry.actorId)).toEqual(["cara", "bob"]);
  });

  it("keeps the newest kind and summary when collapsing", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", kind: "content", summary: "Added a paragraph", at: iso(-4 * MIN) }),
      makeEdit({ id: "b", actorId: "ada", kind: "title", summary: "Renamed", at: iso(-1 * MIN) }),
    ];
    expect(editorHistory(events, { entityId: "p1" })[0]).toMatchObject({
      kind: "title",
      summary: "Renamed",
      count: 2,
    });
  });

  it("fills the summary from an older event when the newest has none", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", kind: "content", summary: "Added a paragraph", at: iso(-4 * MIN) }),
      makeEdit({ id: "b", actorId: "ada", kind: "title", at: iso(-1 * MIN) }),
    ];
    expect(editorHistory(events, { entityId: "p1" })[0]).toMatchObject({
      kind: "title",
      summary: "Added a paragraph",
    });
  });

  it("honors a custom coalesce window", () => {
    const events = [
      makeEdit({ id: "a", actorId: "ada", at: iso(-2 * MIN) }),
      makeEdit({ id: "b", actorId: "ada", at: iso(-1 * MIN) }),
    ];
    expect(editorHistory(events, { entityId: "p1", coalesceMs: 30_000 })).toHaveLength(2);
    expect(editorHistory(events, { entityId: "p1", coalesceMs: 90_000 })).toHaveLength(1);
  });
});

describe("resolveDisplayName", () => {
  const ada: EditMember = { id: "u1", name: "Ada" };
  const creator: EditMember = { id: "u9", name: "Creator Cara", isCreator: true };

  it("resolves an active member by id", () => {
    expect(resolveDisplayName({ actorId: "u1" }, { members: [ada], fallback: "creator" })).toBe(
      "Ada",
    );
  });

  it("falls back to the creator when the author is gone", () => {
    expect(
      resolveDisplayName({ actorId: "deleted" }, { members: [ada, creator], fallback: "creator" }),
    ).toBe("Creator Cara");
  });

  it("returns Unknown when the author is gone and no creator is known", () => {
    expect(resolveDisplayName({ actorId: "deleted" }, { members: [ada], fallback: "creator" })).toBe(
      "Unknown",
    );
  });

  it("honors the unknown fallback even when a creator exists", () => {
    expect(
      resolveDisplayName({ actorId: "deleted" }, { members: [ada, creator], fallback: "unknown" }),
    ).toBe("Unknown");
  });

  it("returns Unknown for a null editor", () => {
    expect(resolveDisplayName(null, { members: [ada, creator], fallback: "creator" })).toBe(
      "Unknown",
    );
  });
});

describe("describeLastEdited", () => {
  const result = { actorId: "u1", at: iso(-5 * MIN), kind: "content" as const };

  it("formats minutes with the author", () => {
    expect(describeLastEdited(result, { now: BASE, actorName: "Ada" })).toBe(
      "Edited 5 min ago by Ada",
    );
  });

  it("formats just-now and the one-minute boundary", () => {
    expect(
      describeLastEdited({ ...result, at: iso(-30_000) }, { now: BASE, actorName: "Ada" }),
    ).toBe("Edited just now by Ada");
    expect(
      describeLastEdited({ ...result, at: iso(-MIN) }, { now: BASE, actorName: "Ada" }),
    ).toBe("Edited 1 min ago by Ada");
  });

  it("formats hours", () => {
    expect(
      describeLastEdited({ ...result, at: iso(-3 * HOUR) }, { now: BASE, actorName: "Ada" }),
    ).toBe("Edited 3 hr ago by Ada");
  });

  it("formats days with singular and plural labels", () => {
    expect(
      describeLastEdited({ ...result, at: iso(-DAY) }, { now: BASE, actorName: "Ada" }),
    ).toBe("Edited 1 day ago by Ada");
    expect(
      describeLastEdited({ ...result, at: iso(-3 * DAY) }, { now: BASE, actorName: "Ada" }),
    ).toBe("Edited 3 days ago by Ada");
  });

  it("formats an absolute date beyond a week", () => {
    expect(
      describeLastEdited({ ...result, at: iso(-30 * DAY) }, { now: BASE, actorName: "Ada" }),
    ).toBe("Edited Apr 1, 2026 by Ada");
  });

  it("renders Never edited for a null result", () => {
    expect(describeLastEdited(null, { now: BASE, actorName: "Ada" })).toBe("Never edited");
  });

  it("omits the author when no name is known", () => {
    expect(describeLastEdited(result, { now: BASE, actorName: null })).toBe("Edited 5 min ago");
  });
});

describe("isStale", () => {
  it("is false when the last edit is within the window", () => {
    const events = [makeEdit({ id: "e1", at: iso(-1 * MIN) })];
    expect(isStale(events, { entityId: "p1", now: BASE, staleAfterMs: 5 * MIN })).toBe(false);
  });

  it("is true when the last edit is older than the window", () => {
    const events = [makeEdit({ id: "e1", at: iso(-10 * MIN) })];
    expect(isStale(events, { entityId: "p1", now: BASE, staleAfterMs: 5 * MIN })).toBe(true);
  });

  it("treats exactly staleAfterMs as stale", () => {
    const events = [makeEdit({ id: "e1", at: iso(-5 * MIN) })];
    expect(isStale(events, { entityId: "p1", now: BASE, staleAfterMs: 5 * MIN })).toBe(true);
  });

  it("is true when the entity has no edits", () => {
    expect(isStale([], { entityId: "p1", now: BASE, staleAfterMs: 5 * MIN })).toBe(true);
  });
});

describe("mergeActorMaps", () => {
  it("merges two maps into a fresh one", () => {
    expect(mergeActorMaps({ u1: "Ada" }, { u2: "Bob" })).toEqual({ u1: "Ada", u2: "Bob" });
  });

  it("lets the second map win on conflicts", () => {
    expect(mergeActorMaps({ u1: "Ada" }, { u1: "Ada Lovelace" })).toEqual({
      u1: "Ada Lovelace",
    });
  });

  it("does not mutate its inputs", () => {
    const a = { u1: "Ada" };
    const b = { u2: "Bob" };
    mergeActorMaps(a, b);
    expect(a).toEqual({ u1: "Ada" });
    expect(b).toEqual({ u2: "Bob" });
  });

  it("handles empty maps", () => {
    expect(mergeActorMaps({}, { u1: "Ada" })).toEqual({ u1: "Ada" });
    expect(mergeActorMaps({ u1: "Ada" }, {})).toEqual({ u1: "Ada" });
  });
});
