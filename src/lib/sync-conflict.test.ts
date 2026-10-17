import { describe, expect, it, vi } from "vitest";
import {
  UNRESOLVED,
  applyResolutions,
  autoResolve,
  compare,
  detectConflicts,
  describeConflict,
  mergeDoc,
  mergeField,
  resolveConflict,
  tick,
  type FieldConflict,
  type MergeConflict,
  type MergedDoc,
  type RecordVersion,
} from "./sync-conflict";

/**
 * Sync conflict handling (S23) — pure, red-first.
 *
 * `src/lib/sync-conflict.ts` did not exist when this file was first written
 * (module-not-found -> suite red; "Red-first").
 *
 * When two replicas edit the same record from a shared base, three-way merges
 * go wrong in exactly one place: fields both sides changed to *different*
 * values. This module names those conflicts (`detectConflicts`), resolves or
 * defers them by strategy (`autoResolve`), and renders one for a human
 * (`describeConflict`) — no Prisma, no React, no clock, no I/O.
 *
 * Contract pinned here:
 *  - a field is a conflict only when BOTH sides moved off `base` AND their
 *    resulting values are not deeply equal;
 *  - detection is shallow (top-level fields) and ASCII-ordered for determinism;
 *  - `local-wins` / `remote-wins` resolve every conflict, `manual` resolves none,
 *    and `merge` (the default) deep-merges objects / unions arrays, deferring
 *    only what it cannot reconcile;
 *  - inputs are never mutated and every helper is total (never throws).
 */

describe("detectConflicts", () => {
  it("returns no conflicts when both sides are unchanged", () => {
    expect(detectConflicts({ a: 1 }, { a: 1 }, { a: 1 })).toEqual([]);
  });

  it("ignores a field changed on only one side", () => {
    expect(detectConflicts({ a: 2 }, { a: 1 }, { a: 1 })).toEqual([]);
    expect(detectConflicts({ a: 1 }, { a: 2 }, { a: 1 })).toEqual([]);
  });

  it("ignores a field both sides changed to the same value", () => {
    expect(detectConflicts({ a: 2 }, { a: 2 }, { a: 1 })).toEqual([]);
  });

  it("reports a changed/changed conflict with base and both values", () => {
    expect(detectConflicts({ title: "B" }, { title: "C" }, { title: "A" })).toEqual([
      {
        field: "title",
        base: "A",
        local: "B",
        remote: "C",
        localOp: "changed",
        remoteOp: "changed",
      },
    ]);
  });

  it("reports an added/added conflict", () => {
    expect(detectConflicts({ x: 1 }, { x: 2 }, {})).toEqual([
      { field: "x", base: undefined, local: 1, remote: 2, localOp: "added", remoteOp: "added" },
    ]);
  });

  it("reports a removed/changed conflict", () => {
    expect(detectConflicts({}, { tags: ["b"] }, { tags: ["a"] })).toEqual([
      {
        field: "tags",
        base: ["a"],
        local: undefined,
        remote: ["b"],
        localOp: "removed",
        remoteOp: "changed",
      },
    ]);
  });

  it("reports a changed/removed conflict", () => {
    expect(detectConflicts({ tags: ["b"] }, {}, { tags: ["a"] })).toEqual([
      {
        field: "tags",
        base: ["a"],
        local: ["b"],
        remote: undefined,
        localOp: "changed",
        remoteOp: "removed",
      },
    ]);
  });

  it("does not report a field both sides removed", () => {
    expect(detectConflicts({}, {}, { tags: ["a"] })).toEqual([]);
  });

  it("compares nested values deeply, ignoring key order", () => {
    expect(detectConflicts({ cfg: { x: 1, y: 2 } }, { cfg: { y: 2, x: 1 } }, {})).toEqual([]);
  });

  it("treats array reordering as a conflict", () => {
    expect(detectConflicts({ list: [1, 2] }, { list: [2, 1] }, { list: [] })).toHaveLength(1);
  });

  it("treats explicit null as a value, not as absence", () => {
    expect(detectConflicts({ a: null }, {}, { a: 1 })).toEqual([
      {
        field: "a",
        base: 1,
        local: null,
        remote: undefined,
        localOp: "changed",
        remoteOp: "removed",
      },
    ]);
  });

  it("orders conflicts ASCII-ascending by field", () => {
    const conflicts = detectConflicts(
      { b: 2, a: 2, c: 2 },
      { b: 3, a: 3, c: 3 },
      { b: 1, a: 1, c: 1 },
    );
    expect(conflicts.map((conflict) => conflict.field)).toEqual(["a", "b", "c"]);
  });

  it("degrades non-record inputs to empty records", () => {
    expect(detectConflicts(42, "nope", null)).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const local = { a: { deep: 1 } };
    const remote = { a: { deep: 2 } };
    const base = { a: { deep: 0 } };
    detectConflicts(local, remote, base);
    expect(local).toEqual({ a: { deep: 1 } });
    expect(remote).toEqual({ a: { deep: 2 } });
    expect(base).toEqual({ a: { deep: 0 } });
  });
});

describe("autoResolve", () => {
  it("defaults to the merge strategy", () => {
    expect(autoResolve({}, {}, {}).strategy).toBe("merge");
  });

  it("applies a single-side change without reporting a conflict", () => {
    const result = autoResolve({ b: 2 }, { b: 1 }, { b: 1 });
    expect(result.record).toEqual({ b: 2 });
    expect(result.conflicts).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("keeps fields unchanged on both sides", () => {
    const result = autoResolve(
      { a: 1, b: 2 },
      { a: 1, b: 1 },
      { a: 1, b: 1 },
      { strategy: "local-wins" },
    );
    expect(result.record).toEqual({ a: 1, b: 2 });
  });

  it("local-wins takes the local value for every conflict", () => {
    const result = autoResolve(
      { title: "B", n: 5 },
      { title: "C", n: 6 },
      { title: "A", n: 0 },
      { strategy: "local-wins" },
    );
    expect(result.record).toEqual({ title: "B", n: 5 });
    expect(result.resolved).toEqual(["n", "title"]);
    expect(result.unresolved).toEqual([]);
  });

  it("remote-wins takes the remote value for every conflict", () => {
    const result = autoResolve({ title: "B" }, { title: "C" }, { title: "A" }, {
      strategy: "remote-wins",
    });
    expect(result.record).toEqual({ title: "C" });
    expect(result.resolved).toEqual(["title"]);
    expect(result.unresolved).toEqual([]);
  });

  it("manual resolves nothing and omits conflicts from the record", () => {
    const result = autoResolve(
      { title: "B", keep: 1 },
      { title: "C", keep: 1 },
      { title: "A", keep: 1 },
      { strategy: "manual" },
    );
    expect(result.record).toEqual({ keep: 1 });
    expect(result.resolved).toEqual([]);
    expect(result.unresolved.map((conflict) => conflict.field)).toEqual(["title"]);
  });

  it("merge applies clean changes while deferring a scalar conflict", () => {
    const result = autoResolve(
      { title: "B", added: 9 },
      { title: "C", added: 1 },
      { title: "A", added: 1 },
      { strategy: "merge" },
    );
    expect(result.record).toEqual({ added: 9 });
    expect(result.unresolved.map((conflict) => conflict.field)).toEqual(["title"]);
  });

  it("merge deep-merges conflicting plain objects", () => {
    const result = autoResolve(
      { cfg: { theme: "dark", size: 2 } },
      { cfg: { theme: "light", size: 2 } },
      { cfg: { theme: "light", size: 1 } },
      { strategy: "merge" },
    );
    expect(result.record).toEqual({ cfg: { size: 2, theme: "dark" } });
    expect(result.conflicts.map((conflict) => conflict.field)).toEqual(["cfg"]);
    expect(result.resolved).toEqual(["cfg"]);
    expect(result.unresolved).toEqual([]);
  });

  it("merge defers an object whose nested leaf diverges", () => {
    const result = autoResolve(
      { cfg: { theme: "dark" } },
      { cfg: { theme: "neon" } },
      { cfg: { theme: "light" } },
      { strategy: "merge" },
    );
    expect(result.record).toEqual({});
    expect(result.unresolved.map((conflict) => conflict.field)).toEqual(["cfg"]);
  });

  it("merge unions conflicting arrays in a stable order", () => {
    const result = autoResolve(
      { tags: ["a", "b"] },
      { tags: ["b", "c"] },
      { tags: ["a"] },
      { strategy: "merge" },
    );
    expect(result.record).toEqual({ tags: ["a", "b", "c"] });
    expect(result.unresolved).toEqual([]);
  });

  it("uses a custom merge function to resolve conflicts", () => {
    const result = autoResolve({ n: 1 }, { n: 2 }, { n: 0 }, {
      strategy: "merge",
      merge: (conflict) => (conflict.local as number) + (conflict.remote as number),
    });
    expect(result.record).toEqual({ n: 3 });
    expect(result.resolved).toEqual(["n"]);
    expect(result.unresolved).toEqual([]);
  });

  it("treats a custom UNRESOLVED result as unresolved", () => {
    const merge = vi.fn(() => UNRESOLVED);
    const result = autoResolve({ n: 1 }, { n: 2 }, { n: 0 }, { strategy: "merge", merge });
    expect(merge).toHaveBeenCalledTimes(1);
    expect(result.unresolved.map((conflict) => conflict.field)).toEqual(["n"]);
  });

  it("removes a field when the winning side removed it", () => {
    const base = { tags: ["a"] };
    const remote = { tags: ["b"] };
    expect(autoResolve({}, remote, base, { strategy: "local-wins" }).record).toEqual({});
    expect(autoResolve({}, remote, base, { strategy: "remote-wins" }).record).toEqual({
      tags: ["b"],
    });
  });

  it("does not mutate inputs and returns a fresh record", () => {
    const local = { a: 1 };
    const remote = { a: 1 };
    const base = { a: 1 };
    const result = autoResolve(local, remote, base);
    expect(result.record).not.toBe(local);
    expect(local).toEqual({ a: 1 });
    expect(remote).toEqual({ a: 1 });
    expect(base).toEqual({ a: 1 });
  });
});

describe("describeConflict", () => {
  it("describes a changed/changed conflict", () => {
    const conflict: FieldConflict = {
      field: "title",
      base: "A",
      local: "B",
      remote: "C",
      localOp: "changed",
      remoteOp: "changed",
    };
    expect(describeConflict(conflict)).toBe(
      'title: local changed "B", remote changed "C"; base "A"',
    );
  });

  it("renders an absent value as none", () => {
    const conflict: FieldConflict = {
      field: "tags",
      base: ["a"],
      local: undefined,
      remote: ["b"],
      localOp: "removed",
      remoteOp: "changed",
    };
    expect(describeConflict(conflict)).toBe(
      'tags: local removed none, remote changed ["b"]; base ["a"]',
    );
  });

  it("serialises object values as JSON", () => {
    const conflict: FieldConflict = {
      field: "cfg",
      base: { a: 1 },
      local: { a: 2 },
      remote: { a: 3 },
      localOp: "changed",
      remoteOp: "changed",
    };
    expect(describeConflict(conflict)).toBe(
      'cfg: local changed {"a":2}, remote changed {"a":3}; base {"a":1}',
    );
  });
});

/**
 * S17 - logical-clock conflict resolution with visible provenance.
 *
 * Red-first: `tick`, `compare`, `mergeField`, `mergeDoc`, `resolveConflict` and
 * `applyResolutions` did not exist when these blocks were written. The design
 * rule under test is "last-writer-wins, but never silent": every field both
 * replicas moved to *different* values is listed in `conflicts[]` with both
 * candidates and their actors, so a resolver can always see the loser, not just
 * the winner.
 */

/** Build a stamped RecordVersion for the tests. */
function version<T>(actorId: string, clock: number, value: T, at = 0): RecordVersion<T> {
  return { actorId, clock, value, at };
}

describe("tick / compare (Lamport clock)", () => {
  it("tick advances the counter by one and carries the actor", () => {
    expect(tick(3, "alice")).toEqual({ clock: 4, actorId: "alice" });
  });

  it("tick accepts an existing ClockStamp", () => {
    expect(tick({ clock: 7, actorId: "bob" }, "carol")).toEqual({
      clock: 8,
      actorId: "carol",
    });
  });

  it("tick is monotonic across repeated ticks", () => {
    let clock = tick(0, "a").clock;
    for (let i = 0; i < 5; i += 1) clock = tick(clock, "a").clock;
    expect(clock).toBe(6);
  });

  it("tick clamps a non-finite counter to a usable base", () => {
    expect(tick(Number.NaN, "a")).toEqual({ clock: 1, actorId: "a" });
  });

  it("compare orders by logical clock first", () => {
    expect(compare(version("a", 1, "x"), version("b", 2, "y"))).toBeLessThan(0);
    expect(compare(version("a", 5, "x"), version("b", 2, "y"))).toBeGreaterThan(0);
  });

  it("compare breaks a clock tie by actorId ascending", () => {
    expect(compare(version("alice", 3, "x"), version("bob", 3, "y"))).toBeLessThan(0);
    expect(compare(version("bob", 3, "x"), version("alice", 3, "y"))).toBeGreaterThan(0);
  });

  it("compare ignores the value and returns 0 for identical stamps", () => {
    expect(compare(version("a", 2, "x"), version("a", 2, "different"))).toBe(0);
  });

  it("compare is antisymmetric", () => {
    const a = version("a", 2, 1);
    const b = version("b", 2, 2);
    expect(Math.sign(compare(a, b))).toBe(-Math.sign(compare(b, a)));
  });
});

describe("mergeField (LWW + provenance)", () => {
  it("picks the higher logical clock", () => {
    const result = mergeField(version("a", 1, "old"), version("b", 2, "new"));
    expect(result.value).toBe("new");
    expect(result.winner).toEqual(version("b", 2, "new"));
  });

  it("breaks a clock tie by actorId", () => {
    expect(mergeField(version("alice", 3, "A"), version("bob", 3, "B")).value).toBe("B");
  });

  it("reports no conflict for equal values", () => {
    const result = mergeField(version("a", 1, { x: 1 }), version("b", 2, { x: 1 }));
    expect(result.conflict).toBe(false);
  });

  it("compares values deeply, ignoring object key order", () => {
    const result = mergeField(version("a", 1, { x: 1, y: 2 }), version("b", 2, { y: 2, x: 1 }));
    expect(result.conflict).toBe(false);
  });

  it("reports a conflict for different values", () => {
    expect(mergeField(version("a", 1, "A"), version("b", 2, "B")).conflict).toBe(true);
  });

  it("records both candidates in provenance (no data loss)", () => {
    const result = mergeField(version("a", 1, "A"), version("b", 2, "B"));
    expect(result.provenance).toEqual([version("a", 1, "A"), version("b", 2, "B")]);
  });

  it("keeps provenance canonically ordered regardless of call order", () => {
    const a = version("a", 1, "A");
    const b = version("b", 2, "B");
    expect(mergeField(a, b).provenance).toEqual(mergeField(b, a).provenance);
  });

  it("is order-independent (mergeField(a,b) equals mergeField(b,a))", () => {
    const a = version("alice", 3, "A");
    const b = version("bob", 3, "B");
    expect(mergeField(a, b)).toEqual(mergeField(b, a));
  });

  it("keeps a single provenance entry when the values agree", () => {
    const result = mergeField(version("a", 1, "same"), version("b", 2, "same"));
    expect(result.provenance).toHaveLength(1);
  });

  it("returns a result without mutating the inputs", () => {
    const local = version("a", 1, "A");
    const remote = version("b", 2, "B");
    mergeField(local, remote);
    expect(local).toEqual({ actorId: "a", clock: 1, value: "A", at: 0 });
    expect(remote).toEqual({ actorId: "b", clock: 2, value: "B", at: 0 });
  });
});

describe("mergeDoc (lww)", () => {
  it("defaults to the lww strategy", () => {
    expect(mergeDoc({}, {}).strategy).toBe("lww");
  });

  it("unions disjoint fields", () => {
    const doc = mergeDoc({ a: version("x", 1, 1) }, { b: version("y", 1, 2) });
    expect(doc.fields).toEqual({ a: 1, b: 2 });
    expect(doc.conflicts).toEqual([]);
  });

  it("takes a field present on only one side without a conflict", () => {
    const doc = mergeDoc({ a: version("x", 1, 1) }, {});
    expect(doc.fields).toEqual({ a: 1 });
    expect(doc.conflicts).toEqual([]);
  });

  it("resolves a divergence to the greater version and records it", () => {
    const doc = mergeDoc({ title: version("alice", 1, "A") }, { title: version("bob", 2, "B") });
    expect(doc.fields).toEqual({ title: "B" });
    expect(doc.conflicts).toHaveLength(1);
    expect(doc.conflicts[0]?.resolved).toBe(true);
  });

  it("gives every conflict before/after and the competing actors", () => {
    const doc = mergeDoc({ title: version("alice", 1, "A") }, { title: version("bob", 2, "B") });
    expect(doc.conflicts[0]).toEqual({
      field: "title",
      before: version("alice", 1, "A"),
      after: version("bob", 2, "B"),
      actors: ["alice", "bob"],
      resolved: true,
    });
  });

  it("orders conflicts ASCII-ascending by field", () => {
    const doc = mergeDoc(
      { b: version("x", 1, 1), a: version("x", 1, 1), c: version("x", 1, 1) },
      { b: version("y", 1, 2), a: version("y", 1, 2), c: version("y", 1, 2) },
    );
    expect(doc.conflicts.map((conflict) => conflict.field)).toEqual(["a", "b", "c"]);
  });

  it("sorts actors ascending and de-duplicates them", () => {
    const doc = mergeDoc({ a: version("zoe", 1, 1) }, { a: version("amy", 2, 2) });
    expect(doc.conflicts[0]?.actors).toEqual(["amy", "zoe"]);
  });

  it("converges: mergeDoc(a,b) equals mergeDoc(b,a)", () => {
    const a = { title: version("alice", 3, "A"), tags: version("alice", 1, ["x"]) };
    const b = { title: version("bob", 3, "B"), tags: version("bob", 2, ["y"]) };
    expect(mergeDoc(a, b)).toEqual(mergeDoc(b, a));
  });

  it("does not mutate its inputs", () => {
    const a = { title: version("alice", 1, "A") };
    const b = { title: version("bob", 2, "B") };
    mergeDoc(a, b);
    expect(a).toEqual({ title: version("alice", 1, "A") });
    expect(b).toEqual({ title: version("bob", 2, "B") });
  });

  it("degrades non-record inputs to an empty document", () => {
    expect(mergeDoc(42, null).fields).toEqual({});
    expect(mergeDoc(42, null).conflicts).toEqual([]);
  });

  it("never resolves silently: a diverging field always appears in conflicts", () => {
    const doc = mergeDoc(
      { a: version("x", 1, 1), b: version("x", 1, 1) },
      { a: version("y", 2, 2), b: version("y", 1, 1) },
    );
    expect(doc.conflicts.map((conflict) => conflict.field)).toEqual(["a"]);
  });
});

describe("mergeDoc (manual)", () => {
  it("defers diverging fields instead of resolving them", () => {
    const doc = mergeDoc(
      { title: version("alice", 1, "A") },
      { title: version("bob", 2, "B") },
      { strategy: "manual" },
    );
    expect(doc.fields).toEqual({});
    expect(doc.conflicts[0]?.resolved).toBe(false);
  });

  it("still applies non-conflicting fields", () => {
    const doc = mergeDoc(
      { title: version("alice", 1, "A"), keep: version("alice", 1, 1) },
      { title: version("bob", 2, "B"), keep: version("alice", 1, 1) },
      { strategy: "manual" },
    );
    expect(doc.fields).toEqual({ keep: 1 });
    expect(doc.conflicts.map((conflict) => conflict.field)).toEqual(["title"]);
  });

  it("converges under manual too", () => {
    const a = { title: version("alice", 3, "A") };
    const b = { title: version("bob", 3, "B") };
    expect(mergeDoc(a, b, { strategy: "manual" })).toEqual(
      mergeDoc(b, a, { strategy: "manual" }),
    );
  });
});

describe("resolveConflict", () => {
  const conflict: MergeConflict = {
    field: "title",
    before: version("alice", 1, "A"),
    after: version("bob", 2, "B"),
    actors: ["alice", "bob"],
    resolved: true,
  };

  it("returns the winning (after) version for choice after", () => {
    expect(resolveConflict(conflict, "after")).toEqual(version("bob", 2, "B"));
  });

  it("returns the superseded (before) version for choice before", () => {
    expect(resolveConflict(conflict, "before")).toEqual(version("alice", 1, "A"));
  });

  it("returns a copy, not the stored object", () => {
    expect(resolveConflict(conflict, "after")).not.toBe(conflict.after);
  });
});

describe("applyResolutions", () => {
  const build = (): MergedDoc =>
    mergeDoc(
      { title: version("alice", 1, "A"), keep: version("alice", 1, 1) },
      { title: version("bob", 2, "B"), keep: version("alice", 1, 1) },
      { strategy: "manual" },
    );

  it("fills a deferred field with the chosen candidate", () => {
    const doc = applyResolutions(build(), [{ field: "title", choice: "before" }]);
    expect(doc.fields).toEqual({ keep: 1, title: "A" });
  });

  it("marks the conflict resolved but keeps its provenance", () => {
    const doc = applyResolutions(build(), [{ field: "title", choice: "after" }]);
    const conflict = doc.conflicts[0];
    expect(conflict?.resolved).toBe(true);
    expect(conflict?.before).toEqual(version("alice", 1, "A"));
    expect(conflict?.after).toEqual(version("bob", 2, "B"));
  });

  it("ignores resolutions for unknown fields", () => {
    const doc = applyResolutions(build(), [{ field: "ghost", choice: "after" }]);
    expect(doc.fields).toEqual({ keep: 1 });
    expect(doc.conflicts[0]?.resolved).toBe(false);
  });

  it("does not mutate the input document", () => {
    const doc = build();
    applyResolutions(doc, [{ field: "title", choice: "after" }]);
    expect(doc.fields).toEqual({ keep: 1 });
    expect(doc.conflicts[0]?.resolved).toBe(false);
  });

  it("is idempotent", () => {
    const once = applyResolutions(build(), [{ field: "title", choice: "after" }]);
    expect(applyResolutions(once, [{ field: "title", choice: "after" }])).toEqual(once);
  });
});

describe("describeConflict (logical-clock conflicts)", () => {
  it("names the field, both candidates, the actors and the state", () => {
    const conflict: MergeConflict = {
      field: "title",
      before: version("alice", 1, "A"),
      after: version("bob", 2, "B"),
      actors: ["alice", "bob"],
      resolved: false,
    };
    const text = describeConflict(conflict);
    expect(text).toContain("title");
    expect(text).toContain("alice");
    expect(text).toContain("bob");
    expect(text).toContain("unresolved");
  });

  it("flags a resolved conflict", () => {
    const conflict: MergeConflict = {
      field: "title",
      before: version("alice", 1, "A"),
      after: version("bob", 2, "B"),
      actors: ["alice", "bob"],
      resolved: true,
    };
    expect(describeConflict(conflict)).toContain("resolved");
  });
});
