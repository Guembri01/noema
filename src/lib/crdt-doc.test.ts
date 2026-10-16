import { describe, expect, it } from "vitest";
import {
  applyOps,
  compareOps,
  compareVectors,
  createDoc,
  deserializeDoc,
  isTombstone,
  liveBlocks,
  mergeDocs,
  mergeVectors,
  serializeDoc,
  type BlockOp,
  type VersionVector,
} from "./crdt-doc";

/**
 * CRDT data model (docs/specs/realtime-collab.md §10, matrix row 353).
 *
 * Red-first: `src/lib/crdt-doc.ts` did not exist when this file was written, so
 * the suite fails on the missing module until the pure engine lands. These are
 * the deterministic, conflict-free pieces behind multiplayer block editing:
 * logical-clock version vectors, last-writer-wins block-op merge, tombstones
 * and a canonical snapshot format — all provable without a socket, a server or
 * a database.
 */

/** Build a `set` op (author a block value at a logical clock). */
const set = (
  id: string,
  blockId: string,
  clientId: string,
  clock: number,
  value: unknown,
): BlockOp => ({ id, blockId, clientId, clock, kind: "set", value });

/** Build a `delete` op (tombstone at a logical clock). */
const del = (id: string, blockId: string, clientId: string, clock: number): BlockOp => ({
  id,
  blockId,
  clientId,
  clock,
  kind: "delete",
});

describe("mergeVectors", () => {
  it("unions disjoint components", () => {
    expect(mergeVectors({ alice: 1 }, { bob: 2 })).toEqual({ alice: 1, bob: 2 });
  });

  it("takes the maximum of each shared component", () => {
    expect(mergeVectors({ alice: 1, bob: 5 }, { bob: 2, carol: 3 })).toEqual({
      alice: 1,
      bob: 5,
      carol: 3,
    });
  });

  it("is idempotent", () => {
    const vector: VersionVector = { alice: 3, bob: 1 };
    expect(mergeVectors(vector, vector)).toEqual({ alice: 3, bob: 1 });
  });

  it("is commutative", () => {
    const a: VersionVector = { alice: 1, bob: 3 };
    const b: VersionVector = { bob: 2, carol: 4 };
    expect(mergeVectors(a, b)).toEqual(mergeVectors(b, a));
  });

  it("drops non-positive and non-finite components", () => {
    expect(mergeVectors({ alice: 0, bob: -1, carol: Number.NaN }, { dave: 2 })).toEqual({
      dave: 2,
    });
  });

  it("returns a fresh object and never mutates its inputs", () => {
    const a: VersionVector = { alice: 1 };
    const b: VersionVector = { bob: 2 };
    const merged = mergeVectors(a, b);
    expect(merged).not.toBe(a);
    expect(a).toEqual({ alice: 1 });
    expect(b).toEqual({ bob: 2 });
  });
});

describe("compareVectors", () => {
  it("reports equality for the same components", () => {
    expect(compareVectors({}, {})).toBe("equal");
    expect(compareVectors({ alice: 2 }, { alice: 2 })).toBe("equal");
  });

  it("treats a missing component as zero", () => {
    expect(compareVectors({ alice: 1 }, { alice: 1, bob: 0 })).toBe("equal");
  });

  it("reports less when one vector is dominated", () => {
    expect(compareVectors({ alice: 1 }, { alice: 2 })).toBe("less");
    expect(compareVectors({ alice: 1 }, { alice: 1, bob: 2 })).toBe("less");
  });

  it("reports greater when one vector dominates", () => {
    expect(compareVectors({ alice: 2 }, { alice: 1 })).toBe("greater");
    expect(compareVectors({ alice: 1, bob: 2 }, { alice: 1 })).toBe("greater");
  });

  it("reports concurrency when neither dominates", () => {
    expect(compareVectors({ alice: 2, bob: 1 }, { alice: 1, bob: 2 })).toBe("concurrent");
    expect(compareVectors({ alice: 1 }, { bob: 1 })).toBe("concurrent");
  });

  it("normalizes non-finite components before comparing", () => {
    expect(compareVectors({ alice: Number.NaN }, {})).toBe("equal");
  });
});

describe("compareOps", () => {
  it("ranks a higher logical clock later", () => {
    const low = set("op", "b", "alice", 1, "x");
    const high = set("op", "b", "alice", 2, "x");
    expect(compareOps(low, high)).toBeLessThan(0);
    expect(compareOps(high, low)).toBeGreaterThan(0);
  });

  it("breaks a clock tie by clientId ascending", () => {
    const alice = set("op", "b", "alice", 1, "x");
    const bob = set("op", "b", "bob", 1, "x");
    expect(compareOps(alice, bob)).toBeLessThan(0);
    expect(compareOps(bob, alice)).toBeGreaterThan(0);
  });

  it("breaks a clock+client tie by op id ascending", () => {
    const opX = set("op-x", "b", "alice", 1, "x");
    const opY = set("op-y", "b", "alice", 1, "y");
    expect(compareOps(opX, opY)).toBeLessThan(0);
    expect(compareOps(opY, opX)).toBeGreaterThan(0);
  });

  it("reports equality for an identical op", () => {
    const op = set("op", "b", "alice", 1, "x");
    expect(compareOps(op, op)).toBe(0);
  });
});

describe("applyOps", () => {
  it("applies a set op and updates the version vector", () => {
    const doc = applyOps(createDoc(), [set("s1", "b1", "alice", 1, "hello")]);
    expect(doc.blocks.b1).toMatchObject({ id: "b1", deleted: false, value: "hello" });
    expect(doc.vector).toEqual({ alice: 1 });
  });

  it("keeps the highest clock per block regardless of arrival order", () => {
    const older = set("s1", "b1", "alice", 1, "old");
    const newer = set("s2", "b1", "alice", 2, "new");
    expect(liveBlocks(applyOps(createDoc(), [newer, older]))[0].value).toBe("new");
    expect(liveBlocks(applyOps(createDoc(), [older, newer]))[0].value).toBe("new");
  });

  it("breaks concurrent clock ties by clientId, deterministically", () => {
    const alice = set("a", "b1", "alice", 1, "A");
    const bob = set("b", "b1", "bob", 1, "B");
    const left = applyOps(createDoc(), [alice, bob]);
    const right = applyOps(createDoc(), [bob, alice]);
    expect(liveBlocks(left)[0].value).toBe("B");
    expect(serializeDoc(left)).toBe(serializeDoc(right));
  });

  it("breaks a full clock+client tie by op id, deterministically", () => {
    const opX = set("op-x", "b1", "alice", 1, "X");
    const opY = set("op-y", "b1", "alice", 1, "Y");
    expect(liveBlocks(applyOps(createDoc(), [opX, opY]))[0].value).toBe("Y");
    expect(liveBlocks(applyOps(createDoc(), [opY, opX]))[0].value).toBe("Y");
  });

  it("records every client's highest clock, even for losing ops", () => {
    const doc = applyOps(createDoc(), [
      set("s1", "b1", "alice", 1, "one"),
      set("s2", "b1", "alice", 2, "two"),
      set("lose", "b1", "bob", 1, "beaten"),
    ]);
    expect(doc.vector).toEqual({ alice: 2, bob: 1 });
  });

  it("tombstones a deleted block and hides it from liveBlocks", () => {
    const doc = applyOps(createDoc(), [del("d1", "b1", "alice", 1)]);
    expect(doc.blocks.b1.deleted).toBe(true);
    expect(liveBlocks(doc)).toEqual([]);
  });

  it("lets a delete win a concurrent tie by clientId", () => {
    const doc = applyOps(createDoc(), [
      set("s", "b1", "alice", 1, "value"),
      del("d", "b1", "bob", 1),
    ]);
    expect(doc.blocks.b1.deleted).toBe(true);
    expect(liveBlocks(doc)).toEqual([]);
  });

  it("never resurrects a tombstone from a lower clock", () => {
    const stale = set("stale", "b1", "alice", 1, "stale");
    const remove = del("d", "b1", "bob", 2);
    const doc = applyOps(createDoc(), [stale, remove]);
    expect(doc.blocks.b1.deleted).toBe(true);
    expect(liveBlocks(doc)).toEqual([]);
  });

  it("resurrects a tombstone when a strictly higher clock sets it", () => {
    const remove = del("d", "b1", "alice", 1);
    const revive = set("r", "b1", "alice", 2, "back");
    const doc = applyOps(createDoc(), [remove, revive]);
    expect(doc.blocks.b1.deleted).toBe(false);
    expect(liveBlocks(doc)[0].value).toBe("back");
  });

  it("converges when the same ops arrive in a different order", () => {
    const ops = [
      set("s1", "b1", "alice", 1, "A"),
      del("d1", "b2", "bob", 3),
      set("s2", "b1", "bob", 2, "B"),
      set("s3", "b3", "carol", 1, "C"),
      del("d2", "b3", "alice", 2),
    ];
    const forward = applyOps(createDoc(), ops);
    const backward = applyOps(createDoc(), [...ops].reverse());
    expect(serializeDoc(forward)).toBe(serializeDoc(backward));
  });

  it("is idempotent when the same ops are applied twice", () => {
    const ops = [set("s1", "b1", "alice", 1, "v"), del("d1", "b2", "bob", 2)];
    const once = applyOps(createDoc(), ops);
    const twice = applyOps(once, ops);
    expect(serializeDoc(twice)).toBe(serializeDoc(once));
  });

  it("skips malformed ops instead of throwing", () => {
    const ops: BlockOp[] = [
      { id: "", blockId: "b", clientId: "alice", clock: 1, kind: "set", value: 1 },
      { id: "y", blockId: "", clientId: "alice", clock: 1, kind: "set", value: 1 },
      { id: "z", blockId: "b", clientId: "", clock: 1, kind: "set", value: 1 },
      { id: "w", blockId: "b", clientId: "alice", clock: Number.NaN, kind: "set", value: 1 },
      set("ok", "b", "alice", 1, "kept"),
    ];
    const doc = applyOps(createDoc(), ops);
    expect(Object.keys(doc.blocks)).toEqual(["b"]);
    expect(doc.blocks.b.value).toBe("kept");
    expect(doc.vector).toEqual({ alice: 1 });
  });

  it("returns an equal doc for an empty op list", () => {
    expect(applyOps(createDoc(), [])).toEqual(createDoc());
  });

  it("returns a fresh doc and never mutates its inputs", () => {
    const doc = createDoc();
    const ops = [set("s1", "b1", "alice", 1, { text: "hi" })];
    const out = applyOps(doc, ops);
    expect(out).not.toBe(doc);
    expect(doc.blocks).toEqual({});
    expect(doc.vector).toEqual({});
    expect(ops[0].value).toEqual({ text: "hi" });
  });

  it("tombstones a block deleted before it was ever set", () => {
    const doc = applyOps(createDoc(), [del("d", "ghost", "alice", 1)]);
    expect(doc.blocks.ghost.deleted).toBe(true);
    expect(liveBlocks(doc)).toEqual([]);
  });
});

describe("liveBlocks", () => {
  it("returns live blocks sorted by id and hides tombstones", () => {
    const doc = applyOps(createDoc(), [
      set("o2", "b2", "alice", 1, "two"),
      set("o1", "b1", "alice", 1, "one"),
      del("o3", "b3", "alice", 1),
    ]);
    expect(liveBlocks(doc).map((block) => block.id)).toEqual(["b1", "b2"]);
  });

  it("returns a fresh array", () => {
    const doc = applyOps(createDoc(), [set("s", "b1", "alice", 1, "v")]);
    const live = liveBlocks(doc);
    expect(live).not.toBe(liveBlocks(doc));
    expect(liveBlocks(createDoc())).toEqual([]);
  });
});

describe("isTombstone", () => {
  it("is true only for a known, deleted block", () => {
    const doc = applyOps(createDoc(), [
      set("s", "live", "alice", 1, "v"),
      del("d", "dead", "alice", 1),
    ]);
    expect(isTombstone(doc, "dead")).toBe(true);
    expect(isTombstone(doc, "live")).toBe(false);
    expect(isTombstone(doc, "missing")).toBe(false);
  });
});

describe("mergeDocs", () => {
  it("picks the winning block state per block and merges vectors", () => {
    const left = applyOps(createDoc(), [set("a", "b1", "alice", 1, "L")]);
    const right = applyOps(createDoc(), [set("b", "b1", "bob", 2, "R")]);
    const merged = mergeDocs(left, right);
    expect(liveBlocks(merged)[0].value).toBe("R");
    expect(merged.vector).toEqual({ alice: 1, bob: 2 });
  });

  it("is commutative up to canonical serialization", () => {
    const left = applyOps(createDoc(), [set("a", "b1", "alice", 1, "L")]);
    const right = applyOps(createDoc(), [del("b", "b1", "bob", 2)]);
    expect(serializeDoc(mergeDocs(left, right))).toBe(serializeDoc(mergeDocs(right, left)));
  });

  it("converges a partition of the op log back to the whole", () => {
    const ops = [
      set("s1", "b1", "alice", 1, "A"),
      del("d1", "b2", "bob", 3),
      set("s2", "b1", "carol", 2, "B"),
      del("d2", "b3", "alice", 2),
      set("s3", "b3", "bob", 4, "C"),
    ];
    const whole = applyOps(createDoc(), ops);
    const left = applyOps(createDoc(), ops.filter((_, index) => index % 2 === 0));
    const right = applyOps(createDoc(), ops.filter((_, index) => index % 2 === 1));
    expect(serializeDoc(mergeDocs(left, right))).toBe(serializeDoc(whole));
  });

  it("merges two empty docs into an empty doc", () => {
    expect(mergeDocs(createDoc(), createDoc())).toEqual(createDoc());
  });
});

describe("serializeDoc / deserializeDoc", () => {
  it("serializes equal docs identically regardless of insertion order", () => {
    const one = applyOps(createDoc(), [
      set("a", "b1", "alice", 1, "x"),
      set("b", "b2", "alice", 1, "y"),
    ]);
    const two = applyOps(createDoc(), [
      set("b", "b2", "alice", 1, "y"),
      set("a", "b1", "alice", 1, "x"),
    ]);
    expect(serializeDoc(one)).toBe(serializeDoc(two));
  });

  it("canonicalizes nested value key order", () => {
    const one = applyOps(createDoc(), [
      set("a", "b1", "alice", 1, { z: 1, a: { y: 2, b: 3 } }),
    ]);
    const two = applyOps(createDoc(), [
      set("a", "b1", "alice", 1, { a: { b: 3, y: 2 }, z: 1 }),
    ]);
    expect(serializeDoc(one)).toBe(serializeDoc(two));
  });

  it("round-trips a document exactly", () => {
    const doc = applyOps(createDoc(), [
      set("a", "b1", "alice", 1, { text: "hi" }),
      del("d", "b2", "bob", 2),
    ]);
    expect(deserializeDoc(serializeDoc(doc))).toStrictEqual(doc);
  });

  it("preserves tombstones across a round-trip", () => {
    const doc = applyOps(createDoc(), [del("d", "b1", "alice", 1)]);
    const text = serializeDoc(doc);
    expect(text).toContain('"deleted":true');
    expect(deserializeDoc(text).blocks.b1.deleted).toBe(true);
  });

  it("degrades malformed input to an empty document", () => {
    expect(deserializeDoc("not json")).toEqual(createDoc());
    expect(deserializeDoc("")).toEqual(createDoc());
    expect(deserializeDoc("[]")).toEqual(createDoc());
    expect(deserializeDoc("null")).toEqual(createDoc());
    expect(deserializeDoc(undefined)).toEqual(createDoc());
  });

  it("drops malformed block entries but keeps the valid vector", () => {
    const raw = JSON.stringify({
      blocks: {
        good: { id: "good", deleted: false, clock: 1, clientId: "alice", opId: "o", value: 1 },
        bad: { id: "bad" },
      },
      vector: { alice: 1 },
    });
    const doc = deserializeDoc(raw);
    expect(Object.keys(doc.blocks)).toEqual(["good"]);
    expect(doc.vector).toEqual({ alice: 1 });
  });

  it("is idempotent under a second round-trip", () => {
    const doc = applyOps(createDoc(), [set("a", "b1", "alice", 1, "v")]);
    const once = deserializeDoc(serializeDoc(doc));
    expect(serializeDoc(once)).toBe(serializeDoc(doc));
    expect(serializeDoc(deserializeDoc(serializeDoc(once)))).toBe(serializeDoc(doc));
  });
});
