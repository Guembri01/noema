import { describe, expect, it } from "vitest";
import {
  buildSyncPayload,
  deltaHasChanges,
  documentIsStale,
  acceptDelta,
  pullDelta,
  receiveSyncPayload,
  resolveDocConflict,
  surfaceConflicts,
} from "./offline-provider";
import { describeConflict, type RecordVersion } from "@/lib/sync-conflict";
import type { DocEntity, Op } from "@/lib/incremental-sync";
import type { SnapshotDocument } from "@/lib/sync-delta";

/**
 * Wiring proof for `incremental-sync.ts`, `sync-conflict.ts` and `sync-delta.ts`
 * through the offline provider's pure bridges.
 *
 * Everything here is DOM-free and clock-free, so it runs in the Node sandbox:
 * an op-log round-trip (build → receive → reconstruct), a malformed-log
 * rejection, a conflict surfaced with provenance and resolved, and the reused
 * coarse `sync-delta` path.
 */

/** Build a fully-formed op; override the fields a test cares about. */
const op = (over: Partial<Op> & { id: string; seq: number }): Op => ({
  entity: "block",
  entityId: "x",
  kind: "update",
  at: 0,
  actorId: "me",
  ...over,
});

/** Build a stamped field version for the logical-clock conflict path. */
const version = (
  clock: number,
  actorId: string,
  value: unknown,
  at = 0,
): RecordVersion => ({ clock, actorId, value, at });

const base: DocEntity[] = [
  { id: "a", text: "hello" },
  { id: "b", text: "world" },
];

const next: DocEntity[] = [
  { id: "a", text: "hello!" }, // update
  { id: "c", text: "new" }, // create
  // b deleted
];

describe("op-log round-trip (incremental-sync)", () => {
  it("computes exactly one op per changed id, ascending by id", () => {
    const payload = buildSyncPayload(base, next, { actorId: "me", at: 10 });
    expect(payload.ops.map((entry) => [entry.entityId, entry.kind])).toEqual([
      ["a", "update"],
      ["b", "delete"],
      ["c", "create"],
    ]);
    expect(payload.cursor).toBe(3);
  });

  it("folds an incoming log back onto the base document", () => {
    const payload = buildSyncPayload(base, next, { actorId: "me", at: 10 });
    const result = receiveSyncPayload(base, payload.ops);

    expect(result.rejected).toBe(false);
    expect(result.validation.valid).toBe(true);
    expect(result.applied).toBe(payload.ops.length);

    const byId = new Map(result.doc.map((entity) => [entity.id, entity]));
    expect(result.doc.map((entity) => entity.id)).toEqual(["a", "c"]);
    expect(byId.get("a")).toMatchObject({ text: "hello!" });
    expect(byId.get("c")).toMatchObject({ text: "new" });
    expect(byId.has("b")).toBe(false);
  });

  it("applies only the ops after a cursor (incremental pull)", () => {
    const payload = buildSyncPayload(base, next, { actorId: "me", at: 10 });
    const result = receiveSyncPayload(base, payload.ops, 1);
    expect(result.applied).toBe(2);
    expect(result.doc.map((entity) => entity.id)).toEqual(["a", "c"]);
  });

  it("rejects a structurally invalid log instead of half-applying it", () => {
    const log: Op[] = [
      op({ id: "x", seq: 1, entityId: "a" }),
      op({ id: "y", seq: 1, entityId: "c" }), // duplicate seq
    ];
    const result = receiveSyncPayload(base, log);
    expect(result.validation.valid).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.validation.issues[0].kind).toBe("duplicate-seq");
    // The document is returned untouched (id-ordered).
    expect(result.doc.map((entity) => entity.id)).toEqual(["a", "b"]);
  });
});

describe("conflict surfacing (sync-conflict)", () => {
  const localDoc = {
    title: version(1, "alice", "A"),
    body: version(1, "alice", "same"),
  };
  const remoteDoc = {
    title: version(2, "bob", "B"),
    body: version(1, "alice", "same"),
  };

  it("surfaces only the genuinely divergent field, with provenance", () => {
    const surface = surfaceConflicts(localDoc, remoteDoc);
    expect(surface.doc.strategy).toBe("manual");
    expect(surface.views).toHaveLength(1);

    const [view] = surface.views;
    expect(view.conflict.field).toBe("title");
    expect(view.conflict.actors).toEqual(["alice", "bob"]);
    expect(view.conflict.before.value).toBe("A");
    expect(view.conflict.after.value).toBe("B");
    expect(view.summary).toBe(describeConflict(view.conflict));
    expect(view.summary).toContain("alice@1");
    expect(view.summary).toContain("bob@2");
    expect(view.summary).toContain("unresolved");

    // Manual keeps the untouched field and defers the conflict.
    expect(surface.doc.fields.body).toBe("same");
    expect(surface.doc.fields.title).toBeUndefined();
  });

  it("resolves a surfaced conflict to either side, keeping provenance", () => {
    const surface = surfaceConflicts(localDoc, remoteDoc);

    const keptLoser = resolveDocConflict(surface.doc, "title", "before");
    expect(keptLoser.fields.title).toBe("A");
    expect(keptLoser.conflicts[0].resolved).toBe(true);
    expect(keptLoser.conflicts[0].before.value).toBe("A");
    expect(keptLoser.conflicts[0].after.value).toBe("B");

    const keptWinner = resolveDocConflict(surface.doc, "title", "after");
    expect(keptWinner.fields.title).toBe("B");
    expect(keptWinner.conflicts[0].resolved).toBe(true);
  });
});

describe("coarse document-set sync (sync-delta, reused)", () => {
  const prev: SnapshotDocument[] = [
    { id: "p1", updatedAt: 1, title: "x" },
    { id: "p2", updatedAt: 1 },
  ];
  const after: SnapshotDocument[] = [
    { id: "p1", updatedAt: 2, title: "y" },
    { id: "p3", updatedAt: 3 },
  ];

  it("buckets the id space into added/updated/removed", () => {
    const delta = pullDelta(prev, after);
    expect(delta.added.map((doc) => doc.id)).toEqual(["p3"]);
    expect(delta.updated.map((doc) => doc.id)).toEqual(["p1"]);
    expect(delta.removed.map((doc) => doc.id)).toEqual(["p2"]);
    expect(deltaHasChanges(delta)).toBe(true);
  });

  it("folds a delta back onto the snapshot", () => {
    const folded = acceptDelta(prev, pullDelta(prev, after));
    expect(folded.map((doc) => doc.id)).toEqual(["p1", "p3"]);
  });

  it("answers the staleness question from two updatedAt stamps", () => {
    expect(documentIsStale({ id: "p1", updatedAt: 1 }, { id: "p1", updatedAt: 2 })).toBe(true);
    expect(documentIsStale({ id: "p1", updatedAt: 2 }, { id: "p1", updatedAt: 2 })).toBe(false);
    expect(documentIsStale(null, { id: "p1", updatedAt: 2 })).toBe(true);
    expect(documentIsStale({ id: "p1", updatedAt: 2 }, null)).toBe(false);
  });
});
