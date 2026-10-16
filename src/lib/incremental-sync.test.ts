import { describe, expect, it } from "vitest";
import {
  applyOps,
  buildOps,
  compactOps,
  cursorOf,
  hashDoc,
  opsSince,
  validateOpLog,
  type BuildContext,
  type DocEntity,
  type Op,
} from "./incremental-sync";

/**
 * Incremental sync engine / op-log (§17 "Incremental syncing",
 * docs/FEATURE_MATRIX.md "Sync only changed blocks") — pure, deterministic,
 * red-first.
 *
 * `src/lib/incremental-sync.ts` did not exist when this file was first run
 * (module-not-found -> suite red; scripts/LOOP_PLAYBOOK.md "red-first"). The
 * whole engine is a sandbox: diff two entity arrays by `id` into a minimal,
 * `seq`-ordered op-log (`buildOps`), fold that log back onto a document
 * (`applyOps`), and reason about it — collapse redundant chains
 * (`compactOps`), read cursors (`cursorOf`/`opsSince`), cheap-compare
 * documents (`hashDoc`) and audit a log's structure (`validateOpLog`).
 *
 * Contract pinned here:
 *  - an `Op` names one change to one entity: `{id, seq, entity, entityId,
 *    kind, path?, before?, after?, at, actorId}`;
 *  - `buildOps(prev, next, ctx)` emits create/update/delete *only* where a
 *    shared id's canonical content actually differs, `seq`-ordered, never
 *    mutating either side;
 *  - `applyOps(doc, ops)` is pure, applies ops in ascending `seq` and is
 *    idempotent — re-applying an already-applied log changes nothing;
 *  - `applyOps(prev, buildOps(prev, next))` reproduces `next` (content-exact,
 *    id-ordered);
 *  - `compactOps` collapses redundant create/update/delete chains while
 *    preserving the net effect; cursors/hash/validation stay total and
 *    non-mutating (malformed input degrades, nothing throws).
 */

/** Build a document entity with `extra` payload merged in, without `any`. */
const entity = (id: string, extra: Record<string, unknown> = {}): DocEntity => ({ id, ...extra });

/** `id`-ascending copy of a document, matching `applyOps`'s output order. */
const byId = (doc: readonly DocEntity[]): DocEntity[] =>
  [...doc].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

/** Readable fingerprint of a log: `seq:kind:entityId` in array order. */
const shape = (ops: readonly Op[]): string[] =>
  ops.map((op) => `${op.seq}:${op.kind}:${op.entityId}`);

const baseCtx: BuildContext = { entity: "block", actorId: "u1", at: 1000 };

const build = (
  prev: readonly DocEntity[],
  next: readonly DocEntity[],
  ctx: BuildContext = baseCtx,
): Op[] => buildOps(prev, next, ctx);

/** Mint an op for the apply/compact/cursor suites, defaults filling the rest. */
const op = (over: Partial<Op> & Pick<Op, "seq" | "entityId" | "kind">): Op => {
  const base: Op = {
    id: `op-${over.seq}`,
    seq: over.seq,
    entity: "block",
    entityId: over.entityId,
    kind: over.kind,
    at: 0,
    actorId: "u1",
  };
  return { ...base, ...over };
};

describe("buildOps — minimal diff by id", () => {
  it("returns no ops for identical documents", () => {
    expect(build([entity("a", { v: 1 })], [entity("a", { v: 1 })])).toEqual([]);
  });

  it("returns no ops for two empty documents", () => {
    expect(build([], [])).toEqual([]);
  });

  it("emits one create per added id, ordered by id", () => {
    const ops = build([], [entity("a"), entity("b", { text: "B" })]);
    expect(shape(ops)).toEqual(["1:create:a", "2:create:b"]);
    expect(ops[0]).toMatchObject({ entity: "block", actorId: "u1", at: 1000, path: [0] });
    expect(ops[0].id).toBe("block:a:1");
    expect(ops[0].after).toEqual(entity("a"));
    expect(ops[0].before).toBeUndefined();
    expect(ops[1].path).toEqual([1]);
  });

  it("emits one delete per removed id, carrying the previous entity", () => {
    const ops = build([entity("a"), entity("b", { text: "B" })], []);
    expect(shape(ops)).toEqual(["1:delete:a", "2:delete:b"]);
    expect(ops[0].before).toEqual(entity("a"));
    expect(ops[0].after).toBeUndefined();
    expect(ops[0].path).toEqual([0]);
  });

  it("emits an update only where a shared id's content changed", () => {
    const ops = build(
      [entity("a", { text: "old" }), entity("b")],
      [entity("a", { text: "new" }), entity("b")],
    );
    expect(shape(ops)).toEqual(["1:update:a"]);
    expect(ops[0].before).toEqual(entity("a", { text: "old" }));
    expect(ops[0].after).toEqual(entity("a", { text: "new" }));
  });

  it("classifies a mix of add/update/delete at once, in id order", () => {
    const ops = build(
      [entity("a"), entity("b", { text: "B1" }), entity("gone")],
      [entity("a"), entity("b", { text: "B2" }), entity("new")],
    );
    expect(shape(ops)).toEqual(["1:update:b", "2:delete:gone", "3:create:new"]);
  });

  it("ignores object key order (no update for reordered keys)", () => {
    expect(
      build([entity("a", { meta: { x: 1, y: 2 } })], [entity("a", { meta: { y: 2, x: 1 } })]),
    ).toEqual([]);
  });

  it("treats an array reorder as a change", () => {
    const ops = build(
      [entity("a", { tags: ["x", "y"] })],
      [entity("a", { tags: ["y", "x"] })],
    );
    expect(shape(ops)).toEqual(["1:update:a"]);
  });

  it("orders seq ascending and deterministically regardless of array order", () => {
    const prev = [entity("c", { v: 1 }), entity("a", { v: 1 })];
    const next = [entity("c", { v: 2 }), entity("a", { v: 1 }), entity("b")];
    const first = build(prev, next);
    expect(shape(first)).toEqual(["1:create:b", "2:update:c"]);
    expect(first.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(build(prev, next)).toEqual(first);
  });

  it("records the entity kind, actor and clock from the context", () => {
    const ops = buildOps([], [entity("r")], { entity: "row", actorId: "u2", at: 42 });
    expect(ops[0]).toMatchObject({ entity: "row", actorId: "u2", at: 42 });
  });

  it("honours ctx.seqStart", () => {
    const ops = buildOps([], [entity("a"), entity("b")], {
      entity: "block",
      actorId: "u1",
      at: 0,
      seqStart: 10,
    });
    expect(shape(ops)).toEqual(["10:create:a", "11:create:b"]);
  });

  it("uses ctx.idFactory when provided", () => {
    const ops = buildOps([], [entity("a")], {
      entity: "block",
      actorId: "u1",
      at: 0,
      idFactory: (entry) => `custom:${entry.entityId}:${entry.seq}`,
    });
    expect(ops[0].id).toBe("custom:a:1");
  });

  it("does not mutate either input", () => {
    const prev = [entity("a", { nested: { keep: true } })];
    const next = [entity("a", { nested: { keep: false } })];
    build(prev, next);
    expect(prev).toEqual([entity("a", { nested: { keep: true } })]);
    expect(next).toEqual([entity("a", { nested: { keep: false } })]);
  });

  it("keeps the first occurrence of a duplicate id", () => {
    const ops = build([entity("a", { v: 1 }), entity("a", { v: 2 })], []);
    expect(ops[0].before).toEqual(entity("a", { v: 1 }));
  });

  it("degrades malformed input instead of throwing", () => {
    expect(buildOps(null, undefined)).toEqual([]);
    const malformed = [entity("ok"), null, 42, { id: "" }] as unknown as DocEntity[];
    expect(shape(buildOps([], malformed))).toEqual(["1:create:ok"]);
  });
});

describe("applyOps — pure, ordered, idempotent", () => {
  it("returns an id-ordered copy when there are no ops", () => {
    const doc = [entity("b"), entity("a")];
    expect(applyOps(doc, []).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(doc.map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("applies creates", () => {
    const ops = [op({ seq: 1, entityId: "b", kind: "create", after: entity("b", { t: 1 }) })];
    expect(applyOps([entity("a")], ops)).toEqual([entity("a"), entity("b", { t: 1 })]);
  });

  it("applies updates in place", () => {
    const ops = [
      op({
        seq: 1,
        entityId: "a",
        kind: "update",
        before: entity("a", { v: 1 }),
        after: entity("a", { v: 2 }),
      }),
    ];
    expect(applyOps([entity("a", { v: 1 }), entity("b")], ops)).toEqual([
      entity("a", { v: 2 }),
      entity("b"),
    ]);
  });

  it("applies deletes", () => {
    const ops = [op({ seq: 1, entityId: "a", kind: "delete", before: entity("a") })];
    expect(applyOps([entity("a"), entity("b")], ops)).toEqual([entity("b")]);
  });

  it("round-trips: apply(prev, build(prev, next)) reproduces next", () => {
    const prev = [entity("b", { v: 1 }), entity("a", { v: 1 })];
    const next = [entity("a", { v: 2 }), entity("c", { v: 3 })];
    expect(applyOps(prev, build(prev, next))).toEqual(byId(next));
  });

  it("is idempotent: applying the same log twice equals applying once", () => {
    const prev = [entity("a", { v: 1 })];
    const next = [entity("a", { v: 2 }), entity("b")];
    const ops = build(prev, next);
    const once = applyOps(prev, ops);
    expect(applyOps(once, ops)).toEqual(once);
  });

  it("is idempotent against an already-applied document", () => {
    const prev = [entity("a", { v: 1 }), entity("b")];
    const next = [entity("a", { v: 2 }), entity("c")];
    expect(applyOps(next, build(prev, next))).toEqual(byId(next));
  });

  it("applies ops in seq order regardless of array order", () => {
    const ops = [
      op({ seq: 2, entityId: "a", kind: "delete", before: entity("a") }),
      op({ seq: 1, entityId: "a", kind: "create", after: entity("a") }),
    ];
    expect(applyOps([], ops)).toEqual([]);
  });

  it("upserts a create for an id that already exists", () => {
    const ops = [op({ seq: 1, entityId: "a", kind: "create", after: entity("a", { v: 9 }) })];
    expect(applyOps([entity("a", { v: 1 })], ops)).toEqual([entity("a", { v: 9 })]);
  });

  it("treats a delete of a missing id as a no-op", () => {
    const ops = [op({ seq: 1, entityId: "a", kind: "delete" })];
    expect(applyOps([entity("b")], ops)).toEqual([entity("b")]);
  });

  it("does not mutate the document or the log", () => {
    const doc = [entity("a", { v: 1 })];
    const ops = [
      op({
        seq: 1,
        entityId: "a",
        kind: "update",
        before: entity("a", { v: 1 }),
        after: entity("a", { v: 2 }),
      }),
    ];
    applyOps(doc, ops);
    expect(doc).toEqual([entity("a", { v: 1 })]);
    expect(shape(ops)).toEqual(["1:update:a"]);
  });

  it("degrades null/undefined document and log instead of throwing", () => {
    expect(applyOps(null, undefined)).toEqual([]);
    const ops = [op({ seq: 1, entityId: "a", kind: "create", after: entity("a") })];
    expect(applyOps(undefined, ops)).toEqual([entity("a")]);
  });
});

describe("compactOps — collapse redundant chains", () => {
  it("returns [] for an empty or malformed log", () => {
    expect(compactOps([])).toEqual([]);
    expect(compactOps(null)).toEqual([]);
    expect(compactOps(undefined)).toEqual([]);
  });

  it("collapses create + update into one create with the final content", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "create", after: entity("a", { v: 1 }) }),
      op({ seq: 2, entityId: "a", kind: "update", before: entity("a", { v: 1 }), after: entity("a", { v: 2 }) }),
    ];
    const compacted = compactOps(ops);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({ seq: 1, kind: "create", entityId: "a" });
    expect(compacted[0].after).toEqual(entity("a", { v: 2 }));
    expect(compacted[0].before).toBeUndefined();
  });

  it("collapses update + update into first before and last after", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "update", before: entity("a", { v: 0 }), after: entity("a", { v: 1 }) }),
      op({ seq: 2, entityId: "a", kind: "update", before: entity("a", { v: 1 }), after: entity("a", { v: 2 }) }),
    ];
    const compacted = compactOps(ops);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({ seq: 1, kind: "update" });
    expect(compacted[0].before).toEqual(entity("a", { v: 0 }));
    expect(compacted[0].after).toEqual(entity("a", { v: 2 }));
  });

  it("drops a create that is immediately deleted", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "create", after: entity("a") }),
      op({ seq: 2, entityId: "a", kind: "delete", before: entity("a") }),
    ];
    expect(compactOps(ops)).toEqual([]);
  });

  it("turns update + delete into a delete carrying the original before", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "update", before: entity("a", { v: 0 }), after: entity("a", { v: 1 }) }),
      op({ seq: 2, entityId: "a", kind: "delete", before: entity("a", { v: 1 }) }),
    ];
    const compacted = compactOps(ops);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({ seq: 1, kind: "delete" });
    expect(compacted[0].before).toEqual(entity("a", { v: 0 }));
    expect(compacted[0].after).toBeUndefined();
  });

  it("turns delete + create into an update preserving before and after", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "delete", before: entity("a", { v: 0 }) }),
      op({ seq: 2, entityId: "a", kind: "create", after: entity("a", { v: 1 }) }),
    ];
    const compacted = compactOps(ops);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({ seq: 1, kind: "update" });
    expect(compacted[0].before).toEqual(entity("a", { v: 0 }));
    expect(compacted[0].after).toEqual(entity("a", { v: 1 }));
  });

  it("collapses delete + delete into a single delete", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "delete", before: entity("a", { v: 1 }) }),
      op({ seq: 2, entityId: "a", kind: "delete", before: entity("a", { v: 1 }) }),
    ];
    const compacted = compactOps(ops);
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({ seq: 1, kind: "delete" });
  });

  it("leaves unrelated entities untouched and keeps seq ordering", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "update", before: entity("a", { v: 0 }), after: entity("a", { v: 1 }) }),
      op({ seq: 2, entityId: "b", kind: "create", after: entity("b") }),
      op({ seq: 3, entityId: "a", kind: "update", before: entity("a", { v: 1 }), after: entity("a", { v: 2 }) }),
    ];
    expect(shape(compactOps(ops))).toEqual(["1:update:a", "2:create:b"]);
  });

  it("preserves the net effect of the log", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "update", before: entity("a", { v: 0 }), after: entity("a", { v: 1 }) }),
      op({ seq: 2, entityId: "a", kind: "update", before: entity("a", { v: 1 }), after: entity("a", { v: 2 }) }),
      op({ seq: 3, entityId: "b", kind: "create", after: entity("b", { v: 1 }) }),
      op({ seq: 4, entityId: "b", kind: "update", before: entity("b", { v: 1 }), after: entity("b", { v: 2 }) }),
    ];
    const base = [entity("a", { v: 0 })];
    expect(applyOps(base, compactOps(ops))).toEqual(applyOps(base, ops));
  });

  it("is idempotent", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "create", after: entity("a", { v: 1 }) }),
      op({ seq: 2, entityId: "a", kind: "update", before: entity("a", { v: 1 }), after: entity("a", { v: 2 }) }),
      op({ seq: 3, entityId: "a", kind: "delete", before: entity("a", { v: 2 }) }),
      op({ seq: 4, entityId: "b", kind: "create", after: entity("b") }),
    ];
    expect(compactOps(compactOps(ops))).toEqual(compactOps(ops));
  });

  it("does not mutate the input log", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "create", after: entity("a", { v: 1 }) }),
      op({ seq: 2, entityId: "a", kind: "update", before: entity("a", { v: 1 }), after: entity("a", { v: 2 }) }),
    ];
    const before = shape(ops);
    compactOps(ops);
    expect(shape(ops)).toEqual(before);
  });
});

describe("cursorOf / opsSince", () => {
  it("cursorOf is 0 for an empty or malformed log, else the max seq", () => {
    expect(cursorOf([])).toBe(0);
    expect(cursorOf(null)).toBe(0);
    expect(cursorOf(undefined)).toBe(0);
    expect(
      cursorOf([
        op({ seq: 3, entityId: "a", kind: "update" }),
        op({ seq: 7, entityId: "b", kind: "update" }),
      ]),
    ).toBe(7);
  });

  it("opsSince returns only ops strictly after the cursor, ordered", () => {
    const ops = [
      op({ seq: 1, entityId: "a", kind: "create" }),
      op({ seq: 3, entityId: "b", kind: "create" }),
      op({ seq: 7, entityId: "c", kind: "create" }),
    ];
    expect(opsSince(ops, 0).map((entry) => entry.seq)).toEqual([1, 3, 7]);
    expect(opsSince(ops, 3).map((entry) => entry.seq)).toEqual([7]);
  });

  it("opsSince(cursorOf(ops)) is empty", () => {
    const ops = [
      op({ seq: 2, entityId: "a", kind: "create" }),
      op({ seq: 5, entityId: "b", kind: "create" }),
    ];
    expect(opsSince(ops, cursorOf(ops))).toEqual([]);
  });

  it("opsSince treats a non-finite cursor as from the start", () => {
    const ops = [op({ seq: 4, entityId: "a", kind: "create" })];
    expect(opsSince(ops, Number.NaN).map((entry) => entry.seq)).toEqual([4]);
    expect(opsSince(ops, null).map((entry) => entry.seq)).toEqual([4]);
  });

  it("opsSince sorts by seq without mutating the input", () => {
    const ops = [
      op({ seq: 5, entityId: "a", kind: "create" }),
      op({ seq: 1, entityId: "b", kind: "create" }),
    ];
    expect(opsSince(ops, 0).map((entry) => entry.seq)).toEqual([1, 5]);
    expect(ops.map((entry) => entry.seq)).toEqual([5, 1]);
  });
});

describe("hashDoc — cheap equality", () => {
  it("is order-independent over entities", () => {
    expect(hashDoc([entity("b"), entity("a")])).toBe(hashDoc([entity("a"), entity("b")]));
  });

  it("differs for different content but not for key order", () => {
    expect(hashDoc([entity("a", { v: 1 })])).not.toBe(hashDoc([entity("a", { v: 2 })]));
    expect(hashDoc([entity("a", { x: 1, y: 2 })])).toBe(hashDoc([entity("a", { y: 2, x: 1 })]));
  });

  it("is stable for an empty document", () => {
    expect(hashDoc([])).toBe(hashDoc([]));
    expect(hashDoc(null)).toBe(hashDoc(undefined));
  });

  it("matches the hash of a round-tripped document", () => {
    const prev = [entity("a", { v: 1 }), entity("b")];
    const next = [entity("a", { v: 2 }), entity("c")];
    expect(hashDoc(applyOps(prev, build(prev, next)))).toBe(hashDoc(next));
  });
});

describe("validateOpLog — structure audit", () => {
  it("accepts a contiguous, monotonic log", () => {
    const result = validateOpLog([
      op({ seq: 1, entityId: "a", kind: "create" }),
      op({ seq: 2, entityId: "b", kind: "create" }),
      op({ seq: 3, entityId: "a", kind: "update" }),
    ]);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result).toMatchObject({ count: 3, cursor: 3, minSeq: 1, maxSeq: 3 });
  });

  it("treats an empty or malformed log as valid", () => {
    expect(validateOpLog([])).toMatchObject({ valid: true, issues: [], count: 0, cursor: 0 });
    expect(validateOpLog(null)).toMatchObject({ valid: true, issues: [], count: 0 });
    expect(validateOpLog({} as unknown as readonly Op[])).toMatchObject({ valid: true, count: 0 });
  });

  it("detects a seq gap and lists the missing numbers", () => {
    const result = validateOpLog([
      op({ seq: 1, entityId: "a", kind: "create" }),
      op({ seq: 2, entityId: "b", kind: "create" }),
      op({ seq: 4, entityId: "c", kind: "create" }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.issues.find((issue) => issue.kind === "gap")?.missing).toEqual([3]);
  });

  it("detects a duplicate seq", () => {
    const result = validateOpLog([
      op({ id: "x", seq: 1, entityId: "a", kind: "create" }),
      op({ id: "y", seq: 1, entityId: "b", kind: "create" }),
    ]);
    expect(result.issues.some((issue) => issue.kind === "duplicate-seq")).toBe(true);
  });

  it("detects a duplicate op id", () => {
    const result = validateOpLog([
      op({ id: "same", seq: 1, entityId: "a", kind: "create" }),
      op({ id: "same", seq: 2, entityId: "b", kind: "create" }),
    ]);
    expect(result.issues.some((issue) => issue.kind === "duplicate-id")).toBe(true);
  });

  it("detects a non-monotonic seq", () => {
    const result = validateOpLog([
      op({ seq: 2, entityId: "a", kind: "create" }),
      op({ seq: 1, entityId: "b", kind: "create" }),
    ]);
    expect(result.issues.some((issue) => issue.kind === "non-monotonic")).toBe(true);
  });

  it("detects an invalid (non-integer) seq", () => {
    const result = validateOpLog([
      op({ seq: Number.NaN, entityId: "a", kind: "create" }),
      null as unknown as Op,
    ]);
    expect(result.issues.filter((issue) => issue.kind === "invalid-seq")).toHaveLength(2);
  });

  it("reports cursor, min and max even across a gap", () => {
    const result = validateOpLog([
      op({ seq: 2, entityId: "a", kind: "create" }),
      op({ seq: 5, entityId: "b", kind: "create" }),
    ]);
    expect(result).toMatchObject({ count: 2, cursor: 5, minSeq: 2, maxSeq: 5 });
  });
});
