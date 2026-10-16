import { describe, expect, it } from "vitest";
import {
  applyDelta,
  diffSnapshot,
  hasChanges,
  isStale,
  type Snapshot,
  type SnapshotDelta,
  type SnapshotDocument,
} from "./sync-delta";

/**
 * Incremental syncing (docs/MISSING_FEATURES.md "Incremental syncing - sync
 * only changed blocks") — pure, deterministic, red-first.
 *
 * `src/lib/sync-delta.ts` did not exist when this file was first written
 * (module-not-found -> suite red; scripts/LOOP_PLAYBOOK.md "red-first"). The
 * whole engine is a sandbox: reconcile two document snapshots by `id`, carrying
 * `updatedAt` as the version marker, so a client can pull/merge only what moved.
 *
 * Contract pinned here:
 *  - `diffSnapshot(prev, next)` buckets documents by `id` into
 *    `added`/`updated`/`removed`/`unchanged`; `added`/`updated`/`unchanged`
 *    carry the NEXT document, `removed` carries the PREV one.
 *  - An `id` common to both is `updated` when its canonical document content
 *    differs — `updatedAt` alone is enough, and so is any other field.
 *  - Every bucket is ASCII-ascending by `id`, whatever the input order, so
 *    equal input always yields an identical delta.
 *  - `applyDelta(snapshot, delta)` folds a delta back onto a snapshot and
 *    returns an id-ordered array; round-tripping through `diffSnapshot` is
 *    content-exact (modulo `id` ordering, which is not part of the delta).
 *  - `isStale(local, remote)` compares `updatedAt` (ISO string, epoch ms or
 *    `Date`) and says whether the local copy must be refreshed.
 *  - Nothing is mutated and no helper throws on malformed input.
 */

/** Build a document with `extra` payload merged in, without `any`. */
const doc = (
  id: string,
  updatedAt: string | number | Date,
  extra: Record<string, unknown> = {},
): SnapshotDocument => ({ id, updatedAt, ...extra });

/** `id`-ascending copy of a snapshot, matching `applyDelta`'s output order. */
const byId = (snapshot: readonly SnapshotDocument[]): SnapshotDocument[] =>
  [...snapshot].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

const ids = (documents: readonly SnapshotDocument[]): string[] =>
  documents.map((entry) => entry.id);

describe("diffSnapshot — buckets", () => {
  it("returns everything in `unchanged` for equal snapshots", () => {
    const delta = diffSnapshot([doc("a", "t1"), doc("b", "t2")], [doc("a", "t1"), doc("b", "t2")]);
    expect(ids(delta.unchanged)).toEqual(["a", "b"]);
    expect(delta).toEqual({
      added: [],
      updated: [],
      removed: [],
      unchanged: [doc("a", "t1"), doc("b", "t2")],
    });
  });

  it("reports ids only in `next` as `added`, carrying the next document", () => {
    const delta = diffSnapshot([doc("a", "t1")], [doc("a", "t1"), doc("c", "t3", { title: "C" })]);
    expect(delta.added).toEqual([doc("c", "t3", { title: "C" })]);
    expect(ids(delta.removed)).toEqual([]);
    expect(ids(delta.updated)).toEqual([]);
  });

  it("reports ids only in `prev` as `removed`, carrying the previous document", () => {
    const delta = diffSnapshot([doc("a", "t1"), doc("b", "t2", { title: "B" })], [doc("a", "t1")]);
    expect(delta.removed).toEqual([doc("b", "t2", { title: "B" })]);
    expect(ids(delta.added)).toEqual([]);
    expect(ids(delta.updated)).toEqual([]);
  });

  it("classifies a mix of added, updated, removed and unchanged at once", () => {
    const delta = diffSnapshot(
      [doc("a", "t1"), doc("b", "t2"), doc("gone", "t9")],
      [doc("a", "t1"), doc("b", "t3"), doc("new", "t4")],
    );
    expect(ids(delta.unchanged)).toEqual(["a"]);
    expect(ids(delta.updated)).toEqual(["b"]);
    expect(ids(delta.added)).toEqual(["new"]);
    expect(ids(delta.removed)).toEqual(["gone"]);
  });

  it("degrades an empty side: empty prev is all added, empty next is all removed", () => {
    const allAdded = diffSnapshot([], [doc("a", "t1"), doc("b", "t2")]);
    expect(ids(allAdded.added)).toEqual(["a", "b"]);
    expect(allAdded).toEqual({
      added: [doc("a", "t1"), doc("b", "t2")],
      updated: [],
      removed: [],
      unchanged: [],
    });

    const allRemoved = diffSnapshot([doc("a", "t1"), doc("b", "t2")], []);
    expect(ids(allRemoved.removed)).toEqual(["a", "b"]);

    expect(diffSnapshot([], [])).toEqual({ added: [], updated: [], removed: [], unchanged: [] });
  });
});

describe("diffSnapshot — change detection", () => {
  it("treats a newer updatedAt alone as an update", () => {
    expect(diffSnapshot([doc("a", "t1")], [doc("a", "t2")]).updated).toEqual([doc("a", "t2")]);
  });

  it("treats a payload change with the same updatedAt as an update (defensive)", () => {
    const delta = diffSnapshot(
      [doc("a", "t1", { title: "before" })],
      [doc("a", "t1", { title: "after" })],
    );
    expect(delta.updated).toEqual([doc("a", "t1", { title: "after" })]);
    expect(delta.unchanged).toEqual([]);
  });

  it("ignores object key order, at the top level and nested", () => {
    const before = doc("a", "t1", { meta: { x: 1, y: 2 } });
    const after = doc("a", "t1", { meta: { y: 2, x: 1 } });
    expect(diffSnapshot([before], [after]).unchanged).toEqual([after]);
    expect(diffSnapshot([before], [after]).updated).toEqual([]);
  });

  it("compares arrays by content and position, so a reorder is an update", () => {
    const same = diffSnapshot([doc("a", "t1", { tags: ["x", "y"] })], [doc("a", "t1", { tags: ["x", "y"] })]);
    expect(ids(same.unchanged)).toEqual(["a"]);
    const reordered = diffSnapshot([doc("a", "t1", { tags: ["x", "y"] })], [doc("a", "t1", { tags: ["y", "x"] })]);
    expect(ids(reordered.updated)).toEqual(["a"]);
  });

  it("compares Date updatedAt by time, not identity", () => {
    const when = new Date("2026-10-15T09:00:00.000Z");
    const equal = diffSnapshot([doc("a", when)], [doc("a", new Date(when.getTime()))]);
    expect(ids(equal.unchanged)).toEqual(["a"]);
    const newer = diffSnapshot([doc("a", when)], [doc("a", new Date(when.getTime() + 1000))]);
    expect(ids(newer.updated)).toEqual(["a"]);
  });
});

describe("diffSnapshot — determinism & robustness", () => {
  it("orders every bucket by id regardless of input order", () => {
    const delta = diffSnapshot(
      [doc("c", "t1"), doc("a", "t1"), doc("removedB", "t1"), doc("removedA", "t1")],
      [doc("c", "t1"), doc("a", "t2"), doc("addedB", "t1"), doc("addedA", "t1")],
    );
    expect(ids(delta.added)).toEqual(["addedA", "addedB"]);
    expect(ids(delta.updated)).toEqual(["a"]);
    expect(ids(delta.removed)).toEqual(["removedA", "removedB"]);
    expect(ids(delta.unchanged)).toEqual(["c"]);
  });

  it("keeps the first occurrence of a duplicate id", () => {
    const delta = diffSnapshot([doc("a", "t1", { tag: "first" }), doc("a", "t2", { tag: "second" })], []);
    expect(delta.removed).toEqual([doc("a", "t1", { tag: "first" })]);
  });

  it("never throws on non-array or malformed input", () => {
    expect(diffSnapshot(null, undefined)).toEqual({ added: [], updated: [], removed: [], unchanged: [] });
    expect(diffSnapshot({} as unknown as Snapshot, [doc("a", "t1")]).added).toEqual([doc("a", "t1")]);
    const malformed = [doc("ok", "t1"), null, 42, { updatedAt: "t1" }, { id: "" }] as unknown as Snapshot;
    expect(ids(diffSnapshot([], malformed).added)).toEqual(["ok"]);
  });

  it("does not mutate either input", () => {
    const prev = [doc("a", "t1", { nested: { keep: true } })];
    const next = [doc("a", "t2", { nested: { keep: false } })];
    diffSnapshot(prev, next);
    expect(prev).toEqual([doc("a", "t1", { nested: { keep: true } })]);
    expect(next).toEqual([doc("a", "t2", { nested: { keep: false } })]);
  });

  it("is deterministic: the same inputs give deeply equal deltas", () => {
    const prev = [doc("b", "t1"), doc("a", "t1")];
    const next = [doc("b", "t2"), doc("a", "t1"), doc("c", "t1")];
    expect(diffSnapshot(prev, next)).toEqual(diffSnapshot(prev, next));
  });
});

describe("applyDelta", () => {
  it("returns an id-ordered copy for an empty delta and does not mutate", () => {
    const snapshot = [doc("b", "t1"), doc("a", "t1")];
    const delta: SnapshotDelta = { added: [], updated: [], removed: [], unchanged: [] };
    const applied = applyDelta(snapshot, delta);
    expect(applied).toEqual([doc("a", "t1"), doc("b", "t1")]);
    expect(snapshot).toEqual([doc("b", "t1"), doc("a", "t1")]);
  });

  it("inserts added documents", () => {
    const applied = applyDelta(
      [doc("a", "t1")],
      { added: [doc("b", "t2")], updated: [], removed: [], unchanged: [] },
    );
    expect(applied).toEqual([doc("a", "t1"), doc("b", "t2")]);
  });

  it("replaces updated documents in place", () => {
    const applied = applyDelta(
      [doc("a", "t1", { title: "old" })],
      { added: [], updated: [doc("a", "t2", { title: "new" })], removed: [], unchanged: [] },
    );
    expect(applied).toEqual([doc("a", "t2", { title: "new" })]);
  });

  it("drops removed documents", () => {
    const applied = applyDelta(
      [doc("a", "t1"), doc("b", "t2")],
      { added: [], updated: [], removed: [doc("a", "t1")], unchanged: [] },
    );
    expect(applied).toEqual([doc("b", "t2")]);
  });

  it("round-trips: applying its own snapshot delta reproduces the next snapshot", () => {
    const prev = [doc("b", "t1"), doc("a", "t1", { title: "A" })];
    const next = [doc("a", "t2", { title: "A2" }), doc("c", "t3")];
    expect(applyDelta(prev, diffSnapshot(prev, next))).toEqual(byId(next));
    expect(applyDelta(prev, diffSnapshot(prev, prev))).toEqual(byId(prev));
  });

  it("lets a later upsert win when an id is both removed and re-added", () => {
    const applied = applyDelta(
      [doc("a", "t1")],
      { added: [doc("a", "t2", { revived: true })], updated: [], removed: [doc("a", "t1")], unchanged: [] },
    );
    expect(applied).toEqual([doc("a", "t2", { revived: true })]);
  });

  it("upserts an update for an id absent from the snapshot", () => {
    const applied = applyDelta(
      [],
      { added: [], updated: [doc("a", "t1")], removed: [], unchanged: [] },
    );
    expect(applied).toEqual([doc("a", "t1")]);
  });

  it("does not mutate the snapshot or the delta", () => {
    const snapshot = [doc("a", "t1")];
    const delta: SnapshotDelta = {
      added: [doc("b", "t2")],
      updated: [doc("a", "t3")],
      removed: [],
      unchanged: [],
    };
    applyDelta(snapshot, delta);
    expect(snapshot).toEqual([doc("a", "t1")]);
    expect(delta).toEqual({
      added: [doc("b", "t2")],
      updated: [doc("a", "t3")],
      removed: [],
      unchanged: [],
    });
  });

  it("degrades null/undefined snapshot and delta instead of throwing", () => {
    expect(applyDelta(null, undefined)).toEqual([]);
    expect(applyDelta(undefined, { added: [doc("a", "t1")], updated: [], removed: [], unchanged: [] })).toEqual([
      doc("a", "t1"),
    ]);
  });
});

describe("isStale", () => {
  it("is not stale when there is no remote copy", () => {
    expect(isStale(doc("a", "t1"), null)).toBe(false);
    expect(isStale(doc("a", "t1"), undefined)).toBe(false);
    expect(isStale(null, null)).toBe(false);
  });

  it("is stale when only the remote copy exists", () => {
    expect(isStale(null, doc("a", "t1"))).toBe(true);
    expect(isStale(undefined, doc("a", "t1"))).toBe(true);
  });

  it("is stale only when the remote is newer", () => {
    const local = doc("a", "2026-10-15T09:00:00.000Z");
    expect(isStale(local, doc("a", "2026-10-15T09:00:01.000Z"))).toBe(true);
    expect(isStale(local, doc("a", "2026-10-15T08:59:59.000Z"))).toBe(false);
    expect(isStale(local, doc("a", "2026-10-15T09:00:00.000Z"))).toBe(false);
    expect(isStale(local, local)).toBe(false);
  });

  it("compares ISO strings and epoch milliseconds on the same clock", () => {
    const epoch = Date.parse("2026-10-15T09:00:00.000Z");
    expect(isStale(doc("a", epoch), doc("a", "2026-10-15T09:00:01.000Z"))).toBe(true);
    expect(isStale(doc("a", "2026-10-15T09:00:00.000Z"), doc("a", epoch))).toBe(false);
  });

  it("compares Date objects", () => {
    const local = new Date("2026-10-15T09:00:00.000Z");
    expect(isStale(doc("a", local), doc("a", new Date("2026-10-15T10:00:00.000Z")))).toBe(true);
    expect(isStale(doc("a", local), doc("a", new Date(local.getTime())))).toBe(false);
  });

  it("falls back to the raw text when a timestamp cannot be parsed", () => {
    expect(isStale(doc("a", "not-a-date"), doc("a", "also-bad"))).toBe(true);
    expect(isStale(doc("a", "not-a-date"), doc("a", "not-a-date"))).toBe(false);
    expect(isStale(doc("a", "broken"), doc("a", "2026-10-15T09:00:00.000Z"))).toBe(true);
  });
});

describe("hasChanges", () => {
  it("is false when only `unchanged` is populated", () => {
    expect(hasChanges({ added: [], updated: [], removed: [], unchanged: [doc("a", "t1")] })).toBe(false);
  });

  it("is true for any add, update or removal", () => {
    expect(hasChanges({ added: [doc("a", "t1")], updated: [], removed: [], unchanged: [] })).toBe(true);
    expect(hasChanges({ added: [], updated: [doc("a", "t2")], removed: [], unchanged: [] })).toBe(true);
    expect(hasChanges({ added: [], updated: [], removed: [doc("a", "t1")], unchanged: [] })).toBe(true);
  });

  it("is false for null, undefined or an empty delta", () => {
    expect(hasChanges(null)).toBe(false);
    expect(hasChanges(undefined)).toBe(false);
    expect(hasChanges({ added: [], updated: [], removed: [], unchanged: [] })).toBe(false);
  });
});
